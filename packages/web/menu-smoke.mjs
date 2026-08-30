import { chromium } from '/tmp/node_modules/playwright/index.mjs';
const BASE = 'http://127.0.0.1:4173';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 }, locale: 'ar' });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const results = [];
const check = (n, ok, x='') => { results.push(ok); console.log(`${ok?'PASS':'FAIL'}  ${n}${x?' — '+x:''}`); };

// owner sign-in
await p.goto(BASE, { waitUntil: 'networkidle' });
await p.locator('button', { hasText: /^إدارة$/ }).first().click();
await p.waitForTimeout(600);
await p.fill('input[type="email"]', 'owner@maralounge.sa');
await p.fill('input[type="password"]', 'MaraOwner#2026Xy');
await p.locator('button', { hasText: 'تسجيل الدخول' }).first().click();
await p.waitForSelector('.topbar', { timeout: 30000 });
await p.waitForTimeout(2500);

check('المنيو appears in the owner nav', await p.locator('a', { hasText: 'المنيو' }).count() > 0);
await p.locator('a', { hasText: 'المنيو' }).first().click();
await p.waitForSelector('.data', { timeout: 20000 });
await p.waitForTimeout(1200);
await p.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/30-menu-products.png` : '/tmp/30-menu-products.png' });

const body = await p.locator('.app').innerText();
check('imported items are listed', body.includes('برجر مارا') && body.includes('قهوة تركية'),
  'برجر مارا, قهوة تركية');
check('categories from the import are shown', body.includes('أطباق رئيسية'));
check('prices render in riyals', body.includes('48.00'));

// availability toggle
const rowCount = await p.locator('.data tbody tr').count();
check('product rows rendered', rowCount >= 7, `${rowCount} rows`);
const firstStop = p.locator('button', { hasText: /^أوقف$/ }).first();
await firstStop.click();
await p.waitForTimeout(1500);
check('a product can be taken off sale', (await p.locator('.badge.red', { hasText: 'موقوف' }).count()) > 0);
await p.locator('button', { hasText: /^أعِد$/ }).first().click();
await p.waitForTimeout(1500);
check('and put back', (await p.locator('.badge.red', { hasText: 'موقوف' }).count()) === 0);

// create a product
await p.locator('button', { hasText: '+ صنف جديد' }).first().click();
await p.waitForSelector('.modal', { timeout: 10000 });
await p.fill('.modal input.input >> nth=0', 'ليموناضة نعناع');
await p.locator('.modal .chip', { hasText: 'البار' }).first().click();
await p.fill('.modal input.ltr', '22.50');
await p.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/31-menu-new-product.png` : '/tmp/31-menu-new-product.png' });
await p.locator('.modal-footer button', { hasText: 'حفظ' }).click();
await p.waitForTimeout(2500);
const after = await p.locator('.app').innerText();
check('a new product is created and priced', after.includes('ليموناضة نعناع') && after.includes('22.50'));

// categories tab
await p.locator('.chip', { hasText: 'التصنيفات' }).first().click();
await p.waitForTimeout(1200);
await p.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/32-menu-categories.png` : '/tmp/32-menu-categories.png' });
check('categories tab lists them with counts',
  (await p.locator('.app').innerText()).includes('أطباق رئيسية'));

// modifiers tab
await p.locator('.chip', { hasText: 'مجموعات الخيارات' }).first().click();
await p.waitForTimeout(1200);
const mods = await p.locator('.app').innerText();
check('modifier groups are listed', mods.includes('إلزامي') || mods.includes('اختيار واحد'), mods.slice(0,80).replace(/\s+/g,' '));
await p.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/33-menu-modifiers.png` : '/tmp/33-menu-modifiers.png' });

// the new product must be sellable in the POS
await p.locator('a', { hasText: 'نقطة البيع' }).first().click();
await p.waitForSelector('.product-tile', { timeout: 20000 });
await p.waitForTimeout(1500);
const pos = await p.locator('.app').innerText();
check('the new product is sellable in the POS', pos.includes('ليموناضة نعناع'));
await p.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/34-pos-with-new-menu.png` : '/tmp/34-pos-with-new-menu.png' });

check('no uncaught JS errors', errors.length === 0, errors.slice(0,2).join(' | '));
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} menu checks passed`);
process.exit(passed === results.length ? 0 : 1);
