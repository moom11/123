import { chromium } from '/tmp/node_modules/playwright/index.mjs';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
const results=[]; const check=(n,ok,x='')=>{results.push(ok);console.log(`${ok?'PASS':'FAIL'}  ${n}${x?' — '+x:''}`);};
const ctx = await b.newContext({ viewport:{width:412,height:900}, locale:'ar', isMobile:true, hasTouch:true });
const p = await ctx.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
await p.goto('http://127.0.0.1:8099/', { waitUntil:'networkidle' });

check('page is RTL', await p.evaluate(()=>document.documentElement.dir)==='rtl');
check('MARA branding', (await p.locator('.brand').innerText()).includes('MARA'));
check('all 115 items rendered', await p.locator('.item').count()===115, `${await p.locator('.item').count()}`);
check('all 16 categories', await p.locator('.section').count()===16, `${await p.locator('.section').count()}`);
const body = await p.locator('body').innerText();
check('real menu items present', body.includes('شيش طاووق') && body.includes('أرجيلة سبيشل مكس') && body.includes('لاتيه'));
check('prices shown', body.includes('49') && body.includes('75'));
check('unpriced item marked غير متوفر', body.includes('غير متوفر'));
if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/50-menu-site.png` });

// category filter
await p.locator('.chip', { hasText:'معسلات' }).first().click();
await p.waitForTimeout(600);
const visSections = await p.locator('.section:not([hidden])').count();
check('category filter narrows to one section', visSections===1, `${visSections} visible`);
check('shows the shisha items', (await p.locator('body').innerText()).includes('أرجيلة سبيشل نخله'));
if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/51-menu-site-shisha.png` });

// search
await p.locator('.chip', { hasText:'الكل' }).first().click();
await p.waitForTimeout(300);
await p.fill('#q','قهوة');
await p.waitForTimeout(600);
const found = await p.locator('.item:not([hidden])').count();
check('search finds matching items', found>0 && found<115, `${found} matches`);
check('search hides the rest', !(await p.locator('body').innerText()).includes('شيش طاووق'));
if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/52-menu-site-search.png` });

// no results
await p.fill('#q','xyzzy');
await p.waitForTimeout(500);
check('empty state shown for no matches', await p.locator('#empty.on').count()===1);

check('no JS errors', errs.length===0, errs.slice(0,2).join(' | '));
await b.close();
const passed=results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} static menu checks passed`);
process.exit(passed===results.length?0:1);
