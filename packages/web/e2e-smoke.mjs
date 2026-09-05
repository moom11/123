import { chromium } from '/tmp/node_modules/playwright/index.mjs';
import { execSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:4173';
const psql = (q) => execSync(
  `psql -h 127.0.0.1 -U postgres -d ${process.env.MARA_DB ?? 'mara'} -qtAX -c "${q}"`, { encoding: 'utf8' },
).trim();

const branchId = psql("select id from branches where code='MARA-01'");
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
// iPad-sized viewport: the POS's primary target.
const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, locale: 'ar' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// --- 1. Login screen renders in RTL Arabic --------------------------------
await page.goto(BASE, { waitUntil: 'networkidle' });
const dir = await page.evaluate(() => document.documentElement.dir);
check('login screen renders RTL', dir === 'rtl', `dir=${dir}`);
check('MARA branding visible', await page.locator('.login-logo .mark').isVisible());
check('staff / admin tabs present', (await page.locator('.tabs button').count()) === 2);
check('branch loaded from API', (await page.locator('.select option').count()) > 0);

// --- 2. Staff PIN login ----------------------------------------------------
await page.fill('input[placeholder="1042"]', '2001');
for (const d of ['4', '8', '2', '6']) {
  await page.locator('.keypad button', { hasText: new RegExp(`^${d}$`) }).first().click();
}
await page.waitForSelector('.topbar', { timeout: 15000 });
check('cashier signed in with employee id + PIN', true);
const who = await page.locator('.topbar').innerText();
check('cashier name shown in top bar', who.includes('نورة'), who.replace(/\s+/g, ' ').slice(0, 60));

// --- 3. Floor board --------------------------------------------------------
await page.waitForSelector('.table-tile', { timeout: 15000 });
const tiles = await page.locator('.table-tile').count();
check('floor board shows tables', tiles >= 20, `${tiles} tiles`);

// --- 4. Navigation reflects permissions ------------------------------------
const navLabels = await page.locator('.nav-item').allInnerTexts();
const nav = navLabels.map((s) => s.trim());
check('cashier sees POS', nav.some((n) => n.includes('نقطة البيع')));
check('cashier sees customers', nav.some((n) => n.includes('العملاء')));
check('cashier does NOT see audit log', !nav.some((n) => n.includes('سجل العمليات')),
  nav.join(' | '));
check('cashier does NOT see users admin', !nav.some((n) => n.includes('المستخدمون')));

// --- 5. POS: add a product and see the cart total --------------------------
await page.locator('.nav-item', { hasText: 'نقطة البيع' }).click();
await page.waitForSelector('.product-tile', { timeout: 15000 });
const productCount = await page.locator('.product-tile').count();
check('POS lists products', productCount >= 4, `${productCount} products`);

await page.locator('.product-tile', { hasText: 'فلات وايت' }).first().click();
await page.waitForSelector('.cart-line', { timeout: 10000 });
const cartText = await page.locator('.cart-lines').innerText();
check('tapping a product adds it to the cart', cartText.includes('فلات وايت'));
const grand = await page.locator('.total-row.grand .amount').innerText();
// Read the price from the database rather than hardcoding it: the point of
// this check is that the cart shows the menu price, whatever it currently is.
const menuPrice = (Number(psql(
  "select price from products where name_ar='فلات وايت' and deleted_at is null limit 1",
)) / 100).toFixed(2);
check('cart total is the menu price', grand.includes(menuPrice), `${grand} vs ${menuPrice}`);

// --- 6. A product with required options opens the option sheet -------------
// Ask the database which product carries a required option group rather than
// naming one: the menu is the restaurant's to change, and importing a real one
// replaces whatever the seed happened to create.
// The price to expect is the base plus the FIRST option of EVERY required
// group, because that is what the loop below ticks.
const optionProduct = psql(`
  with first_option as (
    select distinct on (pm.product_id, m.id)
           pm.product_id, m.id AS modifier_id, m.name_ar AS group_name, o.price_delta
      from product_modifiers pm
      join modifiers m on m.id = pm.modifier_id and m.is_required and m.is_active
      join modifier_options o on o.modifier_id = m.id and o.is_active
     order by pm.product_id, m.id, m.sort_order, o.sort_order
  )
  select p.name_ar || '|' || min(f.group_name) || '|'
         || (p.price + sum(f.price_delta))
    from products p join first_option f on f.product_id = p.id
   where p.is_active and p.is_available and p.deleted_at is null
   group by p.id, p.name_ar, p.price
   order by p.name_ar limit 1`);

if (!optionProduct) {
  // Not a failure: a menu with no option groups attached is a valid menu. The
  // seeded demo menu has them, a freshly imported real one may not until
  // someone attaches them in the menu screen.
  console.log('SKIP  option sheet — no product in this menu carries a required '
              + 'option group');
} else {
  const [productName, groupName, withOptions] = optionProduct.split('|');
  const expected = (Number(withOptions) / 100).toFixed(2);

  await page.locator('.product-tile', { hasText: productName }).first().click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  // The sheet renders immediately with a spinner and loads its option groups
  // asynchronously, so wait for the groups themselves before reading the text.
  await page.waitForSelector('.modal .chip', { timeout: 10000 });
  const modalText = await page.locator('.modal').innerText();
  check(`required options sheet opens for ${productName}`, modalText.includes(groupName));
  check('add button is blocked until required options chosen',
    await page.locator('.modal-footer .btn').first().isDisabled());

  // Choose the first option of every required group, which is what the button
  // is waiting for.
  for (const group of await page.locator('.modal .field').all()) {
    if (!(await group.innerText()).includes('إلزامي')) continue;
    await group.locator('.chip').first().click();
  }
  const addLabel = await page.locator('.modal-footer .btn').first().innerText();
  check('option price reflected before adding', addLabel.includes(expected),
    `${addLabel} vs ${expected}`);
  await page.locator('.modal-footer .btn').first().click();
  await page.waitForTimeout(400);
  check(`${productName} added with its options`,
    (await page.locator('.cart-lines').innerText()).includes(productName));
}

await page.screenshot({ path: '/tmp/shot-pos.png', fullPage: false });

// --- 7. Send the order; it should print to departments ---------------------
const ordersBefore = Number(psql('select count(*) from orders'));
await page.locator('.cart-footer .btn.primary').click();
await page.waitForTimeout(2500);
const ordersAfter = Number(psql('select count(*) from orders'));
check('sending the cart creates exactly one order', ordersAfter === ordersBefore + 1,
  `${ordersBefore} -> ${ordersAfter}`);
const jobs = Number(psql(
  "select count(*) from print_jobs where order_id = (select id from orders order by created_at desc limit 1)",
));
check('order queued print jobs for its departments', jobs >= 1, `${jobs} jobs`);

// --- 8. Guest QR menu ------------------------------------------------------
const qrToken = psql("select qr_token from restaurant_tables where table_number='12'");
const sig = execSync(
  `cd /home/user/123/packages/server && node -e "
    const {createHmac}=require('node:crypto');
    console.log(createHmac('sha256','dev-cookie-secret-at-least-32-characters-long!!')
      .update('table:'+process.argv[1]).digest('base64url').slice(0,16));
  " ${qrToken}`, { encoding: 'utf8' },
).trim();

const guest = await context.newPage();
await guest.goto(`${BASE}/menu/${qrToken}.${sig}`, { waitUntil: 'networkidle' });
await guest.waitForSelector('.menu-hero', { timeout: 15000 });
const heroText = await guest.locator('.menu-hero').innerText();
check('guest menu resolves the table from the QR alone', heroText.includes('12'), heroText.replace(/\s+/g, ' '));
check('guest sees the service buttons',
  (await guest.locator('.service-buttons .btn').count()) === 3);
check('guest sees menu items', (await guest.locator('.menu-item').count()) >= 4);
await guest.screenshot({ path: '/tmp/shot-guest.png', fullPage: false });

// --- 9. Tampered QR is rejected -------------------------------------------
const bad = await context.newPage();
await bad.goto(`${BASE}/menu/${qrToken}.0000000000000000`, { waitUntil: 'networkidle' });
await bad.waitForTimeout(1200);
check('tampered QR is refused', (await bad.locator('.alert-box').count()) > 0);

// --- 10. Guest charcoal request prints to the shisha printer --------------
// A charcoal request is intentionally debounced for 3 minutes per table, so
// clear any open one first to make this assertion deterministic across runs.
psql("update service_requests set status='resolved', resolved_at=now() where kind='charcoal' and status='open'");
const charcoalBefore = Number(psql(
  "select count(*) from print_jobs where kind='charcoal_request'"));
await guest.locator('.service-buttons .btn', { hasText: 'طلب فحم' }).click();
await guest.waitForTimeout(1500);
const charcoalAfter = Number(psql(
  "select count(*) from print_jobs where kind='charcoal_request'"));
check('charcoal request produces a shisha ticket', charcoalAfter === charcoalBefore + 1,
  `${charcoalBefore} -> ${charcoalAfter}`);

check('no uncaught JS errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed`);
process.exit(failed.length ? 1 : 0);
