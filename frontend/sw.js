/* عامل الخدمة: يجعل النظام قابلاً للتثبيت كتطبيق ويسرّع فتحه.
   ملفات الواجهة تُجلب من الشبكة أولاً (فيصل التحديث فوراً بلا حاجة لفتح التطبيق مرتين)،
   والذاكرة تُستخدم عند انقطاع الشبكة فقط. طلبات الـ API لا تُخزَّن إطلاقاً. */
const VERSION = 'v12';
const CACHE = 'hr-shell-' + VERSION;
const SHELL = [
  '/app/index.html',
  '/app/styles.css',
  '/app/app.js',
  '/app/i18n.js',
  '/app/icons.js',
  '/app/manifest.json',
  '/app/icons/icon-192.png',
  '/app/icons/icon-512.png',
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

/* ------------------------------ إشعارات الجوال ------------------------------ */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'إشعار جديد' }; }
  const title = data.title || 'نظام الموارد البشرية';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/app/icons/icon-192.png',
    badge: '/app/icons/icon-192.png',
    dir: 'rtl',
    lang: 'ar',
    tag: 'hr-' + (data.page || 'general'),
    renotify: true,
    vibrate: [180, 90, 180],
    data: { page: data.page || '' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const page = (event.notification.data && event.notification.data.page) || '';
  const target = '/app/' + (page ? '?page=' + encodeURIComponent(page) : '');
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((list) => {
      for (const client of list) {
        if (client.url.includes('/app/') && 'focus' in client) {
          if (page) client.postMessage({ type: 'open-page', page });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }));
});
