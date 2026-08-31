import { chromium } from '/tmp/node_modules/playwright/index.mjs';
const APP='http://127.0.0.1:8088';   // "ProFreeHost"
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});
const p=await (await b.newContext({viewport:{width:1180,height:900},locale:'ar'})).newPage();
const errs=[],blocked=[];
p.on('pageerror',e=>errs.push(String(e)));
p.on('console',m=>{ if(m.type()==='error') errs.push(m.text()); });
p.on('requestfailed',r=>blocked.push(`${r.url()} :: ${r.failure()?.errorText}`));
const r=[]; const ck=(n,ok,x='')=>{r.push(ok);console.log(`${ok?'PASS':'FAIL'}  ${n}${x?' — '+x:''}`);};

await p.goto(APP,{waitUntil:'networkidle'});
await p.waitForTimeout(2500);
ck('app loads from the static host', (await p.locator('.login-card').count())>0);
const branchOk = await p.locator('select.select option').count();
ck('it reached the API across origins', branchOk>0, `${branchOk} branch option(s)`);

await p.fill('input[placeholder="1042"]','2001');
for (const d of ['4','8','2','6']) await p.locator('.keypad button',{hasText:new RegExp(`^${d}$`)}).first().click();
await p.waitForSelector('.topbar',{timeout:25000});
ck('cashier signs in cross-origin', true);
await p.waitForTimeout(2000);
ck('floor board loads its tables', (await p.locator('.table-tile').count())>0, `${await p.locator('.table-tile').count()} tables`);
await p.locator('a',{hasText:'نقطة البيع'}).first().click();
await p.waitForSelector('.product-tile',{timeout:20000});
ck('POS loads the menu', (await p.locator('.product-tile').count())>100, `${await p.locator('.product-tile').count()} products`);
if (process.env.SHOT_DIR) await p.screenshot({path:`${process.env.SHOT_DIR}/60-crossorigin.png`});

const cors = blocked.filter(x=>/4000/.test(x));
ck('no request was blocked by CORS', cors.length===0, cors.slice(0,2).join(' | '));
ck('no JS errors', errs.length===0, errs.slice(0,2).join(' | '));
await b.close();
const pass=r.filter(Boolean).length;
console.log(`\n${pass}/${r.length} cross-origin checks passed`);
process.exit(pass===r.length?0:1);
