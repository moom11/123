/* عامل الخدمة: يجعل النظام قابلاً للتثبيت كتطبيق ويسرّع فتحه.
   ملفات الواجهة تُجلب من الشبكة أولاً (فيصل التحديث فوراً بلا حاجة لفتح التطبيق مرتين)،
   والذاكرة تُستخدم عند انقطاع الشبكة فقط. طلبات الـ API لا تُخزَّن إطلاقاً. */
const VERSION = 'v9';
const CACHE = 'hr-shell-' + VERSION;
const SHELL = [
  '/app/index.html',
  '/app/styles.css',
  '/app/app.js',
  '/app/i18n.js',
  '/app/icons.js',
  '/app/manifest.json',
  '/app/assets/icon-192.png',
  '/app/assets/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // لا تخزين لواجهة البرمجة ولا للمرفقات ولا لمسار الأجهزة
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/iclock/') || url.pathname.startsWith('/uploads/')) return;

  // ملفات الواجهة: الشبكة أولاً ثم الذاكرة (حتى يصل أي تحديث من أول فتح)
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/app/index.html')))
  );
});
