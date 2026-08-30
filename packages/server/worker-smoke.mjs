/**
 * Runs the security-critical flows against the Worker build on the real
 * workerd runtime, to prove the port preserved behaviour.
 */
import { execSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:8787';
const psql = (q) => execSync(
  `psql -h 127.0.0.1 -U postgres -d mara -qtAX -c "${q}"`, { encoding: 'utf8' },
).trim();

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

const api = async (path, opts = {}) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
};

const branchId = psql("select id from branches where code='MARA-01'");

// Repeated runs deliberately submit a wrong PIN, which trips the lockout. Clear
// it so each run starts from the same state — the lockout itself has its own
// test in the server suite.
psql("UPDATE employees SET failed_pin_count = 0, locked_until = NULL");
psql("UPDATE users SET failed_login_count = 0, locked_until = NULL");

// --- 1. Argon2 under workerd: the CPU-heavy path -----------------------------
const t0 = Date.now();
const login = await api('/auth/employee/login', {
  method: 'POST', body: { branchId, employeeCode: '2001', pin: '4826' },
});
check('employee PIN login works on workerd (pure-JS argon2)', login.status === 200,
  `${Date.now() - t0} ms`);
const cashier = login.json?.tokens?.accessToken;
check('login returns the employee identity', login.json?.employee?.role === 'cashier');

// --- 2. Wrong PIN is still refused -------------------------------------------
const badPin = await api('/auth/employee/login', {
  method: 'POST', body: { branchId, employeeCode: '2001', pin: '9999' },
});
check('a wrong PIN is refused', badPin.status === 401);

// --- 3. Administrative account cannot use a PIN -------------------------------
const adminPin = await api('/auth/employee/login', {
  method: 'POST', body: { branchId, employeeCode: '9001', pin: '1234' },
});
check('an administrative account is refused a PIN login',
  adminPin.status === 403 || adminPin.status === 401, `HTTP ${adminPin.status}`);

// --- 4. Admin login + the /auth/me permission set ------------------------------
const adminLogin = await api('/auth/login', {
  method: 'POST', body: { email: 'manager@maralounge.sa', password: 'MaraManager#2026Xy' },
});
check('admin email+password login works', adminLogin.json?.status === 'ok',
  `status=${adminLogin.json?.status}`);
const manager = adminLogin.json?.tokens?.accessToken;

const me = await api('/auth/me', { token: cashier });
check('/auth/me returns the caller permission set',
  Array.isArray(me.json?.permissions) && me.json.permissions.length > 10,
  `${me.json?.permissions?.length} permissions`);

// --- 5. Authorisation is still enforced ---------------------------------------
const waiterLogin = await api('/auth/employee/login', {
  method: 'POST', body: { branchId, employeeCode: '1042', pin: '2580' },
});
const waiter = waiterLogin.json?.tokens?.accessToken;

const reports = await api('/reports/sales', { token: waiter });
check('a waiter is refused financial reports', reports.status === 403);

const audit = await api('/audit', { token: waiter });
check('a waiter is refused the audit log', audit.status === 403);

const noToken = await api('/tables');
check('an unauthenticated request is refused', noToken.status === 401);

// --- 6. Route resolution: the static-vs-parameter case -------------------------
const inbox = await api('/orders/pending-approval', { token: waiter });
check('static route beats the :id route on workerd',
  inbox.status === 200 && Array.isArray(inbox.json?.orders),
  `HTTP ${inbox.status}`);

// --- 7. Branch containment -----------------------------------------------------
psql("INSERT INTO branches (code,name,name_ar) VALUES ('WKR','W','فرع') ON CONFLICT (code) DO NOTHING");
const otherBranch = psql("select id from branches where code='WKR'");
// Unique per run: a crashed run leaves its fixture behind, and a fixed number
// would then collide on the unique index.
const foreignNumber = `ORD-7777-${String(Date.now()).slice(-6)}`;
const foreignOrder = psql(
  `INSERT INTO orders (order_number, branch_id, status, grand_total)
   VALUES ('${foreignNumber}', '${otherBranch}', 'paid', 12345) RETURNING id`);
const cross = await api(`/orders/${foreignOrder}`, { token: waiter });
check("another branch's order is refused", cross.status === 403, `HTTP ${cross.status}`);

// --- 8. The guest QR surface ---------------------------------------------------
const qrToken = psql("select qr_token from restaurant_tables where table_number='12'");
const { createHmac } = await import('node:crypto');
const sig = createHmac('sha256', 'dev-cookie-secret-at-least-32-characters-long!!')
  .update('table:' + qrToken).digest('base64url').slice(0, 16);

