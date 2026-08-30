/**
 * Go-live check.
 *
 * The seed exists so the system is usable five minutes after cloning it. That
 * convenience is a liability the moment a real customer pays with it: the
 * owner's password and every staff PIN it creates are printed in this
 * repository, which is public. Opening with any of them still in place is not
 * a weak password, it is a published one.
 *
 * So this does not lecture about password strength — it verifies the actual
 * stored hashes against the actual published values, and refuses to pass while
 * any of them still match.
 *
 *   npm --workspace @mara/server run preflight
 *
 * Exits non-zero if anything would be unsafe to open with, so it can gate a
 * deploy. Warnings do not fail the run; they are things to decide about.
 */
import { closePool, many, one } from './core/db.js';
import { verifySecret } from './core/crypto.js';

/** Exactly what src/seed.ts writes, and what the README prints. */
const PUBLISHED_PASSWORDS = ['MaraOwner#2026Xy', 'MaraManager#2026Xy'];
const PUBLISHED_PINS = ['2580', '4826', '7192', '6473', '9265', '3648', '1357', '2468'];
/** The seed's addresses, and loopback — a printer is never on the API host. */
const PLACEHOLDER_PRINTER = /^(192\.168\.10\.|127\.|::1$|0\.0\.0\.0$)/;
const DEMO_CUSTOMER_PHONE = '+966551234567';

/** The values in .env.example, which must never reach production. */
const DEV_SECRET_MARKERS = ['dev-access-secret', 'dev-refresh-secret', 'dev-cookie-secret',
  'dev-mfa-key', 'change-me', 'changeme', 'test-'];

const problems: string[] = [];
const warnings: string[] = [];
const passed: string[] = [];

const fail = (m: string) => problems.push(m);
const warn = (m: string) => warnings.push(m);
const ok = (m: string) => passed.push(m);

async function checkAdminPasswords(): Promise<void> {
  const users = await many<{ id: string; email: string; password_hash: string | null }>(
    `SELECT u.id, u.email, u.password_hash FROM users u
      WHERE u.email IS NOT NULL AND u.is_active AND u.deleted_at IS NULL`,
  );
  if (users.length === 0) { fail('لا يوجد أي حساب إداري.'); return; }

  const exposed: string[] = [];
  for (const user of users) {
    if (!user.password_hash) continue;
    for (const published of PUBLISHED_PASSWORDS) {
      if (await verifySecret(user.password_hash, published)) {
        exposed.push(user.email);
        break;
      }
    }
  }

  if (exposed.length > 0) {
    fail(`${exposed.length} حساب إداري ما زال على كلمة المرور المنشورة في المستودع: `
       + `${exposed.join('، ')} — غيّرها قبل الافتتاح.`);
  } else {
    ok(`${users.length} حساب إداري، ولا واحد منها على كلمة مرور منشورة`);
  }
}

async function checkStaffPins(): Promise<void> {
  const employees = await many<{ employee_code: string; full_name: string; pin_hash: string | null }>(
    `SELECT employee_code, full_name, pin_hash FROM employees
      WHERE is_active AND deleted_at IS NULL`,
  );
  if (employees.length === 0) { warn('لا يوجد موظفون بعد.'); return; }

  const exposed: string[] = [];
  for (const employee of employees) {
    if (!employee.pin_hash) continue;
    for (const published of PUBLISHED_PINS) {
      if (await verifySecret(employee.pin_hash, published)) {
        exposed.push(`${employee.full_name} (${employee.employee_code})`);
        break;
      }
    }
  }

  if (exposed.length > 0) {
    fail(`${exposed.length} موظف ما زال على الرمز السري المنشور: ${exposed.join('، ')} — `
       + 'عيّن رموزاً جديدة من شاشة المستخدمين.');
  } else {
    ok(`${employees.length} موظف، ولا واحد منهم على رمز سري منشور`);
  }
}

function checkSecrets(): void {
  const named: Array<[string, string | undefined]> = [
    ['JWT_ACCESS_SECRET', process.env.JWT_ACCESS_SECRET],
    ['JWT_REFRESH_SECRET', process.env.JWT_REFRESH_SECRET],
    ['COOKIE_SECRET', process.env.COOKIE_SECRET],
    ['MFA_SECRET_KEY', process.env.MFA_SECRET_KEY],
  ];

  const weak: string[] = [];
  const missing: string[] = [];
  for (const [name, value] of named) {
    if (!value) { missing.push(name); continue; }
    if (value.length < 32) { weak.push(`${name} (أقصر من 32 حرفاً)`); continue; }
    if (DEV_SECRET_MARKERS.some((marker) => value.toLowerCase().includes(marker))) {
      weak.push(`${name} (قيمة التطوير)`);
    }
  }

  if (missing.length > 0) {
    warn(`لم أستطع فحص ${missing.join('، ')} — غير موجودة في بيئة هذا الأمر. `
       + 'شغّله بنفس المتغيرات التي سيعمل بها الخادم.');
  }
  if (weak.length > 0) {
    fail(`أسرار غير صالحة للإنتاج: ${weak.join('، ')}.`);
  } else if (missing.length === 0) {
    ok('الأسرار الأربعة مضبوطة وليست قيم تطوير');
  }

  if (process.env.JWT_ACCESS_SECRET
      && process.env.JWT_ACCESS_SECRET === process.env.JWT_REFRESH_SECRET) {
    fail('JWT_ACCESS_SECRET و JWT_REFRESH_SECRET متطابقان — رمز وصول منتهٍ يصير رمز تجديد.');
  }
}

