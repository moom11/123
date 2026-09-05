# تعريف الاتصال بالخادم

كيف يتصل كل جزء من MARA بالـ API — العنوان، الترويسات، الجلسة، والمسارات.
هذا الملف مُستخرَج من الكود نفسه، لا من الذاكرة.

---

## 1. العنوان الأساسي (Base URL)

التطبيق **نسبي افتراضياً**: ينادي `/api` على نفس النطاق الذي فُتح منه.

| ما فُتح منه المتصفح | إلى أين يذهب الطلب |
|---|---|
| `https://mara.unaux.com/pos` | `https://mara.unaux.com/api/...` |
| `http://localhost:5173/pos` | `http://localhost:5173/api/...` (عبر بروكسي التطوير) |

مكان البناء الوحيد — `packages/web/src/lib/api.ts`:

```ts
const BUILT_IN_BASE = (import.meta.env?.VITE_API_BASE ?? '').replace(/\/$/, '');

export function apiBase(): string {
  return localStorage.getItem('mara.api') ?? BUILT_IN_BASE;   // '' = نفس النطاق
}

fetch(`${apiBase()}/api${path}`, { ... })
```

ثلاث طبقات، الأعلى يفوز:

1. **قيمة محفوظة على الجهاز** — `localStorage['mara.api']`. تُوجِّه جهازاً واحداً إلى خادم آخر دون إعادة بناء.
2. **قيمة مبنية** — `VITE_API_BASE` وقت البناء. تُستخدم فقط حين يكون الـ API على نطاق مختلف.
3. **فارغ = نسبي.** هذا هو الوضع الافتراضي، وهو ما يُنتجه `npm run build:upload`.

`scripts/build-upload.mjs` يمشي على كل ملف قبل إخراج `upload/` ويرفض البناء إن وجد أي عنوان ثابت
(`http://`، `localhost`، منفذ صريح، أو `ws://`). البناء الحالي: **صفر عناوين ثابتة**.

## 2. الترويسات المُرسَلة مع كل طلب

من `api.ts` سطر 100–114 — لا شيء غيرها:

| الترويسة | متى تُرسل | لماذا |
|---|---|---|
| `Content-Type: application/json` | حين يوجد جسم للطلب فقط | |
| `Authorization: Bearer <accessToken>` | حين توجد جلسة | التحقق من الهوية |
| `X-Idempotency-Key: <uuid>` | مع العمليات المالية | ضغطتان على «ادفع» لا تُنتجان دفعتين |
| `X-Branch-Id: <uuid>` | حين يكون فرع محفوظاً | مدير متعدد الفروع لا فرع أساسي له؛ بدونها ترجع كل الشاشات فارغة |
| `X-Device-Token` | من كل طرفية مسجَّلة | يقول أي جهاز يطلب — والكاشير وحده يُقفل الفواتير |
| `X-Device-Label` | من الأجهزة الموسومة | يُسجَّل في سجل التدقيق |

هذه الستة مسموحة صراحةً في CORS على الخادم (`app.ts` و`worker.ts`). حذف `X-Branch-Id`
من تلك القائمة كان عطلاً حقيقياً: التطبيق يفتح، الفروع تُقرأ، ولا أحد يستطيع الدخول.

## 3. الجلسة

```
POST /api/auth/login          البريد + كلمة المرور  →  mfaToken
POST /api/auth/mfa/verify     mfaToken + رمز TOTP    →  { accessToken, refreshToken }
POST /api/auth/employee/login الفرع + الرمز الوظيفي + PIN → tokens (موظفون فقط)
```

الحسابات الإدارية **لا تدخل بـ PIN إطلاقاً** — بريد + كلمة مرور + تحقق ثنائي.

- **رمز الوصول** في الذاكرة فقط، صلاحيته 15 دقيقة (`ACCESS_TTL_SECONDS`).
- **رمز التجديد** في `localStorage['mara.refresh']` — 12 ساعة للإداري، 14 للموظف، 30 يوماً للعميل.
- على أي `401`: طلب واحد إلى `POST /api/auth/refresh`، ثم **إعادة المحاولة مرة واحدة**.
  الطلبات المتزامنة تتشارك عملية تجديد واحدة، وإلا استهلك كل منها دورة تدوير وأطلق كاشف الإعادة.
