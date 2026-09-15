/* جهاز العرض خلف الشاشة: يسأل الخادم ماذا يعرض، ويستمر من الذاكرة إن انقطعت الشبكة. */
'use strict';

const KEY_STORE = 'signage_key';
const STATE_STORE = 'signage_state';
const QUEUE_STORE = 'signage_queue';

const el = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const player = {
  token: '',
  state: null,
  slides: [],
  index: 0,
  layer: 0,          // أي الطبقتين ظاهرة الآن
  run: 0,            // رقم دورة العرض: يُبطل مؤقتات الدورة السابقة
  offline: false,
  shownAt: 0,
};

// ------------------------------ المفتاح ------------------------------

function readToken() {
  const fromUrl = new URLSearchParams(location.search).get('k');
  if (fromUrl) {
    try { localStorage.setItem(KEY_STORE, fromUrl); } catch (e) { /* وضع التصفح الخاص */ }
    return fromUrl;
  }
  try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; }
}

function askForKey(message) {
  el('setup').classList.remove('hidden');
  el('stage').classList.add('hidden');
  el('idle').classList.add('hidden');
  if (message) el('setupErr').textContent = message;
  el('keySave').onclick = () => {
    const value = el('keyInput').value.trim();
    if (!value) return;
    location.search = '?k=' + encodeURIComponent(value);
  };
  el('keyInput').onkeydown = (ev) => { if (ev.key === 'Enter') el('keySave').click(); };
}

// ------------------------------ الحالة المخزّنة ------------------------------

function cacheState(state) {
  try { localStorage.setItem(STATE_STORE, JSON.stringify(state)); } catch (e) { /* ممتلئ */ }
}

function cachedState() {
  try { return JSON.parse(localStorage.getItem(STATE_STORE) || 'null'); } catch (e) { return null; }
}

// ------------------------------ سجل العرض ------------------------------
// يُخزَّن محلياً ثم يُرسل، فلا يضيع إحصاء الإعلانات عند انقطاع الشبكة.

function queueImpression(row) {
  let queue = [];
  try { queue = JSON.parse(localStorage.getItem(QUEUE_STORE) || '[]'); } catch (e) { queue = []; }
  queue.push(row);
  if (queue.length > 500) queue = queue.slice(-500);
  try { localStorage.setItem(QUEUE_STORE, JSON.stringify(queue)); } catch (e) { /* ممتلئ */ }
}

async function flushImpressions() {
  let queue = [];
  try { queue = JSON.parse(localStorage.getItem(QUEUE_STORE) || '[]'); } catch (e) { return; }
  while (queue.length) {
    const row = queue[0];
    try {
      const res = await fetch(`/api/signage/play/${encodeURIComponent(player.token)}/impression`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row),
      });
      // 404 يعني شريحة حُذفت: نُسقطها بدل أن تسدّ الطابور
      if (!res.ok && res.status !== 404) break;
    } catch (e) {
      break;                       // الشبكة مقطوعة: نكمل في الدورة القادمة
    }
    queue.shift();
    try { localStorage.setItem(QUEUE_STORE, JSON.stringify(queue)); } catch (e) { /* ممتلئ */ }
  }
}

function reportShown(slide, breakId) {
  if (!slide || !player.shownAt) return;
  const seconds = Math.min(600, Math.round((Date.now() - player.shownAt) / 1000));
  if (seconds < 1) return;
  queueImpression({ slide_id: slide.id, seconds, break_session_id: breakId || null });
}

// ------------------------------ رسم الشرائح ------------------------------

function slideHtml(slide) {
  if (slide.kind === 'promo' && slide.image_url) {
    return `<div class="promo" style="background-image:url('${esc(slide.image_url)}')"></div>`;
  }
  if (slide.kind === 'notice' || !slide.image_url) {
    return `<div class="notice">
      ${slide.badge ? `<span class="badge" style="justify-self:center">${esc(slide.badge)}</span>` : ''}
      <h1 class="title">${esc(slide.title)}</h1>
      ${slide.subtitle ? `<p class="subtitle">${esc(slide.subtitle)}</p>` : ''}
      ${slide.price != null ? priceHtml(slide) : ''}
    </div>`;
  }
  return `<div class="product">
    <div class="shot" style="background-image:url('${esc(slide.image_url)}')"></div>
    <div class="info">
      ${slide.badge ? `<span class="badge">${esc(slide.badge)}</span>` : ''}
      <h1 class="title">${esc(slide.title)}</h1>
      ${slide.subtitle ? `<p class="subtitle">${esc(slide.subtitle)}</p>` : ''}
      ${slide.price != null ? priceHtml(slide) : ''}
    </div>
  </div>`;
}

function priceHtml(slide) {
  const fmt = (v) => Number(v).toLocaleString('ar-SA', { maximumFractionDigits: 2 });
  return `<div class="price-row">
    <span class="price">${fmt(slide.price)}<span class="cur">ريال</span></span>
    ${slide.old_price ? `<span class="old-price">${fmt(slide.old_price)}</span>` : ''}
  </div>`;
}

function preload(url) {
  return new Promise((resolve) => {
    if (!url) return resolve();
    const img = new Image();
    img.onload = img.onerror = () => resolve();
    img.src = url;
  });
}

// ------------------------------ دورة العرض ------------------------------

