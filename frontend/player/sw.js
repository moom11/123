/* عامل خدمة شاشة العرض: الشاشة تعمل بلا إنترنت.
   ملفات الصفحة من الشبكة أولاً (ليصل أي تحديث)، وصور الشرائح من الذاكرة أولاً
   (فهي ثابتة وكبيرة، ولا يصح أن يتوقف العرض لانقطاع دقيقة). */
const VERSION = 'v1';
const SHELL_CACHE = 'signage-shell-' + VERSION;
const MEDIA_CACHE = 'signage-media-' + VERSION;
const MEDIA_LIMIT = 120;          // أحدث ١٢٠ صورة تكفي قوائم فرع كامل

const SHELL = ['/player/', '/player/index.html', '/player/player.css', '/player/player.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('signage-') && k !== SHELL_CACHE && k !== MEDIA_CACHE)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MEDIA_LIMIT))) {
    await cache.delete(key);
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // حالة الشاشة تُسأل حيّة دائماً: تخزينها يعني فاصلاً لا ينتهي
  if (url.pathname.startsWith('/api/')) return;

  // صور الشرائح: الذاكرة أولاً، وتُجلب في الخلفية لتحديثها
  if (url.pathname.startsWith('/uploads/')) {
    event.respondWith(
      caches.open(MEDIA_CACHE).then(async (cache) => {
        const hit = await cache.match(event.request);
        const fetching = fetch(event.request).then((res) => {
          if (res && res.ok) cache.put(event.request, res.clone()).then(() => trim(cache));
          return res;
        }).catch(() => hit);
        return hit || fetching;
      })
    );
    return;
  }

  if (!url.pathname.startsWith('/player/')) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('/player/index.html')))
  );
});