- التجديد يُدوِّر الرمز؛ استعمال رمز قديم يُبطل العائلة كلها.

شكل الخطأ موحَّد: `{ "error": { "code": "...", "message": "رسالة بالعربية", "details": ... } }`

## 4. التحديث المباشر (WebSocket)

```ts
const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
`${protocol}://${location.host}/ws?access_token=<token>`
```

نفس النطاق، ونفس بروتوكول الصفحة. الرمز في الـ query لأن ترقية WebSocket لا تحمل ترويسة
`Authorization`؛ والخادم يقرأه في خطاف `onRequest` أثناء الترقية. المقبس يرث صلاحيات صاحبه بالضبط.

إعادة الاتصال تتضاعف حتى 15 ثانية كحد أقصى — شبكة المحل المتقطعة تتعافى وحدها.

> **شارة «غير متصل» الحمراء** تعني أن هذا المقبس تحديداً لم يفتح. السبب الأشيع: صفحة على `https://`
> تحاول فتح `ws://` — المتصفح يمنعها بصمت. البناء النسبي يحل هذا لأنه يشتق `wss://` من الصفحة.
> السبب الثاني: الاستضافة لا تمرر WebSocket أصلاً (ProFreeHost لا تمررها). بقية التطبيق يعمل؛ التحديث يصير يدوياً.

## 5. سطح المسارات — 170 مساراً

كلها تحت `/api`، عدا `/health`. المسارات المطلوب فحصها:

**الدخول** — `GET /auth/branches` · `POST /auth/login` · `POST /auth/mfa/verify` ·
`POST /auth/employee/login` · `POST /auth/refresh` · `POST /auth/logout` · `GET /auth/me` ·
`POST /auth/password` · `GET /auth/sessions` · `POST /auth/mfa/setup` · `POST /auth/mfa/confirm`

**الطلبات** — `POST /orders` · `GET /orders` · `GET /orders/:id` · `GET /orders/pending-approval` ·
`POST /orders/:id/review` · `POST /orders/:id/items` · `POST /orders/:id/items/:itemId/void` ·
`POST /orders/:id/discount/request-otp` · `POST /orders/:id/discount/apply` ·
`POST /orders/:id/points/request-otp` · `POST /orders/:id/points/redeem` ·
`POST /orders/:id/pay` · `GET /orders/:id/split/even` · `POST /orders/:id/split/items` ·
`POST /payments/:id/void`

**الطاولات** — `GET /tables` · `POST /tables` · `GET /tables/:id/qr` · `POST /tables/:id/rotate-qr` ·
`POST /tables/:id/waiter` · `POST /tables/move` · `POST /tables/merge` · `GET /service-requests` ·
`POST /service-requests/:id/resolve`

**العملاء** — `GET /customers/search` · `GET /customers/:id` · `POST /customers` ·
`PATCH /customers/:id` · `GET /customers/:id/wallet` · `POST /customers/:id/wallet/adjust` ·
`GET /customers/:id/otp-history` · `POST /customers/:id/special-prices` ·
`DELETE /customers/special-prices/:id` · `GET /loyalty/rules` · `POST /loyalty/rules`

**المخزون** — `GET /inventory/stock` · `GET /inventory/low-stock` · `GET /inventory/items` ·
`GET /inventory/locations` · `GET /inventory/transactions` · `POST /inventory/receive` ·
`POST /inventory/adjust` · `POST /waste` · `GET /waste` · `POST /waste/:id/approve` ·
`POST /stock-counts` · `GET /stock-counts` · `GET /stock-counts/:id` ·
`POST /stock-counts/:id/entries` · `POST /stock-counts/:id/submit` · `POST /stock-counts/:id/approve`