function stopShow() {
  player.run += 1;
  if (player.timer) clearTimeout(player.timer);
  if (player.tick) clearInterval(player.tick);
  player.timer = player.tick = null;
}

function showIdle(state) {
  stopShow();
  el('setup').classList.add('hidden');
  el('stage').classList.add('hidden');
  el('idle').classList.remove('hidden');
  el('idleName').textContent = (state && state.screen_name) || '';
  const paint = () => {
    el('idleClock').textContent = new Date().toLocaleTimeString('ar-SA',
      { hour: '2-digit', minute: '2-digit' });
  };
  paint();
  player.tick = setInterval(paint, 20000);
}

async function startShow(state) {
  stopShow();
  const run = player.run;
  player.slides = state.slides || [];
  player.index = 0;
  el('setup').classList.add('hidden');
  el('idle').classList.add('hidden');
  el('stage').classList.remove('hidden');
  el('tickerLabel').textContent = state.label || state.playlist_name || '';
  document.body.className = state.rotation ? `rot-${state.rotation}` : '';

  if (!player.slides.length) {
    // فاصل بلا محتوى صالح: لوحة اعتذار صامتة خير من شاشة بيضاء
    el('slideA').innerHTML = slideHtml({ kind: 'notice', title: state.screen_name || '' });
    el('slideA').classList.add('on');
    el('slideB').classList.remove('on');
    return;
  }

  startCountdown(state);
  await preload(player.slides[0].image_url);
  if (run !== player.run) return;
  advance(run, state, true);
}

function advance(run, state, first) {
  if (run !== player.run) return;
  const slide = player.slides[player.index % player.slides.length];
  const layers = [el('slideA'), el('slideB')];
  const next = layers[player.layer];
  const current = layers[1 - player.layer];

  next.innerHTML = slideHtml(slide);
  next.classList.add('on');
  if (!first) current.classList.remove('on');
  player.layer = 1 - player.layer;

  if (!first) reportShown(player.lastSlide, state.break_session_id);
  player.lastSlide = slide;
  player.shownAt = Date.now();

  const ahead = player.slides[(player.index + 1) % player.slides.length];
  preload(ahead && ahead.image_url);

  player.index += 1;
  player.timer = setTimeout(() => advance(run, state), Math.max(2, slide.duration) * 1000);
}

function startCountdown(state) {
  if (!state.ends_at) {
    el('barFill').style.width = '0';
    el('tickerLeft').textContent = '';
    return;
  }
  const ends = new Date(state.ends_at).getTime();
  const total = Math.max(1, (ends - Date.now()) / 1000);
  const paint = () => {
    const left = Math.max(0, Math.round((ends - Date.now()) / 1000));
    el('barFill').style.width = `${Math.min(100, 100 - (left / total) * 100)}%`;
    const m = String(Math.floor(left / 60)).padStart(2, '0');
    const s = String(left % 60).padStart(2, '0');
    el('tickerLeft').textContent = `${m}:${s}`;
    if (left <= 0 && player.tick) { clearInterval(player.tick); player.tick = null; poll(); }
  };
  paint();
  player.tick = setInterval(paint, 1000);
}

// ------------------------------ الاتصال بالخادم ------------------------------

function setOffline(value) {
  if (player.offline === value) return;
  player.offline = value;
  el('banner').classList.toggle('hidden', !value);
  el('banner').textContent = 'انقطع الاتصال بالخادم — العرض مستمر من الذاكرة';
}

function applyState(state) {
  const same = player.state && player.state.revision === state.revision;
  player.state = state;
  if (same) {
    // نفس المحتوى: نُبقي الشريحة الظاهرة كما هي ولا نعيد الدورة من أولها
    return;
  }
  if (state.playing === 'idle') showIdle(state);
  else startShow(state);
}

async function poll() {
  try {
    const res = await fetch(`/api/signage/play/${encodeURIComponent(player.token)}`, {
      cache: 'no-store',
    });
    if (res.status === 404) {
      stopShow();
      return askForKey('مفتاح الشاشة غير صالح أو أُلغيت الشاشة');
    }
    if (!res.ok) throw new Error(res.status);
    const state = await res.json();
    setOffline(false);
    cacheState(state);
    applyState(state);
    flushImpressions();
    schedule(state.poll_seconds || 15);
  } catch (e) {
    setOffline(true);
    if (!player.state) {
      const fallback = cachedState();
      // آخر حالة محفوظة قد تكون فاصلاً انتهى وقته؛ لا نعيد تشغيله بعد انقطاع
      if (fallback && fallback.playing === 'always') applyState(fallback);
      else if (fallback) showIdle(fallback);
    }
    schedule(10);
  }
}

function schedule(seconds) {
  if (player.poller) clearTimeout(player.poller);
  player.poller = setTimeout(poll, Math.max(5, seconds) * 1000);
}

// ------------------------------ الإقلاع ------------------------------

player.token = readToken();
if (!player.token) {
  askForKey('');
} else {
  const cached = cachedState();
  if (cached) applyState(cached);      // عرض فوري بعد إعادة التشغيل قبل وصول الشبكة
  poll();
}

// إعادة السؤال فور عودة الشبكة بدل انتظار الدورة
window.addEventListener('online', () => poll());

// بعض الأجهزة تُجمّد المؤقتات وقت إطفاء الشاشة: نُحدّث فور عودتها
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* يعمل بلا تخزين مؤقت */ });
}