function checkFlags(): void {
  if (process.env.REQUIRE_ADMIN_MFA === 'false') {
    fail('REQUIRE_ADMIN_MFA=false — التحقق الثنائي إلزامي للحسابات الإدارية.');
  } else {
    ok('التحقق الثنائي مطلوب للحسابات الإدارية');
  }

  if (process.env.AUTO_MIGRATE === 'true') {
    warn('AUTO_MIGRATE=true — بداية باردة قد تسابق تغييراً في المخطط. طبّق الهجرات يدوياً.');
  }

  if (process.env.WHATSAPP_PROVIDER !== 'meta_cloud') {
    fail(`WHATSAPP_PROVIDER=${process.env.WHATSAPP_PROVIDER ?? '(غير مضبوط)'} — `
       + 'رموز التحقق ستُكتب في السجل بدل واتساب، فلن يستلمها العميل.');
  } else if (!process.env.WHATSAPP_ACCESS_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    fail('WHATSAPP_PROVIDER=meta_cloud لكن بيانات واتساب ناقصة — الخصم والنقاط يحتاجان OTP.');
  } else {
    ok('واتساب مضبوط لإرسال رموز التحقق');
  }
}

async function checkMfaEnrolment(): Promise<void> {
  const rows = await many<{ email: string }>(
    `SELECT u.email FROM users u
      WHERE u.email IS NOT NULL AND u.is_active AND u.deleted_at IS NULL
        AND NOT u.mfa_enabled`,
  );
  if (rows.length > 0) {
    warn(`${rows.length} حساب إداري لم يُفعّل التحقق الثنائي بعد `
       + `(${rows.map((r) => r.email).join('، ')}). سيُطلب منه التسجيل عند أول دخول.`);
  } else {
    ok('كل الحسابات الإدارية فعّلت التحقق الثنائي');
  }
}

async function checkBranchData(): Promise<void> {
  const printers = await many<{ name: string; ip: string }>(
    `SELECT name, host(ip_address) AS ip FROM printers
      WHERE is_enabled AND deleted_at IS NULL`,
  );
  const placeholders = printers.filter((p) => PLACEHOLDER_PRINTER.test(p.ip));
  if (printers.length === 0) {
    fail('لا توجد طابعات مفعّلة — لن تصل أي تذكرة للمطبخ أو البار أو المعسل.');
  } else if (placeholders.length > 0) {
    fail(`${placeholders.length} طابعة على عنوان تجربة أو محلي: `
       + `${placeholders.map((p) => `${p.name} (${p.ip})`).join('، ')} — `
       + 'ضع عناوين الطابعات الحقيقية في الشبكة.');
  } else {
    ok(`${printers.length} طابعة على عناوين حقيقية`);
  }

  const demo = await one<{ id: string }>(
    'SELECT id FROM customers WHERE phone = $1 AND deleted_at IS NULL',
    [DEMO_CUSTOMER_PHONE],
  );
  if (demo) {
    warn(`عميل التجربة ${DEMO_CUSTOMER_PHONE} ما زال موجوداً بنقاطه وسعره الخاص.`);
  }

  const products = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM products
      WHERE is_active AND is_available AND deleted_at IS NULL`,
  );
  if (Number(products!.n) === 0) {
    fail('لا يوجد صنف واحد متاح للبيع.');
  } else {
    ok(`${products!.n} صنف متاح للبيع`);
  }

  const tables = await one<{ n: string }>(
    'SELECT count(*)::text AS n FROM restaurant_tables WHERE is_active',
  );
  ok(`${tables!.n} طاولة`);

  const agents = await one<{ n: string }>(
    'SELECT count(*)::text AS n FROM print_agents WHERE is_enabled',
  );
  if (Number(agents!.n) === 0) {
    fail('لا يوجد وكيل طباعة — لن تُسحب أوامر الطباعة من الطابور.');
  }
}

async function main(): Promise<void> {
  console.log('\nفحص ما قبل الافتتاح\n');

  await checkAdminPasswords();
  await checkStaffPins();
  checkSecrets();
  checkFlags();
  await checkMfaEnrolment();
  await checkBranchData();

  for (const p of passed) console.log(`  ✅  ${p}`);
  if (warnings.length > 0) {
    console.log('');
    for (const w of warnings) console.log(`  ⚠️   ${w}`);
  }
  if (problems.length > 0) {
    console.log('');
    for (const p of problems) console.log(`  ⛔  ${p}`);
    console.log(`\n${problems.length} مانع للافتتاح. عالجها ثم أعد الفحص.\n`);
    process.exitCode = 1;
    return;
  }

  console.log(
    warnings.length > 0
      ? `\nلا مانع للافتتاح، مع ${warnings.length} ملاحظة أعلاه.\n`
      : '\nجاهز للافتتاح.\n',
  );
}

main()
  .catch((err) => {
    console.error(`\nتعذّر الفحص: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => { void closePool(); });