const menu = await fetch(`${BASE}/api/public/menu/${qrToken}.${sig}`).then((r) => r.json());
check('QR resolves the table without a session', menu?.table?.number === '12',
  `table ${menu?.table?.number}`);
check('the guest menu carries products', (menu?.menu?.products?.length ?? 0) > 0);

const tampered = await fetch(`${BASE}/api/public/menu/${qrToken}.0000000000000000`);
check('a tampered QR is refused', tampered.status === 404);

// --- 9. An order routes to its department printers -----------------------------
const flatWhite = psql("select id from products where name_ar='فلات وايت'");
const dessert = psql("select id from products where name_ar='كيك الشوكولاتة'");
const before = Number(psql('select count(*) from orders'));
const order = await api('/orders', {
  method: 'POST', token: cashier,
  body: {
    lines: [
      { productId: flatWhite, quantity: 1 },
      { productId: dessert, quantity: 1 },
    ],
    idempotencyKey: `worker-${Date.now()}`,
  },
});
check('an order is created through the Worker', order.status === 200,
  `HTTP ${order.status} ${JSON.stringify(order.json).slice(0, 90)}`);
const after = Number(psql('select count(*) from orders'));
check('exactly one order was written', after === before + 1, `${before} -> ${after}`);

if (order.json?.orderId) {
  const depts = psql(
    `select string_agg(distinct p.department, ',' order by p.department)
       from print_jobs pj join printers p on p.id = pj.printer_id
      where pj.order_id = '${order.json.orderId}'`);
  check('items routed to their own department printers', depts === 'BAR,KITCHEN', depts);

  // --- 10. Prices come from the database ------------------------------------
  check('total is the menu price, not anything the client sent',
    order.json.grandTotal === 4600, `${order.json.grandTotal} halalas`);
}

// --- 11. Idempotency ----------------------------------------------------------
const key = `worker-idem-${Date.now()}`;
const first = await api('/orders', {
  method: 'POST', token: cashier,
  body: { lines: [{ productId: flatWhite, quantity: 1 }], idempotencyKey: key },
});
const second = await api('/orders', {
  method: 'POST', token: cashier,
  body: { lines: [{ productId: flatWhite, quantity: 1 }], idempotencyKey: key },
});
check('a retried submit returns the original order',
  first.json?.orderId === second.json?.orderId);

// --- 12. The discount OTP gate -------------------------------------------------
const customerId = psql("select id from customers where phone='+966551234567'");
const shisha = psql("select id from products where name_ar='معسل تفاحتين'");
const discOrder = await api('/orders', {
  method: 'POST', token: cashier,
  body: {
    customerId, lines: [{ productId: shisha, quantity: 1 }],
    idempotencyKey: `worker-disc-${Date.now()}`,
  },
});
const otpReq = await api(`/orders/${discOrder.json.orderId}/discount/request-otp`, {
  method: 'POST', token: cashier, body: { customerId },
});
check('a discount requires an OTP to be issued', otpReq.status === 200,
  `HTTP ${otpReq.status}`);

const wrongCode = await api(`/orders/${discOrder.json.orderId}/discount/apply`, {
  method: 'POST', token: cashier,
  body: {
    customerId, otpRequestId: otpReq.json?.otpRequestId,
    operationRef: otpReq.json?.operationRef, code: '000000',
  },
});
check('a wrong OTP is refused and no discount is written', wrongCode.status === 400);
const discounts = discOrder.json?.orderId
  ? Number(psql(`select count(*) from discounts where order_id='${discOrder.json.orderId}'`))
  : -1;
check('the invoice is untouched after a failed OTP', discounts === 0, `${discounts} discounts`);

// --- 13. Transactions with row locks still work over Hyperdrive ----------------
const stockBefore = Number(psql(
  "select coalesce(sum(quantity),0) from inventory_stock s join inventory_items i on i.id=s.item_id where i.sku='ING-COFFEE'"));
await api('/orders', {
  method: 'POST', token: cashier,
  body: { lines: [{ productId: flatWhite, quantity: 2 }], idempotencyKey: `worker-stock-${Date.now()}` },
});
const stockAfter = Number(psql(
  "select coalesce(sum(quantity),0) from inventory_stock s join inventory_items i on i.id=s.item_id where i.sku='ING-COFFEE'"));
check('recipe consumption drew stock inside a transaction',
  stockBefore - stockAfter === 36, `${stockBefore} -> ${stockAfter} (expected -36 g)`);

// Cleanup
psql("DELETE FROM orders WHERE order_number LIKE 'ORD-7777%'");
psql("DELETE FROM branches WHERE code='WKR'");

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} Worker runtime checks passed`);
process.exit(failed.length ? 1 : 0);
