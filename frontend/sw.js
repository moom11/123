/* عامل الخدمة: يجعل النظام قابلاً للتثبيت كتطبيق ويسرّع فتحه.
   ملاحظة: طلبات الـ API لا تُخزَّن إطلاقاً حتى تبقى بيانات الحضور والرواتب صحيحة دائماً. */
const CACHE = 'hr-shell-v3';
const SHELL = [
  '/app/index.html',
  '/app/styles.css',
  '/app/app.js',
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

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // لا تخزين لواجهة البرمجة ولا للمرفقات ولا لمسار الأجهزة
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/iclock/') || url.pathname.startsWith('/uploads/')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached || caches.match('/app/index.html'));
      return cached || network;
    })
  );
});