**التقارير** — `GET /dashboard/branch` · `GET /dashboard/owner` · `GET /reports/sales` ·
`GET /reports/products` · `GET /reports/employees` · `GET /reports/customers` ·
`GET /reports/inventory` · `GET /reports/purchasing`

**عام بلا جلسة** — `/api/public/*` فقط: `GET /menu/:qrValue` · `GET /products/:id/options` ·
`POST /auth/request-otp` · `POST /auth/verify-otp` · `GET /me/wallet` · `GET /me/orders` ·
`POST /orders` · `POST /service-request`. كل معالج فيها مكتوب على أن مُناديه مجهول.

**الأجهزة والفوترة** — `GET /devices` · `POST /devices` · `GET /devices/me` ·
`POST /devices/:id/rotate-token` · `POST /devices/:id/retire` ·
`POST /devices/:id/zatca/csr` · `POST /devices/:id/zatca/onboard` ·
`GET /invoices` · `GET /invoices/:id` · `GET /invoices/chain/verify` ·
`POST /invoices/report` · `POST /invoices/:id/credit-note`

**التوصيل** — `GET /delivery/orders` · `POST /delivery/orders/:id/accept` ·
`POST /delivery/orders/:id/reject` · `POST /delivery/orders/:id/ready` ·
`GET /delivery/failed` · `POST /delivery/failed/:id/replay` ·
`GET /delivery/partners` · `POST /delivery/partners` ·
`POST /delivery/partners/:id/menu-map`

**استقبال المنصات — بلا جلسة** — `POST /api/delivery/webhook/:partner/:branchCode?`
هو السطح العام الثاني بعد `/api/public`. لا يحمل جلسة لأن منصة توصيل لا تملك واحدة؛
ما يصادقه توقيع HMAC-SHA256 على البايتات الخام.

**العروض** — `GET /promotions` · `POST /promotions` · `PUT /promotions/:id` ·
`POST /promotions/:id/retire` · `GET /reports/promotions` · `GET /orders/:id/promotions`

**الفحص** — `GET /health` يرجع حالة قاعدة البيانات وزمنها وعدد المتصلين. لا يحتاج جلسة.

### الجهاز مقابل الجلسة

الجلسة تقول **مَن**؛ رمز الجهاز يقول **أين**. وهما مستقلان عمداً: الرمز يُدخل مرة عند
تركيب الجهاز ويبقى عبر كل وردية وكل تسجيل دخول، والجلسة تتغير مع كل موظف.

ولهذا يُقرأ رمز الجهاز **قبل** التحقق من الجلسة — الطرفية تسأل `GET /api/devices/me`
عمّا هي عند الإقلاع، قبل أن يسجّل أحد دخوله.

## 6. من يتصل غير المتصفح

| العميل | العنوان | التحقق |
|---|---|---|
| واجهة الـ POS | نسبي `/api` | `Bearer` + تجديد |
| تطبيق المشتري (Android) | `VITE_API_BASE` مبني — نطاق حقيقي، لا بروكسي | `Bearer` + طابور غير متصل |
| وكيل الطباعة المحلي | `MARA_API_URL` + `MARA_AGENT_TOKEN` | `Bearer` بالرمز الخاص بالوكيل |

وكيل الطباعة يسحب ولا يُدفَع إليه: `POST /api/print-agent/claim` كل دورة، ثم
`POST /api/print-agent/result`، و`POST /api/print-agent/heartbeat`. يخرج من الشبكة إلى السحابة،
فلا يحتاج الخادم أن يصل إلى شبكة المحل، ولا الطابعات أن تُعرَّض للإنترنت.
الطباعة إلى الطابعة نفسها عبر TCP منفذ 9100 داخل الشبكة المحلية.

## 7. ما لا يفعله التطبيق

- **لا يتصل بقاعدة البيانات مباشرة.** الواجهة → API → قاعدة البيانات. لا استثناء.
- **لا يقرر الصلاحيات.** الخادم يقرر؛ و`403` هنا خطأ في إخفاء زر، لا ثغرة.
- **لا يحمل أسراراً.** لا مفتاح ولا كلمة مرور في كود الواجهة.
