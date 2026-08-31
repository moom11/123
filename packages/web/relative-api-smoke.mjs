/**
 * Proves the uploaded build talks to /api on its own host and nowhere else.
 *
 * Serve upload/ with /api proxied to the API (as shared hosting does), then
 * drive the six screens that matter and assert every request the page made was
 * same-origin. A single absolute URL anywhere would show up here as a
 * cross-origin request.
 */
import { chromium } from '/tmp/node_modules/playwright/index.mjs';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:8090';
const origin = new URL(APP).origin;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const page = await (await browser.newContext({
  viewport: { width: 1280, height: 900 }, locale: 'ar',
})).newPage();

const results = [];
const check = (n, ok, x = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? ' — ' + x : ''}`);
};

const errors = [];
const foreign = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('request', (r) => {
  const u = r.url();
  if (u.startsWith('data:') || u.startsWith('blob:')) return;
  if (!u.startsWith(origin)) foreign.push(`${r.method()} ${u}`);
});

await page.goto(APP, { waitUntil: 'networkidle' });
check('app loads', (await page.locator('.login-card').count()) > 0);
check('branches came from /api', (await page.locator('select.select option').count()) > 0);

// --- login ---
await page.fill('input[placeholder="1042"]', '2001');
for (const d of ['4', '8', '2', '6']) {
  await page.locator('.keypad button', { hasText: new RegExp(`^${d}$`) }).first().click();
}
await page.waitForSelector('.topbar', { timeout: 25000 });
check('login', true);

const visit = async (label, link, selector, name) => {
  await page.locator('a', { hasText: link }).first().click();
  try {
    await page.waitForSelector(selector, { timeout: 20000 });
    const n = await page.locator(selector).count();
    check(name, n > 0, `${n}`);
  } catch {
    check(name, false, 'nothing rendered');
  }
  await page.waitForTimeout(400);
};

await visit('tables', 'الطاولات', '.table-tile', 'tables');
await visit('pos', 'نقطة البيع', '.product-tile', 'orders / POS menu');
await visit('customers', 'العملاء', '.data, .empty', 'customers');

// The owner sees inventory and reports; the cashier does not.
await page.locator('.btn.ghost.sm', { hasText: 'خروج' }).first().click();
await page.waitForSelector('.login-card', { timeout: 20000 });
await page.locator('button', { hasText: /^إدارة$/ }).first().click();
await page.waitForTimeout(500);
await page.fill('input[type="email"]', 'owner@maralounge.sa');
await page.fill('input[type="password"]', 'MaraOwner#2026Xy');
await page.locator('button', { hasText: 'تسجيل الدخول' }).first().click();
await page.waitForSelector('.topbar', { timeout: 30000 });
await page.waitForTimeout(2500);
check('owner login', true);

await visit('inventory', 'المخزون', '.data', 'inventory');
await visit('reports', 'التقارير', '.chip, .data, .stat', 'reports');

check('every request was same-origin', foreign.length === 0,
  foreign.slice(0, 3).join(' | ') || `${origin}`);
check('no JS errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} relative-API checks passed`);
process.exit(passed === results.length ? 0 : 1);
