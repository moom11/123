import { chromium } from '/tmp/node_modules/playwright/index.mjs';
import { execSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:4174';
const psql = (q) => execSync(
  `psql -h 127.0.0.1 -U postgres -d mara -qtAX -c "${q}"`, { encoding: 'utf8' },
).trim();

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

// Build the fixture through the real API so this runs from a fresh seed: the
// bar raises a request for 60 litres of milk, the branch manager approves only
// 40 of them. The gap between the two is the whole point of the checks below.
const API = 'http://127.0.0.1:4000/api';
const branchId = psql("select id from branches where code='MARA-01'");
const milkId = psql("select id from inventory_items where name_ar='حليب' limit 1");

const call = async (path, { token, body, method = 'POST' } = {}) => {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
};

// Clear anything a previous run left behind, so the queue holds exactly the
// request this suite is about.
psql(`
  DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases);
  DELETE FROM supplier_prices WHERE purchase_id IN (SELECT id FROM purchases);
  DELETE FROM purchases;
  DELETE FROM purchase_request_items;
  DELETE FROM purchase_requests;
`.replace(/\s+/g, ' '));

const bar = await call('/auth/employee/login',
  { body: { branchId, employeeCode: '3001', pin: '7192' } });
const created = await call('/purchase-requests', {
  token: bar.tokens.accessToken,
  body: {
    branchId,
    department: 'BAR',
    priority: 'normal',
    reason: 'نفاد الحليب في البار',
    submit: true,
    items: [{ itemId: milkId, quantity: 60, unit: 'l', reason: 'استهلاك الأسبوع' }],
  },
});
const requestId = created.id ?? created.requestId ?? created.request?.id;

const manager = await call('/auth/login',
  { body: { email: 'manager@maralounge.sa', password: 'MaraManager#2026Xy' } });
await call(`/purchase-requests/${requestId}/decide`, {
  token: manager.tokens.accessToken,
  body: {
    decision: 'approve',
    comment: 'أربعون لترًا تكفي هذا الأسبوع',
    itemQuantities: [{ itemId: milkId, approvedQuantity: 40, unit: 'l' }],
  },
});

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
// A phone in a warehouse.
const context = await browser.newContext({
  viewport: { width: 412, height: 900 }, locale: 'ar', isMobile: true, hasTouch: true,
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

// Point the app at the API through the preview proxy.
await page.addInitScript(() => {
  localStorage.setItem('mara.buyer.base', '');
});

await page.goto(BASE, { waitUntil: 'networkidle' });
check('buyer app loads in RTL', await page.evaluate(() => document.documentElement.dir) === 'rtl');
check('shows MARA branding', (await page.locator('.login-card').innerText()).includes('MARA'));

// --- Sign in as the purchasing rep -----------------------------------------
await page.fill('input[placeholder="4001"]', '4001');
for (const d of ['3', '6', '4', '8']) {
  await page.locator('.keypad button', { hasText: new RegExp(`^${d}$`) }).first().click();
}
await page.waitForSelector('.topbar', { timeout: 20000 });
check('purchasing rep signs in with employee id + PIN', true);
check('online indicator shown',
  (await page.locator('.topbar').innerText()).includes('متصل'));

// --- Only approved work is visible ------------------------------------------
await page.waitForSelector('.request-card, .empty', { timeout: 20000 });
const cards = await page.locator('.request-card').count();
check('approved request appears in the buyer queue', cards >= 1, `${cards} cards`);

const pendingInDb = psql(
  "select count(*) from purchase_requests where status='pending_branch_manager'");
const visibleNumbers = await page.locator('.request-card .num').allInnerTexts();
const pendingNumbers = psql(
  "select coalesce(string_agg(request_number, ','), '') from purchase_requests where status='pending_branch_manager'");
const leaked = pendingNumbers
  ? pendingNumbers.split(',').filter((n) => visibleNumbers.includes(n.trim()))
  : [];
check('no unapproved request is visible to the rep', leaked.length === 0,
  `${pendingInDb} pending in db, ${leaked.length} leaked`);

// --- The approved quantity is what is shown ---------------------------------
await page.locator('.request-card .btn').first().click();
await page.waitForSelector('.modal', { timeout: 10000 });
const sheet = await page.locator('.modal-body').innerText();
check('sheet shows the APPROVED 40 litres, not the requested 60',
  sheet.includes('40') && !sheet.includes('60'), sheet.replace(/\s+/g, ' ').slice(0, 120));
check("manager's note is shown", sheet.includes('تكفي'));

await page.screenshot({ path: '/tmp/shot-buyer.png' });

// --- Purchase entry warns when exceeding the approval -----------------------
await page.locator('.modal-footer .btn', { hasText: 'تسجيل الشراء' }).click();
await page.waitForSelector('input[inputmode="decimal"]', { timeout: 10000 });
const qtyInput = page.locator('input[inputmode="decimal"]').first();
await qtyInput.fill('60');
await page.waitForTimeout(400);
check('over-approval quantity is flagged in the app',
  (await page.locator('.alert-box.error').count()) > 0);

// The server must refuse it regardless of the UI.
const before = Number(psql('select count(*) from purchases'));
await qtyInput.fill('60');
const priceInput = page.locator('input[inputmode="decimal"]').nth(1);
await priceInput.fill('6.20');
await page.locator('.btn.success', { hasText: 'حفظ الشراء' }).click();
await page.waitForTimeout(2500);
const after = Number(psql('select count(*) from purchases'));
check('server refuses a purchase beyond the approved quantity', after === before,
  `${before} -> ${after}`);

// --- Buying exactly the approved amount succeeds ----------------------------
await qtyInput.fill('40');
await page.locator('.btn.success', { hasText: 'حفظ الشراء' }).click();
await page.waitForTimeout(2500);
const afterOk = Number(psql('select count(*) from purchases'));
check('purchasing the approved quantity is recorded', afterOk === before + 1,
  `${before} -> ${afterOk}`);

// --- Offline: actions are queued, then replayed -----------------------------
await page.waitForTimeout(800);
await context.setOffline(true);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
const offlineText = await page.locator('body').innerText();
check('app still opens with no connection', offlineText.includes('MARA'));
check('offline banner is shown', offlineText.includes('بدون اتصال'));
check('cached approved work is still listed',
  (await page.locator('.request-card').count()) >= 1);

// Take an action while offline and confirm it is queued rather than lost.
await page.locator('.request-card .btn').first().click();
await page.waitForSelector('.modal', { timeout: 10000 });
const statusBtn = page.locator('.modal-footer .btn.primary');
if (await statusBtn.count()) {
  await statusBtn.click();
  await page.waitForTimeout(1200);
}
const queuedCount = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('mara-buyer', 1);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return new Promise((res) => {
    const tx = db.transaction('queue', 'readonly').objectStore('queue').getAll();
    tx.onsuccess = () => res(tx.result.length);
  });
});
check('an offline action is queued locally', queuedCount >= 1, `${queuedCount} queued`);

// Back online: the queue drains.
await context.setOffline(false);
await page.evaluate(() => window.dispatchEvent(new Event('online')));
await page.waitForTimeout(3000);
const drained = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('mara-buyer', 1);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return new Promise((res) => {
    const tx = db.transaction('queue', 'readonly').objectStore('queue').getAll();
    tx.onsuccess = () => res(tx.result.length);
  });
});
check('the queue drains once the connection returns', drained === 0, `${drained} left`);

check('no uncaught JS errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} buyer app checks passed`);
process.exit(failed.length ? 1 : 0);
