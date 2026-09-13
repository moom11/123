/* نظام الموارد البشرية - واجهة المستخدم (بدون أطر عمل خارجية) */
'use strict';

const state = {
  token: localStorage.getItem('hr_token') || '',
  user: JSON.parse(localStorage.getItem('hr_user') || 'null'),
  page: 'dashboard',
  cache: {},
};

// خرائط الصفحات: تُملأ بدوال العرض أدناه
const views = {};

const PAGES = [
  { id: 'dashboard',  title: 'لوحة المؤشرات', icon: 'dashboard', group: 'عام',      roles: ['admin','hr','manager','employee'] },
  { id: 'attendance', title: 'الحضور اليومي', icon: 'clock', group: 'الحضور',   roles: ['admin','hr','manager','employee'] },
  { id: 'punches',    title: 'سجل البصمات',   icon: 'fingerprint', group: 'الحضور',   roles: ['admin','hr','manager','employee'] },
  { id: 'restDays',   title: 'أيام الراحة',    icon: 'bed', group: 'الحضور',   roles: ['admin','hr','manager'] },
  { id: 'leaves',     title: 'الإجازات',       icon: 'leave', group: 'الإجازات', roles: ['admin','hr','manager'] },
  { id: 'myLeaves',   title: 'الطلبات',        icon: 'leave', group: 'الإجازات', roles: ['employee'] },
  { id: 'schedule',   title: 'جدولي',          icon: 'calendar', group: 'الحضور', roles: ['employee'] },
  { id: 'balances',   title: 'أرصدة الإجازات', icon: 'balance', group: 'الإجازات', roles: ['admin','hr','manager'] },
  { id: 'violations', title: 'المخالفات',      icon: 'violation', group: 'شؤون الموظفين', roles: ['admin','hr','manager','employee'] },
  { id: 'payroll',    title: 'الرواتب',        icon: 'payroll', group: 'شؤون الموظفين', roles: ['admin','hr','manager','employee'] },
  { id: 'loans',      title: 'السلف',          icon: 'loans', group: 'شؤون الموظفين', roles: ['admin','hr','manager','employee'] },
  { id: 'purchases',  title: 'مشتريات الموظفين', icon: 'cart', group: 'شؤون الموظفين', roles: ['admin','hr','manager','employee'] },
  { id: 'carryovers', title: 'المستحقات المرحّلة', icon: 'money', group: 'شؤون الموظفين', roles: ['admin','hr','manager','employee'] },
  { id: 'punchRequests', title: 'طلبات البصمة', icon: 'edit', group: 'الحضور', roles: ['admin','hr','manager'] },
  { id: 'overtime',   title: 'الوقت الإضافي',  icon: 'bolt', group: 'الحضور', roles: ['admin','hr','manager'] },
  { id: 'myOvertime', title: 'وقتي الإضافي',   icon: 'bolt', group: 'عام', roles: ['employee'] },
  { id: 'requests',   title: 'طلبات الموظفين', icon: 'documents', group: 'الإجازات', roles: ['admin','hr','manager'] },
  { id: 'employees',  title: 'الموظفون',       icon: 'employees', group: 'شؤون الموظفين', roles: ['admin','hr','manager'] },
  { id: 'documents',  title: 'الوثائق',        icon: 'documents', group: 'شؤون الموظفين', roles: ['admin','hr','manager','employee'] },
  { id: 'devices',    title: 'أجهزة البصمة',   icon: 'device', group: 'الإدارة',  roles: ['admin','hr'] },
  { id: 'reports',    title: 'التقارير',       icon: 'reports', group: 'الإدارة',  roles: ['admin','hr','manager'] },
  { id: 'settings',   title: 'الإعدادات',      icon: 'settings', group: 'الإدارة',  roles: ['admin','hr'] },
  { id: 'myProfile',  title: 'بياناتي',        icon: 'idcard', group: 'شؤون الموظفين', roles: ['employee','manager','hr','admin'] },
  { id: 'notifications', title: 'الإشعارات',   icon: 'bell', group: 'عام', roles: ['employee'] },
  { id: 'more',       title: 'المزيد',         icon: 'grid', group: 'عام', roles: ['employee'] },
  { id: 'account',    title: 'حسابي',          icon: 'key', group: 'الإدارة',  roles: ['admin','hr','manager','employee'] },
];
const OT_STATUS = { pending: 'بانتظار الموافقة', approved: 'معتمد', rejected: 'مرفوض' };
const OT_TAG = { pending: 'pending', approved: 'approved', rejected: 'rejected' };
const DEDUCTION_TONE = { violation: 'danger', absence: 'danger', open_break: 'danger' };

const NAV_GROUPS = ['عام', 'الحضور', 'الإجازات', 'شؤون الموظفين', 'الإدارة'];

const DAY_STATUS = {
  present: 'حاضر', late: 'متأخر', absent: 'غائب', leave: 'إجازة',
  holiday: 'عطلة رسمية', weekend: 'راحة أسبوعية', missing_out: 'انصراف ناقص',
  scheduled: 'لم يحن بعد', needs_review: 'تحتاج مراجعة',
};
const WORK_STATES = { in: 'داخل العمل', break: 'في استراحة', out: 'خارج العمل' };
const EVENT_LABELS = {
  CLOCK_IN: 'حضور', BREAK_START: 'بدء استراحة',
  BREAK_END: 'عودة من الاستراحة', CLOCK_OUT: 'انصراف',
};
const LEAVE_STATUS = { pending:'قيد الاعتماد', approved:'معتمدة', rejected:'مرفوضة', cancelled:'ملغاة' };
const LOAN_STATUS = { pending:'بانتظار الاعتماد', approved:'بانتظار إقرار الاستلام',
  active:'سارية', settled:'مسدّدة', cancelled:'ملغاة' };
const LOAN_TAG = { pending:'pending', approved:'late', active:'on', settled:'approved', cancelled:'cancelled' };
const PUNCH_KINDS = { auto:'يحدّده النظام', clock_in:'حضور', break_start:'بدء استراحة',
  break_end:'عودة من الاستراحة', clock_out:'انصراف' };
const ROLES = { admin:'مدير النظام', hr:'موارد بشرية', manager:'مدير إدارة', employee:'موظف' };
const SOURCES = { device_pull:'جهاز (سحب)', device_push:'جهاز (دفع)', manual:'إدخال يدوي', web:'ويب' };
const VIOLATION_STATUS = { pending:'بانتظار إقرار الموظف', acknowledged:'أقرّ بالاطلاع',
  objected:'تظلّم الموظف', approved:'معتمدة', cancelled:'ملغاة' };
const PENALTY_ACTIONS = { warning:'إنذار كتابي', deduction_percent_day:'خصم نسبة من أجر يوم',
  deduction_days:'خصم أجر أيام', suspension:'إيقاف بدون أجر', termination:'الفصل من العمل' };
const MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
const money = (v) => (Number(v || 0)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const APP_VERSION = '2026.09.10g';

/* يفرض تحديث عامل الخدمة فور توفر نسخة جديدة (مهم على آيفون) */
function watchForUpdates() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistration().then((reg) => {
    if (!reg) return;
    reg.update();
    reg.addEventListener('updatefound', () => {
      const fresh = reg.installing;
      if (!fresh) return;
      fresh.addEventListener('statechange', () => {
        if (fresh.state === 'installed' && navigator.serviceWorker.controller) {
          fresh.postMessage('skip-waiting');
          toast('وصل تحديث جديد للتطبيق، جارٍ إعادة التحميل…', 'ok');
          setTimeout(() => location.reload(), 1200);
        }
      });
    });
  }).catch(() => {});
}

const CHART_COLORS = ['#2563eb','#14b8a6','#8b5cf6','#f59e0b','#22c55e','#0ea5e9','#ef4444','#64748b'];

/* تقويم شهري لحالات الحضور */
const CAL_DOW = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
function calendarMonth(rows, year, month, restDates = []) {
  const byDate = {};
  rows.forEach((r) => { byDate[r.work_date] = r; });
  const rest = new Set(restDates);
  const first = new Date(year, month - 1, 1);
  const days = new Date(year, month, 0).getDate();
  const todayStr = today();
  let cells = '';
  for (let i = 0; i < first.getDay(); i++) cells += '<div class="day blank"></div>';
  for (let d = 1; d <= days; d++) {
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const row = byDate[iso];
    // يوم الراحة المعتمد يظهر ولو لم يحن بعد، فلا سجل حضور له
    const isRest = rest.has(iso);
    const status = isRest ? 'weekend' : (row ? row.status : '');
    const label = isRest ? 'راحة معتمدة' : (row ? (DAY_STATUS[row.status] || '') : '');
    const time = !isRest && row && row.check_in ? fmtTime(row.check_in) : '';
    cells += `<div class="day ${status} ${isRest ? 'rest' : ''} ${iso === todayStr ? 'today' : ''}"
      title="${esc(iso + ' — ' + label)}">
      <span class="n">${d}</span><span class="s">${esc(time || label)}</span></div>`;
  }
  return `<div class="calendar">${CAL_DOW.map((d) => `<div class="dow">${d}</div>`).join('')}${cells}</div>`;
}

/* ------------------------------ عناصر عرض مشتركة ------------------------------ */
const initials = (name) => (String(name || '؟').trim().split(/\s+/).slice(0, 2)
  .map((w) => w[0]).join('') || '؟');
function avatarTone(seed) {
  let h = 0;
  for (const ch of String(seed || '')) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return 'c' + ((h % 6) + 1);
}
const avatar = (name, size = '') =>
  `<div class="avatar ${size} ${avatarTone(name)}">${esc(initials(name))}</div>`;

/** مدة الخدمة بصيغة «٣ سنوات و٢ شهر» */
function serviceLength(hireDate) {
  if (!hireDate) return '—';
  const from = new Date(hireDate), now = new Date();
  if (isNaN(from)) return '—';
  let months = (now.getFullYear() - from.getFullYear()) * 12 + (now.getMonth() - from.getMonth());
  if (now.getDate() < from.getDate()) months -= 1;
  if (months < 0) return '—';
  const y = Math.floor(months / 12), m = months % 12;
  const yTxt = y === 1 ? 'سنة' : y === 2 ? 'سنتان' : y <= 10 ? `${y} سنوات` : `${y} سنة`;
  const mTxt = m === 1 ? 'شهر' : m === 2 ? 'شهران' : m <= 10 ? `${m} أشهر` : `${m} شهراً`;
  if (!y) return m ? mTxt : 'أقل من شهر';
  return m ? `${yTxt} و${mTxt}` : yTxt;
}
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

/** شريط تقدّم بعنوان وقيمة */
function meter(label, valueText, percent, tone = '') {
  const pct = Math.max(0, Math.min(100, Math.round(percent || 0)));
  return `<div class="meter"><div class="row"><span class="muted">${esc(label)}</span>
    <b>${esc(valueText)}</b></div>
    <div class="progress ${tone}"><i style="width:${pct}%"></i></div></div>`;
}

/** رسم دائري (SVG) بلا مكتبات خارجية */
function donut(items) {
  const data = items.filter((i) => i.value > 0);
  const total = data.reduce((sum, i) => sum + i.value, 0);
  if (!total) return '<div class="empty">لا توجد بيانات كافية للعرض</div>';
  const r = 58, circ = 2 * Math.PI * r;
  let offset = 0;
  const rings = data.map((i, idx) => {
    const len = (i.value / total) * circ;
    const seg = `<circle r="${r}" cx="75" cy="75" stroke="${i.color || CHART_COLORS[idx % CHART_COLORS.length]}"
      stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}"></circle>`;
    offset += len;
    return seg;
  }).join('');
  const legend = data.map((i, idx) => `<div class="it">
      <span class="lab"><i style="background:${i.color || CHART_COLORS[idx % CHART_COLORS.length]}"></i>
        ${esc(i.label)}</span>
      <b>${i.value} <span class="muted">(${Math.round((i.value / total) * 100)}%)</span></b>
    </div>`).join('');
  return `<div class="donut-wrap">
      <svg class="donut" viewBox="0 0 150 150">${rings}</svg>
      <div class="donut-legend">${legend}</div>
    </div>`;
}

const WEEK_DAYS = [['6','الأحد'],['0','الاثنين'],['1','الثلاثاء'],['2','الأربعاء'],['3','الخميس'],['4','الجمعة'],['5','السبت']];

/* ------------------------------ أدوات عامة ------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const el = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + '01';
const fmtTime = (v) => (v ? String(v).slice(11, 16) : '—');
const fmtDateTime = (v) => (v ? String(v).slice(0, 16).replace('T', ' ') : '—');
const hours = (m) => (m ? (m / 60).toFixed(2) : '0');

const TOAST_ICONS = { ok: 'check', err: 'alert', '': 'alert' };
function toast(message, type = '') {
  const node = document.createElement('div');
  node.className = 'toast ' + type;
  node.innerHTML = `<span class="ti">${icon(TOAST_ICONS[type] || 'alert', 'sm')}</span>` +
    `<span>${esc(message)}</span>`;
  el('toasts').appendChild(node);
  const close = () => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 220);
  };
  node.onclick = close;
  setTimeout(close, 4200);
}

/* هياكل تحميل (Skeleton) بدل شاشة الانتظار الفارغة */
function skeleton(kind = 'rows') {
  if (kind === 'kpis') {
    return `<div class="grid cols-4">${'<div class="sk tall"></div>'.repeat(4)}</div>
      <div class="card"><div class="sk-rows">${'<div class="sk line w80"></div>'.repeat(5)}</div></div>`;
  }
  if (kind === 'cards') {
    return `<div class="grid cards">${'<div class="sk tall" style="height:150px"></div>'.repeat(8)}</div>`;
  }
  return `<div class="card"><div class="sk-rows">
    <div class="sk line w40"></div>${'<div class="sk line"></div>'.repeat(6)}</div></div>`;
}

async function api(path, options = {}) {
  const opts = { method: options.method || 'GET', headers: {} };
  if (state.token) opts.headers['Authorization'] = 'Bearer ' + state.token;
  if (options.body instanceof FormData) opts.body = options.body;
  else if (options.body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(options.body);
  }
  if (options.form) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(options.form).toString();
  }
  const res = await fetch(path, opts);
  // 401 على طلب مصادَق عليه = انتهاء الجلسة، أما على شاشة الدخول فهو خطأ في البيانات
  if (res.status === 401 && state.token && !path.startsWith('/api/auth/login')) {
    logout();
    throw new Error('انتهت الجلسة، سجّل الدخول من جديد');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const detail = (data && data.detail) || 'حدث خطأ غير متوقع';
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return data;
}

function modal({ title, body, footer, onOpen, width }) {
  const root = el('modalRoot');
  root.innerHTML = `<div class="modal-back"><div class="modal" ${width ? `style="width:min(${width}px,100%)"` : ''}>
      <div class="modal-head"><h3>${esc(title)}</h3><button class="x" data-close>&times;</button></div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div></div>`;
  root.querySelectorAll('[data-close]').forEach((b) => b.onclick = closeModal);
  $('.modal-back', root).onclick = (e) => { if (e.target.classList.contains('modal-back')) closeModal(); };
  if (onOpen) onOpen(root);
  return root;
}
const closeModal = () => { el('modalRoot').innerHTML = ''; };

function table(columns, rows, renderRow, emptyText = 'لا توجد بيانات') {
  if (!rows.length) return `<div class="empty">${esc(emptyText)}</div>`;
  const labels = columns.map((c) => esc(c)).join('|');
  const tools = columns.length > 4
    ? `<div class="table-tools"><button class="btn sm ghost" onclick="openFullTable(this)">${
        icon('menu', 'sm')} عرض الجدول الكامل</button></div>`
    : '';
  return `${tools}<div class="table-wrap"><table class="stack" data-labels="${labels}"><thead><tr>${
    columns.map((c) => `<th>${esc(c)}</th>`).join('')
  }</tr></thead><tbody>${rows.map(renderRow).join('')}</tbody></table></div>`;
}

/** يفتح الجدول كاملاً (بلا تحويل إلى بطاقات) في ورقة منزلقة قابلة للتمرير أفقياً */
window.openFullTable = (button) => {
  const card = button.closest('.card') || document;
  const source = card.querySelector('table.stack');
  if (!source) return;
  const clone = source.cloneNode(true);
  clone.classList.remove('stack');
  clone.querySelectorAll('button, a.btn').forEach((node) => node.remove());
  const title = (card.querySelector('.card-head h3') || {}).textContent || 'الجدول الكامل';
  modal({
    title: title.trim(),
    body: `<div class="full-table-wrap">${clone.outerHTML}</div>`,
    footer: '<button class="btn gray" data-close>إغلاق</button>',
    width: 900,
  });
};

/** يضيف data-label لكل خلية (اسم عمودها) ليعمل عرض البطاقات على الجوال */
function labelTableCells(root = document) {
  root.querySelectorAll('table.stack[data-labels]').forEach((tbl) => {
    const labels = (tbl.dataset.labels || '').split('|');
    tbl.querySelectorAll('tbody tr').forEach((tr) => {
      [...tr.children].forEach((td, index) => {
        if (!td.dataset.label && labels[index]) td.dataset.label = labels[index];
      });
    });
    tbl.removeAttribute('data-labels');
  });
}

const can = (...roles) => state.user && roles.includes(state.user.role);
const isHR = () => can('admin', 'hr');

/* ------------------------------ الدخول والخروج ------------------------------ */
async function login(ev) {
  ev.preventDefault();
  try {
    const form = {
      username: el('username').value.trim(),
      password: el('password').value,
    };
    // رمز التحقق بخطوتين يُرسل في client_secret كما يقبله معيار OAuth2
    const code = el('otp') ? el('otp').value.trim() : '';
    if (code) form.client_secret = code;
    const data = await api('/api/auth/login', { method: 'POST', form });
    state.token = data.access_token;
    state.user = data.user;
    localStorage.setItem('hr_token', state.token);
    localStorage.setItem('hr_user', JSON.stringify(state.user));
    if (el('otpField')) el('otpField').classList.add('hidden');
    startApp();
  } catch (e) {
    // الحساب محمي بخطوتين: أظهر حقل الرمز بدل رسالة غامضة
    if (/رمز التحقق/.test(e.message) && el('otpField')) {
      el('otpField').classList.remove('hidden');
      el('otp').focus();
    }
    toast(e.message, 'err');
  }
}

/* ------------------------------ خروج تلقائي عند السكون ------------------------------ */
const IDLE_MINUTES = Number(localStorage.getItem('hr_idle_minutes') || 30);
let idleTimer = null;
function resetIdleTimer() {
  clearTimeout(idleTimer);
  if (!state.token || IDLE_MINUTES <= 0) return;
  idleTimer = setTimeout(() => {
    if (!state.token) return;
    logout();
    toast(`أُنهيت الجلسة تلقائياً بعد ${IDLE_MINUTES} دقيقة بلا استخدام`, 'ok');
  }, IDLE_MINUTES * 60000);
}
['click', 'keydown', 'touchstart', 'visibilitychange'].forEach((event) =>
  document.addEventListener(event, () => {
    if (document.visibilityState !== 'hidden') resetIdleTimer();
  }, { passive: true }));

function logout() {
  clearTimeout(idleTimer);
  state.token = ''; state.user = null;
  localStorage.removeItem('hr_token'); localStorage.removeItem('hr_user');
  el('app').classList.add('hidden');
  el('login').classList.remove('hidden');
}

function forcePasswordChange() {
  modal({
    title: 'كلمة المرور المؤقتة',
    body: `<div class="help" style="margin-bottom:12px">
        دخلت بكلمة مرور مؤقتة (رقم جوالك). اختر كلمة مرور جديدة لتأمين حسابك — لن تتمكن من
        متابعة العمل قبل تغييرها.</div>
      <div class="field"><label>كلمة المرور الحالية</label>
        <input type="password" id="fcOld" autocomplete="current-password" /></div>
      <div class="field"><label>كلمة المرور الجديدة (٦ أحرف فأكثر)</label>
        <input type="password" id="fcNew" autocomplete="new-password" /></div>`,
    footer: `<button class="btn" id="fcSave">حفظ ومتابعة</button>
             <button class="btn gray" id="fcLogout">خروج</button>`,
    onOpen: (root) => {
      root.querySelectorAll('[data-close]').forEach((b) => b.remove());
      $('#fcSave', root).onclick = async () => {
        try {
          await api('/api/auth/change-password', { method: 'POST', body: {
            current_password: el('fcOld').value, new_password: el('fcNew').value } });
          state.user.must_change_password = false;
          localStorage.setItem('hr_user', JSON.stringify(state.user));
          closeModal();
          toast('تم تغيير كلمة المرور، أهلاً بك', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
      $('#fcLogout', root).onclick = () => { closeModal(); logout(); };
    },
  });
}

function startApp() {
  el('login').classList.add('hidden');
  el('app').classList.remove('hidden');
  resetIdleTimer();
  const pages = PAGES.filter((p) => p.roles.includes(state.user.role));
  el('nav').innerHTML = NAV_GROUPS.map((group) => {
    const items = pages.filter((p) => p.group === group);
    if (!items.length) return '';
    return `<div class="nav-group">${esc(group)}</div>` + items.map((p) =>
      `<a data-page="${p.id}" data-title="${esc(p.title)}">
         <span class="ico">${icon(p.icon)}</span><span class="lbl">${esc(p.title)}</span></a>`).join('');
  }).join('');
  el('nav').querySelectorAll('a').forEach((a) => a.onclick = () => {
    go(a.dataset.page);
    el('app').classList.remove('drawer-open');
    closeScrim();
  });
  el('sideUser').innerHTML =
    `${esc(state.user.username)} — <span>${esc(ROLES[state.user.role])}</span>`;
  el('topWho').textContent = state.user.employee_name || ROLES[state.user.role];
  el('selfPunchBtn').classList.toggle('hidden', !state.user.employee_id);
  buildTabbar();
  refreshBell();
  go(pages.some((p) => p.id === state.page) ? state.page : 'dashboard');
  if (state.user.must_change_password) forcePasswordChange();
  // أرصدة الإجازات قد تكون معطّلة (الاعتماد على الطلبات)، فتُخفى صفحتها
  api('/api/settings').then((st) => {
    state.cache.settings = st;
    if (st.leave_balances_enabled) return;
    const link = el('nav').querySelector('[data-page="balances"]');
    if (link) link.remove();
    if (state.page === 'balances') go('dashboard');
  }).catch(() => {});
}

const EXTRA_TITLES = { profile: 'ملف الموظف', home: 'الرئيسية' };
function go(page) {
  state.page = page;
  // رقم تسلسلي للتنقل: نتيجة شاشة قديمة وصلت متأخرة لا تمسّ الشاشة الحالية
  const token = (state.nav = (state.nav || 0) + 1);
  const meta = PAGES.find((p) => p.id === page);
  const employeeHome = page === 'dashboard' && state.user && state.user.role === 'employee';
  // في شاشة الموظف الرئيسية تظهر علامة المنشأة بدل عنوان الصفحة
  el('brandBar').classList.toggle('hidden', !employeeHome);
  el('pageTitle').classList.toggle('hidden', employeeHome);
  // الترويسة المختصرة على الجوال للموظف: علامة + جرس + حرف فقط
  document.body.classList.toggle('tidy-top', !!(state.user && state.user.role === 'employee'));
  const avatarBox = el('topAvatar');
  if (avatarBox && state.user) {
    avatarBox.textContent = initials(state.user.employee_name || state.user.username);
    avatarBox.title = state.user.employee_name || state.user.username;
    avatarBox.classList.toggle('hidden', state.user.role !== 'employee');
  }
  el('pageTitle').textContent = employeeHome
    ? 'الرئيسية'
    : (meta ? meta.title : (EXTRA_TITLES[page] || ''));
  el('nav').querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  markTabbar(page);
  el('view').innerHTML = skeleton(
    page === 'dashboard' ? 'kpis' : page === 'employees' ? 'cards' : 'rows');
  const fn = views[page];
  Promise.resolve(fn ? fn() : '<div class="empty">صفحة غير متاحة</div>')
    .catch((e) => {
      if (state.nav !== token) return;   // المستخدم انتقل لشاشة أخرى، فلا نعرض خطأ القديمة
      toast(e.message, 'err');
      el('view').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    });
}
const render = (html) => {
  el('view').innerHTML = html;
  labelTableCells(el('view'));
  I18N.apply(el('view'));
};

// أي جدول يُدرج لاحقاً (بعد جلب البيانات) يُوسم تلقائياً، مرة واحدة لكل إطار عرض
let _labelPending = false;
const _tableObserver = new MutationObserver(() => {
  if (_labelPending) return;
  _labelPending = true;
  requestAnimationFrame(() => {
    _labelPending = false;
    labelTableCells(document);
    I18N.apply(document.body);
  });
});
_tableObserver.observe(document.documentElement, { childList: true, subtree: true });

/* ------------------------------ الوضع الفاتح / الداكن ------------------------------ */
const THEMES = ['auto', 'light', 'dark'];
const THEME_META = {
  auto:  ['settings', 'تلقائي حسب الجهاز'],
  light: ['sun', 'الوضع الفاتح'],
  dark:  ['bed', 'الوضع الداكن'],
};

function currentTheme() {
  return localStorage.getItem('hr_theme') || 'auto';
}
function isDarkNow() {
  const theme = currentTheme();
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
function applyTheme(theme) {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('hr_theme', theme);
  // لون شريط حالة الجوال يطابق الشريط العلوي للتطبيق
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    if (!meta.media) meta.setAttribute('content', isDarkNow() ? '#1e293b' : '#ffffff');
  });
  const btn = el('themeBtn');
  if (btn) {
    const [iconName, label] = THEME_META[theme];
    btn.innerHTML = icon(iconName);
    btn.title = label;
  }
}
function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
  applyTheme(next);
  toast(THEME_META[next][1], 'ok');
}

/* ------------------------------ آيفون: التثبيت والإشعارات ------------------------------ */
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches
  || navigator.standalone === true;

/** لافتة إرشاد لمستخدمي آيفون: التطبيق والإشعارات تتطلب الإضافة إلى الشاشة الرئيسية */
function iosInstallHint() {
  if (!isIOS() || isStandalone() || localStorage.getItem('hr_ios_hint') === 'off') return '';
  return `<div class="ios-hint" id="iosHint">
      ${icon('phone')}
      <div>لتشغيله كتطبيق مستقل وتصلك الإشعارات بنغمة: اضغط زر المشاركة في سفاري ثم «إضافة إلى الشاشة الرئيسية».</div>
      <button class="x" onclick="dismissIosHint()" title="إخفاء">×</button>
    </div>`;
}
window.dismissIosHint = () => {
  localStorage.setItem('hr_ios_hint', 'off');
  const node = el('iosHint');
  if (node) node.remove();
};

/* ------------------------------ إشعارات الجوال ------------------------------ */
const urlBase64ToUint8Array = (base64) => {
  const padded = (base64 + '='.repeat((4 - base64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};

async function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return {
      supported: false,
      reason: isIOS() && !isStandalone()
        ? 'على آيفون: أضف النظام إلى الشاشة الرئيسية أولاً (المشاركة ← إضافة إلى الشاشة الرئيسية) ثم افتحه من الأيقونة وفعّل الإشعارات'
        : 'المتصفح لا يدعم إشعارات الويب',
    };
  }
  if (isIOS() && !isStandalone()) {
    return {
      supported: false,
      reason: 'على آيفون تعمل الإشعارات فقط بعد إضافة النظام إلى الشاشة الرئيسية وفتحه من أيقونته',
    };
  }
  if (!window.isSecureContext) return { supported: false, reason: 'الإشعارات تتطلب HTTPS' };
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return { supported: true, permission: Notification.permission, subscribed: !!sub, sub, reg };
}

async function enablePush() {
  const st = await pushState();
  if (!st.supported) { toast(st.reason, 'err'); return false; }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    toast('لم تُمنح صلاحية الإشعارات — فعّلها من إعدادات المتصفح', 'err');
    return false;
  }
  const info = await api('/api/push/key');
  if (!info.enabled || !info.public_key) {
    toast('إشعارات الجوال معطّلة من إعدادات النظام', 'err');
    return false;
  }
  let sub = st.sub;
  if (!sub) {
    sub = await st.reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(info.public_key),
    });
  }
  const json = sub.toJSON();
  await api('/api/push/subscribe', { method: 'POST', body: {
    endpoint: sub.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth,
    user_agent: navigator.userAgent.slice(0, 200),
  } });
  toast('تم تفعيل إشعارات هذا الجهاز', 'ok');
  return true;
}

async function disablePush() {
  const st = await pushState();
  if (st.sub) {
    await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: st.sub.endpoint } });
    await st.sub.unsubscribe();
  }
  toast('تم إيقاف إشعارات هذا الجهاز', 'ok');
}

/* ------------------------------ القائمة الجانبية ------------------------------ */
function closeScrim() {
  const scrim = document.querySelector('.scrim');
  if (scrim) scrim.remove();
}
function toggleDrawer() {
  const open = el('app').classList.toggle('drawer-open');
  closeScrim();
  if (open) {
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.onclick = () => { el('app').classList.remove('drawer-open'); closeScrim(); };
    document.body.appendChild(scrim);
  }
}
function toggleMini() {
  const mini = el('app').classList.toggle('mini');
  localStorage.setItem('hr_sidebar_mini', mini ? '1' : '0');
  el('collapseBtn').innerHTML = icon(mini ? 'expand' : 'collapse');
}
const TABBAR_PAGES = {
  admin: ['dashboard', 'attendance', 'leaves', 'employees'],
  hr: ['dashboard', 'attendance', 'leaves', 'employees'],
  manager: ['dashboard', 'attendance', 'leaves', 'reports'],
  // شريط الموظف: الرئيسية — الإشعارات — الطلبات — المزيد — حسابي
  employee: ['dashboard', 'notifications', 'myLeaves', 'more', 'account'],
};

function buildTabbar() {
  const ids = TABBAR_PAGES[state.user.role] || TABBAR_PAGES.employee;
  const items = ids
    .map((id) => PAGES.find((p) => p.id === id && p.roles.includes(state.user.role)))
    .filter(Boolean);
  const employee = state.user.role === 'employee';
  // الموظف: خمسة أزرار فقط بلا «المزيد»، والبصمة زر كبير في الشاشة الرئيسية
  const punch = (!employee && state.user.employee_id)
    ? `<a class="punch" data-action="punch"><span class="ico">${icon('fingerprint')}</span>بصمة</a>` : '';
  el('tabbar').innerHTML = employee
    ? items.map((p) => tabLink(p)).join('')
    : items.slice(0, 2).map((p) => tabLink(p)).join('') + punch +
      items.slice(2).map((p) => tabLink(p)).join('') +
      `<a data-action="menu"><span class="ico">${icon('menu')}</span>المزيد</a>`;
  el('tabbar').querySelectorAll('a').forEach((a) => a.onclick = () => {
    if (a.dataset.action === 'menu') return toggleDrawer();
    if (a.dataset.action === 'punch') return selfPunch();
    go(a.dataset.page);
  });
  markTabbar(state.page);
}
const TAB_LABELS = { dashboard: 'الرئيسية', attendance: 'الحضور', myLeaves: 'الطلبات',
  schedule: 'جدولي', notifications: 'الإشعارات', more: 'المزيد', account: 'حسابي' };
const TAB_ICONS = { dashboard: 'home' };   // الموظف: منزل للرئيسية بدل أيقونة اللوحة
const tabLink = (p) =>
  `<a data-page="${p.id}"><span class="ico">${icon(TAB_ICONS[p.id] || p.icon)}</span>${
    esc(TAB_LABELS[p.id] || p.title.split(' ')[0])}</a>`;
function markTabbar(page) {
  el('tabbar').querySelectorAll('a').forEach((a) =>
    a.classList.toggle('active', a.dataset.page === page));
}

function initShell() {
  el('menuBtn').innerHTML = icon('menu');
  el('langBtn').innerHTML = icon('globe');
  el('logoutBtn').innerHTML = icon('logout');
  el('bellBtn').insertAdjacentHTML('afterbegin', icon('bell'));
  el('selfPunchBtn').insertAdjacentHTML('afterbegin', icon('fingerprint'));
  el('collapseBtn').innerHTML = icon('collapse');
  applyTheme(currentTheme());
  el('themeBtn').onclick = cycleTheme;
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => applyTheme(currentTheme()));
  watchForUpdates();
  if (localStorage.getItem('hr_sidebar_mini') === '1') {
    el('app').classList.add('mini');
    el('collapseBtn').innerHTML = icon('expand');
  }
  el('menuBtn').onclick = toggleDrawer;
  el('collapseBtn').onclick = toggleMini;
}

function currentPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('المتصفح لا يدعم تحديد الموقع'));
      return;
    }
    if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(location.hostname)) {
      reject(new Error('تحديد الموقع يتطلب تشغيل النظام عبر HTTPS'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy_meters: Math.round(pos.coords.accuracy),
      }),
      (err) => {
        const messages = {
          1: 'رفضت المتصفح صلاحية الموقع. فعّلها من إعدادات الموقع في المتصفح ثم أعد المحاولة.',
          2: 'تعذر تحديد موقعك. تأكد من تفعيل GPS/خدمة الموقع.',
          3: 'انتهت مهلة تحديد الموقع، حاول مرة أخرى في مكان مكشوف.',
        };
        reject(new Error(messages[err.code] || 'تعذر تحديد الموقع'));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0, ...options }
    );
  });
}

async function selfPunch() {
  const btn = el('selfPunchBtn');
  btn.disabled = true;
  const original = btn.textContent;
  try {
    let coords = {};
    const settings = state.cache.settings || (state.cache.settings = await api('/api/settings'));
    if (settings.web_punch_requires_location) {
      btn.textContent = 'جارٍ تحديد موقعك…';
      coords = await currentPosition();
    }
    btn.textContent = 'جارٍ التسجيل…';
    const res = await api('/api/attendance/self-punch', { method: 'POST', body: coords });
    const dist = res.distance_meters !== null && res.distance_meters !== undefined
      ? ` (على بُعد ${Math.round(res.distance_meters)} م من الموقع)` : '';
    toast(res.message + dist, 'ok');
    if (['dashboard', 'attendance', 'punches'].includes(state.page)) go(state.page);
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}


/* ------------------------------ الإشعارات ------------------------------ */
async function refreshBell() {
  if (!state.user) return;
  try {
    const { count } = await api('/api/notifications/unread-count');
    const badge = el('bellCount');
    badge.textContent = count > 99 ? '99+' : count;
    badge.classList.toggle('hidden', !count);
  } catch { /* تجاهل أخطاء الشبكة المؤقتة */ }
}

const NOTIF_META = {
  document:  ['documents', 'الوثائق'],
  leave:     ['leave', 'الإجازات'],
  violation: ['violation', 'المخالفات'],
  payroll:   ['payroll', 'الرواتب'],
  attendance:['clock', 'الحضور'],
  quote:     ['sun', 'عبارة اليوم'],
};

async function openNotifications() {
  const rows = await api('/api/notifications?limit=50');
  const unread = rows.filter((n) => !n.is_read).length;
  const categories = [...new Set(rows.map((n) => n.category).filter(Boolean))];
  const filters = [['all', `الكل (${rows.length})`], ['unread', `غير مقروء (${unread})`]]
    .concat(categories.map((c) => [c, (NOTIF_META[c] || ['bell', c])[1]]));

  const itemHtml = (n) => {
    const [iconName] = NOTIF_META[n.category] || ['bell'];
    return `<div class="notif ${n.is_read ? '' : 'unread'}" data-id="${n.id}"
        data-page="${n.link_page || ''}" data-cat="${n.category || ''}" data-read="${n.is_read ? 1 : 0}">
      <div class="t">${icon(iconName, 'sm')} ${esc(n.title)}</div>
      ${n.body ? `<div class="b">${esc(n.body)}</div>` : ''}
      <div class="d">${fmtDateTime(n.created_at)}</div></div>`;
  };
  const body = rows.length
    ? `<div class="sub-tabs" style="padding:14px 16px 0;margin:0" id="nFilters">
         ${filters.map(([key, label], i) =>
           `<button data-f="${key}" class="${i === 0 ? 'active' : ''}">${esc(label)}</button>`).join('')}
       </div>
       <div id="nList">${rows.map(itemHtml).join('')}</div>`
    : `<div class="empty">${icon('bell', 'lg')}<br>لا توجد إشعارات</div>`;

  modal({
    title: `مركز التنبيهات${unread ? ` — ${unread} جديد` : ''}`,
    body: `<div style="margin:-18px">${body}</div>`,
    footer: '<button class="btn ghost" id="readAll">تعليم الكل كمقروء</button><button class="btn gray" data-close>إغلاق</button>',
    width: 580,
    onOpen: (root) => {
      const apply = (f) => {
        root.querySelectorAll('.notif').forEach((node) => {
          const show = f === 'all' ? true
            : f === 'unread' ? node.dataset.read === '0'
            : node.dataset.cat === f;
          node.classList.toggle('hidden', !show);
        });
      };
      const filterBar = $('#nFilters', root);
      if (filterBar) filterBar.querySelectorAll('button').forEach((b) => b.onclick = () => {
        filterBar.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        apply(b.dataset.f);
      });
      root.querySelectorAll('.notif').forEach((node) => node.onclick = async () => {
        try { await api(`/api/notifications/${node.dataset.id}/read`, { method: 'POST' }); } catch {}
        refreshBell();
        if (node.dataset.page) { closeModal(); go(node.dataset.page); }
        else { node.classList.remove('unread'); node.dataset.read = '1'; }
      });
      $('#readAll', root).onclick = async () => {
        await api('/api/notifications/read-all', { method: 'POST' });
        closeModal(); refreshBell(); toast('تم تعليم كل الإشعارات كمقروءة', 'ok');
      };
    },
  });
}

/* ------------------------------ المخالفات والجزاءات ------------------------------ */
views.violations = async () => {
  const canRecord = can('admin', 'hr', 'manager');
  const { employees } = canRecord ? await loadLookups() : { employees: [] };
  const types = await api('/api/violation-types');
  render(`
    <div class="card"><div class="card-body inline">
      ${canRecord ? '<button class="btn ok" id="vNew">تسجيل مخالفة</button>' : ''}
      <div class="field"><label>الحالة</label><select id="vStatus"><option value="">الكل</option>
        ${Object.entries(VIOLATION_STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      ${canRecord ? `<div class="field"><label>الموظف</label><select id="vEmp"><option value="">الكل</option>${options(employees, '', 'id', 'full_name')}</select></div>` : ''}
      <button class="btn ghost" id="vLoad">تحديث</button>
      ${canRecord ? '<button class="btn ghost" id="vExport">تصدير CSV</button>' : ''}
    </div></div>
    <div class="card"><div class="card-head"><h3>سجل المخالفات</h3><span class="muted" id="vCount"></span></div>
      <div id="vTable"><div class="empty">جارٍ التحميل…</div></div></div>
    ${canRecord ? `<div class="card"><div class="card-head"><h3>أنواع المخالفات وسلّم الجزاءات</h3>
      <button class="btn sm ghost" onclick="go('settings')">تعديل الأنواع من الإعدادات</button></div>
      ${table(['التصنيف', 'المخالفة', 'الأولى', 'الثانية', 'الثالثة', 'الرابعة فأكثر'], types.filter((t) => t.is_active), (t) =>
        `<tr><td>${esc(t.category)}</td><td>${esc(t.name)}</td>
          <td>${penaltyText(t.level1_action, t.level1_value)}</td>
          <td>${penaltyText(t.level2_action, t.level2_value)}</td>
          <td>${penaltyText(t.level3_action, t.level3_value)}</td>
          <td>${penaltyText(t.level4_action, t.level4_value)}</td></tr>`, 'لا توجد أنواع')}
      </div>` : ''}`);

  const load = async () => {
    const q = new URLSearchParams();
    if (el('vStatus').value) q.set('status', el('vStatus').value);
    if (el('vEmp') && el('vEmp').value) q.set('employee_id', el('vEmp').value);
    const rows = await api('/api/violations?' + q);
    el('vCount').textContent = `${rows.length} مخالفة`;
    el('vTable').innerHTML = table(
      ['#', 'التاريخ', 'الموظف', 'المخالفة', 'التكرار', 'الجزاء', 'الخصم', 'الحالة', 'إجراءات'],
      rows,
      (v) => {
        const mine = state.user.employee_id === v.employee_id;
        let actions = '';
        if (mine && v.status === 'pending') actions += `<button class="btn sm ok" onclick="ackViolation(${v.id})">إقرار بالاطلاع</button> `;
        if (mine && ['pending', 'acknowledged'].includes(v.status)) actions += `<button class="btn sm gray" onclick="objectViolation(${v.id})">تظلّم</button> `;
        if (isHR() && !['approved', 'cancelled'].includes(v.status)) {
          actions += `<button class="btn sm" onclick="decideViolation(${v.id},'approve')">اعتماد</button>
                      <button class="btn sm danger" onclick="decideViolation(${v.id},'cancel')">إلغاء</button> `;
        }
        if (v.attachment_path) actions += `<a class="btn sm ghost" href="/uploads/${encodeURIComponent(v.attachment_path)}" target="_blank">المرفق</a>`;
        return `<tr><td>${v.id}</td><td>${v.occurred_on}</td><td>${esc(v.employee_name)}</td>
          <td>${esc(v.violation_type_name)}<div class="muted" style="font-size:11.5px">${esc(v.description || v.category || '')}</div></td>
          <td>${v.repetition_no}</td><td>${esc(v.penalty_action_label || PENALTY_ACTIONS[v.penalty_action])}${v.penalty_value ? ' — ' + v.penalty_value : ''}</td>
          <td class="money">${v.penalty_amount ? money(v.penalty_amount) : '—'}</td>
          <td><span class="tag ${v.status}">${VIOLATION_STATUS[v.status]}</span>
            ${v.employee_note ? `<div class="muted" style="font-size:11.5px">${esc(v.employee_note)}</div>` : ''}</td>
          <td>${actions}</td></tr>`;
      },
      'لا توجد مخالفات مسجلة');
  };

  el('vLoad').onclick = () => load().catch((e) => toast(e.message, 'err'));
  if (el('vExport')) el('vExport').onclick = () =>
    downloadCsv('/api/violations-export.csv?year=' + new Date().getFullYear(), 'violations.csv');
  if (el('vNew')) el('vNew').onclick = () => violationModal(employees, types, load);

  window.ackViolation = async (id) => {
    if (!confirm('تأكيد الإقرار بالاطلاع على المخالفة؟')) return;
    try { await api(`/api/violations/${id}/acknowledge`, { method: 'POST', body: {} });
      toast('تم الإقرار', 'ok'); load(); } catch (e) { toast(e.message, 'err'); }
  };
  window.objectViolation = async (id) => {
    const note = prompt('اكتب سبب التظلّم');
    if (!note) return;
    try { await api(`/api/violations/${id}/object`, { method: 'POST', body: { note } });
      toast('تم إرسال التظلّم', 'ok'); load(); } catch (e) { toast(e.message, 'err'); }
  };
  window.decideViolation = async (id, action) => {
    const note = prompt(action === 'approve' ? 'ملاحظة الاعتماد (اختياري)' : 'سبب الإلغاء (اختياري)', '');
    if (note === null) return;
    try { await api(`/api/violations/${id}/${action}`, { method: 'POST', body: { note } });
      toast('تم تنفيذ الإجراء', 'ok'); load(); refreshBell(); } catch (e) { toast(e.message, 'err'); }
  };
  load();
};

const penaltyText = (action, value) => {
  if (action === 'warning') return 'إنذار';
  if (action === 'deduction_percent_day') return `خصم ${value}% من أجر يوم`;
  if (action === 'deduction_days') return `خصم ${value} يوم`;
  if (action === 'suspension') return `إيقاف ${value} يوم`;
  return PENALTY_ACTIONS[action] || action;
};

function violationModal(employees, types, after) {
  const grouped = {};
  types.filter((t) => t.is_active).forEach((t) => { (grouped[t.category] ||= []).push(t); });
  modal({
    title: 'تسجيل مخالفة',
    width: 700,
    body: `<div class="grid cols-2">
        <div class="field"><label>الموظف</label><select id="viEmp">${options(employees, '', 'id', 'full_name')}</select></div>
        <div class="field"><label>تاريخ المخالفة</label><input type="date" id="viDate" value="${today()}" max="${today()}" /></div>
      </div>
      <div class="field"><label>نوع المخالفة</label><select id="viType">
        ${Object.entries(grouped).map(([cat, items]) =>
          `<optgroup label="${esc(cat)}">${items.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</optgroup>`).join('')}
      </select></div>
      <div class="field"><label>وصف الواقعة</label><textarea id="viDesc" rows="3" placeholder="مثال: عدم التواجد في المكان المخصص الساعة 10:30 رغم التنبيه"></textarea></div>
      <div class="inline"><button class="btn ghost" id="viHere"> إرفاق موقعي الحالي</button>
        <span class="help" id="viGeo">اختياري: يوثّق مكان رصد المخالفة.</span></div>
      <div class="help" id="viPreview" style="margin-top:12px">اختر الموظف والنوع لعرض التكرار والجزاء المستحق.</div>`,
    footer: `<button class="btn" id="viSave">تسجيل المخالفة</button><button class="btn gray" data-close>إلغاء</button>`,
    onOpen: (root) => {
      let coords = {};
      const payload = () => ({
        employee_id: Number(el('viEmp').value),
        violation_type_id: Number(el('viType').value),
        occurred_on: el('viDate').value,
        description: el('viDesc').value || null,
        ...coords,
      });
      const preview = async () => {
        try {
          const r = await api('/api/violations/preview', { method: 'POST', body: payload() });
          el('viPreview').innerHTML =
            `التكرار رقم <b>${r.repetition_no}</b> خلال المدة النظامية — الجزاء: <b>${r.penalty_action_label}</b>` +
            (r.penalty_value ? ` (${r.penalty_value})` : '') +
            (r.penalty_amount ? ` — قيمة الخصم: <b>${money(r.penalty_amount)} ريال</b> (أجر اليوم ${money(r.daily_wage)})` : ' — بدون خصم مالي');
        } catch (e) { el('viPreview').textContent = e.message; }
      };
      ['viEmp', 'viType', 'viDate'].forEach((id) => el(id).onchange = preview);
      preview();
      $('#viHere', root).onclick = async () => {
        el('viGeo').textContent = 'جارٍ تحديد الموقع…';
        try {
          const pos = await currentPosition();
          coords = { latitude: pos.latitude, longitude: pos.longitude };
          el('viGeo').textContent = `تم إرفاق الموقع (دقة ${pos.accuracy_meters} م).`;
        } catch (e) { el('viGeo').textContent = e.message; }
      };
      $('#viSave', root).onclick = async () => {
        try {
          const created = await api('/api/violations', { method: 'POST', body: payload() });
          toast(`تم تسجيل المخالفة رقم ${created.id} وإشعار الموظف`, 'ok');
          closeModal(); if (after) after();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

/* ------------------------------ بيانات مساعدة ------------------------------ */
async function loadLookups(force = false) {
  if (!state.cache.lookups || force) {
    const [employees, departments, shifts, leaveTypes, sites] = await Promise.all([
      api('/api/employees'), api('/api/departments'), api('/api/shifts'),
      api('/api/leave-types'), api('/api/sites'),
    ]);
    state.cache.sites = sites;
    state.cache.lookups = { employees, departments, shifts, leaveTypes, sites };
  }
  return state.cache.lookups;
}
const options = (items, value, key = 'id', label = 'name') =>
  items.map((i) => `<option value="${i[key]}" ${String(i[key]) === String(value) ? 'selected' : ''}>${esc(i[label])}</option>`).join('');



/* ------------------------------ لوحة التعليمات الجانبية ------------------------------ */
/* شرح مختصر لكل شاشة: ماذا تفعل هنا، وما القواعد التي يطبّقها النظام خلفك. */
const HELP = {
  overtime: ['الوقت الإضافي', `
    <h4>لا يُحتسب إضافي بلا اعتماد</h4>
    <ul>
      <li>العمل بعد نهاية الدوام يُسجَّل تلقائياً <b>وقتاً زائداً بانتظار الموافقة</b>، ولا يدخل الراتب.</li>
      <li><b>الاعتماد</b> يحوّله إلى عمل إضافي معتمد يُحتسب مالياً بمعامل الإضافي المعتمد في الإعدادات.</li>
      <li><b>الرفض</b> يبقيه مسجّلاً في السجل ولا يُصرف عنه شيء.</li>
      <li>يمكن اعتماد <b>جزء</b> من الوقت المرصود، ولا يُقبل اعتماد أكثر منه.</li>
      <li>كل قرار يُحفظ باسم من اتخذه وتاريخه ووقته في سجل التدقيق، فلا مطالبة لاحقة بساعات لم تُعتمد.</li>
      <li>إعادة الاحتساب لا تغيّر قراراً اتُّخذ. لتصحيح قرار: <b>إعادة فتح</b> ثم البتّ من جديد.</li>
    </ul>`],

  dashboard: ['لوحة المؤشرات', `
    <h4>${icon('dashboard')} ما هذه الشاشة</h4>
    <p>ملخّص يومك: من حضر، ومن تأخر، ومن غاب، والطلبات التي تنتظر قرارك.</p>
    <h4>${icon('clock')} نصيحة</h4>
    <p>ابدأ يومك من هنا: أي رقم أحمر (غياب أو تحتاج مراجعة) اضغط عليه للانتقال إلى تفاصيله.</p>`],

  attendance: ['الحضور اليومي', `
    <h4>${icon('pulse')} الحالة الآن</h4>
    <p>البطاقة العليا تعرض كل موظف وحالته لحظياً: <b>داخل العمل</b> أو <b>في استراحة</b> أو
      <b>خارج العمل</b>، وتتحدّث تلقائياً كل نصف دقيقة. البطاقة الحمراء تعني تجاوز استراحة
      أو استراحة مفتوحة تحتاج تدخّلك.</p>
    <h4>${icon('fingerprint')} كيف يفهم النظام البصمة</h4>
    <p>المعنى يتحدّد بحالة الموظف لا بترتيب البصمة:</p>
    <table><tr><th>حالته قبل</th><th>البصمة تعني</th></tr>
      <tr><td>خارج العمل</td><td>حضور</td></tr>
      <tr><td>داخل العمل (أثناء الدوام)</td><td>بدء استراحة</td></tr>
      <tr><td>داخل العمل (قرب نهاية الدوام)</td><td>انصراف</td></tr>
      <tr><td>في استراحة</td><td>عودة من الاستراحة</td></tr></table>
    <div class="hp-note">لا استراحة في آخر نصف ساعة من الدوام (قابلة للضبط): أي بصمة فيها
      تُفهم <b>انصرافاً</b>. اضبط المدة من الإعدادات ← سياسة الحضور والاستراحة.</div>
    <h4>${icon('coffee')} عمود الاستراحة</h4>
    <p>يعرض إجمالي الدقائق وعدد الاستراحات. اضغط عليه لترى <b>سلسلة أحداث اليوم</b> كاملة:
      كل بصمة ومعناها والحالة قبلها وبعدها ومن أي جهاز وصلت.</p>
    <h4>${icon('users')} تسجيل حضور جماعي</h4>
    <p>لملء أيام عمل ماضية للجميع دفعة واحدة حين لم تُسجَّل بصمات. لا يمسّ يوماً فيه بصمات
      فعلية ولا الراحات ولا العطل ولا الإجازات المعتمدة.</p>`],

  punches: ['سجل البصمات', `
    <h4>${icon('fingerprint')} ما هذه الشاشة</h4>
    <p>البصمات الخام كما وصلت من الجهاز أو التطبيق، قبل أي تفسير.</p>
    <h4>${icon('shield')} التعديل والحذف</h4>
    <p>كلاهما يتطلب <b>سبباً مكتوباً</b> يُحفظ في سجل التدقيق مع القيمة القديمة والجديدة
      واسمك ووقت التعديل.</p>
    <div class="hp-note">الحذف <b>ناعم</b>: السجل يبقى في قاعدة البيانات ويخرج من الاحتساب فقط،
      فلا يُمحى سجل حضور نهائياً بلا أثر.</div>
    <h4>${icon('clock')} تصحيح تفسير خاطئ</h4>
    <p>إن فُهمت بصمة استراحةً وهي انصراف (أو العكس)، اضغط <b>تعديل</b> واختر النوع الصحيح،
      فيعيد النظام حساب اليوم كله فوراً.</p>`],

  employees: ['الموظفون', `
    <h4>${icon('users')} حقول تؤثر على الحساب</h4>
    <ul>
      <li><b>الوردية</b>: تحدد أوقات الدوام والتأخير والانصراف. الموظف بلا وردية يأخذ دواماً افتراضياً.</li>
      <li><b>أيام الراحة الأسبوعية</b>: تخصّ هذا الموظف وحده وتغلب أيام عمل الوردية.</li>
      <li><b>الاستراحة</b>: «لا يأخذ استراحة» تعني ألا تُخصم استراحة الوردية الثابتة من ساعاته.</li>
      <li><b>أيام الراحة الشهرية</b>: رصيد هذا الموظف وحده. «افتراضي المنشأة» يعني اتباع رقم الإعدادات العام.</li>
      <li><b>حساب الدخول</b>: يُنشأ ويُعاد ضبطه ويُوقف من ملف الموظف نفسه، واسم المستخدم هو رقم جواله.</li>
      <li><b>رقم الجوال</b>: بمجرد إضافته يُنشأ للموظف حساب دخول، اسم المستخدم وكلمة المرور
        هما رقم الجوال، ويُطلب منه تغييرها أول دخول.</li>
      <li><b>البدلات</b>: تدخل في إجمالي الراتب وتُحتسب عليها الخصومات.</li>
    </ul>`],

  leaves: ['الإجازات', `
    <h4>${icon('leave')} الدورة</h4>
    <p>تقديم ← اعتماد أو رفض ← إمكانية الإلغاء مع إرجاع الرصيد. الأيام تُحتسب باستثناء
      الراحات الأسبوعية والعطل الرسمية.</p>
    <div class="hp-tip">الغياب <b>بإذن</b> سجّله إجازة: «بدون راتب» تُخصم يوماً واحداً،
      والمدفوعة بلا خصم. أما الغياب <b>بدون إذن</b> فيُخصم بمعامل الإعدادات (يومان افتراضياً).</div>`],

  payroll: ['الرواتب', `
    <h4>${icon('money')} كيف يُحتسب المسير</h4>
    <p>من الحضور الفعلي: خصم الغياب والتأخير والإجازات بلا راتب وخصومات المخالفات وأقساط
      السلف، وإضافة بدل العمل الإضافي.</p>
    <h4>${icon('check')} الاعتماد وإلغاؤه</h4>
    <ul>
      <li><b>الاعتماد</b> يقفل المسير عن التعديل ويرسل القسائم للموظفين.</li>
      <li><b>إلغاء الاعتماد</b> يعيده مسودة قابلة للتعديل، وتختفي القسائم من شاشات الموظفين
        ويصلهم إشعار بأنها قيد المراجعة. السبب إلزامي ويُحفظ في سجل التدقيق.</li>
    </ul>
    <h4>${icon('shield')} فحص ما قبل الإقفال</h4>
    <p>اضغطه قبل احتساب المسير ليعرض لك، لكل موظف، خمس حالات تحتاج معالجة:</p>
    <ul>
      <li>أيام غياب بلا بصمة وبلا إجازة.</li>
      <li>تجاوز رصيد الإجازة.</li>
      <li>مستحقات مرحّلة من شهر سابق لم تُصرف.</li>
      <li>خصم مسجَّل لم يُعتمد بعد.</li>
      <li>بصمة دخول بلا خروج (أو استراحة بلا عودة).</li>
    </ul>
    <p>وزر «إرسال الملخّص للإدارة» يرسل النتيجة إشعاراً لمديري النظام والموارد البشرية.</p>
    <h4>${icon('printer')} الطباعة</h4>
    <ul>
      <li><b>القسائم PDF</b>: قسيمة مستقلة لكل موظف.</li>
      <li><b>طباعة الجدول</b>: جدول الرواتب كاملاً في صفحة أفقية مرتّبة، بمجاميع
        وخانات توقيع (أعدّه / راجعه / اعتمده) والمبلغ كتابةً.</li>
    </ul>
    <div class="hp-note">بعد أي تعديل على الحضور أو المخالفات، احذف المسير وأعد إنشاءه
      ليُحتسب من جديد على البيانات المصححة.</div>`],

  violations: ['المخالفات', `
    <h4>${icon('alert')} كيف تعمل</h4>
    <p>لكل نوع مخالفة سلّم جزاءات يتصاعد مع التكرار خلال ١٨٠ يوماً (قابلة للضبط):
      إنذار ← خصم نسبة من أجر يوم ← خصم أيام ← إيقاف أو فصل.</p>
    <h4>${icon('coffee')} مخالفة تلقائية</h4>
    <p>تجاوز وقت الاستراحة يفتح مخالفة تلقائياً عند بلوغ الحد المضبوط، بحالة
      <b>بانتظار إقرار الموظف</b> — فله أن يقرّ أو يتظلّم.</p>
    <div class="hp-note">لا يُخصم شيء من الراتب إلا بعد <b>اعتمادك</b> للمخالفة.</div>`],

  restDays: ['أيام الراحة', `
    <h4>${icon('bed')} الفرق</h4>
    <ul>
      <li><b>الراحة الأسبوعية</b>: ثابتة، من الوردية أو من بطاقة الموظف.</li>
      <li><b>الراحة المجدولة</b>: أيام محددة بتواريخها تُجدولها هنا شهرياً.</li>
    </ul>
    <p>كلاهما لا يُحتسب غياباً، والعمل فيهما يُحتسب وقتاً إضافياً كاملاً.</p>`],

  devices: ['أجهزة البصمة', `
    <h4>${icon('device')} وضعا التشغيل</h4>
    <ul>
      <li><b>سحب</b>: النظام يتصل بالجهاز على المنفذ 4370 ويسحب السجلات.</li>
      <li><b>دفع (ADMS)</b>: الجهاز يرسل البصمة لحظة حدوثها — الأفضل والأسرع.</li>
    </ul>
    <h4>${icon('shield')} تسجيل جهاز جديد</h4>
    <p>افتح <b>نافذة الاقتران</b> أولاً ثم اضبط الجهاز خلالها. خارج النافذة تُرفض الأجهزة
      المجهولة حمايةً من أي جهاز غريب يرسل بصمات وهمية.</p>`],

  settings: ['الإعدادات', `
    <h4>${icon('settings')} أهم ما تضبطه</h4>
    <ul>
      <li><b>الورديات</b>: أوقات الدوام وأيام العمل — أساس كل الحسابات.</li>
      <li><b>سياسة الحضور والاستراحة</b>: مدة الاستراحة، وقت السماح بالانصراف، سياسة التأخير،
        وسياسة خاصة لكل فرع أو إدارة أو وردية.</li>
      <li><b>قواعد الرواتب</b>: أيام الشهر، معامل الإضافي، وخصم الغياب بدون إذن.</li>
      <li><b>هوية المنشأة</b>: الاسم والشعار — والشعار نفسه يصبح أيقونة التطبيق على الجوال.</li>
    </ul>
    <div class="hp-tip">أهم قيمة واحدة: <b>وقت السماح بالانصراف</b>. هي الحد الفاصل بين
      «استراحة» و«انصراف» في فهم البصمة.</div>`],

  home: ['شاشتك', `
    <h4>${icon('fingerprint')} الزر الذكي</h4>
    <p>الزر يتغيّر حسب حالتك: تسجيل حضور ← بدء استراحة ← إنهاء الاستراحة ← تسجيل انصراف.</p>
    <h4>${icon('coffee')} الاستراحة</h4>
    <p>لك أن تأخذ أكثر من استراحة في اليوم. المهم أن تسجّل <b>عودتك</b> من كل واحدة، وإلا
      بقيت مفتوحة واحتاج يومك مراجعة من الإدارة.</p>
    <div class="hp-note">تجاوز المدة المسموحة يصلك عليه تنبيه، وقد يُسجَّل مخالفة إن زاد
      عن الحد. ولا استراحة في آخر نصف ساعة من دوامك.</div>
    <h4>${icon('location')} الموقع</h4>
    <p>إن كان مكتوباً «يتحقق من موقعك» فلا تُقبل بصمتك إلا داخل نطاق فرعك.</p>
    <h4>${icon('money')} راتبي حتى اليوم</h4>
    <p>يعرض ما استحققته من بداية الشهر حتى اليوم: أجر اليوم × الأيام المنقضية، ناقص
      ما عليك من غياب وتأخير ومخالفات وأقساط سلف ومشتريات. رقم تقديري يتغيّر حتى
      نهاية الشهر.</p>
    <h4>${icon('edit')} نسيت البصمة؟</h4>
    <p>أرسل طلباً بالوقت الفعلي وسببه. بعد اعتماد الإدارة تُسجَّل بصمتك ويُعاد احتساب يومك.</p>`],

  purchases: ['مشتريات الموظفين', `
    <h4>${icon('cart')} ما هذه الشاشة</h4>
    <p>فواتير ما يشتريه الموظف من المتجر أو المطعم. كل فاتورة تُخصم تلقائياً من راتب
      <b>الشهر الذي يقع فيه تاريخها</b>، وتظهر في قسيمته باسم «مشتريات».</p>
    <h4>${icon('shield')} الإلغاء</h4>
    <p>الفاتورة لا تُحذف: تُلغى بسبب مكتوب فتبقى في السجل ولا تُخصم.</p>
    <div class="hp-note">إن كان مسير الشهر <b>معتمداً</b> فلا تُقبل فاتورة جديدة فيه —
      ألغِ اعتماد المسير أولاً أو سجّلها في الشهر الحالي.</div>`],

  punchRequests: ['طلبات البصمة', `
    <h4>${icon('edit')} ما هذه الشاشة</h4>
    <p>طلبات «نسيت البصمة» التي يرسلها الموظفون. الموظف يحدد الوقت الفعلي ونوع البصمة
      ويكتب السبب.</p>
    <h4>${icon('check')} الاعتماد</h4>
    <p>عند الاعتماد تُسجَّل البصمة فعلياً بالوقت المطلوب مصدرها «إدخال يدوي»، ويُعاد
      احتساب اليوم تلقائياً فتتغيّر حالته من «انصراف ناقص» إلى «حاضر».</p>
    <div class="hp-tip">لا تُقبل طلبات أقدم من ٣٠ يوماً ولا بوقت مستقبلي، والطلب المكرر
      بالوقت نفسه مرفوض.</div>`],

  loans: ['السلف', `
    <h4>${icon('loans')} دورة السلفة</h4>
    <ol>
      <li><b>الطلب</b>: الموارد البشرية تسجّلها، أو الموظف يطلبها من شاشته.</li>
      <li><b>الاعتماد</b>: الموارد البشرية تعتمد أو ترفض بسبب مكتوب.</li>
      <li><b>إقرار الاستلام</b>: الموظف يقرّ باستلام المبلغ.</li>
      <li><b>الخصم</b>: يبدأ خصم الأقساط من راتبه حسب الجدول.</li>
    </ol>
    <div class="hp-note">لا يُخصم قسط واحد قبل إقرار الموظف بالاستلام — فلا يُخصم من
      راتب أحد مبلغ لم يستلمه.</div>`],

  carryovers: ['المستحقات المرحّلة', `
    <h4>${icon('money')} ما هذه الشاشة</h4>
    <p>جدول مستقل للمستحقات والخصومات المرحّلة من شهور سابقة. مثال: موظف لم يُصرف
      له راتب أربعة أيام من الشهر الماضي.</p>
    <div class="hp-note">تلك الأيام <b>لا تُقيَّد إجازةً ولا غياباً</b> في الشهر الحالي —
      تُسجَّل هنا حركة مالية مستقلة فقط.</div>
    <h4>${icon('check')} كيف تُصرف</h4>
    <p>كل حركة «غير مصروفة» تدخل تلقائياً في أقرب مسير: المستحق يُضاف والخصم يُخصم،
      وتُعلَّم <b>مصروف</b> عند اعتماد المسير. وإلغاء اعتماده يعيدها «غير مصروف».</p>
    <h4>${icon('edit')} الحقول</h4>
    <ul>
      <li><b>نوع الحركة</b>: مستحق سابق أو خصم سابق.</li>
      <li><b>الشهر الذي تخصّه</b>: لا شهر الصرف.</li>
      <li><b>الأيام × قيمة اليوم</b> = المبلغ (قيمة اليوم تُحتسب من راتبه إن تُركت فارغة).</li>
      <li><b>السبب</b> و<b>ملاحظة الإدارة</b> و<b>حالة الصرف</b>.</li>
    </ul>`],

  myLeaves: ['الطلبات', `
    <h4>${icon('documents')} كل طلباتك من هنا</h4>
    <p>أربعة أنواع ترفعها بضغطة من أعلى الشاشة:</p>
    <ul>
      <li><b>إجازة</b>: النوع والتاريخان والسبب، مع إمكانية إرفاق مستند.</li>
      <li><b>بصمة فائتة</b>: الوقت الفعلي ونوع البصمة وسبب نسيانها.</li>
      <li><b>سلفة</b>: المبلغ والقسط وشهر البداية — وبعد الاعتماد تقرّ باستلامها.</li>
      <li><b>طلب آخر</b>: تعريف أو شهادة، تغيير وردية، تصحيح بيانات، شكوى، اقتراح، أو غيرها.</li>
    </ul>
    <h4>${icon('clock')} المتابعة</h4>
    <p>القائمة أدناه تجمع طلباتك كلها بحالتها ورد الإدارة عليها. الطلب <b>قيد الاعتماد</b>
      يمكنك سحبه، والمعتمد يظهر معه رد الإدارة.</p>`],

  requests: ['طلبات الموظفين', `
    <h4>${icon('documents')} صندوق الطلبات</h4>
    <p>الطلبات العامة التي يرفعها الموظفون: تعريف أو شهادة، تغيير وردية، تصحيح بيانات،
      شكوى، اقتراح، أو غيرها.</p>
    <p>الاعتماد أو الرفض يصل الموظف إشعاراً مع <b>ردّك المكتوب</b>، ويظهر في شاشة طلباته.</p>
    <div class="hp-tip">طلبات الإجازة في شاشة «الإجازات»، وطلبات البصمة في «طلبات البصمة»،
      وطلبات السلف في «السلف».</div>`],

  schedule: ['جدولي', `
    <h4>${icon('calendar')} ما تراه</h4>
    <p>وردية اليوم، وأيام أسبوعك وراحاتك، وسجل حضورك خلال الشهر بالحالة والوقت.</p>`],
};

const HELP_DEFAULT = ['التعليمات', `
  <h4>${icon('info')} النظام باختصار</h4>
  <p>نظام حضور وانصراف وإجازات ورواتب، مربوط بجهاز البصمة وبتطبيق الجوال.</p>
  <p>افتح هذه اللوحة في أي شاشة لترى شرحها والقواعد التي يطبّقها النظام فيها.</p>`];

function toggleHelp(open) {
  const panel = el('helpPanel');
  const scrim = el('helpScrim');
  if (!panel) return;
  const show = open === undefined ? panel.hidden : open;
  if (show) {
    const [title, body] = HELP[state.page] || HELP_DEFAULT;
    el('helpTitle').textContent = title;
    el('helpBody').innerHTML = body;
    I18N.apply(el('helpBody'));
  }
  panel.hidden = !show;
  scrim.hidden = !show;
}

/* ------------------------------ لوحة المؤشرات ------------------------------ */
/* ------------------------------ شاشة الموظف الرئيسية ------------------------------ */
const HOME_STATE_TONE = { in: 'in', break: 'break', out: '', done: '', off: 'off' };
const ACTION_ICONS = {
  clock_in: 'fingerprint', clock_out: 'logout',
  break_start: 'coffee', break_end: 'play',
};

/** شاشة نجاح مختصرة بعد البصمة: الوقت والموقع */
function punchSuccess(result) {
  const site = result.site_name ? ` — ${result.site_name}` : '';
  const box = document.createElement('div');
  box.className = 'punch-done';
  box.innerHTML = `<div class="box">
      <div class="ring">${icon('check')}</div>
      <h3>تم تسجيل ${esc(result.kind || 'الحضور')}</h3>
      <p>${esc(result.time_label || '')}${esc(site)}</p>
    </div>`;
  box.onclick = () => box.remove();
  document.body.appendChild(box);
  if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
  setTimeout(() => box.remove(), 2600);
}

const GREETINGS = [[4, 'صباح الخير'], [12, 'مساء الخير'], [17, 'مساء الخير'], [23, 'مساء الخير']];
const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'صباح الخير' : 'مساء الخير';
};
const AR_DOW = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const longDate = (d = new Date()) =>
  `${AR_DOW[d.getDay()]}، ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
const EVENT_TONE = { CLOCK_IN: 'ok', BREAK_START: 'warn', BREAK_END: 'info', CLOCK_OUT: 'danger' };
const EVENT_ICON = { CLOCK_IN: 'login', BREAK_START: 'coffee', BREAK_END: 'play', CLOCK_OUT: 'logout' };

/** مدة بصيغة «3 ساعات و18 دقيقة» */
function durationLabel(minutes) {
  const m = Math.max(0, Math.round(minutes || 0));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (!h) return `${rest} دقيقة`;
  const hourWord = h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : h <= 10 ? `${h} ساعات` : `${h} ساعة`;
  return rest ? `${hourWord} و${rest} دقيقة` : hourWord;
}

views.home = async () => {
  const home = await api('/api/me/home');
  const tone = HOME_STATE_TONE[home.state] || '';
  const timeOf = (value) => (value ? fmtTime(value) : '—');
  const sinceLabel = home.state === 'break'
    ? (home.break_started_at ? `منذ ${fmtTime(home.break_started_at)}` : '')
    : (home.check_in ? `منذ ${fmtTime(home.check_in)}` : (home.state_detail || ''));

  render(`
    ${iosInstallHint()}
    <div class="hi">
      <h2>${greeting()}، ${esc(String(home.employee_name || '').split(' ')[0])}</h2>
      <p>${esc(longDate())}</p>
    </div>

    <div class="state-soft ${tone}">
      <div class="txt">
        <b><span class="dot"></span>${esc(home.state_label)}</b>
        <span>${esc(sinceLabel)}</span>
      </div>
      <div class="mark">${icon(home.state === 'break' ? 'coffee' : 'building')}</div>
    </div>

    <div class="tiles">
      <div class="tile">
        <div class="th"><span class="ti blue">${icon('clock')}</span>مدة العمل اليوم</div>
        <b id="workedLive">${durationLabel(home.worked_minutes_live)}</b>
      </div>
      <div class="tile">
        <div class="th"><span class="ti violet">${icon('calendar')}</span>عدد مرات الحضور</div>
        <b>${home.clock_in_count} / ${home.expected_clock_ins}</b>
        <div class="progress ok"><i style="width:${Math.min(100,
          (home.clock_in_count / Math.max(1, home.expected_clock_ins)) * 100)}%"></i></div>
      </div>
    </div>

    ${home.punch_enabled
      ? `<button class="punch-btn big" id="homePunch" data-intent="${esc(home.action)}">
           ${icon(ACTION_ICONS[home.action] || 'fingerprint')} ${esc(home.action_label)}</button>
         ${home.secondary_action ? `<button class="punch-btn ghost" id="homePunch2"
           data-intent="${esc(home.secondary_action)}">${icon(ACTION_ICONS[home.secondary_action]
           || 'fingerprint')} ${esc(home.secondary_action_label)}</button>` : ''}
         <div class="hint" id="homeHint">${home.requires_location
           ? 'يجب أن تكون داخل نطاق موقع العمل عند التسجيل.' : 'اضغط الزر لتسجيل بصمتك.'}</div>`
      : '<div class="hint">تسجيل الحضور من التطبيق معطّل حالياً</div>'}

    ${home.alert ? `<div class="soft-alert">${icon('alert')} ${esc(home.alert)}</div>` : ''}

    <div class="quick4">
      <a onclick="go('myLeaves')" class="q amber">${home.pending_requests
        ? `<span class="badge">${home.pending_requests}</span>` : ''}
        <span class="qi">${icon('documents')}</span>طلباتي</a>
      <a onclick="go('attendance')" class="q blue"><span class="qi">${icon('clock')}</span>حضوري</a>
      <a onclick="go('notifications')" class="q rose">${home.unread_notifications
        ? `<span class="badge">${home.unread_notifications}</span>` : ''}
        <span class="qi">${icon('bell')}</span>الإشعارات</a>
      <a onclick="go('schedule')" class="q green"><span class="qi">${icon('calendar')}</span>جدولي</a>
    </div>

    <div class="card"><div class="card-head"><h3>آخر الحركات</h3>
      <button class="btn sm ghost" onclick="go('punches')">عرض الكل</button></div>
      ${home.recent_events.length ? home.recent_events.map((e) => `
        <div class="row-item">
          <span class="ri ${EVENT_TONE[e.type] || ''}">${icon(EVENT_ICON[e.type] || 'fingerprint')}</span>
          <div class="rt"><b>${esc(e.label)}</b><span>${esc(e.site_name || '')}</span></div>
          <div class="rv">${fmtTime(e.at)}<small>${esc(String(e.at).slice(0, 10))}</small></div>
        </div>`).join('')
        : '<div class="empty">لا حركات بعد</div>'}
    </div>

    <div class="card" id="salaryCard"><div class="card-head"><h3>راتبي حتى اليوم</h3>
      <span class="muted" id="salPeriod"></span></div>
      <div id="salBody"><div class="sk-rows">${'<div class="sk line"></div>'.repeat(2)}</div></div></div>

    <div class="card"><div class="card-head"><h3>دوام اليوم</h3>
      <span class="muted">${esc(home.shift_name || '')}</span></div>
      <div class="row-item"><span class="ri">${icon('clock')}</span>
        <div class="rt"><b>الحضور</b><span>${esc(home.shift_label || '')}</span></div>
        <div class="rv">${timeOf(home.check_in)}</div></div>
      <div class="row-item"><span class="ri">${icon('logout')}</span>
        <div class="rt"><b>الانصراف</b><span>${home.check_out ? 'انتهى دوامك' : 'لم يُسجَّل بعد'}</span></div>
        <div class="rv">${timeOf(home.check_out)}</div></div>
      ${home.late_minutes ? `<div class="row-item"><span class="ri danger">${icon('alert')}</span>
        <div class="rt"><b>تأخير</b><span>يُحتسب في المسير</span></div>
        <div class="rv danger">${home.late_minutes} دقيقة</div></div>` : ''}
      <div class="row-item"><span class="ri">${icon('coffee')}</span>
        <div class="rt"><b>الاستراحات</b><span>${home.break_count
          ? home.break_count + ' استراحة من أصل ' + home.break_allowance_minutes + ' دقيقة مسموحة'
          : 'المسموح ' + home.break_allowance_minutes + ' دقيقة يومياً'}</span></div>
        <div class="rv ${home.break_overrun_minutes ? 'danger' : ''}">${home.break_minutes} دقيقة</div></div>
      ${home.next_rest_date ? `<div class="row-item" onclick="go('schedule')" style="cursor:pointer">
        <span class="ri ok">${icon('bed')}</span>
        <div class="rt"><b>راحتك المعتمدة</b><span>${esc(home.next_rest_weekday || '')}</span></div>
        <div class="rv"><b>${esc(home.next_rest_date)}</b></div></div>` : ''}
      <div class="row-item" id="missedPunch" style="cursor:pointer">
        <span class="ri">${icon('edit')}</span>
        <div class="rt"><b>نسيت البصمة؟</b><span>أرسل طلباً لتسجيل بصمة فائتة</span></div>
        <div class="rv">${icon('chevron')}</div></div>
    </div>

    <div class="card"><div class="card-head"><h3>جدول هذا الأسبوع</h3>
      <button class="btn sm ghost" onclick="go('schedule')">التفاصيل</button></div>
      <div class="card-body">
        <div class="week-strip">${home.week.map((d) => `
          <div class="d ${d.status || ''} ${d.is_today ? 'today' : ''}" title="${esc(d.label)}">
            <span class="n">${esc(d.weekday.replace('ال', ''))}</span>
            <span class="v">${d.date.slice(8)}</span>
            <span class="s">${d.check_in ? fmtTime(d.check_in) : esc(d.label || '')}</span>
          </div>`).join('')}</div>
      </div></div>`);

  const punch = async (button) => {
    button.disabled = true;
    const hint = el('homeHint');
    try {
      let body = {};
      if (home.requires_location) {
        if (hint) hint.textContent = 'جارٍ تحديد موقعك…';
        body = await currentPosition();
      }
      const intent = button.dataset.intent;
      if (intent && intent !== 'none') body.intent = intent;
      const result = await api('/api/attendance/self-punch', { method: 'POST', body });
      punchSuccess(result);
      setTimeout(() => views.home(), 1800);
    } catch (e) {
      toast(e.message, 'err');
      if (hint) hint.textContent = e.message;
      button.disabled = false;
    }
  };
  ['homePunch', 'homePunch2'].forEach((id) => {
    const button = el(id);
    if (button) button.onclick = () => punch(button);
  });
  if (el('missedPunch')) el('missedPunch').onclick = () => missedPunchModal();

  // راتبي حتى اليوم
  api('/api/me/salary-to-date').then((pay) => {
    if (!el('salBody')) return;
    el('salPeriod').textContent = `${MONTHS[pay.month - 1]} ${pay.year}`;
    const pct = pay.month_days ? (pay.days_elapsed / pay.month_days) * 100 : 0;
    el('salBody').innerHTML = `
      <div class="card-body" style="padding-bottom:6px">
        <div class="progress ok" style="margin-bottom:6px"><i style="width:${Math.min(100, pct)}%"></i></div>
        <div class="muted" style="font-size:12px">مضى ${pay.days_elapsed} من ${pay.month_days} يوماً
          — يتبقى ${pay.days_remaining} يوماً</div>
      </div>
      <div class="row-item"><span class="ri">${icon('money')}</span>
        <div class="rt"><b>المستحق حتى اليوم</b>
          <span>${money(pay.daily_rate)} ريال × ${pay.days_elapsed} يوم</span></div>
        <div class="rv"><b>${money(pay.gross_to_date)}</b></div></div>
      ${pay.deductions_total ? `<div class="row-item"><span class="ri danger">${icon('alert')}</span>
        <div class="rt"><b>الخصومات حتى اليوم</b><span>${[
          pay.absence_deduction ? 'غياب' : '', pay.late_deduction ? 'تأخير' : '',
          pay.early_leave_deduction ? 'خروج مبكر' : '',
          pay.violation_deduction ? 'مخالفات' : '', pay.loan_deduction ? 'سلف' : '',
          pay.purchases_deduction ? 'مشتريات' : '',
          pay.open_break_deduction ? 'استراحة بلا عودة' : ''].filter(Boolean).join(' · ')}</span></div>
        <div class="rv danger">− ${money(pay.deductions_total)}</div></div>` : ''}
      <div class="row-item"><span class="ri ok">${icon('check')}</span>
        <div class="rt"><b>الصافي التقديري الآن</b><span>يتغيّر حتى نهاية الشهر</span></div>
        <div class="rv"><b class="money" style="color:var(--ok)">${money(pay.net_to_date)}</b></div></div>
      <div class="row-item"><span class="ri">${icon('calendar')}</span>
        <div class="rt"><b>راتب الشهر كاملاً</b><span>إن أكملت الشهر بلا خصومات</span></div>
        <div class="rv">${money(pay.expected_full_month)}</div></div>`;
  }).catch(() => { if (el('salaryCard')) el('salaryCard').remove(); });

  // عدّاد حيّ: مدة العمل ومدة الاستراحة الجارية
  clearInterval(state.breakTimer);
  const started = home.check_in ? new Date(home.check_in) : null;
  if (home.state === 'in' && started && !home.check_out) {
    state.breakTimer = setInterval(() => {
      const box = el('workedLive');
      if (!box) return clearInterval(state.breakTimer);
      const minutes = Math.floor((Date.now() - started) / 60000) - (home.break_minutes || 0);
      box.textContent = durationLabel(minutes);
    }, 30000);
  } else if (home.state === 'break' && home.break_started_at) {
    const from = new Date(home.break_started_at);
    state.breakTimer = setInterval(() => {
      const box = document.querySelector('.state-soft .txt span');
      if (!box) return clearInterval(state.breakTimer);
      const minutes = Math.max(0, Math.floor((Date.now() - from) / 60000));
      box.textContent = `منذ ${fmtTime(home.break_started_at)} — ${minutes} دقيقة`;
    }, 30000);
  }
};

/* ------------------------------ الإشعارات (شاشة كاملة) ------------------------------ */
views.notifications = async () => {
  const rows = await api('/api/notifications?limit=100');
  render(`
    <div class="card"><div class="card-head"><h3>الإشعارات</h3>
      <button class="btn sm ghost" id="ntAllRead">تعليم الكل كمقروء</button></div>
      ${rows.length ? rows.map((n) => `
        <div class="row-item ${n.is_read ? '' : 'unread'}" data-id="${n.id}"
             ${n.link_page ? `onclick="go('${esc(n.link_page)}')" style="cursor:pointer"` : ''}>
          <span class="ri ${n.is_read ? '' : 'info'}">${icon('bell')}</span>
          <div class="rt"><b>${esc(n.title)}</b><span>${esc(n.body || '')}</span></div>
          <div class="rv">${fmtTime(n.created_at)}<small>${esc(String(n.created_at).slice(0, 10))}</small></div>
        </div>`).join('') : '<div class="empty">لا إشعارات</div>'}
    </div>`);
  el('ntAllRead').onclick = async () => {
    try { await api('/api/notifications/read-all', { method: 'POST' });
      toast('تم', 'ok'); views.notifications(); refreshBell(); }
    catch (e) { toast(e.message, 'err'); }
  };
};

/* ------------------------------ المزيد ------------------------------ */
const MORE_LINKS = [
  ['violations', 'violation', 'مخالفاتي', 'إنذاراتك وجزاءاتها'],
  ['payroll', 'payroll', 'رواتبي', 'قسائم رواتبك الشهرية'],
  ['loans', 'loans', 'سلفي', 'طلب سلفة ومتابعة أقساطها'],
  ['purchases', 'cart', 'مشترياتي', 'فواتير تُخصم من راتبك'],
  ['documents', 'documents', 'وثائقي', 'الإقامة والعقد وغيرها'],
  ['schedule', 'calendar', 'جدولي', 'وردياتك وأيام راحتك'],
  ['myOvertime', 'bolt', 'وقتي الإضافي', 'ما اعتُمد لك وما لم يُعتمد'],
  ['myProfile', 'idcard', 'بياناتي', 'تحديث جوالك وهويتك'],
  ['account', 'key', 'حسابي', 'كلمة المرور والإشعارات واللغة'],
];

views.more = async () => {
  render(`<div class="card"><div class="card-head"><h3>المزيد</h3></div>
    ${MORE_LINKS.filter(([id]) => {
      const meta = PAGES.find((p) => p.id === id);
      return meta && meta.roles.includes(state.user.role);
    }).map(([id, ic, title, sub]) => `
      <div class="row-item" onclick="go('${id}')" style="cursor:pointer">
        <span class="ri">${icon(ic)}</span>
        <div class="rt"><b>${title}</b><span>${sub}</span></div>
        <div class="rv">${icon('chevron')}</div></div>`).join('')}
    <div class="row-item" id="moreTheme" style="cursor:pointer">
      <span class="ri">${icon(THEME_META[currentTheme()][0])}</span>
      <div class="rt"><b>مظهر التطبيق</b><span>${THEME_META[currentTheme()][1]}</span></div>
      <div class="rv">${icon('chevron')}</div></div>
    <div class="row-item" id="moreLang" style="cursor:pointer">
      <span class="ri">${icon('globe')}</span>
      <div class="rt"><b>اللغة</b><span>${I18N.isEnglish() ? 'English' : 'العربية'}</span></div>
      <div class="rv">${icon('chevron')}</div></div>
    <div class="row-item" onclick="logout()" style="cursor:pointer">
      <span class="ri danger">${icon('logout')}</span>
      <div class="rt"><b>تسجيل الخروج</b><span>إنهاء الجلسة على هذا الجهاز</span></div>
      <div class="rv">${icon('chevron')}</div></div>
  </div>`);
  el('moreTheme').onclick = () => { cycleTheme(); views.more(); };
  el('moreLang').onclick = () => I18N.set(I18N.isEnglish() ? 'ar' : 'en');
};

/** طلب «نسيت البصمة»: يرسله الموظف فتعتمده الإدارة وتُسجَّل البصمة */
function missedPunchModal(after) {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  modal({
    title: 'طلب تسجيل بصمة فائتة',
    body: `<div class="help" style="margin-bottom:12px">اكتب الوقت الفعلي الذي حضرت أو انصرفت
        فيه وسبب عدم تسجيل البصمة. يصل الطلب للموارد البشرية، وعند اعتماده تُسجَّل بصمتك
        ويُعاد احتساب يومك.</div>
      <div class="field"><label>وقت البصمة الفائتة</label>
        <input type="datetime-local" id="mpqTime" value="${local}" /></div>
      <div class="field"><label>نوعها</label><select id="mpqKind">
        <option value="auto">يحدّده النظام حسب حالتي</option>
        <option value="clock_in">حضور</option>
        <option value="clock_out">انصراف</option>
        <option value="break_start">بدء استراحة</option>
        <option value="break_end">عودة من الاستراحة</option></select></div>
      <div class="field"><label>السبب</label>
        <textarea id="mpqReason" rows="3" placeholder="مثال: نسيت تسجيل الانصراف، غادرت الساعة الخامسة"></textarea></div>`,
    footer: '<button class="btn" id="mpqSave">إرسال الطلب</button><button class="btn gray" data-close>إلغاء</button>',
    onOpen: (root) => {
      $('#mpqSave', root).onclick = async () => {
        const reason = $('#mpqReason', root).value.trim();
        if (reason.length < 3) return toast('اكتب سبب الطلب', 'err');
        try {
          await api('/api/punch-requests', { method: 'POST', body: {
            requested_time: $('#mpqTime', root).value + ':00',
            kind: $('#mpqKind', root).value,
            reason } });
          toast('أُرسل الطلب للموارد البشرية', 'ok'); closeModal(); if (after) after();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

/* ------------------------------ جدولي ------------------------------ */
views.schedule = async () => {
  const now = new Date();
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    .toLocaleDateString('en-CA');
  const [home, rows, rest] = await Promise.all([
    api('/api/me/home'),
    // إلى نهاية الشهر لا إلى اليوم، ليظهر ما لم يحن بعد من راحة ووردية
    api(`/api/attendance/employee/${state.user.employee_id}?date_from=${monthStart()}&date_to=${monthEnd}`)
      .catch(() => []),
    api('/api/me/rest-days').catch(() => ({ days: [], quota: 0, used: 0, scheduled: 0, remaining: 0 })),
  ]);
  const restDates = (rest.days || []).map((d) => d.date);

  render(`
    <div class="card"><div class="card-head"><h3>أسبوعي</h3>
      <span class="muted">${esc(home.shift_name || '')} · ${esc(home.shift_label || '')}</span></div>
      <div class="card-body">
        ${home.week.map((d) => `
          <div class="row-item">
            <span class="ri ${d.is_scheduled_rest ? 'ok' : ''}">${icon(d.status === 'weekend' ? 'bed'
              : d.status === 'leave' ? 'leave' : 'clock')}</span>
            <div class="rt"><b>${esc(d.weekday)} ${d.date.slice(5)}${d.is_today ? ' — اليوم' : ''}</b>
              <span>${esc(d.is_scheduled_rest ? 'راحتك المعتمدة' : (d.shift_label || ''))}</span></div>
            <div class="rv">${d.check_in
              ? fmtTime(d.check_in) + (d.check_out ? ' → ' + fmtTime(d.check_out) : '')
              : `<span class="tag ${d.is_scheduled_rest ? 'leave' : (d.status || '')}">${esc(d.label || '')}</span>`}</div>
          </div>`).join('')}
      </div></div>

    <div class="card"><div class="card-head"><h3>أيام راحتي المعتمدة</h3>
      <span class="muted">${esc(rest.month_name || '')} ${rest.year || ''}</span></div>
      <div class="card-body">
        <div class="kpis">
          <div class="kpi ok"><div class="label">المعتمد لك هذا الشهر<span class="ico">${icon('bed')}</span></div>
            <div class="value ok">${rest.scheduled || 0}</div></div>
          <div class="kpi"><div class="label">مضى منها<span class="ico">${icon('check')}</span></div>
            <div class="value">${rest.used || 0}</div></div>
          <div class="kpi info"><div class="label">لم يُجدول بعد<span class="ico">${icon('calendar')}</span></div>
            <div class="value info">${rest.remaining || 0} من ${rest.quota || 0}</div></div>
        </div>
        ${(rest.days || []).length ? (rest.days || []).map((d) => `
          <div class="row-item">
            <span class="ri ${d.is_past ? '' : 'ok'}">${icon('bed')}</span>
            <div class="rt"><b>${esc(d.weekday)} ${esc(d.date)}</b>
              <span>${esc(d.note || (d.is_today ? 'راحتك اليوم' : d.is_past ? 'مضت' : 'قادمة'))}</span></div>
            <div class="rv">${d.is_today
              ? '<span class="tag leave">اليوم</span>'
              : d.is_past ? '<span class="tag">مضت</span>' : '<span class="tag ok">قادمة</span>'}</div>
          </div>`).join('')
        : '<div class="empty">لم تُعتمد لك أيام راحة هذا الشهر بعد. راجع مسؤولك.</div>'}
      </div></div>

    <div class="card"><div class="card-head"><h3>تقويم ${MONTHS[now.getMonth()]} ${now.getFullYear()}</h3>
      <div class="legend"><span><i style="background:#dcfce7"></i>حاضر</span>
        <span><i style="background:#fef3c7"></i>متأخر</span>
        <span><i style="background:#fee2e2"></i>غياب</span>
        <span><i style="background:#ccfbf1"></i>راحة معتمدة</span></div></div>
      <div class="card-body">${calendarMonth(rows, now.getFullYear(), now.getMonth() + 1, restDates)}</div></div>`);
};

views.dashboard = async () => {
  // الموظف يرى شاشة مبسّطة (بطاقة الحالة + زر البصمة) بدل لوحة المؤشرات الإدارية
  if (state.user.role === 'employee') return views.home();
  const stats = await api('/api/reports/dashboard');
  const mine = state.user.role === 'employee';
  const myStatus = stats.late ? ['متأخر', 'warn', 'clock']
    : stats.on_leave ? ['في إجازة', 'info', 'leave']
    : stats.present ? ['حاضر', 'ok', 'check']
    : stats.absent ? ['غياب', 'danger', 'alert'] : ['لم تُسجَّل بصمة بعد', '', 'clock'];
  const max = Math.max(1, ...stats.weekly_trend.map((d) => d.present + d.late + d.absent + d.leave));
  const bar = (d) => {
    const seg = (k, v) => v ? `<div class="seg ${k}" style="height:${(v / max) * 100}%" title="${DAY_STATUS[k] || k}: ${v}"></div>` : '';
    return `<div class="col"><div class="stack">
        ${seg('present', d.present)}${seg('late', d.late)}${seg('leave', d.leave)}${seg('absent', d.absent)}
      </div><div class="cap">${d.date.slice(5)}</div></div>`;
  };
  const kpi = (label, value, tone, icon, foot = '') => `
    <div class="kpi ${tone}"><div class="label">${esc(label)}<span class="ico">${icon}</span></div>
      <div class="value ${tone === 'primary' ? '' : tone}">${value}</div>
      ${foot ? `<div class="foot">${esc(foot)}</div>` : ''}</div>`;

  const quickActions = [];
  if (isHR()) {
    quickActions.push(['plus', 'إضافة موظف', "go('employees');setTimeout(()=>document.getElementById('eNew')&&document.getElementById('eNew').click(),400)"]);
    quickActions.push(['leave', 'اعتماد الإجازات', "go('leaves')"]);
    quickActions.push(['violation', 'تسجيل مخالفة', "go('violations')"]);
    quickActions.push(['payroll', 'مسير الرواتب', "go('payroll')"]);
    quickActions.push(['reports', 'إصدار تقرير', "go('reports')"]);
    quickActions.push(['documents', 'إضافة وثيقة', "go('documents')"]);
  } else if (can('manager')) {
    quickActions.push(['leave', 'طلبات فريقي', "go('leaves')"]);
    quickActions.push(['clock', 'حضور الفريق', "go('attendance')"]);
    quickActions.push(['reports', 'التقارير', "go('reports')"]);
  } else {
    quickActions.push(['leave', 'طلب إجازة', "go('myLeaves')"]);
    quickActions.push(['clock', 'سجل حضوري', "go('attendance')"]);
    quickActions.push(['payroll', 'قسائم رواتبي', "go('payroll')"]);
    quickActions.push(['documents', 'وثائقي', "go('documents')"]);
  }

  render(`
    ${iosInstallHint()}
    <div class="grid cols-4 stagger">
      ${mine ? `
        ${kpi('حالتي اليوم', `<span style="font-size:19px">${myStatus[0]}</span>`, myStatus[1], icon(myStatus[2]))}
        ${kpi('طلبات إجازتي المعلّقة', stats.pending_leaves, 'warn', icon('leave'))}
        ${kpi('تاريخ اليوم', `<span style="font-size:18px">${stats.date}</span>`, 'primary', icon('calendar'))}
      ` : `
        ${kpi('إجمالي الموظفين', stats.employees_total, 'primary', icon('employees'))}
        ${kpi('الحضور اليوم', stats.present, 'ok', icon('check'))}
        ${kpi('متأخرون', stats.late, 'warn', icon('clock'))}
        ${kpi('غياب', stats.absent, 'danger', icon('alert'))}
        ${kpi('في إجازة', stats.on_leave, 'info', icon('leave'))}
        ${kpi('طلبات إجازة معلّقة', stats.pending_leaves, 'warn', icon('mail'))}
        ${can('admin', 'hr') ? kpi('أجهزة البصمة', `${stats.devices_online}/${stats.devices_total}`, 'primary', icon('device'), 'متصلة خلال ٢٤ ساعة') : ''}
        ${kpi('تاريخ اليوم', `<span style="font-size:18px">${stats.date}</span>`, 'primary', icon('calendar'))}
      `}
    </div>

    <div class="card"><div class="card-head"><h3>${icon('bolt')} إجراءات سريعة</h3></div>
      <div class="card-body"><div class="quick">
        ${quickActions.map(([ico, label, action]) =>
          `<button onclick="${action}"><span class="qi">${icon(ico)}</span>${esc(label)}</button>`).join('')}
      </div></div></div>

    ${state.user.employee_id ? `<div class="card"><div class="card-head"><h3>${icon('fingerprint')} تسجيل حضوري من التطبيق</h3>
      <button class="btn sm ghost" id="checkLoc">التحقق من موقعي</button></div>
      <div class="card-body inline">
        <button class="btn ok" id="punchNow">تسجيل حضور / انصراف</button>
        <span class="help" id="locHint">يجب أن تكون داخل نطاق موقع العمل المعتمد عند التسجيل.</span>
      </div></div>` : ''}

    <div class="grid cols-2">
      <div class="card" style="margin:0">
        <div class="card-head"><h3>${mine ? 'حضوري خلال آخر ٧ أيام' : 'الحضور خلال آخر ٧ أيام'}</h3>
          <div class="legend">
            <span><i style="background:#22c55e"></i>حاضر</span><span><i style="background:#f59e0b"></i>متأخر</span>
            <span><i style="background:#14b8a6"></i>إجازة</span><span><i style="background:#ef4444"></i>غياب</span>
          </div>
        </div>
        <div class="card-body"><div class="bars">${stats.weekly_trend.map(bar).join('')}</div></div>
      </div>
      ${mine ? '' : `<div class="card" style="margin:0">
        <div class="card-head"><h3>توزيع الموظفين حسب الإدارة</h3></div>
        <div class="card-body" id="depChart"><div class="sk tall"></div></div>
      </div>`}
    </div>

    <div class="card"><div class="card-head"><h3>${mine ? 'سجلي اليوم' : 'حضور اليوم'}</h3>
      <button class="btn sm ghost" onclick="go('attendance')">${mine ? 'فتح سجل حضوري' : 'فتح الكشف اليومي'}</button></div>
      <div id="todayTable"><div class="sk-rows">${'<div class="sk line"></div>'.repeat(4)}</div></div>
    </div>`);

  if (el('punchNow')) {
    el('punchNow').onclick = selfPunch;
    el('checkLoc').onclick = async () => {
      el('locHint').textContent = 'جارٍ تحديد موقعك…';
      try {
        const pos = await currentPosition();
        const res = await api('/api/sites/check', { method: 'POST', body: pos });
        el('locHint').textContent = res.message + ` — دقة التحديد ${pos.accuracy_meters} م`;
      } catch (e) { el('locHint').textContent = e.message; }
    };
  }

  const rows = await api('/api/attendance/daily?work_date=' + today());
  el('todayTable').innerHTML = table(
    ['الموظف', 'وقت الحضور', 'وقت الانصراف', 'ساعات', 'التأخير (د)', 'الحالة'],
    rows,
    (r) => `<tr><td><div style="display:flex;align-items:center;gap:9px">${avatar(r.employee_name, 'sm')}
        <div><div style="font-weight:600">${esc(r.employee_name)}</div>
        <div class="muted" style="font-size:11.5px">${esc(r.employee_code)}</div></div></div></td>
      <td>${fmtTime(r.check_in)}</td><td>${fmtTime(r.check_out)}</td><td>${hours(r.worked_minutes)}</td>
      <td>${r.late_minutes || 0}</td><td><span class="tag ${r.status}">${DAY_STATUS[r.status]}</span></td></tr>`,
    'لا توجد سجلات لهذا اليوم');

  if (!mine && el('depChart')) {
    try {
      const employees = await api('/api/employees?status=active');
      const counts = {};
      employees.forEach((e) => {
        const key = e.department_name || 'بدون إدارة';
        counts[key] = (counts[key] || 0) + 1;
      });
      const items = Object.entries(counts).sort((a, b) => b[1] - a[1])
        .map(([label, value]) => ({ label, value }));
      el('depChart').innerHTML = donut(items);
    } catch (e) { el('depChart').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
};

/* ------------------------------ الحضور اليومي ------------------------------ */
views.attendance = async () => {
  const { departments, employees } = await loadLookups();
  render(`
    <div class="card"><div class="card-body inline">
      <div class="field"><label>التاريخ</label><input type="date" id="attDate" value="${today()}" /></div>
      <div class="field"><label>الإدارة</label><select id="attDep"><option value="">الكل</option>${options(departments)}</select></div>
      <div class="field"><label>الحالة</label><select id="attStatus"><option value="">الكل</option>
        ${Object.entries(DAY_STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      <button class="btn" id="attLoad">عرض</button>
      <button class="btn ghost" id="attExport">تصدير CSV</button>
      ${isHR() ? '<button class="btn gray" id="attRecompute">إعادة احتساب</button>' : ''}
      ${isHR() ? '<button class="btn ok" id="attManual">بصمة يدوية</button>' : ''}
      ${isHR() ? '<button class="btn gray" id="attBulk">تسجيل حضور جماعي</button>' : ''}
    </div></div>
    <div id="attLock"></div>
    <div class="grid cols-4 stagger" id="attKpis"></div>
    <div class="card"><div class="card-head"><h3>الحالة الآن</h3>
      <span class="muted" id="liveCount">جارٍ التحميل…</span></div>
      <div class="card-body"><div class="live-grid" id="liveGrid"></div></div></div>
    <div class="card"><div class="card-head"><h3>كشف الحضور</h3><span class="muted" id="attCount"></span></div>
      <div id="attTable"><div class="empty">اختر التاريخ ثم اضغط «عرض»</div></div></div>
    <div class="card"><div class="card-head"><h3>كشف موظف لفترة</h3></div><div class="card-body">
      <div class="inline">
        <div class="field"><label>الموظف</label><select id="empSel">${options(employees, '', 'id', 'full_name')}</select></div>
        <div class="field"><label>من</label><input type="date" id="empFrom" value="${monthStart()}" /></div>
        <div class="field"><label>إلى</label><input type="date" id="empTo" value="${today()}" /></div>
        <button class="btn" id="empLoad">عرض</button>
      </div>
      <div id="empTable" style="margin-top:14px"></div>
    </div></div>`);

  const load = async () => {
    const q = new URLSearchParams({ work_date: el('attDate').value });
    if (el('attDep').value) q.set('department_id', el('attDep').value);
    if (el('attStatus').value) q.set('status', el('attStatus').value);
    const rows = await api('/api/attendance/daily?' + q);
    el('attCount').textContent = `${rows.length} سجل`;
    api(`/api/attendance/lock-status?date_from=${el('attDate').value}`)
      .then((lock) => { el('attLock').innerHTML = lock.locked
        ? `<div class="card"><div class="card-body inline" style="gap:10px;align-items:center">
             <span class="ri danger">${icon('lock')}</span>
             <div><b>الشهر مُقفل</b><div class="muted" style="font-size:12px">${esc(lock.message)}</div></div>
           </div></div>` : ''; })
      .catch(() => { el('attLock').innerHTML = ''; });
    const count = (...st) => rows.filter((r) => st.includes(r.status)).length;
    el('attKpis').innerHTML = `
      <div class="kpi ok"><div class="label">حاضر<span class="ico">${icon('check')}</span></div>
        <div class="value ok">${count('present', 'missing_out')}</div></div>
      <div class="kpi warn"><div class="label">متأخر<span class="ico">${icon('clock')}</span></div>
        <div class="value warn">${count('late')}</div></div>
      <div class="kpi danger"><div class="label">غياب<span class="ico">${icon('alert')}</span></div>
        <div class="value danger">${count('absent')}</div></div>
      <div class="kpi info"><div class="label">إجازة / عطلة<span class="ico">${icon('leave')}</span></div>
        <div class="value info">${count('leave', 'holiday', 'weekend')}</div></div>`;
    el('attTable').innerHTML = table(
      ['الموظف', 'وقت الحضور', 'وقت الانصراف', 'في المقر', 'استراحة', 'ساعات فعلية',
       'تأخير (د)', 'خروج مبكر (د)', 'إضافي (د)', 'الحالة', 'ملاحظة'],
      rows,
      (r) => `<tr${r.status === 'needs_review' || r.break_overrun_minutes ? ' class="warn-row"' : ''}>
        <td><div style="display:flex;align-items:center;gap:9px">${avatar(r.employee_name, 'sm')}
          <div><div style="font-weight:600">${esc(r.employee_name)}</div>
          <div class="muted" style="font-size:11.5px">${esc(r.employee_code)}${
            r.shift_label ? ' · ' + esc(r.shift_label) : ''}</div></div></div></td>
        <td>${fmtTime(r.check_in)}</td><td>${fmtTime(r.check_out)}</td>
        <td>${hours(r.presence_minutes)}</td>
        <td>${breakCell(r)}</td>
        <td>${hours(r.worked_minutes)}</td>
        <td>${r.late_minutes || 0}</td><td>${r.early_leave_minutes || 0}</td><td>${r.overtime_minutes || 0}</td>
        <td><span class="tag ${r.status}">${DAY_STATUS[r.status]}</span></td><td>${esc(r.note || '')}</td></tr>`);
    el('attTable').querySelectorAll('[data-events]').forEach((cell) => {
      cell.onclick = () => dayEventsSheet(Number(cell.dataset.emp), cell.dataset.day, cell.dataset.name);
    });
  };

  const loadLive = async () => {
    try {
      const rows = await api('/api/attendance/live');
      const count = (st) => rows.filter((r) => r.state === st).length;
      el('liveCount').textContent =
        `${count('in')} داخل العمل · ${count('break')} في استراحة · ${count('out')} خارج العمل`;
      el('liveGrid').innerHTML = rows.length ? rows.map((r) => `
        <div class="live-card ${r.state}${r.needs_review || r.break_overrun_minutes ? ' alarm' : ''}">
          <span class="dot"></span>
          <div class="lt"><b>${esc(r.employee_name)}</b>
            <span>${esc(r.state_label)}${r.since_minutes ? ' — منذ ' + r.since_minutes + ' دقيقة' : ''}</span>
            ${r.break_overrun_minutes ? `<span class="danger">تجاوز الاستراحة ${r.break_overrun_minutes} دقيقة</span>` : ''}
            ${r.needs_review ? '<span class="danger">استراحة مفتوحة — تحتاج مراجعة</span>' : ''}</div>
          <div class="lv">${r.check_in ? fmtTime(r.check_in) : '—'}
            <small>${r.break_count ? r.break_count + ' استراحة' : 'بلا استراحة'}</small></div>
        </div>`).join('') : '<div class="empty">لا يوجد موظفون</div>';
    } catch (e) { el('liveCount').textContent = e.message; }
  };
  loadLive();
  clearInterval(state.liveTimer);
  state.liveTimer = setInterval(() => {
    if (state.page === 'attendance') loadLive(); else clearInterval(state.liveTimer);
  }, 30000);
  el('attLoad').onclick = () => load().catch((e) => toast(e.message, 'err'));
  el('attExport').onclick = () => downloadCsv(
    `/api/attendance/export.csv?date_from=${el('attDate').value}&date_to=${el('attDate').value}`, 'attendance.csv');
  if (el('attRecompute')) el('attRecompute').onclick =
    () => recomputeModal(el('attDate').value, load);
  if (el('attManual')) el('attManual').onclick = () => manualPunchModal(employees, load);
  if (el('attBulk')) el('attBulk').onclick = () => bulkPresentModal(employees, load);

  el('empLoad').onclick = async () => {
    const id = el('empSel').value;
    const from = el('empFrom').value;
    const rows = await api(`/api/attendance/employee/${id}?date_from=${from}&date_to=${el('empTo').value}`);
    const [y, m] = from.split('-').map(Number);
    const calendar = rows.length
      ? `<div class="card" style="margin:14px 0 0"><div class="card-head">
          <h3>تقويم ${MONTHS[m - 1]} ${y}</h3>
          <div class="legend"><span><i style="background:#dcfce7"></i>حاضر</span>
            <span><i style="background:#fef3c7"></i>متأخر</span>
            <span><i style="background:#fee2e2"></i>غياب</span>
            <span><i style="background:#ccfbf1"></i>إجازة</span></div></div>
          <div class="card-body">${calendarMonth(rows, y, m)}</div></div>`
      : '';
    el('empTable').innerHTML = calendar + table(
      ['التاريخ', 'وقت الحضور', 'وقت الانصراف', 'ساعات', 'تأخير (د)', 'إضافي (د)', 'الحالة', 'ملاحظة'],
      rows,
      (r) => `<tr><td>${r.work_date}</td><td>${fmtTime(r.check_in)}</td><td>${fmtTime(r.check_out)}</td>
        <td>${hours(r.worked_minutes)}</td><td>${r.late_minutes || 0}</td><td>${r.overtime_minutes || 0}</td>
        <td><span class="tag ${r.status}">${DAY_STATUS[r.status]}</span></td><td>${esc(r.note || '')}</td></tr>`);
  };
  load().catch(() => {});
};

function recomputeModal(day, after) {
  modal({
    title: 'إعادة احتساب الحضور',
    body: `<div class="grid cols-2">
        <div class="field"><label>من تاريخ</label><input type="date" id="rcFrom" value="${day}" /></div>
        <div class="field"><label>إلى تاريخ</label><input type="date" id="rcTo" value="${day}" /></div>
      </div>
      <div class="field"><label>الوردية المستعملة في الحساب</label><select id="rcMode">
        <option value="frozen">وردية كل يوم كما حُسب به (موصى به)</option>
        <option value="current">الوردية الحالية للموظف — يعيد كتابة الماضي</option>
      </select></div>
      <div id="rcLock"></div>
      <div class="help" id="rcHelp">الأيام الماضية تُحسب بلقطة ورديتها المحفوظة، فتعديلك للورديات
        اليوم لا يغيّر ما مضى. اليوم الجاري وما بعده يتبعان الوردية الحالية دائماً.</div>`,
    footer: `<button class="btn" id="rcRun">إعادة الاحتساب</button>
      <button class="btn gray" data-close>إلغاء</button>`,
    width: 560,
    onOpen: (root) => {
      const help = $('#rcHelp', root);
      const btn = $('#rcRun', root);
      const checkLock = () => api(
        `/api/attendance/lock-status?date_from=${$('#rcFrom', root).value}` +
        `&date_to=${$('#rcTo', root).value}`)
        .then((lock) => { $('#rcLock', root).innerHTML = lock.locked
          ? `<div class="help"><b class="danger">${esc(lock.message)}</b>
               أيام هذه الأشهر ستُتخطّى.</div>` : ''; })
        .catch(() => {});
      $('#rcFrom', root).onchange = checkLock;
      $('#rcTo', root).onchange = checkLock;
      checkLock();
      $('#rcMode', root).onchange = (ev) => {
        const current = ev.target.value === 'current';
        help.innerHTML = current
          ? `<b class="danger">تنبيه:</b> ستُحسب الأيام الماضية بالوردية المسندة للموظف الآن،
             فقد تتحوّل أيام كانت سليمة إلى تأخير أو «تحتاج مراجعة» (خصم نصف يوم).
             استعمله لتصحيح إسناد وردية خاطئ فقط — ويُسجَّل في سجل التدقيق.`
          : `الأيام الماضية تُحسب بلقطة ورديتها المحفوظة، فتعديلك للورديات اليوم لا يغيّر ما مضى.
             اليوم الجاري وما بعده يتبعان الوردية الحالية دائماً.`;
        btn.className = current ? 'btn danger' : 'btn';
      };
      btn.onclick = async () => {
        const current = $('#rcMode', root).value === 'current';
        if (current && !confirm('إعادة حساب الماضي بالوردية الحالية قد تغيّر أياماً معتمدة. متابعة؟')) return;
        try {
          const q = new URLSearchParams({
            date_from: $('#rcFrom', root).value, date_to: $('#rcTo', root).value });
          if (current) q.set('use_current_shift', 'true');
          const r = await api('/api/attendance/recompute?' + q, { method: 'POST' });
          toast(r.message, 'ok'); closeModal(); after();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}


function manualPunchModal(employees, after) {
  modal({
    title: 'إضافة بصمة يدوية',
    body: `<div class="field"><label>الموظف</label><select id="mpEmp">${options(employees, '', 'id', 'full_name')}</select></div>
      <div class="field"><label>التاريخ والوقت</label><input type="datetime-local" id="mpTime" value="${new Date().toISOString().slice(0,16)}" /></div>
      <div class="field"><label>ملاحظة</label><input id="mpNote" placeholder="مثال: نسيان البصمة" /></div>`,
    footer: `<button class="btn" id="mpSave">حفظ</button><button class="btn gray" data-close>إلغاء</button>`,
    onOpen: (root) => {
      $('#mpSave', root).onclick = async () => {
        try {
          await api('/api/attendance/punches', { method: 'POST', body: {
            employee_id: Number(el('mpEmp').value), punch_time: el('mpTime').value + ':00', note: el('mpNote').value || null } });
          toast('تمت إضافة البصمة', 'ok'); closeModal(); if (after) after();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

/** خلية الاستراحة في كشف اليوم: المجموع والعدد، وتُفتح على تفاصيل الأحداث */
function breakCell(row) {
  const label = row.break_count
    ? `${row.break_minutes} د · ${row.break_count}`
    : '—';
  const flag = row.break_overrun_minutes
    ? `<span class="tag late" title="تجاوز المسموح">+${row.break_overrun_minutes}</span>`
    : (row.open_break ? '<span class="tag pending">مفتوحة</span>' : '');
  return `<span data-events data-emp="${row.employee_id}" data-day="${row.work_date}"
    data-name="${esc(row.employee_name || '')}" style="cursor:pointer;text-decoration:underline dotted"
    >${label}</span> ${flag}`;
}

/** سلسلة أحداث يوم واحد لموظف: ماذا كانت كل بصمة وما الحالة بعدها */
async function dayEventsSheet(employeeId, day, name) {
  let events = [];
  try {
    events = await api(
      `/api/attendance/events?employee_id=${employeeId}&date_from=${day}&date_to=${day}`);
  } catch (e) { return toast(e.message, 'err'); }
  events.reverse();   // الأقدم أولاً
  modal({
    title: `أحداث ${name || ''} — ${day}`,
    body: events.length ? `<div class="timeline">${events.map((e) => `
        <div class="ev ${e.event_type}">
          <b>${fmtTime(e.event_time)} — ${esc(e.event_label || EVENT_LABELS[e.event_type] || '')}</b>
          <span>${esc(WORK_STATES[e.state_before] || '')} ← ${esc(e.state_after_label || '')}</span>
          <div class="muted" style="font-size:11.5px;margin-top:3px">
            ${esc(SOURCES[e.source] || e.source)}${e.device_name ? ' · ' + esc(e.device_name) : ''}${
              e.site_name ? ' · ' + esc(e.site_name) : ''}${
              e.received_at ? ' · استُلمت ' + fmtDateTime(e.received_at) : ''}</div>
        </div>`).join('')}</div>`
      : '<div class="empty">لا أحداث في هذا اليوم</div>',
    footer: '<button class="btn gray" data-close>إغلاق</button>',
  });
}

/** تسجيل حضور جماعي: يملأ أيام العمل ببصمات بمواعيد الوردية لمن لا بصمة له */
function bulkPresentModal(employees, after) {
  modal({
    title: 'تسجيل حضور جماعي',
    body: `<div class="help" style="margin-bottom:12px">يسجّل الموظفين حاضرين بمواعيد ورديّاتهم
        في أيام العمل ضمن المدى. لا يُمس يوم فيه بصمات فعلية، ولا أيام الراحة الأسبوعية
        والمجدولة ولا العطل الرسمية ولا الإجازات المعتمدة.</div>
      <div class="inline">
        <div class="field"><label>من تاريخ</label><input type="date" id="bpFrom" value="${monthStart()}" /></div>
        <div class="field"><label>إلى تاريخ</label><input type="date" id="bpTo" value="${today()}" /></div>
      </div>
      <div class="field"><label>الموظفون</label><select id="bpScope">
        <option value="all">كل الموظفين النشطين</option>
        <option value="one">موظف واحد</option></select></div>
      <div class="field hidden" id="bpEmpWrap"><label>الموظف</label>
        <select id="bpEmp">${options(employees, '', 'id', 'full_name')}</select></div>
      <div id="bpResult"></div>`,
    footer: `<button class="btn" id="bpSave">تسجيل الحضور</button><button class="btn gray" data-close>إلغاء</button>`,
    onOpen: (root) => {
      $('#bpScope', root).onchange = (e) =>
        $('#bpEmpWrap', root).classList.toggle('hidden', e.target.value !== 'one');
      $('#bpSave', root).onclick = async () => {
        const btn = $('#bpSave', root);
        btn.disabled = true;
        try {
          const body = { date_from: $('#bpFrom', root).value, date_to: $('#bpTo', root).value };
          if ($('#bpScope', root).value === 'one') body.employee_ids = [Number($('#bpEmp', root).value)];
          const r = await api('/api/attendance/mark-present', { method: 'POST', body });
          $('#bpResult', root).innerHTML = `<div class="help" style="margin-top:12px;line-height:2">
            <b>${esc(r.message)}</b><br>
            تُخطّي: ${r.skipped_existing} يوم فيه بصمات، ${r.skipped_rest} يوم راحة،
            ${r.skipped_holiday} عطلة رسمية، ${r.skipped_leave} يوم إجازة معتمدة،
            ${r.skipped_before_hire} قبل التعيين.</div>`;
          toast(r.message, 'ok');
          if (after) after();
        } catch (e) { toast(e.message, 'err'); }
        btn.disabled = false;
      };
    },
  });
}

function downloadCsv(url, filename) {
  fetch(url, { headers: { Authorization: 'Bearer ' + state.token } })
    .then((r) => { if (!r.ok) throw new Error('تعذر التصدير'); return r.blob(); })
    .then((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename; a.click();
      URL.revokeObjectURL(a.href);
    })
    .catch((e) => toast(e.message, 'err'));
}

/** يفتح صفحة HTML محمية (قسيمة راتب) في تبويب جديد مع ترويسة المصادقة */
async function openAuthedDocument(url, fallbackTitle = 'مستند') {
  const tab = window.open('', '_blank');
  if (tab) {
    tab.document.write(
      `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
       <title>${esc(fallbackTitle)}</title></head>
       <body style="font-family:Tahoma;padding:40px;text-align:center;color:#64748b">
       جارٍ تجهيز المستند…</body></html>`);
  }
  try {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + state.token } });
    if (!res.ok) {
      let message = 'تعذر فتح المستند';
      try { message = (await res.json()).detail || message; } catch (e) { /* تجاهل */ }
      throw new Error(message);
    }
    const html = await res.text();
    if (tab) {
      tab.document.open();
      tab.document.write(html);
      tab.document.close();
    } else {
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      window.open(URL.createObjectURL(blob), '_blank');
    }
  } catch (e) {
    if (tab) tab.close();
    toast(e.message, 'err');
  }
}
window.printPayslip = (id) => openAuthedDocument(`/api/payroll/payslips/${id}/print`, 'قسيمة راتب');
window.printRun = (id) => openAuthedDocument(`/api/payroll/runs/${id}/print`, 'قسائم الرواتب');

/* ------------------------------ سجل البصمات ------------------------------ */
views.punches = async () => {
  const { employees } = await loadLookups();
  render(`
    <div class="card"><div class="card-body inline">
      <div class="field"><label>من</label><input type="date" id="pFrom" value="${monthStart()}" /></div>
      <div class="field"><label>إلى</label><input type="date" id="pTo" value="${today()}" /></div>
      <div class="field"><label>الموظف</label><select id="pEmp"><option value="">الكل</option>${options(employees, '', 'id', 'full_name')}</select></div>
      <button class="btn" id="pLoad">عرض</button>
      ${isHR() ? '<button class="btn ok" id="pManual">بصمة يدوية</button>' : ''}
    </div></div>
    <div class="card"><div class="card-head"><h3>البصمات الخام</h3><span class="muted" id="pCount"></span></div>
      <div id="pTable"><div class="empty">جارٍ التحميل…</div></div></div>`);
  let rowsCache = [];
  const load = async () => {
    const q = new URLSearchParams({ date_from: el('pFrom').value, date_to: el('pTo').value, limit: 500 });
    if (el('pEmp').value) q.set('employee_id', el('pEmp').value);
    const rows = await api('/api/attendance/punches?' + q);
    rowsCache = rows;
    el('pCount').textContent = `${rows.length} بصمة`;
    el('pTable').innerHTML = table(
      ['الوقت', 'رقم الموظف', 'الاسم', 'المصدر', 'الجهاز / الموقع', 'المسافة', 'الخريطة', 'ملاحظة', ''],
      rows,
      (r) => `<tr><td>${fmtDateTime(r.punch_time)}</td><td>${esc(r.employee_code)}</td>
        <td>${esc(r.employee_name || 'غير مرتبط')}</td><td>${SOURCES[r.source] || r.source}</td>
        <td>${esc(r.device_name || r.site_name || '—')}</td>
        <td>${r.distance_meters !== null && r.distance_meters !== undefined ? Math.round(r.distance_meters) + ' م' : '—'}</td>
        <td>${r.latitude ? `<a href="https://www.openstreetmap.org/?mlat=${r.latitude}&mlon=${r.longitude}#map=18/${r.latitude}/${r.longitude}" target="_blank" rel="noopener">عرض</a>` : '—'}</td>
        <td>${esc(r.note || '')}</td>
        <td>${isHR() ? `<button class="btn sm ghost" onclick="editPunch(${r.id})">تعديل</button>
          <button class="btn sm danger" onclick="deletePunch(${r.id})">حذف</button>` : ''}</td></tr>`,
      'لا توجد بصمات في هذه الفترة');
  };
  el('pLoad').onclick = () => load().catch((e) => toast(e.message, 'err'));
  if (el('pManual')) el('pManual').onclick = () => manualPunchModal(employees, load);
  // التعديل والحذف يتطلبان سبباً يُحفظ في سجل التدقيق مع القيمة القديمة والجديدة
  window.editPunch = (id) => {
    const row = rowsCache.find((r) => r.id === id);
    if (!row) return;
    modal({
      title: 'تعديل بصمة',
      body: `<div class="help" style="margin-bottom:12px">يُحفظ في سجل التدقيق: من عدّل،
          ومتى، والقيمة القديمة والجديدة، والسبب.</div>
        <div class="field"><label>الوقت</label>
          <input type="datetime-local" id="epTime" value="${esc(String(row.punch_time).slice(0, 16))}" /></div>
        <div class="field"><label>نوع الحدث (اتركه تلقائياً ليحدّده النظام من الحالة)</label>
          <select id="epIntent">
            <option value="auto">تلقائي حسب الحالة</option>
            <option value="clock_in">حضور</option>
            <option value="break_start">بدء استراحة</option>
            <option value="break_end">عودة من الاستراحة</option>
            <option value="clock_out">انصراف</option></select></div>
        <div class="field"><label>سبب التعديل (إلزامي)</label>
          <input id="epReason" placeholder="مثال: الجهاز كان متأخراً 35 دقيقة" /></div>`,
      footer: '<button class="btn" id="epSave">حفظ</button><button class="btn gray" data-close>إلغاء</button>',
      onOpen: (root) => {
        $('#epSave', root).onclick = async () => {
          const reason = $('#epReason', root).value.trim();
          if (reason.length < 3) return toast('اكتب سبب التعديل', 'err');
          try {
            await api('/api/attendance/punches/' + id, { method: 'PATCH', body: {
              punch_time: $('#epTime', root).value + ':00',
              intent: $('#epIntent', root).value,
              reason } });
            toast('عُدّلت البصمة وسُجّل الأثر', 'ok'); closeModal(); load();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  };
  window.deletePunch = (id) => {
    modal({
      title: 'حذف بصمة',
      body: `<div class="help" style="margin-bottom:12px">لا يُمحى السجل من قاعدة البيانات:
          يُستبعد من الاحتساب ويبقى أثره كاملاً في سجل التدقيق.</div>
        <div class="field"><label>سبب الحذف (إلزامي)</label>
          <input id="dpReason" placeholder="مثال: بصمة خاطئة لموظف آخر" /></div>`,
      footer: '<button class="btn danger" id="dpSave">حذف</button><button class="btn gray" data-close>إلغاء</button>',
      onOpen: (root) => {
        $('#dpSave', root).onclick = async () => {
          const reason = $('#dpReason', root).value.trim();
          if (reason.length < 3) return toast('اكتب سبب الحذف', 'err');
          try {
            await api('/api/attendance/punches/' + id, { method: 'DELETE', body: { reason } });
            toast('حُذفت البصمة وسُجّل الأثر', 'ok'); closeModal(); load();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  };
  load();
};

/* ------------------------------ الإجازات ------------------------------ */
views.leaves = async () => {
  const { employees, leaveTypes } = await loadLookups();
  const canDecide = can('admin', 'hr', 'manager');
  render(`
    <div class="card"><div class="card-body inline">
      <button class="btn" id="newLeave">طلب إجازة جديد</button>
      <div class="field"><label>الحالة</label><select id="lStatus"><option value="">الكل</option>
        ${Object.entries(LEAVE_STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      ${canDecide ? `<div class="field"><label>الموظف</label><select id="lEmp"><option value="">الكل</option>${options(employees, '', 'id', 'full_name')}</select></div>` : ''}
      <button class="btn ghost" id="lLoad">تحديث</button>
      ${canDecide ? `<button class="btn ghost" id="lExport">تصدير CSV</button>` : ''}
    </div></div>
    <div class="card"><div class="card-head">
        <h3>طلبات الإجازة <span class="muted" id="lCount" style="font-weight:400;font-size:13px"></span></h3>
        <div class="sub-tabs" style="margin:0">
          <button id="lModeCards" class="active">${icon('dashboard')} بطاقات</button>
          <button id="lModeTable">${icon('menu')} جدول</button>
        </div></div>
      <div id="lTable"><div class="sk-rows">${'<div class="sk line"></div>'.repeat(4)}</div></div></div>`);

  const actionsFor = (r) => {
    let actions = '';
    if (r.status === 'pending' && canDecide) {
      actions += `<button class="btn sm ok" onclick="decideLeave(${r.id},'approve')">اعتماد</button>
                  <button class="btn sm danger" onclick="decideLeave(${r.id},'reject')">رفض</button> `;
    }
    const mine = state.user.employee_id === r.employee_id;
    if (r.status === 'pending' && mine) actions += `<button class="btn sm gray" onclick="decideLeave(${r.id},'cancel')">إلغاء</button>`;
    if (r.status === 'approved' && isHR()) actions += `<button class="btn sm gray" onclick="decideLeave(${r.id},'cancel')">إلغاء</button>`;
    if (r.attachment_path) actions += ` <a class="btn sm ghost" href="/uploads/${encodeURIComponent(r.attachment_path)}" target="_blank">المرفق</a>`;
    if (r.status === 'pending' && mine) actions += ` <button class="btn sm ghost" onclick="attachLeave(${r.id})">إرفاق</button>`;
    return actions;
  };
  const cardsHtml = (rows) => rows.length ? `<div class="card-body"><div class="grid cards stagger">
      ${rows.map((r) => `<div class="emp-card" style="cursor:default">
        <div class="top">${avatar(r.employee_name)}
          <div style="min-width:0"><div class="name">${esc(r.employee_name)}</div>
            <div class="role">${esc(r.leave_type_name)} — ${r.days} يوم</div></div></div>
        <div class="meta"><span class="chip">من ${r.start_date}</span><span class="chip">إلى ${r.end_date}</span></div>
        ${r.reason ? `<div class="help" style="margin-bottom:8px">${esc(r.reason)}</div>` : ''}
        <div class="foot"><span class="tag ${r.status}">${LEAVE_STATUS[r.status]}</span>
          <span style="display:flex;gap:5px;flex-wrap:wrap">${actionsFor(r)}</span></div>
      </div>`).join('')}</div></div>`
    : `<div class="empty">${icon('leave', 'lg')}<br>لا توجد طلبات مطابقة</div>`;

  let currentRows = [];
  const paint = () => {
    const mode = localStorage.getItem('hr_leave_view') || 'cards';
    el('lModeCards').classList.toggle('active', mode === 'cards');
    el('lModeTable').classList.toggle('active', mode !== 'cards');
    el('lTable').innerHTML = mode === 'cards' ? cardsHtml(currentRows) : tableHtml(currentRows);
  };

  const load = async () => {
    const q = new URLSearchParams();
    if (el('lStatus').value) q.set('status', el('lStatus').value);
    if (el('lEmp') && el('lEmp').value) q.set('employee_id', el('lEmp').value);
    currentRows = await api('/api/leave-requests?' + q);
    el('lCount').textContent = `(${currentRows.length} طلب)`;
    paint();
  };

  const tableHtml = (rows) => table(
      ['#', 'الموظف', 'النوع', 'من', 'إلى', 'الأيام', 'الحالة', 'السبب', 'إجراءات'],
      rows,
      (r) => `<tr><td>${r.id}</td>
          <td><div style="display:flex;align-items:center;gap:9px">${avatar(r.employee_name, 'sm')}
            <span>${esc(r.employee_name)}</span></div></td>
          <td>${esc(r.leave_type_name)}</td>
          <td>${r.start_date}</td><td>${r.end_date}</td><td>${r.days}</td>
          <td><span class="tag ${r.status}">${LEAVE_STATUS[r.status]}</span></td>
          <td>${esc(r.reason || '')}</td><td>${actionsFor(r)}</td></tr>`,
      'لا توجد طلبات');

  el('lModeCards').onclick = () => { localStorage.setItem('hr_leave_view', 'cards'); paint(); };
  el('lModeTable').onclick = () => { localStorage.setItem('hr_leave_view', 'table'); paint(); };

  el('lLoad').onclick = () => load().catch((e) => toast(e.message, 'err'));
  if (el('lExport')) el('lExport').onclick = () =>
    downloadCsv('/api/leave-requests-export.csv?year=' + new Date().getFullYear(), 'leaves.csv');
  el('newLeave').onclick = () => leaveModal(employees, leaveTypes, load);

  window.decideLeave = async (id, action) => {
    let note = null;
    if (action !== 'cancel') {
      note = prompt(action === 'approve' ? 'ملاحظة الاعتماد (اختياري)' : 'سبب الرفض (اختياري)', '');
      if (note === null && action === 'reject') return;
    } else if (!confirm('تأكيد إلغاء الطلب؟')) return;
    try {
      await api(`/api/leave-requests/${id}/${action}`, { method: 'POST', body: { decision_note: note } });
      toast('تم تنفيذ الإجراء', 'ok'); load();
    } catch (e) { toast(e.message, 'err'); }
  };
  window.attachLeave = (id) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.pdf,.png,.jpg,.jpeg,.webp';
    input.onchange = async () => {
      const fd = new FormData(); fd.append('file', input.files[0]);
      try { await api(`/api/leave-requests/${id}/attachment`, { method: 'POST', body: fd });
        toast('تم رفع المرفق', 'ok'); load(); } catch (e) { toast(e.message, 'err'); }
    };
    input.click();
  };
  load();
};

function leaveModal(employees, leaveTypes, after) {
  const forOthers = isHR();
  modal({
    title: 'طلب إجازة جديد',
    body: `
      ${forOthers ? `<div class="field"><label>الموظف</label><select id="lrEmp">${options(employees, state.user.employee_id, 'id', 'full_name')}</select></div>` : ''}
      <div class="field"><label>نوع الإجازة</label><select id="lrType">${options(leaveTypes.filter((t) => t.is_active))}</select></div>
      <div class="inline">
        <div class="field" style="flex:1"><label>من تاريخ</label><input type="date" id="lrFrom" value="${today()}" /></div>
        <div class="field" style="flex:1"><label>إلى تاريخ</label><input type="date" id="lrTo" value="${today()}" /></div>
      </div>
      <div class="field"><label>السبب</label><textarea id="lrReason" rows="3" placeholder="اختياري"></textarea></div>
      <div class="help" id="lrPreview">اختر النوع والتواريخ لعرض عدد الأيام والرصيد.</div>`,
    footer: `<button class="btn" id="lrSave">إرسال الطلب</button><button class="btn gray" data-close>إلغاء</button>`,
    onOpen: (root) => {
      const payload = () => ({
        employee_id: el('lrEmp') ? Number(el('lrEmp').value) : state.user.employee_id,
        leave_type_id: Number(el('lrType').value),
        start_date: el('lrFrom').value, end_date: el('lrTo').value,
        reason: el('lrReason').value || null,
      });
      const preview = async () => {
        try {
          const r = await api('/api/leave-requests/preview', { method: 'POST', body: payload() });
          el('lrPreview').innerHTML = r.remaining_days === null || r.remaining_days === undefined
            ? `عدد الأيام المحتسبة: <b>${r.days}</b>`
            : `عدد الأيام المحتسبة: <b>${r.days}</b> — الرصيد الحالي: <b>${r.remaining_days}</b>` +
              (r.after_request !== null ? ` — المتبقي بعد الطلب: <b>${r.after_request}</b>` : ' — (لا يخصم من الرصيد)');
        } catch (e) { el('lrPreview').textContent = e.message; }
      };
      ['lrType', 'lrFrom', 'lrTo', 'lrEmp'].forEach((id) => { if (el(id)) el(id).onchange = preview; });
      preview();
      $('#lrSave', root).onclick = async () => {
        try {
          await api('/api/leave-requests', { method: 'POST', body: payload() });
          toast('تم إرسال الطلب', 'ok'); closeModal(); if (after) after();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

/* ------------------------------ إجازاتي (واجهة الموظف) ------------------------------ */
const REQ_KINDS = {
  leave: ['leave', 'إجازة'],
  punch: ['edit', 'بصمة فائتة'],
  loan: ['loans', 'سلفة'],
  general: ['documents', 'طلب عام'],
};
const REQ_CATEGORIES = {
  certificate: 'تعريف أو شهادة',
  shift_change: 'تغيير وردية أو راحة',
  data_update: 'تصحيح بيانات',
  complaint: 'شكوى',
  suggestion: 'اقتراح',
  other: 'طلب آخر',
};

/** شاشة الطلبات: كل ما يرفعه الموظف من هنا — إجازة، بصمة فائتة، سلفة، وطلب عام */
views.myLeaves = async () => {
  const year = new Date().getFullYear();
  if (!state.user.employee_id) {
    render(`<div class="card"><div class="card-body">
      <div class="empty">حسابك غير مرتبط بملف موظف، لذلك لا يمكنك تقديم طلبات.
      راجع الموارد البشرية لربط الحساب باسمك في قائمة الموظفين.</div></div></div>`);
    return;
  }
  const [leaveTypes, settings] = await Promise.all([
    api('/api/leave-types'),
    api('/api/settings').catch(() => ({ show_leave_balance_to_employee: false })),
  ]);
  const showBalance = !!settings.show_leave_balance_to_employee && !!settings.leave_balances_enabled;

  render(`
    <div class="card"><div class="card-head"><h3>تقديم طلب جديد</h3></div>
      <div class="card-body">
        <div class="quick4">
          <a class="q blue" id="reqLeave"><span class="qi">${icon('leave')}</span>إجازة</a>
          <a class="q amber" id="reqPunch"><span class="qi">${icon('edit')}</span>بصمة فائتة</a>
          <a class="q green" id="reqLoan"><span class="qi">${icon('loans')}</span>سلفة</a>
          <a class="q rose" id="reqOther"><span class="qi">${icon('documents')}</span>طلب آخر</a>
        </div>
        <div class="help" style="margin-top:10px">كل طلباتك ترفعها من هنا، وتتابع حالتها في
          القائمة أدناه. تظهر لك طلباتك أنت فقط.</div>
      </div></div>

    ${showBalance ? `<div class="card"><div class="card-head"><h3>رصيدي لعام ${year}</h3></div>
      <div id="mlBal"><div class="empty">جارٍ التحميل…</div></div></div>` : ''}

    <div class="card"><div class="card-head"><h3>طلباتي</h3>
      <span class="muted" id="mlCount"></span></div>
      <div id="mlList"><div class="sk-rows">${'<div class="sk line"></div>'.repeat(3)}</div></div></div>`);

  const load = async () => {
    const [balances, data] = await Promise.all([
      showBalance ? api('/api/leave-balances?year=' + year) : Promise.resolve([]),
      api('/api/me/requests'),
    ]);
    if (el('mlBal')) el('mlBal').innerHTML = balances.length
      ? `<div class="card-body">${balances.map((b) => {
          const total = b.entitled_days + b.carried_over_days;
          const pct = total ? (b.remaining_days / total) * 100 : 0;
          return meter(b.leave_type_name, `${b.remaining_days} متبقٍ من ${total} يوم` +
            (b.used_days ? ` — استُخدم ${b.used_days}` : ''), pct,
            pct > 50 ? 'ok' : pct > 20 ? 'warn' : 'danger');
        }).join('')}</div>`
      : '<div class="empty">لا توجد أرصدة مسجّلة</div>';

    const rows = data.rows || [];
    el('mlCount').textContent = `${rows.length} طلب` +
      (data.pending ? ` — ${data.pending} قيد الاعتماد` : '');
    el('mlList').innerHTML = rows.length ? rows.map((r) => {
      const [iconName] = REQ_KINDS[r.kind] || ['documents', ''];
      const actions = [];
      if (r.can_cancel) actions.push(
        `<button class="btn sm gray" onclick="cancelRequest('${r.kind}',${r.id})">إلغاء</button>`);
      if (r.kind === 'leave' && r.status === 'pending') actions.push(
        `<button class="btn sm ghost" onclick="attachMyLeave(${r.id})">إرفاق</button>`);
      if (r.needs_ack) actions.push(
        `<button class="btn sm ok" onclick="acknowledgeLoanRow(${r.id})">أقرّ بالاستلام</button>`);
      if (r.attachment) actions.push(
        `<a class="btn sm ghost" href="/uploads/${encodeURIComponent(r.attachment)}"
            target="_blank" rel="noopener">المرفق</a>`);
      return `<div class="row-item" style="align-items:flex-start">
        <span class="ri ${r.status === 'approved' ? 'ok' : r.status === 'rejected' ? 'danger' : ''}">${icon(iconName)}</span>
        <div class="rt"><b>${esc(r.title)}</b>
          <span>${esc(r.kind_label)}${r.detail ? ' · ' + esc(r.detail) : ''}</span>
          ${r.note ? `<div class="muted" style="font-size:11.5px;margin-top:3px">${esc(r.note)}</div>` : ''}
          ${r.decision_note ? `<div class="muted" style="font-size:11.5px;margin-top:3px">
            رد الإدارة: ${esc(r.decision_note)}</div>` : ''}
          ${actions.length ? `<div class="inline" style="margin-top:7px;gap:6px">${actions.join('')}</div>` : ''}
        </div>
        <div class="rv"><span class="tag ${r.status}">${esc(r.status_label)}</span>
          <small>${r.at ? String(r.at).slice(0, 10) : ''}</small></div>
      </div>`;
    }).join('') : '<div class="empty">لم تقدّم أي طلب بعد</div>';
  };

  el('reqLeave').onclick = () => leaveModal([], leaveTypes, load);
  el('reqPunch').onclick = () => missedPunchModal(load);
  el('reqLoan').onclick = () => loanRequestModal(load);
  el('reqOther').onclick = () => generalRequestModal(load);

  window.cancelRequest = async (kind, id) => {
    if (!confirm('تأكيد إلغاء الطلب؟')) return;
    const paths = {
      leave: () => api(`/api/leave-requests/${id}/cancel`, { method: 'POST', body: { decision_note: null } }),
      punch: () => api('/api/punch-requests/' + id, { method: 'DELETE' }),
      general: () => api('/api/requests/' + id, { method: 'DELETE' }),
    };
    try { await (paths[kind] || paths.general)(); toast('أُلغي الطلب', 'ok'); load(); }
    catch (e) { toast(e.message, 'err'); }
  };
  window.acknowledgeLoanRow = async (id) => {
    if (!confirm('أقرّ باستلام مبلغ السلفة؟ سيبدأ خصم الأقساط من راتبك.')) return;
    try { await api(`/api/loans/${id}/acknowledge`, { method: 'POST' });
      toast('سُجّل إقرارك بالاستلام', 'ok'); load(); }
    catch (e) { toast(e.message, 'err'); }
  };
  window.attachMyLeave = async (id) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.png,.jpg,.jpeg';
    input.onchange = async () => {
      if (!input.files.length) return;
      const fd = new FormData();
      fd.append('file', input.files[0]);
      try { await api(`/api/leave-requests/${id}/attachment`, { method: 'POST', body: fd });
        toast('أُرفق الملف', 'ok'); load(); }
      catch (e) { toast(e.message, 'err'); }
    };
    input.click();
  };
  load().catch((e) => toast(e.message, 'err'));
};

/** طلب سلفة من شاشة الطلبات */
function loanRequestModal(after) {
  const now = new Date();
  modal({
    title: 'طلب سلفة على الراتب',
    body: `<div class="help" style="margin-bottom:12px">يُرفع الطلب للموارد البشرية،
        وبعد اعتماده تُقرّ أنت باستلام المبلغ ليبدأ الخصم.</div>
      <div class="inline">
        <div class="field" style="flex:1"><label>المبلغ المطلوب</label>
          <input type="number" id="lrAmount" value="1000" /></div>
        <div class="field" style="flex:1"><label>القسط الشهري</label>
          <input type="number" id="lrInst" value="250" /></div>
      </div>
      <div class="inline">
        <div class="field" style="flex:1"><label>يبدأ الخصم من شهر</label><select id="lrMonth">${
          MONTHS.map((m, i) => `<option value="${i + 1}" ${i === now.getMonth() ? 'selected' : ''}>${m}</option>`).join('')
        }</select></div>
        <div class="field" style="flex:1"><label>السنة</label>
          <input type="number" id="lrYear" value="${now.getFullYear()}" /></div>
      </div>
      <div class="field"><label>السبب</label><input id="lrReason" placeholder="ظرف عائلي" /></div>`,
    footer: '<button class="btn" id="lrSave">إرسال الطلب</button><button class="btn gray" data-close>إلغاء</button>',
    onOpen: (root) => {
      $('#lrSave', root).onclick = async () => {
        try {
          await api('/api/loans/request', { method: 'POST', body: {
            amount: Number($('#lrAmount', root).value),
            installment_amount: Number($('#lrInst', root).value),
            start_year: Number($('#lrYear', root).value),
            start_month: Number($('#lrMonth', root).value),
            reason: $('#lrReason', root).value.trim() || null } });
          toast('أُرسل طلب السلفة', 'ok'); closeModal(); if (after) after();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

/** طلب عام: تعريف، تغيير وردية، شكوى، اقتراح، أو غيرها */
function generalRequestModal(after) {
  modal({
    title: 'طلب جديد',
    body: `<div class="field"><label>نوع الطلب</label><select id="grCat">${
      Object.entries(REQ_CATEGORIES).map(([k, v]) =>
        `<option value="${k}">${v}</option>`).join('')}</select></div>
      <div class="field"><label>الموضوع</label>
        <input id="grSubject" placeholder="مثال: طلب تعريف بالراتب للبنك" /></div>
      <div class="field"><label>التفاصيل</label>
        <textarea id="grBody" rows="4" placeholder="اكتب ما تريد بالتفصيل"></textarea></div>`,
    footer: '<button class="btn" id="grSave">إرسال</button><button class="btn gray" data-close>إلغاء</button>',
    onOpen: (root) => {
      $('#grSave', root).onclick = async () => {
        const subject = $('#grSubject', root).value.trim();
        const body = $('#grBody', root).value.trim();
        if (subject.length < 3 || body.length < 3) return toast('اكتب الموضوع والتفاصيل', 'err');
        try {
          await api('/api/requests', { method: 'POST', body: {
            category: $('#grCat', root).value, subject, body } });
          toast('أُرسل الطلب', 'ok'); closeModal(); if (after) after();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

/* ------------------------------ صندوق الطلبات العامة (الإدارة) ------------------------------ */
views.requests = async () => {
  render(`
    <div class="card"><div class="card-body inline">
      <div class="field"><label>الحالة</label><select id="rqStatus">
        <option value="pending">قيد الاعتماد</option><option value="">الكل</option>
        <option value="approved">معتمد</option><option value="rejected">مرفوض</option>
        <option value="cancelled">ملغى</option></select></div>
      <button class="btn ghost" id="rqLoad">عرض</button>
      <span class="help">طلبات الموظفين العامة: تعريف، تغيير وردية، شكوى، اقتراح، وغيرها.</span>
    </div></div>
    <div class="card"><div class="card-head"><h3>طلبات الموظفين</h3>
      <span class="muted" id="rqCount"></span></div>
      <div id="rqList"><div class="sk-rows">${'<div class="sk line"></div>'.repeat(3)}</div></div></div>`);

  const load = async () => {
    const q = new URLSearchParams();
    if (el('rqStatus').value) q.set('status', el('rqStatus').value);
    const rows = await api('/api/requests?' + q);
    el('rqCount').textContent = `${rows.length} طلب`;
    el('rqList').innerHTML = rows.length ? rows.map((r) => `
      <div class="row-item" style="align-items:flex-start">
        <span class="ri">${icon('documents')}</span>
        <div class="rt"><b>${esc(r.subject)}</b>
          <span>${esc(r.employee_name || '')} · ${esc(r.category_label)}</span>
          <div class="muted" style="font-size:12px;margin-top:4px">${esc(r.body)}</div>
          ${r.decision_note ? `<div class="muted" style="font-size:11.5px;margin-top:3px">
            الرد: ${esc(r.decision_note)}</div>` : ''}
          ${r.status === 'pending' ? `<div class="inline" style="margin-top:7px;gap:6px">
            <button class="btn sm ok" onclick="decideRequest(${r.id},true)">اعتماد</button>
            <button class="btn sm danger" onclick="decideRequest(${r.id},false)">رفض</button>
          </div>` : ''}
        </div>
        <div class="rv"><span class="tag ${r.status}">${esc(r.status_label)}</span>
          <small>${r.created_at ? String(r.created_at).slice(0, 10) : ''}</small></div>
      </div>`).join('') : '<div class="empty">لا طلبات</div>';
  };
  el('rqLoad').onclick = () => load().catch((e) => toast(e.message, 'err'));
  el('rqStatus').onchange = () => load().catch((e) => toast(e.message, 'err'));

  window.decideRequest = (id, approve) => modal({
    title: approve ? 'اعتماد الطلب' : 'رفض الطلب',
    body: `<div class="field"><label>رد الإدارة${approve ? ' (اختياري)' : ' / السبب'}</label>
      <textarea id="rdNote" rows="3" placeholder="${approve
        ? 'مثال: التعريف جاهز للاستلام من المكتب' : 'مثال: لا يمكن تغيير الوردية هذا الشهر'}"></textarea></div>`,
    footer: `<button class="btn ${approve ? '' : 'danger'}" id="rdSave">${approve ? 'اعتماد' : 'رفض'}</button>
      <button class="btn gray" data-close>إلغاء</button>`,
    onOpen: (root) => {
      $('#rdSave', root).onclick = async () => {
        try {
          await api(`/api/requests/${id}/decide`, { method: 'POST', body: {
            approve, note: $('#rdNote', root).value.trim() || null } });
          toast(approve ? 'اعتُمد الطلب' : 'رُفض الطلب', 'ok'); closeModal(); load();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
  load().catch((e) => toast(e.message, 'err'));
};

/* ------------------------------ أرصدة الإجازات ------------------------------ */
views.balances = async () => {
  const settings = state.cache.settings || (state.cache.settings = await api('/api/settings'));
  if (!settings.leave_balances_enabled) {
    render(`<div class="card"><div class="card-body"><div class="empty">
      نظام أرصدة الإجازات معطّل، والاعتماد على طلبات الموظفين وقرار الإدارة.<br />
      لإعادة تفعيله: الإعدادات ← التنبيهات ← الإجازات والراحة الشهرية ← أرصدة الإجازات.
      </div></div></div>`);
    return;
  }
  const { employees } = await loadLookups();
  const year = new Date().getFullYear();
  render(`
    <div class="card"><div class="card-body inline">
      ${isHR() ? `<div class="field"><label>الموظف</label><select id="bEmp"><option value="">الكل</option>${options(employees, '', 'id', 'full_name')}</select></div>` : ''}
      <div class="field"><label>السنة</label><input type="number" id="bYear" value="${year}" /></div>
      <button class="btn" id="bLoad">عرض</button>
    </div></div>
    <div class="card"><div class="card-head"><h3>الأرصدة</h3></div><div id="bTable"><div class="empty">جارٍ التحميل…</div></div></div>`);
  const load = async () => {
    const q = new URLSearchParams({ year: el('bYear').value });
    if (el('bEmp') && el('bEmp').value) q.set('employee_id', el('bEmp').value);
    const rows = await api('/api/leave-balances?' + q);
    el('bTable').innerHTML = table(
      ['الموظف', 'نوع الإجازة', 'السنة', 'المستحق', 'مرحّل', 'المستخدم', 'المتبقي', ''],
      rows,
      (r) => `<tr><td>${esc(r.employee_name)}</td><td>${esc(r.leave_type_name)}</td><td>${r.year}</td>
        <td>${r.entitled_days}</td><td>${r.carried_over_days}</td><td>${r.used_days}</td>
        <td><b>${r.remaining_days}</b></td>
        <td>${isHR() ? `<button class="btn sm ghost" onclick="editBalance(${r.employee_id},${r.leave_type_id},${r.year},${r.entitled_days},${r.carried_over_days})">تعديل</button>` : ''}</td></tr>`,
      'لا توجد أرصدة');
  };
  el('bLoad').onclick = () => load().catch((e) => toast(e.message, 'err'));
  window.editBalance = (employee_id, leave_type_id, y, entitled, carried) => {
    modal({
      title: 'تعديل الرصيد',
      body: `<div class="field"><label>الأيام المستحقة</label><input type="number" step="0.5" id="beEnt" value="${entitled}" /></div>
             <div class="field"><label>الأيام المرحّلة</label><input type="number" step="0.5" id="beCar" value="${carried}" /></div>`,
      footer: `<button class="btn" id="beSave">حفظ</button><button class="btn gray" data-close>إلغاء</button>`,
      onOpen: (root) => { $('#beSave', root).onclick = async () => {
        try {
          await api('/api/leave-balances', { method: 'PUT', body: { employee_id, leave_type_id, year: y,
            entitled_days: Number(el('beEnt').value), carried_over_days: Number(el('beCar').value) } });
          toast('تم تحديث الرصيد', 'ok'); closeModal(); load();
        } catch (e) { toast(e.message, 'err'); }
      }; },
    });
  };
  load();
};

/* ------------------------------ الموظفون ------------------------------ */
views.employees = async () => {
  const { departments, shifts } = await loadLookups(true);
  const mode = localStorage.getItem('hr_emp_view') || 'cards';
  render(`
    <div class="card"><div class="card-body inline">
      <div class="field"><label>بحث</label><input id="eQ" placeholder="الاسم أو رقم الموظف" /></div>
      <div class="field"><label>الإدارة</label><select id="eDep"><option value="">الكل</option>${options(departments)}</select></div>
      <button class="btn" id="eLoad">${icon('search')} بحث</button>
      ${isHR() ? `<button class="btn ok" id="eNew">${icon('plus')} إضافة موظف</button>` : ''}
      ${isHR() ? `<button class="btn ghost" id="eExport">${icon('download')} تصدير CSV</button>` : ''}
      ${isHR() ? `<button class="btn gray" id="eImport">${icon('upload')} استيراد من Excel</button>` : ''}
    </div></div>
    <div class="card"><div class="card-head">
        <h3>قائمة الموظفين <span class="muted" id="eCount" style="font-weight:400;font-size:13px"></span></h3>
        <div class="sub-tabs" style="margin:0">
          <button id="eModeCards" class="${mode === 'cards' ? 'active' : ''}">${icon('dashboard')} بطاقات</button>
          <button id="eModeTable" class="${mode === 'table' ? 'active' : ''}">${icon('menu')} جدول</button>
        </div></div>
      <div id="eTable"><div class="sk-rows">${'<div class="sk line"></div>'.repeat(5)}</div></div></div>`);

  const statusTag = (r) => r.status === 'active'
    ? '<span class="tag active">على رأس العمل</span>'
    : r.status === 'suspended' ? '<span class="tag suspended">موقوف</span>'
    : '<span class="tag terminated">منتهية خدمته</span>';

  const cardsHtml = (rows) => rows.length ? `<div class="card-body"><div class="grid cards stagger">
      ${rows.map((r) => `<div class="emp-card" onclick="openProfile(${r.id})">
        <div class="top">${avatar(r.full_name)}
          <div style="min-width:0">
            <div class="name">${esc(r.full_name)}</div>
            <div class="role">${esc(r.job_title || 'بدون مسمى')}</div>
          </div></div>
        <div class="meta">
          <span class="chip">${icon('idcard', 'sm')} ${esc(r.code)}</span>
          <span class="chip">${icon('employees', 'sm')} ${esc(r.department_name || 'بدون إدارة')}</span>
          ${r.shift_name ? `<span class="chip">${icon('clock', 'sm')} ${esc(r.shift_name)}</span>` : ''}
          ${r.monthly_rest_quota !== null && r.monthly_rest_quota !== undefined
            ? `<span class="chip" title="رصيد راحة خاص بهذا الموظف">${icon('bed', 'sm')} راحة ${r.monthly_rest_quota}</span>` : ''}
        </div>
        <div class="foot">${statusTag(r)}
          <span>${r.has_user ? icon('key', 'sm') + ' له حساب دخول' : (r.phone ? '' : icon('phone', 'sm') + ' بلا جوال')}
            ${r.has_user ? '' : ' — خدمة ' + esc(serviceLength(r.hire_date))}</span></div>
      </div>`).join('')}
    </div></div>` : `<div class="empty">${icon('employees', 'lg')}<br>لا يوجد موظفون مطابقون</div>`;

  const tableHtml = (rows) => table(
    ['الموظف', 'الإدارة', 'المسمى الوظيفي', 'الوردية', 'تاريخ التعيين', 'مدة الخدمة', 'الحالة', ''],
    rows,
    (r) => `<tr>
      <td><div style="display:flex;align-items:center;gap:9px;cursor:pointer" onclick="openProfile(${r.id})">
        ${avatar(r.full_name, 'sm')}<div><div style="font-weight:600">${esc(r.full_name)}</div>
        <div class="muted" style="font-size:11.5px">${esc(r.code)}</div></div></div></td>
      <td>${esc(r.department_name || '—')}</td><td>${esc(r.job_title || '—')}</td>
      <td>${esc(r.shift_name || '—')}</td><td>${r.hire_date || '—'}</td>
      <td>${esc(serviceLength(r.hire_date))}</td>
      <td>${statusTag(r)}</td>
      <td><button class="btn sm ghost" onclick="openProfile(${r.id})">الملف</button>
        ${isHR() ? `<button class="btn sm ghost" onclick="editEmployee(${r.id})">تعديل</button>
             <button class="btn sm gray" onclick="makeUser(${r.id},'${esc(r.code)}')">حساب دخول</button>` : ''}</td></tr>`,
    'لا يوجد موظفون');

  let current = [];
  const paint = () => {
    const view = localStorage.getItem('hr_emp_view') || 'cards';
    el('eModeCards').classList.toggle('active', view === 'cards');
    el('eModeTable').classList.toggle('active', view === 'table');
    el('eTable').innerHTML = view === 'cards' ? cardsHtml(current) : tableHtml(current);
  };
  const load = async () => {
    const q = new URLSearchParams();
    if (el('eQ').value) q.set('q', el('eQ').value);
    if (el('eDep').value) q.set('department_id', el('eDep').value);
    current = await api('/api/employees?' + q);
    state.cache.lookups.employees = current;
    el('eCount').textContent = `(${current.length} موظف)`;
    paint();
  };
  el('eModeCards').onclick = () => { localStorage.setItem('hr_emp_view', 'cards'); paint(); };
  el('eModeTable').onclick = () => { localStorage.setItem('hr_emp_view', 'table'); paint(); };
  el('eQ').onkeydown = (ev) => { if (ev.key === 'Enter') load().catch((e) => toast(e.message, 'err')); };
  el('eLoad').onclick = () => load().catch((e) => toast(e.message, 'err'));
  if (el('eExport')) el('eExport').onclick = () => downloadCsv('/api/employees-export.csv', 'employees.csv');
  if (el('eNew')) el('eNew').onclick = () => employeeModal(null, departments, shifts, load);
  if (el('eImport')) el('eImport').onclick = () => importModal(load);
  window.editEmployee = async (id) => {
    const emp = await api('/api/employees/' + id);
    employeeModal(emp, departments, shifts, load);
  };
  window.makeUser = (employee_id, code) => {
    modal({
      title: 'إنشاء حساب دخول للموظف',
      body: `<div class="field"><label>اسم المستخدم</label><input id="uName" value="${esc(code)}" /></div>
        <div class="field"><label>كلمة المرور</label><input id="uPass" type="text" value="Aa123456" /></div>
        <div class="field"><label>الصلاحية</label><select id="uRole">
          <option value="employee">موظف</option><option value="manager">مدير إدارة</option>
          <option value="hr">موارد بشرية</option><option value="admin">مدير النظام</option></select></div>
        <div class="help">يستطيع الموظف الدخول باسم المستخدم أعلاه <b>أو برقم جواله المسجّل في ملفه</b>
          (بأي صيغة: 05… أو ‎+966…‎). تأكّد أن رقم جواله مسجّل وغير مكرر مع موظف آخر.</div>`,
      footer: `<button class="btn" id="uSave">إنشاء</button><button class="btn gray" data-close>إلغاء</button>`,
      onOpen: (root) => { $('#uSave', root).onclick = async () => {
        try {
          await api('/api/users', { method: 'POST', body: { username: el('uName').value,
            password: el('uPass').value, role: el('uRole').value, employee_id } });
          toast('تم إنشاء الحساب', 'ok'); closeModal(); load();
        } catch (e) { toast(e.message, 'err'); }
      }; },
    });
  };
  load();
};

const REST_QUOTA_CHOICES = [0, 1, 2, 4, 6, 8];
const restQuotaLabel = (n) => (n === 0 ? 'بلا راحة مجدولة'
  : n + ' ' + (n === 1 ? 'يوم' : n === 2 ? 'يومان' : 'أيام'));

/* بطاقة حساب الدخول داخل ملف الموظف */
function accountCard(a) {
  if (!a.has_user) {
    return `<div class="row-item"><span class="ri">${icon('lock')}</span>
      <div class="rt"><b>لا يوجد حساب دخول</b>
        <span>${esc(a.blocker || 'يمكن إنشاء الحساب الآن')}</span></div>
      <div class="rv"><button class="btn sm ok" id="acCreate" ${a.blocker ? 'disabled' : ''}>إنشاء حساب</button></div>
    </div>`;
  }
  const tags = [
    `<span class="tag ${a.is_active ? 'on' : 'off'}">${a.is_active ? 'الدخول مفعّل' : 'الدخول موقوف'}</span>`,
    a.must_change_password ? '<span class="tag pending">كلمة مرور مؤقتة</span>' : '',
    a.totp_enabled ? '<span class="tag on">تحقق بخطوتين</span>' : '',
  ].filter(Boolean).join(' ');
  return `<div class="row-item" style="align-items:flex-start">
    <span class="ri ${a.is_active ? 'ok' : 'danger'}">${icon('usercheck')}</span>
    <div class="rt"><b>اسم المستخدم: ${esc(a.username)}</b>
      <span>${tags}</span>
      <div class="muted" style="font-size:11.5px;margin-top:4px">آخر دخول:
        ${a.last_login ? esc(String(a.last_login).replace('T', ' ').slice(0, 16)) : 'لم يدخل بعد'}</div>
      <div class="inline" style="margin-top:7px;gap:6px">
        <button class="btn sm ghost" id="acReset">إعادة تعيين كلمة المرور</button>
        <button class="btn sm ${a.is_active ? 'danger' : 'ok'}" id="acToggle">${
          a.is_active ? 'إيقاف الدخول' : 'تفعيل الدخول'}</button>
      </div>
    </div></div>`;
}

function employeeModal(emp, departments, shifts, after) {
  const v = (k, d = '') => (emp && emp[k] !== null && emp[k] !== undefined ? emp[k] : d);
  modal({
    title: emp ? `تعديل بيانات ${emp.full_name}` : 'إضافة موظف',
    body: `<div class="grid cols-2">
      <div class="field"><label>رقم الموظف (نفس الرقم في جهاز البصمة)</label><input id="fCode" value="${esc(v('code'))}" /></div>
      <div class="field"><label>الاسم الكامل</label><input id="fName" value="${esc(v('full_name'))}" /></div>
      <div class="field"><label>الهوية / الإقامة</label><input id="fNid" value="${esc(v('national_id'))}" /></div>
      <div class="field"><label>الجوال</label><input id="fPhone" value="${esc(v('phone'))}" />
        <div class="help">بمجرد حفظ الرقم يُنشأ حساب دخول للموظف: اسم المستخدم وكلمة المرور
          المؤقتة هما الرقم نفسه، ويُطالَب بتغييرها عند أول دخول.</div></div>
      <div class="field"><label>البريد</label><input id="fEmail" value="${esc(v('email'))}" /></div>
      <div class="field"><label>المسمى الوظيفي</label><input id="fTitle" value="${esc(v('job_title'))}" /></div>
      <div class="field"><label>الإدارة</label><select id="fDep"><option value="">—</option>${options(departments, v('department_id'))}</select></div>
      <div class="field"><label>الوردية</label><select id="fShift"><option value="">—</option>${options(shifts, v('shift_id'))}</select></div>
      <div class="field" style="grid-column:1/-1"><label>أيام الراحة الأسبوعية (خاصة بهذا الموظف)</label>
        <div class="inline" style="gap:6px">${WEEK_DAYS.map(([d, name]) => {
          const rest = String(v('weekly_rest_days', '') || '').split(',').filter(Boolean);
          return `<label class="chip" style="cursor:pointer;gap:6px">
            <input type="checkbox" class="fRest" value="${d}" style="width:auto;margin:0"
              ${rest.includes(d) ? 'checked' : ''} /> ${name}</label>`;
        }).join('')}</div>
        <div class="help">اتركها فارغة ليتبع الموظف أيام عمل الوردية. تحديد يوم راحة يعني أنه يعمل بقية الأيام.</div>
      </div>
      <div class="field"><label>موقع العمل (للبصم من التطبيق)</label><select id="fSite"><option value="">كل المواقع المعتمدة</option>${options(state.cache.sites || [], v('site_id'))}</select></div>
      <div class="field"><label>تاريخ التعيين</label><input type="date" id="fHire" value="${v('hire_date')}" /></div>
      <div class="field"><label>الراتب الأساسي</label><input type="number" id="fSalary" value="${v('basic_salary', 0)}" /></div>
      <div class="field"><label>البدلات</label><input type="number" id="fAllow" value="${v('allowances', 0)}" />
        <div class="help">إجمالي الراتب = الأساسي + البدلات</div></div>
      <div class="field"><label>أيام الراحة الشهرية</label><select id="fRestQuota">
        <option value="">افتراضي المنشأة${emp && emp.rest_quota_default !== undefined
          ? ` (${restQuotaLabel(emp.rest_quota_default)})` : ''}</option>
        ${REST_QUOTA_CHOICES.map((n) => `<option value="${n}" ${
          emp && emp.monthly_rest_quota === n ? 'selected' : ''}>${restQuotaLabel(n)}</option>`).join('')}
        ${emp && emp.monthly_rest_quota !== null && emp.monthly_rest_quota !== undefined
          && !REST_QUOTA_CHOICES.includes(emp.monthly_rest_quota)
          ? `<option value="${emp.monthly_rest_quota}" selected>${restQuotaLabel(emp.monthly_rest_quota)}</option>` : ''}
        </select>
        <div class="help">رصيد هذا الموظف وحده من أيام الراحة المجدولة شهرياً.
          الشائع: يوم واحد، أو يومان، أو أربعة أيام. اتركه «افتراضي المنشأة» ليتبع الرقم العام.</div></div>
      <div class="field"><label>الاستراحة</label><select id="fNoBreak">
        <option value="false" ${!v('no_break') ? 'selected' : ''}>يأخذ استراحة</option>
        <option value="true" ${v('no_break') ? 'selected' : ''}>لا يأخذ استراحة</option></select>
        <div class="help">«لا يأخذ استراحة» تعني ألا تُخصم استراحة الوردية الثابتة من ساعاته،
          وأي استراحة يسجّلها تُحتسب تجاوزاً.</div></div>
      <div class="field"><label>الحالة</label><select id="fStatus">
        <option value="active" ${v('status') === 'active' ? 'selected' : ''}>على رأس العمل</option>
        <option value="suspended" ${v('status') === 'suspended' ? 'selected' : ''}>موقوف</option>
        <option value="terminated" ${v('status') === 'terminated' ? 'selected' : ''}>منتهية خدمته</option></select></div>
      ${emp ? `<div class="field" style="grid-column:1/-1"><label>حساب دخول الموظف</label>
        <div id="fAccount"><div class="sk line"></div></div>
        <div class="help">حساب الموظف يُدار من ملفه: إنشاؤه، إعادة كلمة مروره، أو إيقاف دخوله.
          اسم المستخدم وكلمة المرور المؤقتة هما رقم جواله، ويُطالَب بتغييرها عند أول دخول.</div>
      </div>` : ''}
      </div>`,
    footer: `<button class="btn" id="fSave">حفظ</button>
      ${emp ? `<button class="btn danger" id="fDel">حذف</button>` : ''}
      <button class="btn gray" data-close>إلغاء</button>`,
    width: 720,
    onOpen: (root) => {
      const paintAccount = async (data) => {
        const box = $('#fAccount', root);
        if (!box) return;
        try {
          const a = data || await api(`/api/employees/${emp.id}/account`);
          box.innerHTML = accountCard(a);
          const act = async (url, confirmText) => {
            if (confirmText && !confirm(confirmText)) return;
            try {
              const r = await api(url, { method: 'POST' });
              toast(r.message || 'تم', 'ok');
              paintAccount(r);
              loadLookups(true);
            } catch (e) { toast(e.message, 'err'); }
          };
          if ($('#acCreate', root)) $('#acCreate', root).onclick =
            () => act(`/api/employees/${emp.id}/account`);
          if ($('#acReset', root)) $('#acReset', root).onclick =
            () => act(`/api/employees/${emp.id}/account/reset`,
              'إعادة كلمة المرور إلى رقم الجوال وإنهاء جلسات الموظف؟');
          if ($('#acToggle', root)) $('#acToggle', root).onclick =
            () => act(`/api/employees/${emp.id}/account/toggle?active=${a.is_active ? 'false' : 'true'}`,
              a.is_active ? 'إيقاف دخول الموظف؟' : null);
        } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
      };
      if (emp) paintAccount();

      $('#fSave', root).onclick = async () => {
        const body = {
          code: el('fCode').value.trim(), full_name: el('fName').value.trim(),
          national_id: el('fNid').value || null, phone: el('fPhone').value || null,
          email: el('fEmail').value || null, job_title: el('fTitle').value || null,
          department_id: el('fDep').value ? Number(el('fDep').value) : null,
          shift_id: el('fShift').value ? Number(el('fShift').value) : null,
          site_id: el('fSite').value ? Number(el('fSite').value) : null,
          hire_date: el('fHire').value || null, basic_salary: Number(el('fSalary').value || 0),
          allowances: Number(el('fAllow').value || 0),
          weekly_rest_days: [...document.querySelectorAll('.fRest:checked')].map((c) => c.value).join(',') || null,
          no_break: el('fNoBreak').value === 'true',
          monthly_rest_quota: el('fRestQuota').value === '' ? null : Number(el('fRestQuota').value),
          status: el('fStatus').value,
        };
        try {
          if (emp) await api('/api/employees/' + emp.id, { method: 'PATCH', body });
          else await api('/api/employees', { method: 'POST', body });
          toast('تم الحفظ', 'ok'); closeModal(); loadLookups(true).then(after);
        } catch (e) { toast(e.message, 'err'); }
      };
      if (emp && $('#fDel', root)) $('#fDel', root).onclick = async () => {
        if (!confirm('حذف الموظف وكل سجلاته؟')) return;
        try { await api('/api/employees/' + emp.id, { method: 'DELETE' });
          toast('تم الحذف', 'ok'); closeModal(); loadLookups(true).then(after); }
        catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}


function importModal(after) {
  modal({
    title: 'استيراد الموظفين من ملف',
    body: `<div class="help" style="margin-bottom:14px">
        ارفع ملف <b>Excel (.xlsx)</b> أو <b>CSV</b> بالأعمدة التالية بالترتيب:
        <br><code>رقم الموظف | الاسم | الإدارة | المسمى الوظيفي | الجوال | البريد | الهوية | تاريخ التعيين | الراتب الأساسي | الوردية</code>
        <br>الإدارة تُنشأ تلقائياً إن لم تكن موجودة، ورقم الموظف يجب أن يطابق رقم المستخدم في جهاز البصمة.
      </div>
      <button class="btn ghost" id="imTemplate">تنزيل قالب جاهز</button>
      <div class="field" style="margin-top:14px"><label>الملف</label><input type="file" id="imFile" accept=".xlsx,.xlsm,.csv" /></div>
      <div class="field"><label>الموظفون الموجودون مسبقاً</label><select id="imUpdate">
        <option value="true">تحديث بياناتهم</option><option value="false">تخطيهم</option></select></div>
      <div id="imResult"></div>`,
    width: 640,
    footer: '<button class="btn" id="imSave">استيراد</button><button class="btn gray" data-close>إغلاق</button>',
    onOpen: (root) => {
      $('#imTemplate', root).onclick = () =>
        downloadCsv('/api/employees-import-template.csv', 'employees_template.csv');
      $('#imSave', root).onclick = async () => {
        const input = el('imFile');
        if (!input.files.length) { toast('اختر ملفاً أولاً', 'err'); return; }
        const fd = new FormData();
        fd.append('file', input.files[0]);
        fd.append('update_existing', el('imUpdate').value);
        try {
          const r = await api('/api/employees/import', { method: 'POST', body: fd });
          el('imResult').innerHTML = `<div class="help" style="margin-top:12px">
            ${icon('check', 'sm')} ${esc(r.message)}
            ${r.errors.length ? `<div style="margin-top:8px;color:var(--danger)">تحذيرات:<br>${r.errors.map(esc).join('<br>')}</div>` : ''}
          </div>`;
          toast(r.message, 'ok');
          loadLookups(true).then(after);
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

/* ------------------------------ السلف على الراتب ------------------------------ */
/* ------------------------------ مشتريات الموظفين ------------------------------ */
views.purchases = async () => {
  const manage = isHR();
  const { employees } = manage ? await loadLookups() : { employees: [] };
  const now = new Date();
  render(`
    <div class="card"><div class="card-body inline">
      ${manage ? `<button class="btn ok" id="puNew">${icon('plus')} تسجيل فاتورة</button>` : ''}
      <div class="field"><label>السنة</label><input type="number" id="puYear" value="${now.getFullYear()}" /></div>
      <div class="field"><label>الشهر</label><select id="puMonth">${
        MONTHS.map((m, i) => `<option value="${i + 1}" ${i === now.getMonth() ? 'selected' : ''}>${m}</option>`).join('')
      }</select></div>
      ${manage ? `<div class="field"><label>الموظف</label><select id="puEmp"><option value="">الكل</option>${
        options(employees, '', 'id', 'full_name')}</select></div>` : ''}
      <button class="btn ghost" id="puLoad">عرض</button>
      <span class="help">فواتير الشهر تُخصم تلقائياً في مسير رواتبه.</span>
    </div></div>
    <div class="grid cols-3 stagger" id="puKpis"></div>
    <div class="card"><div class="card-head"><h3>الفواتير</h3><span class="muted" id="puCount"></span></div>
      <div id="puTable"><div class="sk-rows">${'<div class="sk line"></div>'.repeat(4)}</div></div></div>`);

  const load = async () => {
    const q = new URLSearchParams({ year: el('puYear').value, month: el('puMonth').value });
    if (el('puEmp') && el('puEmp').value) q.set('employee_id', el('puEmp').value);
    const rows = await api('/api/purchases?' + q);
    const live = rows.filter((r) => !r.is_cancelled);
    el('puCount').textContent = `${rows.length} فاتورة`;
    el('puKpis').innerHTML = `
      <div class="kpi primary"><div class="label">فواتير الشهر<span class="ico">${icon('cart')}</span></div>
        <div class="value">${live.length}</div></div>
      <div class="kpi danger"><div class="label">إجمالي الخصم<span class="ico">${icon('money')}</span></div>
        <div class="value danger">${money(live.reduce((t, r) => t + r.amount, 0))}</div></div>
      <div class="kpi info"><div class="label">ملغاة<span class="ico">${icon('close')}</span></div>
        <div class="value info">${rows.length - live.length}</div></div>`;
    el('puTable').innerHTML = table(
      ['التاريخ', 'الموظف', 'البيان', 'رقم الفاتورة', 'المبلغ', 'الحالة', ''],
      rows,
      (r) => `<tr${r.is_cancelled ? ' style="opacity:.55"' : ''}>
        <td>${esc(r.purchase_date)}</td>
        <td>${esc(r.employee_name || '')}<div class="muted" style="font-size:11.5px">${esc(r.employee_code || '')}</div></td>
        <td>${esc(r.description)}</td><td>${esc(r.invoice_no || '—')}</td>
        <td class="money"><b>${money(r.amount)}</b></td>
        <td>${r.is_cancelled
          ? `<span class="tag cancelled">ملغاة</span>
             <div class="muted" style="font-size:11px">${esc(r.cancel_reason || '')}</div>`
          : '<span class="tag on">تُخصم</span>'}</td>
        <td>${manage && !r.is_cancelled
          ? `<button class="btn sm danger" onclick="cancelPurchase(${r.id})">إلغاء</button>` : ''}</td></tr>`,
      manage ? 'لا فواتير في هذا الشهر' : 'لا توجد فواتير عليك');
  };

  el('puLoad').onclick = () => load().catch((e) => toast(e.message, 'err'));
  if (el('puNew')) el('puNew').onclick = () => modal({
    title: 'تسجيل فاتورة مشتريات',
    body: `<div class="help" style="margin-bottom:12px">تُخصم من راتب الشهر الذي يقع فيه
        تاريخ الفاتورة، ويصل الموظف إشعار بها.</div>
      <div class="field"><label>الموظف</label>
        <select id="pfEmp">${options(employees, '', 'id', 'full_name')}</select></div>
      <div class="inline">
        <div class="field" style="flex:1"><label>التاريخ</label>
          <input type="date" id="pfDate" value="${today()}" /></div>
        <div class="field" style="flex:1"><label>المبلغ</label>
          <input type="number" step="0.01" id="pfAmount" value="10" /></div>
      </div>
      <div class="field"><label>البيان</label>
        <input id="pfDesc" placeholder="مثال: وجبة من المتجر" /></div>
      <div class="field"><label>رقم الفاتورة (اختياري)</label><input id="pfNo" /></div>`,
    footer: '<button class="btn" id="pfSave">حفظ</button><button class="btn gray" data-close>إلغاء</button>',
    onOpen: (root) => {
      $('#pfSave', root).onclick = async () => {
        const description = $('#pfDesc', root).value.trim();
        if (description.length < 2) return toast('اكتب بيان الفاتورة', 'err');
        try {
          await api('/api/purchases', { method: 'POST', body: {
            employee_id: Number($('#pfEmp', root).value),
            purchase_date: $('#pfDate', root).value,
            amount: Number($('#pfAmount', root).value),
            description,
            invoice_no: $('#pfNo', root).value.trim() || null } });
          toast('سُجّلت الفاتورة', 'ok'); closeModal(); load();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
  window.cancelPurchase = (id) => modal({
    title: 'إلغاء الفاتورة',
    body: `<div class="help" style="margin-bottom:12px">تبقى في السجل ولا تُخصم من الراتب.</div>
      <div class="field"><label>سبب الإلغاء (إلزامي)</label>
        <input id="pcReason" placeholder="مثال: أُعيدت البضاعة" /></div>`,
    footer: '<button class="btn danger" id="pcSave">إلغاء الفاتورة</button><button class="btn gray" data-close>تراجع</button>',
    onOpen: (root) => {
      $('#pcSave', root).onclick = async () => {
        const reason = $('#pcReason', root).value.trim();
        if (reason.length < 3) return toast('اكتب سبب الإلغاء', 'err');
        try {
          await api(`/api/purchases/${id}/cancel`, { method: 'POST', body: { reason } });
          toast('أُلغيت الفاتورة', 'ok'); closeModal(); load();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
  load().catch((e) => toast(e.message, 'err'));
};

/* ------------------------------ المستحقات والخصومات المرحّلة ------------------------------ */
const CARRY_KIND = { earning: 'مستحق سابق', deduction: 'خصم سابق' };
const CARRY_STATUS = { pending: 'غير مصروف', paid: 'مصروف', cancelled: 'ملغاة' };
const CARRY_TAG = { pending: 'pending', paid: 'on', cancelled: 'cancelled' };

views.carryovers = async () => {
  const manage = isHR();
  const { employees } = manage ? await loadLookups() : { employees: [] };
  const now = new Date();
  render(`
    <div class="card"><div class="card-body inline">
      ${manage ? `<button class="btn ok" id="cyNew">${icon('plus')} تسجيل حركة</button>` : ''}
      <div class="field"><label>الحالة</label><select id="cyStatus">
        <option value="pending">غير مصروف</option><option value="">الكل</option>
        <option value="paid">مصروف</option><option value="cancelled">ملغاة</option></select></div>
      <div class="field"><label>النوع</label><select id="cyKind">
        <option value="">الكل</option><option value="earning">مستحق سابق</option>
        <option value="deduction">خصم سابق</option></select></div>
      ${manage ? `<div class="field"><label>الموظف</label><select id="cyEmp"><option value="">الكل</option>${
        options(employees, '', 'id', 'full_name')}</select></div>` : ''}
      <button class="btn ghost" id="cyLoad">عرض</button>
      <span class="help">تُضاف أو تُخصم تلقائياً في أقرب مسير، وتُعلَّم «مصروف» عند اعتماده.</span>
    </div></div>
    <div class="grid cols-3 stagger" id="cyKpis"></div>
    <div class="card"><div class="card-head"><h3>الحركات المرحّلة</h3>
      <span class="muted" id="cyCount"></span></div>
      <div id="cyTable"><div class="sk-rows">${'<div class="sk line"></div>'.repeat(4)}</div></div></div>`);

  const load = async () => {
    const q = new URLSearchParams();
    if (el('cyStatus').value) q.set('status', el('cyStatus').value);
    if (el('cyKind').value) q.set('kind', el('cyKind').value);
    if (el('cyEmp') && el('cyEmp').value) q.set('employee_id', el('cyEmp').value);
    const rows = await api('/api/carryovers?' + q);
    el('cyCount').textContent = `${rows.length} حركة`;
    const live = rows.filter((r) => r.status === 'pending');
    const sum = (kind) => live.filter((r) => r.kind === kind).reduce((t, r) => t + r.amount, 0);
    el('cyKpis').innerHTML = `
      <div class="kpi ok"><div class="label">مستحقات غير مصروفة<span class="ico">${icon('money')}</span></div>
        <div class="value ok">${money(sum('earning'))}</div></div>
      <div class="kpi danger"><div class="label">خصومات مرحّلة<span class="ico">${icon('alert')}</span></div>
        <div class="value danger">${money(sum('deduction'))}</div></div>
      <div class="kpi info"><div class="label">الصافي المرحّل<span class="ico">${icon('check')}</span></div>
        <div class="value info">${money(sum('earning') - sum('deduction'))}</div></div>`;
    el('cyTable').innerHTML = table(
      ['الموظف', 'نوع الحركة', 'الشهر', 'الأيام', 'قيمة اليوم', 'المبلغ', 'السبب',
       'ملاحظة الإدارة', 'حالة الصرف', ''],
      rows,
      (r) => `<tr${r.status === 'cancelled' ? ' style="opacity:.55"' : ''}>
        <td>${esc(r.employee_name || '')}<div class="muted" style="font-size:11.5px">${esc(r.employee_code || '')}</div></td>
        <td><span class="tag ${r.kind === 'earning' ? 'on' : 'late'}">${esc(r.kind_label)}</span></td>
        <td>${esc(r.period_label)}</td>
        <td>${r.days || '—'}</td><td class="money">${money(r.day_rate)}</td>
        <td class="money"><b>${money(r.amount)}</b></td>
        <td>${esc(r.reason)}</td>
        <td class="muted" style="font-size:12px">${esc(r.admin_note || '')}</td>
        <td><span class="tag ${CARRY_TAG[r.status]}">${esc(r.status_label)}</span>
          ${r.paid_at ? `<div class="muted" style="font-size:11px">${esc(String(r.paid_at).slice(0, 10))}</div>` : ''}</td>
        <td>${manage && r.status === 'pending'
          ? `<button class="btn sm ghost" onclick="editCarry(${r.id})">تعديل</button>
             <button class="btn sm danger" onclick="cancelCarry(${r.id})">إلغاء</button>` : ''}</td></tr>`,
      manage ? 'لا حركات مرحّلة' : 'لا مستحقات ولا خصومات مرحّلة عليك');
    window._carryRows = rows;
  };

  el('cyLoad').onclick = () => load().catch((e) => toast(e.message, 'err'));
  ['cyStatus', 'cyKind'].forEach((id) =>
    el(id).onchange = () => load().catch((e) => toast(e.message, 'err')));

  const form = (row) => modal({
    title: row ? 'تعديل الحركة' : 'تسجيل حركة مرحّلة',
    body: `<div class="help" style="margin-bottom:12px">الأيام هنا <b>لا تُقيَّد إجازةً ولا غياباً</b>
        في الشهر الحالي — هي حركة مالية مستقلة تُصرف أو تُخصم في أقرب مسير.</div>
      ${row ? '' : `<div class="field"><label>الموظف</label>
        <select id="cfEmp">${options(employees, '', 'id', 'full_name')}</select></div>
      <div class="field"><label>نوع الحركة</label><select id="cfKind">
        <option value="earning">مستحق سابق (يُضاف للراتب)</option>
        <option value="deduction">خصم سابق (يُخصم من الراتب)</option></select></div>
      <div class="inline">
        <div class="field" style="flex:1"><label>الشهر الذي تخصّه</label><select id="cfMonth">${
          MONTHS.map((m, i) => `<option value="${i + 1}" ${i === (now.getMonth() + 11) % 12 ? 'selected' : ''}>${m}</option>`).join('')
        }</select></div>
        <div class="field" style="flex:1"><label>السنة</label>
          <input type="number" id="cfYear" value="${now.getFullYear()}" /></div>
      </div>`}
      <div class="inline">
        <div class="field" style="flex:1"><label>عدد الأيام</label>
          <input type="number" step="0.5" id="cfDays" value="${row ? row.days : 1}" /></div>
        <div class="field" style="flex:1"><label>قيمة اليوم</label>
          <input type="number" step="0.01" id="cfRate" value="${row ? row.day_rate : 0}"
                 placeholder="يُحتسب تلقائياً" /></div>
      </div>
      <div class="help" id="cfTotal" style="margin-bottom:10px"></div>
      <div class="field"><label>السبب</label>
        <input id="cfReason" value="${esc(row ? row.reason : '')}"
               placeholder="مستحق راتب مرحّل من الشهر السابق - 4 أيام" /></div>
      <div class="field"><label>ملاحظة الإدارة (اختيارية)</label>
        <textarea id="cfNote" rows="2">${esc(row ? (row.admin_note || '') : '')}</textarea></div>`,
    footer: '<button class="btn" id="cfSave">حفظ</button><button class="btn gray" data-close>إلغاء</button>',
    onOpen: (root) => {
      const total = () => {
        const value = Number($('#cfDays', root).value || 0) * Number($('#cfRate', root).value || 0);
        $('#cfTotal', root).innerHTML = value
          ? `إجمالي المبلغ: <b>${money(value)}</b> ريال`
          : 'اترك قيمة اليوم فارغة ليُحتسب أجر اليوم من راتب الموظف.';
      };
      ['cfDays', 'cfRate'].forEach((id) => { $('#' + id, root).oninput = total; });
      total();
      // جلب أجر اليوم المقترح عند اختيار الموظف
      const empSel = $('#cfEmp', root);
      const fillRate = async () => {
        try {
          const r = await api('/api/carryovers/day-rate?employee_id=' + empSel.value);
          if (!Number($('#cfRate', root).value)) { $('#cfRate', root).value = r.day_rate; total(); }
        } catch (e) { /* تجاهل */ }
      };
      if (empSel) { empSel.onchange = fillRate; fillRate(); }

      $('#cfSave', root).onclick = async () => {
        const reason = $('#cfReason', root).value.trim();
        if (reason.length < 2) return toast('اكتب سبب الحركة', 'err');
        try {
          if (row) {
            await api('/api/carryovers/' + row.id, { method: 'PATCH', body: {
              days: Number($('#cfDays', root).value || 0),
              day_rate: Number($('#cfRate', root).value || 0),
              reason, admin_note: $('#cfNote', root).value.trim() || null } });
          } else {
            await api('/api/carryovers', { method: 'POST', body: {
              employee_id: Number(empSel.value),
              kind: $('#cfKind', root).value,
              source_year: Number($('#cfYear', root).value),
              source_month: Number($('#cfMonth', root).value),
              days: Number($('#cfDays', root).value || 0),
              day_rate: Number($('#cfRate', root).value || 0),
              reason, admin_note: $('#cfNote', root).value.trim() || null } });
          }
          toast('حُفظت الحركة', 'ok'); closeModal(); load();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });

  if (el('cyNew')) el('cyNew').onclick = () => form(null);
  window.editCarry = (id) => form((window._carryRows || []).find((r) => r.id === id));
  window.cancelCarry = (id) => modal({
    title: 'إلغاء الحركة',
    body: `<div class="help" style="margin-bottom:12px">تبقى في السجل ولا تُحتسب في المسير.</div>
      <div class="field"><label>سبب الإلغاء (إلزامي)</label>
        <input id="ccReason" placeholder="مثال: سُجّلت بالخطأ" /></div>`,
    footer: '<button class="btn danger" id="ccSave">إلغاء الحركة</button><button class="btn gray" data-close>تراجع</button>',
    onOpen: (root) => {
      $('#ccSave', root).onclick = async () => {
        const reason = $('#ccReason', root).value.trim();
        if (reason.length < 3) return toast('اكتب سبب الإلغاء', 'err');
        try {
          await api(`/api/carryovers/${id}/cancel`, { method: 'POST', body: { reason } });
          toast('أُلغيت الحركة', 'ok'); closeModal(); load();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
  load().catch((e) => toast(e.message, 'err'));
};

/* ------------------------------ طلبات «نسيت البصمة» ------------------------------ */
views.punchRequests = async () => {
  render(`
    <div class="card"><div class="card-body inline">
      <div class="field"><label>الحالة</label><select id="prqStatus">
        <option value="pending">قيد الاعتماد</option><option value="">الكل</option>
        <option value="approved">معتمدة</option><option value="rejected">مرفوضة</option>
        <option value="cancelled">ملغاة</option></select></div>
      <button class="btn ghost" id="prqLoad">عرض</button>
      <span class="help">الاعتماد يسجّل البصمة فعلياً ويعيد احتساب اليوم تلقائياً.</span>
    </div></div>
    <div class="card"><div class="card-head"><h3>طلبات البصمة</h3><span class="muted" id="prqCount"></span></div>
      <div id="prqTable"><div class="sk-rows">${'<div class="sk line"></div>'.repeat(4)}</div></div></div>`);

  const load = async () => {
    const q = new URLSearchParams();
    if (el('prqStatus').value) q.set('status', el('prqStatus').value);
    const rows = await api('/api/punch-requests?' + q);
    el('prqCount').textContent = `${rows.length} طلب`;
    el('prqTable').innerHTML = table(
      ['الموظف', 'الوقت المطلوب', 'النوع', 'السبب', 'الحالة', 'قُدّم', ''],
      rows,
      (r) => `<tr>
        <td>${esc(r.employee_name || '')}<div class="muted" style="font-size:11.5px">${esc(r.employee_code || '')}</div></td>
        <td>${fmtDateTime(r.requested_time)}</td>
        <td>${esc(r.kind_label || PUNCH_KINDS[r.kind] || '')}</td>
        <td>${esc(r.reason)}</td>
        <td><span class="tag ${r.status}">${LEAVE_STATUS[r.status] || r.status}</span>
          ${r.decision_note ? `<div class="muted" style="font-size:11px">${esc(r.decision_note)}</div>` : ''}</td>
        <td>${r.created_at ? String(r.created_at).slice(0, 10) : ''}</td>
        <td>${r.status === 'pending'
          ? `<button class="btn sm ok" onclick="decidePunchRequest(${r.id},true)">اعتماد</button>
             <button class="btn sm danger" onclick="decidePunchRequest(${r.id},false)">رفض</button>` : ''}</td></tr>`,
      'لا طلبات');
  };
  el('prqLoad').onclick = () => load().catch((e) => toast(e.message, 'err'));
  el('prqStatus').onchange = () => load().catch((e) => toast(e.message, 'err'));
  window.decidePunchRequest = (id, approve) => modal({
    title: approve ? 'اعتماد طلب البصمة' : 'رفض الطلب',
    body: `<div class="help" style="margin-bottom:12px">${approve
        ? 'ستُسجَّل البصمة بالوقت المطلوب مصدرها «إدخال يدوي»، ويُعاد احتساب اليوم.'
        : 'يصل الموظف إشعار بالرفض مع السبب.'}</div>
      <div class="field"><label>ملاحظة${approve ? ' (اختيارية)' : ' / السبب'}</label>
        <input id="pdNote" placeholder="${approve ? 'مؤكد من كاميرا الفرع' : 'لا يوجد ما يثبت الحضور'}" /></div>`,
    footer: `<button class="btn ${approve ? '' : 'danger'}" id="pdSave">${approve ? 'اعتماد' : 'رفض'}</button>
      <button class="btn gray" data-close>إلغاء</button>`,
    onOpen: (root) => {
      $('#pdSave', root).onclick = async () => {
        try {
          await api(`/api/punch-requests/${id}/decide`, { method: 'POST', body: {
            approve, note: $('#pdNote', root).value.trim() || null } });
          toast(approve ? 'اعتُمد الطلب وسُجّلت البصمة' : 'رُفض الطلب', 'ok');
          closeModal(); load();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
  load().catch((e) => toast(e.message, 'err'));
};

views.loans = async () => {
  const manage = isHR();
  const { employees } = manage ? await loadLookups() : { employees: [] };
  const now = new Date();
  render(`
    <div class="card"><div class="card-body inline">
      ${manage ? `<button class="btn ok" id="lnNew">${icon('plus')} تسجيل سلفة</button>` : ''}
      ${!manage ? `<button class="btn ok" id="lnAsk">${icon('plus')} طلب سلفة</button>` : ''}
      <div class="field"><label>الحالة</label><select id="lnStatus">
        <option value="">الكل</option>
        <option value="pending">بانتظار الاعتماد</option>
        <option value="approved">بانتظار إقرار الاستلام</option>
        <option value="active">سارية</option>
        <option value="settled">مسدّدة</option><option value="cancelled">ملغاة</option></select></div>
      ${manage ? `<div class="field"><label>الموظف</label><select id="lnEmp"><option value="">الكل</option>${options(employees, '', 'id', 'full_name')}</select></div>` : ''}
      <button class="btn ghost" id="lnLoad">تحديث</button>
      <span class="help">القسط يُخصم تلقائياً في مسير الرواتب الشهري.</span>
    </div></div>
    <div class="grid cols-4 stagger" id="lnKpis"></div>
    <div class="card"><div class="card-head"><h3>السلف</h3><span class="muted" id="lnCount"></span></div>
      <div id="lnTable"><div class="sk-rows">${'<div class="sk line"></div>'.repeat(4)}</div></div></div>`);

  const load = async () => {
    const q = new URLSearchParams();
    if (el('lnStatus').value) q.set('status', el('lnStatus').value);
    if (el('lnEmp') && el('lnEmp').value) q.set('employee_id', el('lnEmp').value);
    const rows = await api('/api/loans?' + q);
    el('lnCount').textContent = `${rows.length} سلفة`;
    const active = rows.filter((r) => r.status === 'active');
    el('lnKpis').innerHTML = `
      <div class="kpi primary"><div class="label">سلف سارية<span class="ico">${icon('loans')}</span></div>
        <div class="value">${active.length}</div></div>
      <div class="kpi warn"><div class="label">إجمالي المتبقي<span class="ico">${icon('clock')}</span></div>
        <div class="value warn">${money(active.reduce((t, r) => t + r.remaining_amount, 0))}</div></div>
      <div class="kpi ok"><div class="label">المسدّد<span class="ico">${icon('check')}</span></div>
        <div class="value ok">${money(active.reduce((t, r) => t + r.paid_amount, 0))}</div></div>
      <div class="kpi info"><div class="label">أقساط هذا الشهر<span class="ico">${icon('calendar')}</span></div>
        <div class="value info">${money(active.reduce((t, r) =>
          t + (r.remaining_amount > 0 ? Math.min(r.installment_amount, r.remaining_amount) : 0), 0))}</div>
        <div class="foot">${MONTHS[now.getMonth()]} ${now.getFullYear()}</div></div>`;
    el('lnTable').innerHTML = table(
      ['الموظف', 'المبلغ', 'القسط', 'الأقساط', 'المسدّد', 'المتبقي', 'يبدأ', 'الحالة', ''],
      rows,
      (r) => {
        const pct = r.amount ? (r.paid_amount / r.amount) * 100 : 0;
        return `<tr>
          <td><div style="display:flex;align-items:center;gap:9px">${avatar(r.employee_name, 'sm')}
            <div><div style="font-weight:600">${esc(r.employee_name || '')}</div>
            <div class="muted" style="font-size:11.5px">${esc(r.employee_code || '')}</div></div></div></td>
          <td class="money">${money(r.amount)}</td><td class="money">${money(r.installment_amount)}</td>
          <td>${r.months}</td>
          <td style="min-width:130px"><div class="progress ok"><i style="width:${Math.min(100, pct)}%"></i></div>
            <span class="muted" style="font-size:11.5px">${money(r.paid_amount)}</span></td>
          <td class="money"><b>${money(r.remaining_amount)}</b></td>
          <td>${String(r.start_month).padStart(2, '0')}/${r.start_year}</td>
          <td><span class="tag ${LOAN_TAG[r.status] || ''}">${esc(LOAN_STATUS[r.status] || r.status)}</span>
            ${r.decision_note ? `<div class="muted" style="font-size:11px">${esc(r.decision_note)}</div>` : ''}</td>
          <td>${manage
            ? `${r.status === 'pending'
                ? `<button class="btn sm ok" onclick="decideLoan(${r.id},true)">اعتماد</button>
                   <button class="btn sm danger" onclick="decideLoan(${r.id},false)">رفض</button>` : ''}
               ${r.status === 'active'
                ? `<button class="btn sm gray" onclick="cancelLoan(${r.id})">إلغاء</button>
                   <button class="btn sm ok" onclick="settleLoan(${r.id})">تسديد كامل</button>` : ''}
               <button class="btn sm danger" onclick="deleteLoan(${r.id})">حذف</button>`
            : (r.can_acknowledge
                ? `<button class="btn sm ok" onclick="acknowledgeLoan(${r.id})">أقرّ باستلام السلفة</button>`
                : '')}</td></tr>`;
      },
      manage ? 'لا توجد سلف مسجّلة' : 'لا توجد سلف على راتبك');
  };

  el('lnLoad').onclick = () => load().catch((e) => toast(e.message, 'err'));
  if (el('lnStatus')) el('lnStatus').onchange = () => load().catch((e) => toast(e.message, 'err'));
  if (el('lnNew')) el('lnNew').onclick = () => modal({
    title: 'تسجيل سلفة على الراتب',
    body: `
      <div class="field"><label>الموظف</label><select id="lnFEmp">${options(employees, '', 'id', 'full_name')}</select></div>
      <div class="inline">
        <div class="field" style="flex:1"><label>مبلغ السلفة</label><input type="number" id="lnFAmount" value="1000" /></div>
        <div class="field" style="flex:1"><label>القسط الشهري</label><input type="number" id="lnFInst" value="250" /></div>
      </div>
      <div class="inline">
        <div class="field" style="flex:1"><label>يبدأ الخصم من شهر</label><select id="lnFMonth">${
          MONTHS.map((m, i) => `<option value="${i + 1}" ${i === now.getMonth() ? 'selected' : ''}>${m}</option>`).join('')
        }</select></div>
        <div class="field" style="flex:1"><label>السنة</label><input type="number" id="lnFYear" value="${now.getFullYear()}" /></div>
      </div>
      <div class="field"><label>السبب (اختياري)</label><input id="lnFReason" placeholder="سلفة شخصية" /></div>
      <div class="help" id="lnFHint"></div>`,
    footer: `<button class="btn" id="lnFSave">حفظ</button><button class="btn gray" data-close>إلغاء</button>`,
    onOpen: (root) => {
      const hint = () => {
        const amount = Number(el('lnFAmount').value || 0);
        const inst = Number(el('lnFInst').value || 0);
        el('lnFHint').textContent = amount > 0 && inst > 0
          ? `عدد الأقساط: ${Math.ceil(amount / inst)} — آخر قسط ${money(amount - inst * (Math.ceil(amount / inst) - 1))} ريال`
          : 'أدخل المبلغ والقسط لعرض الجدول.';
      };
      ['lnFAmount', 'lnFInst'].forEach((id) => el(id).oninput = hint);
      hint();
      $('#lnFSave', root).onclick = async () => {
        try {
          await api('/api/loans', { method: 'POST', body: {
            employee_id: Number(el('lnFEmp').value),
            amount: Number(el('lnFAmount').value),
            installment_amount: Number(el('lnFInst').value),
            start_year: Number(el('lnFYear').value),
            start_month: Number(el('lnFMonth').value),
            reason: el('lnFReason').value || null,
          } });
          toast('تم تسجيل السلفة', 'ok'); closeModal(); load();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });

  // اعتماد السلفة أو رفضها، ثم إقرار الموظف بالاستلام
  window.decideLoan = (id, approve) => modal({
    title: approve ? 'اعتماد السلفة' : 'رفض طلب السلفة',
    body: `<div class="help" style="margin-bottom:12px">${approve
        ? 'بعد الاعتماد تعود السلفة للموظف ليقرّ باستلامها، وعندها فقط يبدأ خصم الأقساط.'
        : 'يصل الموظف إشعار بالرفض مع السبب، ولا يُخصم منه شيء.'}</div>
      <div class="field"><label>ملاحظة${approve ? ' (اختيارية)' : ' / السبب'}</label>
        <input id="ldNote" placeholder="${approve ? 'معتمدة على ثلاثة أقساط' : 'الرصيد لا يسمح حالياً'}" /></div>`,
    footer: `<button class="btn ${approve ? '' : 'danger'}" id="ldSave">${approve ? 'اعتماد' : 'رفض'}</button>
      <button class="btn gray" data-close>إلغاء</button>`,
    onOpen: (root) => {
      $('#ldSave', root).onclick = async () => {
        try {
          await api(`/api/loans/${id}/decide`, { method: 'POST', body: {
            approve, note: $('#ldNote', root).value.trim() || null } });
          toast(approve ? 'اعتُمدت السلفة — بانتظار إقرار الموظف' : 'رُفض الطلب', 'ok');
          closeModal(); load();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
  window.acknowledgeLoan = async (id) => {
    if (!confirm('أقرّ باستلام مبلغ السلفة؟ سيبدأ خصم الأقساط من راتبك حسب الجدول.')) return;
    try { await api(`/api/loans/${id}/acknowledge`, { method: 'POST' });
      toast('سُجّل إقرارك بالاستلام', 'ok'); load(); } catch (e) { toast(e.message, 'err'); }
  };
  // طلب سلفة يقدّمه الموظف بنفسه
  if (el('lnAsk')) el('lnAsk').onclick = () => modal({
    title: 'طلب سلفة على الراتب',
    body: `<div class="help" style="margin-bottom:12px">يُرفع الطلب للموارد البشرية،
        وبعد اعتماده تُقرّ أنت باستلام المبلغ ليبدأ الخصم.</div>
      <div class="inline">
        <div class="field" style="flex:1"><label>المبلغ المطلوب</label>
          <input type="number" id="laAmount" value="1000" /></div>
        <div class="field" style="flex:1"><label>القسط الشهري</label>
          <input type="number" id="laInst" value="250" /></div>
      </div>
      <div class="inline">
        <div class="field" style="flex:1"><label>يبدأ الخصم من شهر</label><select id="laMonth">${
          MONTHS.map((m, i) => `<option value="${i + 1}" ${i === now.getMonth() ? 'selected' : ''}>${m}</option>`).join('')
        }</select></div>
        <div class="field" style="flex:1"><label>السنة</label>
          <input type="number" id="laYear" value="${now.getFullYear()}" /></div>
      </div>
      <div class="field"><label>السبب</label><input id="laReason" placeholder="ظرف عائلي" /></div>`,
    footer: `<button class="btn" id="laSave">إرسال الطلب</button><button class="btn gray" data-close>إلغاء</button>`,
    onOpen: (root) => {
      $('#laSave', root).onclick = async () => {
        try {
          await api('/api/loans/request', { method: 'POST', body: {
            amount: Number($('#laAmount', root).value),
            installment_amount: Number($('#laInst', root).value),
            start_year: Number($('#laYear', root).value),
            start_month: Number($('#laMonth', root).value),
            reason: $('#laReason', root).value.trim() || null } });
          toast('أُرسل طلب السلفة', 'ok'); closeModal(); load();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });

  window.cancelLoan = async (id) => {
    if (!confirm('إلغاء السلفة؟ لن تُخصم أقساطها بعد الآن.')) return;
    try { await api('/api/loans/' + id, { method: 'PATCH', body: { status: 'cancelled' } });
      toast('أُلغيت السلفة', 'ok'); load(); } catch (e) { toast(e.message, 'err'); }
  };
  window.settleLoan = async (id) => {
    if (!confirm('تأكيد تسديد السلفة بالكامل؟')) return;
    try { await api('/api/loans/' + id, { method: 'PATCH', body: { status: 'settled' } });
      toast('سُجّلت مسدّدة', 'ok'); load(); } catch (e) { toast(e.message, 'err'); }
  };
  window.deleteLoan = async (id) => {
    if (!confirm('حذف السلفة نهائياً؟')) return;
    try { await api('/api/loans/' + id, { method: 'DELETE' });
      toast('تم الحذف', 'ok'); load(); } catch (e) { toast(e.message, 'err'); }
  };
  load();
};

/* ------------------------------ الوقت الإضافي ------------------------------ */
const otHours = (minutes) => {
  const m = Math.max(0, Math.round(minutes || 0));
  return m >= 60 ? `${Math.floor(m / 60)} س ${m % 60 ? (m % 60) + ' د' : ''}`.trim() : `${m} د`;
};

views.overtime = async () => {
  const manage = isHR();
  const { employees } = await loadLookups();
  const now = new Date();
  render(`
    <div class="card"><div class="card-body inline">
      <div class="field"><label>الحالة</label><select id="otStatus">
        <option value="pending" selected>بانتظار الموافقة</option>
        <option value="approved">معتمد</option>
        <option value="rejected">مرفوض</option>
        <option value="">الكل</option></select></div>
      <div class="field"><label>الموظف</label><select id="otEmp"><option value="">الكل</option>${
        options(employees, '', 'id', 'full_name')}</select></div>
      <div class="field"><label>من</label><input type="date" id="otFrom" /></div>
      <div class="field"><label>إلى</label><input type="date" id="otTo" /></div>
      <button class="btn" id="otLoad">عرض</button>
      <span class="help">لا يُحتسب أي عمل إضافي في الراتب إلا بعد اعتماد الإدارة.</span>
    </div></div>
    <div class="grid cols-4 stagger" id="otKpis"></div>
    <div class="card"><div class="card-head"><h3>سجل الوقت الإضافي</h3>
      <span class="muted" id="otCount"></span></div>
      <div id="otTable"><div class="sk-rows">${'<div class="sk line"></div>'.repeat(4)}</div></div></div>`);

  const load = async () => {
    const q = new URLSearchParams();
    if (el('otStatus').value) q.set('status', el('otStatus').value);
    if (el('otEmp').value) q.set('employee_id', el('otEmp').value);
    if (el('otFrom').value) q.set('date_from', el('otFrom').value);
    if (el('otTo').value) q.set('date_to', el('otTo').value);
    const [rows, summary] = await Promise.all([
      api('/api/overtime?' + q),
      api(`/api/overtime/summary?year=${now.getFullYear()}&month=${now.getMonth() + 1}`),
    ]);
    el('otCount').textContent = `${rows.length} سجل`;
    el('otKpis').innerHTML = `
      <div class="kpi warn"><div class="label">بانتظار الموافقة<span class="ico">${icon('clock')}</span></div>
        <div class="value warn">${summary.pending_count}</div>
        <div class="foot">${otHours(summary.pending_minutes)} هذا الشهر</div></div>
      <div class="kpi ok"><div class="label">معتمد<span class="ico">${icon('check')}</span></div>
        <div class="value ok">${summary.approved_count}</div>
        <div class="foot">${otHours(summary.approved_minutes)} تُحتسب في الراتب</div></div>
      <div class="kpi danger"><div class="label">مرفوض<span class="ico">${icon('close')}</span></div>
        <div class="value danger">${summary.rejected_count}</div>
        <div class="foot">${otHours(summary.rejected_minutes)} لا تُحتسب</div></div>
      <div class="kpi info"><div class="label">قاعدة الاحتساب<span class="ico">${icon('shield')}</span></div>
        <div class="value info" style="font-size:16px">${
          summary.requires_approval ? 'بالاعتماد فقط' : 'تلقائي'}</div>
        <div class="foot">${summary.requires_approval
          ? 'لا يُصرف إضافي بلا موافقة' : 'يُحتسب كل وقت زائد'}</div></div>`;

    el('otTable').innerHTML = table(
      ['الموظف', 'اليوم', 'نهاية الدوام', 'الانصراف', 'الوقت الزائد', 'المعتمد',
       'الحالة', 'القرار', ''],
      rows,
      (r) => `<tr>
        <td><div style="display:flex;align-items:center;gap:9px">${avatar(r.employee_name, 'sm')}
          <div><div style="font-weight:600">${esc(r.employee_name || '')}</div>
          <div class="muted" style="font-size:11.5px">${esc(r.employee_code || '')}</div></div></div></td>
        <td>${r.work_date}</td>
        <td>${r.shift_end ? fmtTime(r.shift_end) : '—'}</td>
        <td>${r.check_out ? fmtTime(r.check_out) : '—'}</td>
        <td>${otHours(r.minutes)}</td>
        <td>${r.status === 'approved' ? otHours(r.approved_minutes) : '—'}</td>
        <td><span class="tag ${OT_TAG[r.status]}">${esc(r.status_label || OT_STATUS[r.status])}</span></td>
        <td>${r.decided_by ? `${esc(r.decided_by)}<div class="muted" style="font-size:11px">${
          String(r.decided_at || '').replace('T', ' ').slice(0, 16)}</div>${
          r.decision_note ? `<div class="muted" style="font-size:11px">${esc(r.decision_note)}</div>` : ''}`
          : '—'}</td>
        <td>${manage ? (r.status === 'pending'
          ? `<button class="btn sm ok" onclick="decideOvertime(${r.id},true,${r.minutes})">اعتماد</button>
             <button class="btn sm danger" onclick="decideOvertime(${r.id},false,${r.minutes})">رفض</button>`
          : `<button class="btn sm ghost" onclick="reopenOvertime(${r.id})">إعادة فتح</button>`) : ''}</td>
      </tr>`,
      'لا توجد سجلات وقت إضافي');
  };

  window.decideOvertime = (id, approve, detected) => modal({
    title: approve ? 'اعتماد الوقت الإضافي' : 'رفض الوقت الإضافي',
    body: `${approve ? `<div class="field"><label>الدقائق المعتمدة (المرصود ${detected} دقيقة)</label>
        <input type="number" id="otMinutes" value="${detected}" min="1" max="${detected}" />
        <div class="help">يمكن اعتماد جزء من الوقت المرصود، ولا يُقبل أكثر منه.</div></div>` : ''}
      <div class="field"><label>ملاحظة القرار${approve ? ' (اختياري)' : ' / السبب'}</label>
        <textarea id="otNote" rows="3" placeholder="${approve
          ? 'مثال: بقي لإنهاء الجرد بطلب المدير' : 'مثال: لم يُطلب منه البقاء بعد الدوام'}"></textarea></div>
      <div class="help">يُسجَّل القرار باسمك وبتاريخه ووقته في سجل التدقيق.</div>`,
    footer: `<button class="btn ${approve ? 'ok' : 'danger'}" id="otSave">${
      approve ? 'اعتماد' : 'رفض'}</button><button class="btn gray" data-close>إلغاء</button>`,
    onOpen: (root) => {
      $('#otSave', root).onclick = async () => {
        const body = { approve, note: $('#otNote', root).value.trim() || null };
        if (approve) body.minutes = Number($('#otMinutes', root).value || detected);
        try {
          await api(`/api/overtime/${id}/decide`, { method: 'POST', body });
          toast(approve ? 'اعتُمد الوقت الإضافي' : 'رُفض الوقت الإضافي', 'ok');
          closeModal(); load();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });

  window.reopenOvertime = async (id) => {
    if (!confirm('إعادة فتح القرار لمراجعته من جديد؟')) return;
    try {
      await api(`/api/overtime/${id}/reopen`, { method: 'POST' });
      toast('أُعيد السجل بانتظار الموافقة', 'ok'); load();
    } catch (e) { toast(e.message, 'err'); }
  };

  el('otLoad').onclick = () => load().catch((e) => toast(e.message, 'err'));
  ['otStatus', 'otEmp'].forEach((id) =>
    el(id).onchange = () => load().catch((e) => toast(e.message, 'err')));
  load().catch((e) => toast(e.message, 'err'));
};

views.myOvertime = async () => {
  render(`
    <div class="card"><div class="card-head"><h3>وقتي الإضافي</h3>
      <span class="muted" id="moCount"></span></div>
      <div class="card-body">
        <div class="help" style="margin-bottom:12px">العمل بعد نهاية الدوام يُسجَّل تلقائياً،
          ولا يُحتسب في الراتب إلا بعد اعتماد الإدارة. تظهر هنا حالة كل يوم ومن بتّ فيه.</div>
        <div id="moList"><div class="sk-rows">${'<div class="sk line"></div>'.repeat(3)}</div></div>
      </div></div>`);
  try {
    const rows = await api('/api/me/overtime');
    const approved = rows.filter((r) => r.status === 'approved')
      .reduce((t, r) => t + (r.approved_minutes || 0), 0);
    el('moCount').textContent = rows.length
      ? `${rows.length} يوم — معتمد ${otHours(approved)}` : '';
    el('moList').innerHTML = rows.length ? rows.map((r) => `
      <div class="row-item" style="align-items:flex-start">
        <span class="ri ${r.status === 'approved' ? 'ok' : r.status === 'rejected' ? 'danger' : ''}">${icon('bolt')}</span>
        <div class="rt"><b>${r.work_date}</b>
          <span>وقت زائد ${otHours(r.minutes)}${
            r.status === 'approved' ? ` — اعتُمد منه ${otHours(r.approved_minutes)}` : ''}</span>
          ${r.decided_by ? `<div class="muted" style="font-size:11.5px;margin-top:3px">
            القرار: ${esc(r.decided_by)} — ${String(r.decided_at || '').replace('T', ' ').slice(0, 16)}
            ${r.decision_note ? '<br>' + esc(r.decision_note) : ''}</div>` : ''}
        </div>
        <div class="rv"><span class="tag ${OT_TAG[r.status]}">${esc(r.status_label || OT_STATUS[r.status])}</span></div>
      </div>`).join('') : '<div class="empty">لا يوجد وقت إضافي مسجّل لك</div>';
  } catch (e) { el('moList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
};

/* بيان الخصومات: كل خصم بيومه وسببه */
function deductionsTable(lines) {
  if (!lines.length) return '<div class="empty">لا توجد خصومات</div>';
  const total = lines.reduce((t, x) => t + (x.amount || 0), 0);
  return table(
    ['اليوم', 'النوع', 'السبب', 'المبلغ'],
    lines,
    (x) => `<tr>
      <td>${x.work_date || '—'}</td>
      <td><span class="tag ${DEDUCTION_TONE[x.kind] || ''}">${esc(x.kind_label || x.kind)}</span></td>
      <td>${esc(x.reason || '')}</td>
      <td class="money">${money(x.amount)}</td></tr>`)
    + `<div class="inline" style="justify-content:flex-end;padding:10px 14px">
        <b>إجمالي الخصومات: <span class="money">${money(total)}</span> ريال</b></div>`;
}

window.showPayslipDeductions = async (payslipId, name) => {
  modal({
    title: `بيان خصومات ${name || ''}`.trim(),
    body: '<div id="pdBody"><div class="sk-rows">' + '<div class="sk line"></div>'.repeat(3) + '</div></div>',
    footer: '<button class="btn gray" data-close>إغلاق</button>',
    width: 760,
    onOpen: async (root) => {
      try {
        const lines = await api(`/api/payroll/payslips/${payslipId}/deductions`);
        $('#pdBody', root).innerHTML = deductionsTable(lines);
      } catch (e) { $('#pdBody', root).innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    },
  });
};


/* ------------------------------ أيام الراحة الشهرية ------------------------------ */
views.restDays = async () => {
  const { employees } = await loadLookups();
  const now = new Date();
  render(`
    <div class="card"><div class="card-body inline">
      <div class="field"><label>الموظف</label><select id="rdEmp">${options(employees, '', 'id', 'full_name')}</select></div>
      <div class="field"><label>الشهر</label><select id="rdMonth">${
        MONTHS.map((m, i) => `<option value="${i + 1}" ${i === now.getMonth() ? 'selected' : ''}>${m}</option>`).join('')
      }</select></div>
      <div class="field"><label>السنة</label><input type="number" id="rdYear" value="${now.getFullYear()}" /></div>
      <button class="btn" id="rdLoad">عرض</button>
      <span class="help">اضغط على أي يوم في التقويم لتحديده يوم راحة أو لإلغائه.</span>
    </div></div>
    <div class="grid cols-4 stagger" id="rdKpis"></div>
    <div class="card"><div class="card-head"><h3 id="rdTitle">تقويم الراحة</h3></div>
      <div class="card-body" id="rdCal"><div class="sk tall"></div></div></div>
    <div class="card"><div class="card-head"><h3>ملخص الشهر لكل الموظفين</h3></div>
      <div id="rdSummary"><div class="sk-rows">${'<div class="sk line"></div>'.repeat(4)}</div></div></div>`);

  let current = { rows: [], quota: 0 };
  const load = async () => {
    const year = Number(el('rdYear').value);
    const month = Number(el('rdMonth').value);
    const employeeId = Number(el('rdEmp').value);
    const [rows, summary, settings] = await Promise.all([
      api(`/api/rest-days?year=${year}&month=${month}&employee_id=${employeeId}`),
      api(`/api/rest-days/summary?year=${year}&month=${month}`),
      api('/api/settings'),
    ]);
    current = { rows, quota: settings.monthly_rest_quota || 0 };
    const mine = summary.find((r) => r.employee_id === employeeId) || { used: rows.length, quota: current.quota, remaining: 0 };
    el('rdTitle').textContent = `تقويم الراحة — ${MONTHS[month - 1]} ${year}`;
    el('rdKpis').innerHTML = `
      <div class="kpi primary"><div class="label">رصيد الشهر<span class="ico">${icon('bed')}</span></div>
        <div class="value">${mine.quota}</div><div class="foot">${
          mine.custom_quota ? 'رصيد خاص من ملف الموظف' : `افتراضي المنشأة (${current.quota})`}</div></div>
      <div class="kpi ok"><div class="label">المستخدم<span class="ico">${icon('check')}</span></div>
        <div class="value ok">${mine.used}</div></div>
      <div class="kpi warn"><div class="label">المتبقي<span class="ico">${icon('clock')}</span></div>
        <div class="value warn">${mine.remaining}</div></div>
      <div class="kpi info"><div class="label">إجمالي أيام الراحة المجدولة<span class="ico">${icon('calendar')}</span></div>
        <div class="value info">${summary.reduce((t, r) => t + r.used, 0)}</div>
        <div class="foot">لكل الموظفين هذا الشهر</div></div>`;

    // تقويم قابل للنقر
    const restMap = {};
    rows.forEach((r) => { restMap[r.rest_date] = r.id; });
    const first = new Date(year, month - 1, 1);
    const days = new Date(year, month, 0).getDate();
    let cells = '';
    for (let i = 0; i < first.getDay(); i++) cells += '<div class="day blank"></div>';
    for (let d = 1; d <= days; d++) {
      const iso = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const restId = restMap[iso];
      cells += `<div class="day ${restId ? 'weekend' : ''}" style="cursor:pointer"
          onclick="toggleRest('${iso}', ${restId || 0})" title="${iso}">
          <span class="n">${d}</span><span class="s">${restId ? icon('bed', 'sm') + ' راحة' : ''}</span></div>`;
    }
    el('rdCal').innerHTML =
      `<div class="calendar">${CAL_DOW.map((x) => `<div class="dow">${x}</div>`).join('')}${cells}</div>`;

    el('rdSummary').innerHTML = table(
      ['الموظف', 'المستخدم', 'الرصيد', 'المتبقي', 'التواريخ'],
      summary,
      (r) => `<tr>
        <td><div style="display:flex;align-items:center;gap:9px">${avatar(r.employee_name, 'sm')}
          <div><div style="font-weight:600">${esc(r.employee_name)}</div>
          <div class="muted" style="font-size:11.5px">${esc(r.employee_code)}</div></div></div></td>
        <td>${r.used}</td>
        <td>${r.quota}${r.custom_quota
          ? ' <span class="tag on" title="رصيد محدَّد في ملف الموظف">خاص</span>' : ''}</td>
        <td><span class="tag ${r.remaining > 0 ? 'on' : 'off'}">${r.remaining}</span></td>
        <td>${r.dates.map((d) => esc(d)).join('، ') || '—'}</td></tr>`,
      'لا توجد أيام راحة مجدولة هذا الشهر');
  };

  window.toggleRest = async (iso, restId) => {
    try {
      if (restId) {
        await api('/api/rest-days/' + restId, { method: 'DELETE' });
        toast('أُلغي يوم الراحة', 'ok');
      } else {
        await api('/api/rest-days', { method: 'POST', body: {
          employee_id: Number(el('rdEmp').value), rest_date: iso } });
        toast('تم تحديد يوم الراحة', 'ok');
      }
      load();
    } catch (e) { toast(e.message, 'err'); }
  };
  el('rdLoad').onclick = () => load().catch((e) => toast(e.message, 'err'));
  ['rdEmp', 'rdMonth', 'rdYear'].forEach((id) =>
    el(id).onchange = () => load().catch((e) => toast(e.message, 'err')));
  load();
};

/* ------------------------------ بياناتي (تحديث ذاتي) ------------------------------ */
views.myProfile = async () => {
  if (!state.user.employee_id) {
    render(`<div class="card"><div class="card-body"><div class="empty">
      حسابك غير مرتبط بملف موظف — راجع الموارد البشرية.</div></div></div>`);
    return;
  }
  const me = await api('/api/me/profile');
  const restNames = String(me.weekly_rest_days || '').split(',').filter(Boolean)
    .map((d) => (WEEK_DAYS.find(([k]) => k === d) || [null, d])[1]).join('، ');

  render(`
    <div class="card"><div class="card-body">
      <div class="profile-head">
        ${avatar(me.full_name, 'lg')}
        <div class="who" style="flex:1;min-width:200px">
          <h2>${esc(me.full_name)}</h2>
          <div class="sub"><span>${esc(me.job_title || '—')}</span>·
            <span>${esc(me.department_name || '—')}</span>·<span>رقم ${esc(me.code)}</span></div>
        </div>
      </div>
    </div></div>

    <div class="grid cols-2">
      <div class="card" style="margin:0">
        <div class="card-head"><h3>${icon('idcard')} بياناتي الشخصية</h3></div>
        <div class="card-body">
          <div class="help" style="margin-bottom:12px">
            حدّث بياناتك هنا وستصل الموارد البشرية مباشرة. الحقول الأخرى (الراتب، الوردية،
            تاريخ التعيين) تُعدّلها الموارد البشرية فقط.</div>
          <div class="field"><label>رقم الهوية / الإقامة</label>
            <input id="mpNid" inputmode="numeric" value="${esc(me.national_id || '')}"
              placeholder="مثال: 2412345678" /></div>
          <div class="field"><label>رقم الجوال</label>
            <input id="mpPhone" inputmode="tel" value="${esc(me.phone || '')}"
              placeholder="مثال: 0501112233" />
            <div class="help">رقم جوالك هو اسم المستخدم عند الدخول.</div></div>
          <div class="field"><label>البريد الإلكتروني</label>
            <input id="mpEmail" inputmode="email" value="${esc(me.email || '')}"
              placeholder="name@example.com" /></div>
          <button class="btn" id="mpSave">حفظ بياناتي</button>
        </div></div>

      <div class="card" style="margin:0">
        <div class="card-head"><h3>بيانات وظيفتي</h3></div>
        <div class="card-body">
          <div class="kv">
            <div><div class="k">رقم الموظف</div><div class="v">${esc(me.code)}</div></div>
            <div><div class="k">المسمى الوظيفي</div><div class="v">${esc(me.job_title || '—')}</div></div>
            <div><div class="k">الإدارة</div><div class="v">${esc(me.department_name || '—')}</div></div>
            <div><div class="k">الوردية</div><div class="v">${esc(me.shift_name || '—')}</div></div>
            <div><div class="k">موقع العمل</div><div class="v">${esc(me.site_name || '—')}</div></div>
            <div><div class="k">تاريخ التعيين</div><div class="v">${me.hire_date || '—'}</div></div>
            <div><div class="k">أيام الراحة الأسبوعية</div><div class="v">${esc(restNames || 'حسب الوردية')}</div></div>
            <div><div class="k">مدة الخدمة</div><div class="v">${esc(serviceLength(me.hire_date))}</div></div>
            <div><div class="k">الراتب الكامل</div><div class="v money">${money(me.total_salary)} ريال</div></div>
          </div>
          <div class="help">للاستفسار عن الراتب أو الوردية راجع الموارد البشرية.</div>
        </div></div>
    </div>`);

  el('mpSave').onclick = async () => {
    try {
      await api('/api/me/profile', { method: 'PUT', body: {
        national_id: el('mpNid').value.trim() || null,
        phone: el('mpPhone').value.trim() || null,
        email: el('mpEmail').value.trim() || null,
      } });
      toast('تم حفظ بياناتك', 'ok');
      views.myProfile();
    } catch (e) { toast(e.message, 'err'); }
  };
};

/* ------------------------------ ملف الموظف ------------------------------ */
window.openProfile = (id) => { state.profileId = id; go('profile'); };

views.profile = async () => {
  const id = state.profileId;
  if (!id) { go(isHR() || can('manager') ? 'employees' : 'dashboard'); return; }
  const now = new Date();
  const year = now.getFullYear();
  const monthStart = `${year}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const soft = (promise) => promise.catch(() => []);
  const emp = await api('/api/employees/' + id);
  const [balances, attendance, leaves, violations, documents] = await Promise.all([
    soft(api(`/api/leave-balances?employee_id=${id}&year=${year}`)),
    soft(api(`/api/attendance/employee/${id}?date_from=${monthStart}&date_to=${today()}`)),
    soft(api(`/api/leave-requests?employee_id=${id}`)),
    soft(api(`/api/violations?employee_id=${id}`)),
    soft(api(`/api/documents?employee_id=${id}`)),
  ]);

  // ------- المقاييس -------
  const counted = attendance.filter((r) => !['weekend', 'holiday', 'scheduled'].includes(r.status));
  const attended = counted.filter((r) => ['present', 'late', 'missing_out'].includes(r.status)).length;
  const attendancePct = counted.length ? (attended / counted.length) * 100 : 0;
  const annual = balances.find((b) => (b.leave_type_name || '').includes('سنوية')) || balances[0];
  const annualTotal = annual ? annual.entitled_days + annual.carried_over_days : 0;
  const contract = documents.find((d) => (d.doc_type || '').includes('عقد') && d.expiry_date);
  const probationDays = emp.hire_date ? Math.min(90, Math.max(0, daysBetween(emp.hire_date, today()))) : null;
  const lateTotal = attendance.reduce((sum, r) => sum + (r.late_minutes || 0), 0);
  const absentDays = attendance.filter((r) => r.status === 'absent').length;

  const meters = [
    meter('نسبة الحضور هذا الشهر', `${Math.round(attendancePct)}%`, attendancePct,
      attendancePct >= 90 ? 'ok' : attendancePct >= 75 ? 'warn' : 'danger'),
    annual ? meter(`رصيد ${annual.leave_type_name}`,
      `${annual.remaining_days} من ${annualTotal} يوم`,
      annualTotal ? (annual.remaining_days / annualTotal) * 100 : 0, 'info') : '',
    probationDays !== null && probationDays < 90
      ? meter('فترة التجربة (٩٠ يوماً)', `مضى ${probationDays} يوماً`, (probationDays / 90) * 100, 'warn')
      : '',
    contract ? (() => {
      const left = daysBetween(today(), contract.expiry_date);
      const span = contract.issue_date ? Math.max(1, daysBetween(contract.issue_date, contract.expiry_date)) : 365;
      return meter('مدة العقد المتبقية',
        left >= 0 ? `${left} يوماً حتى ${contract.expiry_date}` : `منتهٍ منذ ${Math.abs(left)} يوماً`,
        Math.max(0, (left / span) * 100), left < 0 ? 'danger' : left < 45 ? 'warn' : 'ok');
    })() : '',
  ].filter(Boolean).join('');

  const statusTag = emp.status === 'active' ? '<span class="tag active">على رأس العمل</span>'
    : emp.status === 'suspended' ? '<span class="tag suspended">موقوف</span>'
    : '<span class="tag terminated">منتهية خدمته</span>';

  // ------- الجدول الزمني -------
  const events = [];
  if (emp.hire_date) events.push({ date: emp.hire_date, tone: 'ok', title: 'التعيين ومباشرة العمل',
    body: `المسمى: ${emp.job_title || '—'}${emp.department_name ? ' — ' + emp.department_name : ''}` });
  documents.forEach((d) => {
    if (d.issue_date) events.push({ date: d.issue_date, tone: 'info',
      title: `إصدار وثيقة: ${d.doc_type}`, body: d.number ? `الرقم: ${d.number}` : '' });
    if (d.expiry_date) events.push({ date: d.expiry_date,
      tone: (d.days_left !== null && d.days_left < 0) ? 'danger' : 'warn',
      title: `انتهاء وثيقة: ${d.doc_type}`,
      body: d.days_left === null ? '' : d.days_left < 0 ? `منتهية منذ ${Math.abs(d.days_left)} يوماً`
        : `متبقٍ ${d.days_left} يوماً` });
  });
  leaves.forEach((l) => events.push({ date: l.start_date,
    tone: l.status === 'approved' ? 'ok' : l.status === 'rejected' ? 'danger' : 'warn',
    title: `${l.leave_type_name} — ${LEAVE_STATUS[l.status]}`,
    body: `${l.start_date} ← ${l.end_date} (${l.days} يوم)${l.reason ? ' — ' + l.reason : ''}` }));
  violations.forEach((v) => events.push({ date: v.occurred_on, tone: 'danger',
    title: `مخالفة: ${v.violation_type_name}`,
    body: `${v.penalty_action_label || ''}${v.penalty_amount ? ` — خصم ${money(v.penalty_amount)} ريال` : ''}` }));
  events.sort((a, b) => (a.date < b.date ? 1 : -1));

  const tabs = [
    ['overview', 'نظرة عامة'], ['attendance', 'الحضور'], ['leaves', 'الإجازات'],
    ['salary', 'الراتب'], ['violations', 'المخالفات'], ['documents', 'الوثائق'],
    ['timeline', 'الجدول الزمني'],
  ];

  render(`
    <div class="card"><div class="card-body">
      <div class="profile-head">
        ${avatar(emp.full_name, 'lg')}
        <div class="who" style="flex:1;min-width:200px">
          <h2>${esc(emp.full_name)}</h2>
          <div class="sub">
            <span>${esc(emp.job_title || 'بدون مسمى')}</span>·
            <span>${esc(emp.department_name || 'بدون إدارة')}</span>·
            <span>رقم ${esc(emp.code)}</span>·
            <span>خدمة ${esc(serviceLength(emp.hire_date))}</span>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          ${statusTag}
          ${isHR() ? `<button class="btn sm ghost" onclick="editEmployeeFromProfile(${emp.id})">تعديل البيانات</button>` : ''}
          <button class="btn sm gray" onclick="go('${isHR() || can('manager') ? 'employees' : 'dashboard'}')">رجوع</button>
        </div>
      </div>
    </div></div>

    <div class="grid cols-4 stagger">
      <div class="kpi ok"><div class="label">أيام الحضور هذا الشهر<span class="ico">${icon('check')}</span></div>
        <div class="value ok">${attended}</div><div class="foot">من ${counted.length} يوم عمل</div></div>
      <div class="kpi danger"><div class="label">أيام الغياب<span class="ico">${icon('alert')}</span></div>
        <div class="value danger">${absentDays}</div><div class="foot">خلال الشهر الجاري</div></div>
      <div class="kpi warn"><div class="label">دقائق التأخير<span class="ico">${icon('clock')}</span></div>
        <div class="value warn">${lateTotal}</div><div class="foot">مجموع الشهر</div></div>
      <div class="kpi primary"><div class="label">الراتب الكامل<span class="ico">${icon('payroll')}</span></div>
        <div class="value">${money(emp.total_salary || (emp.basic_salary + (emp.allowances || 0)))}</div>
        <div class="foot">أساسي ${money(emp.basic_salary)} + بدلات ${money(emp.allowances || 0)}</div></div>
    </div>

    <div class="sub-tabs" id="pTabs">
      ${tabs.map(([id2, label], i) =>
        `<button data-tab="${id2}" class="${i === 0 ? 'active' : ''}">${label}</button>`).join('')}
    </div>
    <div id="pBody"></div>`);

  const kv = (rows) => `<div class="kv">${rows.map(([k, v]) =>
    `<div><div class="k">${esc(k)}</div><div class="v">${v === null || v === undefined || v === '' ? '—' : esc(String(v))}</div></div>`).join('')}</div>`;

  const panels = {
    overview: () => `
      <div class="grid cols-2">
        <div class="card" style="margin:0"><div class="card-head"><h3>البيانات الأساسية</h3></div>
          <div class="card-body">${kv([
            ['رقم الموظف', emp.code], ['الاسم', emp.full_name], ['الهوية / الإقامة', emp.national_id],
            ['الجوال', emp.phone], ['البريد', emp.email], ['المسمى الوظيفي', emp.job_title],
            ['الإدارة', emp.department_name], ['الوردية', emp.shift_name],
            ['موقع العمل', emp.site_name], ['تاريخ التعيين', emp.hire_date],
          ])}</div></div>
        <div class="card" style="margin:0"><div class="card-head"><h3>مؤشرات الملف</h3></div>
          <div class="card-body">${meters || '<div class="empty">لا توجد مؤشرات كافية بعد</div>'}</div></div>
      </div>`,
    attendance: () => `
      <div class="card"><div class="card-head"><h3>تقويم ${MONTHS[now.getMonth()]} ${year}</h3>
        <div class="legend"><span><i style="background:#dcfce7"></i>حاضر</span>
          <span><i style="background:#fef3c7"></i>متأخر</span>
          <span><i style="background:#fee2e2"></i>غياب</span>
          <span><i style="background:#ccfbf1"></i>إجازة</span></div></div>
        <div class="card-body">${calendarMonth(attendance, year, now.getMonth() + 1)}</div></div>
      <div class="card"><div class="card-head"><h3>تفصيل أيام الشهر</h3></div>
        ${table(['التاريخ', 'وقت الحضور', 'وقت الانصراف', 'ساعات', 'تأخير (د)', 'إضافي (د)', 'الحالة'], attendance,
          (r) => `<tr><td>${r.work_date}</td><td>${fmtTime(r.check_in)}</td><td>${fmtTime(r.check_out)}</td>
            <td>${hours(r.worked_minutes)}</td><td>${r.late_minutes || 0}</td><td>${r.overtime_minutes || 0}</td>
            <td><span class="tag ${r.status}">${DAY_STATUS[r.status]}</span></td></tr>`,
          'لا توجد سجلات لهذا الشهر')}</div>`,
    leaves: () => `
      ${balances.length ? `<div class="card"><div class="card-head"><h3>الأرصدة</h3></div>
        ${table(['النوع', 'المستحق', 'مرحّل', 'المستخدم', 'المتبقي'], balances,
          (b) => `<tr><td>${esc(b.leave_type_name)}</td><td>${b.entitled_days}</td>
            <td>${b.carried_over_days}</td><td>${b.used_days}</td><td><b>${b.remaining_days}</b></td></tr>`,
          'لا توجد أرصدة')}</div>` : ''}
      <div class="card"><div class="card-head"><h3>الطلبات</h3></div>
        <div class="card-body">${leaves.length ? `<div class="grid cards stagger">${leaves.map((l) => `
          <div class="emp-card" style="cursor:default">
            <div class="top">${avatar(l.leave_type_name)}
              <div style="min-width:0"><div class="name">${esc(l.leave_type_name)}</div>
                <div class="role">${l.days} يوم</div></div></div>
            <div class="meta"><span class="chip">من ${l.start_date}</span><span class="chip">إلى ${l.end_date}</span></div>
            <div class="foot"><span class="tag ${l.status}">${LEAVE_STATUS[l.status]}</span>
              <span>${esc((l.reason || '').slice(0, 24))}</span></div>
          </div>`).join('')}</div>` : `<div class="empty">${icon('leave', 'lg')}<br>لا توجد طلبات إجازة</div>`}
        </div></div>`,
    salary: () => `
      <div class="card"><div class="card-head"><h3>مكوّنات الراتب</h3></div>
        <div class="card-body">${kv([
          ['الراتب الأساسي', money(emp.basic_salary) + ' ريال'],
          ['البدلات', money(emp.allowances || 0) + ' ريال'],
          ['الراتب الكامل', money(emp.total_salary || 0) + ' ريال'],
          ['أجر اليوم التقديري', money((emp.total_salary || 0) / 30) + ' ريال'],
          ['أجر الساعة التقديري', money((emp.total_salary || 0) / 30 / 8) + ' ريال'],
        ])}
        <div class="help">الخصومات والإضافي تُحتسب في مسير الرواتب الشهري حسب القواعد المعتمدة.</div>
        ${isHR() ? '<button class="btn ghost" onclick="go(\'payroll\')">فتح مسير الرواتب</button>' : ''}
        </div></div>
      <div class="card"><div class="card-head"><h3>بيان الخصومات</h3>
          <span class="muted">كل خصم بيومه وسببه</span></div>
        <div id="empDeductions"><div class="sk-rows">${'<div class="sk line"></div>'.repeat(3)}</div></div>
      </div>`,
    violations: () => `
      <div class="card"><div class="card-head"><h3>سجل المخالفات</h3></div>
        ${table(['التاريخ', 'المخالفة', 'التكرار', 'الجزاء', 'الخصم', 'الحالة'], violations,
          (v) => `<tr><td>${v.occurred_on}</td><td>${esc(v.violation_type_name)}</td>
            <td>${v.repetition_no}</td><td>${esc(v.penalty_action_label || '')}</td>
            <td class="money">${money(v.penalty_amount)}</td>
            <td><span class="tag ${v.status}">${esc(v.status_label || VIOLATION_STATUS[v.status] || '')}</span></td></tr>`,
          'لا توجد مخالفات — سجل نظيف')}</div>`,
    documents: () => `
      <div class="card"><div class="card-head"><h3>الوثائق</h3>
        ${isHR() ? '<button class="btn sm ghost" onclick="go(\'documents\')">إدارة الوثائق</button>' : ''}</div>
        ${table(['النوع', 'الرقم', 'الإصدار', 'الانتهاء', 'المتبقي', ''], documents,
          (d) => `<tr><td>${esc(d.doc_type)}</td><td>${esc(d.number || '—')}</td>
            <td>${d.issue_date || '—'}</td><td>${d.expiry_date || '—'}</td>
            <td>${d.days_left === null || d.days_left === undefined ? '—'
              : `<span class="tag ${d.days_left < 0 ? 'expired' : d.days_left < 30 ? 'soon' : 'on'}">
                  ${d.days_left < 0 ? 'منتهية' : d.days_left + ' يوم'}</span>`}</td>
            <td>${d.file_path ? `<a class="btn sm ghost" href="/uploads/${encodeURIComponent(d.file_path)}" target="_blank">عرض</a>` : ''}</td></tr>`,
          'لا توجد وثائق مسجّلة')}</div>`,
    timeline: () => `
      <div class="card"><div class="card-head"><h3>أهم الأحداث</h3></div>
        <div class="card-body">${events.length ? `<ul class="timeline stagger">${events.slice(0, 40).map((e) => `
          <li class="${e.tone}"><div class="t">${esc(e.title)}</div>
            <div class="d">${e.date}</div>
            ${e.body ? `<div class="b">${esc(e.body)}</div>` : ''}</li>`).join('')}</ul>`
          : '<div class="empty">لا توجد أحداث مسجّلة بعد</div>'}
        </div></div>`,
  };

  const paint = (tab) => {
    el('pBody').innerHTML = panels[tab]();
    el('pTabs').querySelectorAll('button').forEach((b) =>
      b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'salary' && el('empDeductions')) {
      api(`/api/payroll/deductions?employee_id=${id}`)
        .then((lines) => { if (el('empDeductions')) el('empDeductions').innerHTML = deductionsTable(lines); })
        .catch((e) => { if (el('empDeductions')) el('empDeductions').innerHTML =
          `<div class="empty">${esc(e.message)}</div>`; });
    }
  };
  el('pTabs').querySelectorAll('button').forEach((b) => b.onclick = () => paint(b.dataset.tab));
  paint('overview');

  window.editEmployeeFromProfile = async (empId) => {
    const { departments, shifts } = await loadLookups();
    employeeModal(await api('/api/employees/' + empId), departments, shifts, () => go('profile'));
  };
};

/* ------------------------------ أجهزة البصمة ------------------------------ */
views.devices = async () => {
  render(`
    <div class="card"><div class="card-body inline">
      <button class="btn ok" id="dNew">إضافة جهاز</button>
      <button class="btn" id="dSyncAll">مزامنة كل الأجهزة</button>
      <button class="btn ghost" id="dLoad">تحديث</button>
      <button class="btn gray" id="dPair">${icon('unlock')} فتح إقران جهاز جديد (٣٠ دقيقة)</button>
      <span class="help" id="dPairState"></span>
    </div></div>
    <div class="card"><div class="card-head"><h3>الأجهزة</h3></div><div id="dTable"><div class="empty">جارٍ التحميل…</div></div></div>
    <div class="card"><div class="card-head"><h3>كيف تربط جهاز ZKTeco فعلياً؟</h3></div><div class="card-body help">
      <b>الطريقة الأولى - السحب (Pull) عبر شبكة محلية:</b><br>
      اضبط للجهاز عنوان IP ثابت من قائمة Comm ← Ethernet، ثم أضف الجهاز هنا بوضع «سحب» مع IP والمنفذ
      <code>4370</code> وكلمة مرور الاتصال (Comm Key، افتراضياً 0). اضغط «اختبار» ثم «مزامنة» لسحب البصمات.
      يجب أن يكون الخادم في نفس الشبكة أو يصل إليها عبر VPN.<br><br>
      <b>الطريقة الثانية - الدفع (Push/ADMS) للحظي:</b><br>
      من الجهاز: Comm ← Cloud Server / ADMS، ضع Server Address = عنوان هذا الخادم، وServer Port = منفذ التطبيق،
      واترك المسار <code>/iclock/</code>. سيرسل الجهاز البصمة فور حدوثها إلى
      <code id="pushUrl"></code> ويظهر تلقائياً في القائمة أعلاه بعد أول اتصال.<br><br>
      <b>مهم:</b> رقم الموظف في النظام يجب أن يطابق رقم المستخدم (PIN) في الجهاز؛ ويمكن استيراد المستخدمين
      من الجهاز مباشرة بزر «استيراد الموظفين».
    </div></div>`);
  el('pushUrl').textContent = location.origin + '/iclock/cdata';
  const load = async () => {
    const rows = await api('/api/devices');
    el('dTable').innerHTML = table(
      ['الاسم', 'الوضع', 'العنوان', 'الرقم التسلسلي', 'الموقع', 'آخر مزامنة', 'الحالة', 'إجراءات'],
      rows,
      (d) => `<tr><td>${esc(d.name)}</td>
        <td>${({ pull: 'سحب (4370)', push: 'دفع (ADMS)', demo: 'تجريبي' })[d.mode]}</td>
        <td>${esc(d.ip ? d.ip + ':' + d.port : '—')}</td><td>${esc(d.serial_number || '—')}</td>
        <td>${esc(d.location || '—')}</td><td>${fmtDateTime(d.last_sync_at)}</td>
        <td>${esc(d.last_status || '—')}</td>
        <td><button class="btn sm" onclick="syncDevice(${d.id})">مزامنة</button>
            <button class="btn sm ghost" onclick="testDevice(${d.id})">اختبار</button>
            <button class="btn sm ghost" onclick="deviceUsers(${d.id})">المستخدمون</button>
            <button class="btn sm gray" onclick="editDevice(${d.id})">تعديل</button></td></tr>`,
      'لا توجد أجهزة مسجلة');
    state.cache.devices = rows;
  };
  el('dLoad').onclick = () => load().catch((e) => toast(e.message, 'err'));

  const pairingState = async () => {
    try {
      const info = await api('/api/devices/pairing');
      el('dPairState').innerHTML = info.open
        ? `<span class="tag on">الإقران مفتوح</span> — أي جهاز جديد يتصل الآن سيُسجَّل تلقائياً
           ${info.until ? `(حتى ${esc(info.until.replace('T', ' '))})` : ''}`
        : '<span class="tag off">الإقران مغلق</span> — لا يُقبل أي جهاز غير مسجّل (حماية من إرسال بصمات مزيّفة)';
      el('dPair').innerHTML = info.open
        ? icon('lock') + ' إغلاق الإقران'
        : icon('unlock') + ' فتح إقران جهاز جديد (٣٠ دقيقة)';
      el('dPair').dataset.open = info.open ? '1' : '';
    } catch (e) { el('dPairState').textContent = ''; }
  };
  el('dPair').onclick = async () => {
    try {
      const open = el('dPair').dataset.open === '1';
      const res = open
        ? await api('/api/devices/pairing', { method: 'DELETE' })
        : await api('/api/devices/pairing?minutes=30', { method: 'POST' });
      toast(res.message, 'ok');
      pairingState();
    } catch (e) { toast(e.message, 'err'); }
  };
  pairingState();
  el('dNew').onclick = () => deviceModal(null, load);
  el('dSyncAll').onclick = async () => {
    toast('جارٍ مزامنة الأجهزة…');
    try {
      const res = await api('/api/devices/sync-all', { method: 'POST' });
      const imported = res.reduce((s, r) => s + (r.imported || 0), 0);
      toast(`تمت المزامنة: ${imported} بصمة جديدة من ${res.length} جهاز`, 'ok'); load();
    } catch (e) { toast(e.message, 'err'); }
  };
  window.syncDevice = async (id) => {
    toast('جارٍ الاتصال بالجهاز…');
    try {
      const r = await api(`/api/devices/${id}/sync`, { method: 'POST' });
      toast(r.message, r.ok ? 'ok' : 'err');
      if (r.unknown_codes && r.unknown_codes.length)
        toast('أرقام غير معرّفة في النظام: ' + r.unknown_codes.join(', '), 'err');
      load();
    } catch (e) { toast(e.message, 'err'); }
  };
  window.testDevice = async (id) => {
    try {
      const r = await api(`/api/devices/${id}/test`, { method: 'POST' });
      modal({ title: 'نتيجة اختبار الاتصال', body:
        `<p class="${r.ok ? '' : 'muted'}">${esc(r.message)}</p>` +
        (Object.keys(r.info || {}).length
          ? `<table>${Object.entries(r.info).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>` : ''),
        footer: '<button class="btn gray" data-close>إغلاق</button>' });
      load();
    } catch (e) { toast(e.message, 'err'); }
  };
  window.deviceUsers = async (id) => {
    try {
      const users = await api(`/api/devices/${id}/users`);
      modal({ title: 'المستخدمون المسجلون على الجهاز', width: 640,
        body: table(['رقم المستخدم', 'الاسم', 'الصلاحية', 'موجود في النظام'], users,
          (u) => `<tr><td>${esc(u.user_id)}</td><td>${esc(u.name)}</td><td>${u.privilege}</td>
            <td>${u.exists_in_system ? icon('check', 'sm') : ''}</td></tr>`, 'لا يوجد مستخدمون على الجهاز'),
        footer: `<button class="btn" id="impUsers">استيراد غير الموجودين كموظفين</button>
                 <button class="btn gray" data-close>إغلاق</button>`,
        onOpen: (root) => { $('#impUsers', root).onclick = async () => {
          try { const r = await api(`/api/devices/${id}/import-users`, { method: 'POST' });
            toast(`تم إنشاء ${r.created} موظف`, 'ok'); closeModal(); loadLookups(true); }
          catch (e) { toast(e.message, 'err'); }
        }; } });
    } catch (e) { toast(e.message, 'err'); }
  };
  window.editDevice = (id) => deviceModal((state.cache.devices || []).find((d) => d.id === id), load);
  load();
};

function deviceModal(dev, after) {
  const v = (k, d = '') => (dev && dev[k] !== null && dev[k] !== undefined ? dev[k] : d);
  modal({
    title: dev ? 'تعديل جهاز' : 'إضافة جهاز بصمة',
    body: `<div class="grid cols-2">
      <div class="field"><label>اسم الجهاز</label><input id="gName" value="${esc(v('name'))}" /></div>
      <div class="field"><label>وضع التشغيل</label><select id="gMode">
        <option value="pull" ${v('mode') === 'pull' ? 'selected' : ''}>سحب مباشر (IP + منفذ 4370)</option>
        <option value="push" ${v('mode') === 'push' ? 'selected' : ''}>دفع لحظي (ADMS/iclock)</option>
        <option value="demo" ${v('mode') === 'demo' ? 'selected' : ''}>تجريبي (بدون عتاد)</option></select></div>
      <div class="field"><label>عنوان IP</label><input id="gIp" value="${esc(v('ip'))}" placeholder="192.168.1.201" /></div>
      <div class="field"><label>المنفذ</label><input type="number" id="gPort" value="${v('port', 4370)}" /></div>
      <div class="field"><label>كلمة مرور الاتصال (Comm Key)</label><input type="number" id="gPass" value="${v('comm_password', 0)}" /></div>
      <div class="field"><label>الرقم التسلسلي (لوضع الدفع)</label><input id="gSn" value="${esc(v('serial_number'))}" /></div>
      <div class="field"><label>الموقع</label><input id="gLoc" value="${esc(v('location'))}" placeholder="المدخل الرئيسي" /></div>
      <div class="field"><label>مسح سجلات الجهاز بعد الاستيراد</label><select id="gClear">
        <option value="false" ${!v('clear_after_sync') ? 'selected' : ''}>لا</option>
        <option value="true" ${v('clear_after_sync') ? 'selected' : ''}>نعم</option></select></div>
      </div>`,
    footer: `<button class="btn" id="gSave">حفظ</button>
      ${dev ? '<button class="btn danger" id="gDel">حذف</button>' : ''}
      <button class="btn gray" data-close>إلغاء</button>`,
    width: 700,
    onOpen: (root) => {
      $('#gSave', root).onclick = async () => {
        const body = { name: el('gName').value.trim(), mode: el('gMode').value,
          ip: el('gIp').value || null, port: Number(el('gPort').value || 4370),
          comm_password: Number(el('gPass').value || 0), serial_number: el('gSn').value || null,
          location: el('gLoc').value || null, clear_after_sync: el('gClear').value === 'true' };
        try {
          if (dev) await api('/api/devices/' + dev.id, { method: 'PATCH', body });
          else await api('/api/devices', { method: 'POST', body });
          toast('تم الحفظ', 'ok'); closeModal(); after();
        } catch (e) { toast(e.message, 'err'); }
      };
      if (dev && $('#gDel', root)) $('#gDel', root).onclick = async () => {
        if (!confirm('حذف الجهاز؟ ستبقى البصمات المستوردة.')) return;
        try { await api('/api/devices/' + dev.id, { method: 'DELETE' }); toast('تم الحذف', 'ok'); closeModal(); after(); }
        catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}


/* ------------------------------ الرواتب ------------------------------ */
views.payroll = async () => {
  if (!isHR()) return myPayslipsView();
  const now = new Date();
  render(`
    <div class="card"><div class="card-body inline">
      <div class="field"><label>السنة</label><input type="number" id="prYear" value="${now.getFullYear()}" /></div>
      <div class="field"><label>الشهر</label><select id="prMonth">${
        MONTHS.map((m, i) => `<option value="${i + 1}" ${i === now.getMonth() ? 'selected' : ''}>${m}</option>`).join('')
      }</select></div>
      <button class="btn ok" id="prRun">احتساب المسير</button>
      <button class="btn gray" id="prCheck">${icon('shield')} فحص ما قبل الإقفال</button>
      <span class="help">افحص الشهر قبل الاحتساب لتعالج الغياب والمستحقات المعلّقة.</span>
    </div></div>
    <div id="prIssues"></div>
    <div class="grid cols-4 stagger" id="prKpis"></div>
    <div class="card"><div class="card-head"><h3>مسيّرات الرواتب</h3></div>
      <div id="prRuns"><div class="sk-rows">${'<div class="sk line"></div>'.repeat(3)}</div></div></div>
    <div id="prDetail"></div>`);

  // فحص ما قبل الإقفال: خمس حالات تُراجَع قبل احتساب المسير
  const preClose = async (notify) => {
    const year = el('prYear').value, month = el('prMonth').value;
    el('prIssues').innerHTML = `<div class="card"><div class="card-body">
      <div class="sk-rows">${'<div class="sk line"></div>'.repeat(2)}</div></div></div>`;
    let result;
    try {
      result = notify
        ? await api(`/api/payroll/pre-close/notify?year=${year}&month=${month}`, { method: 'POST' })
        : await api(`/api/payroll/pre-close?year=${year}&month=${month}`);
    } catch (e) { el('prIssues').innerHTML = ''; return toast(e.message, 'err'); }

    if (result.clean) {
      el('prIssues').innerHTML = `<div class="card"><div class="card-body">
        <div class="soft-alert" style="background:var(--ok-soft);color:var(--ok)">
          ${icon('check')} لا ملاحظات على ${MONTHS[month - 1]} ${year} — الشهر جاهز للإقفال
          (فُحص ${result.employees_checked} موظف).</div></div></div>`;
      if (notify) toast('أُرسل الملخّص للإدارة', 'ok');
      return;
    }

    const chips = Object.entries(result.totals).filter(([, n]) => n)
      .map(([key, n]) => `<span class="tag ${key === 'absent_days' || key === 'leave_overdraft'
        ? 'absent' : 'pending'}">${esc(result.labels[key])}: ${n}</span>`).join(' ');
    el('prIssues').innerHTML = `<div class="card">
      <div class="card-head"><h3>${icon('alert')} ملاحظات قبل إقفال ${MONTHS[month - 1]} ${year}</h3>
        <button class="btn sm ghost" id="prNotify">إرسال الملخّص للإدارة</button></div>
      <div class="card-body"><div class="inline" style="flex-wrap:wrap;gap:6px">${chips}</div>
        <div class="help" style="margin-top:8px">${result.rows.length} موظف بحاجة مراجعة
          من أصل ${result.employees_checked}.</div></div>
      ${result.rows.map((row) => `
        <div class="row-item" style="align-items:flex-start">
          <span class="ri danger">${icon('employees')}</span>
          <div class="rt"><b>${esc(row.employee_name)}</b>
            <span>${row.issues.map((i) =>
              `<span class="tag ${i.tone === 'danger' ? 'absent' : 'pending'}"
                     style="margin-inline-end:4px">${esc(i.label)} (${i.count})</span>`).join('')}</span>
            <div class="muted" style="font-size:11.5px;margin-top:4px">${row.issues.map((i) =>
              esc(i.detail)).join(' · ')}</div></div>
          <div class="rv"><button class="btn sm ghost"
            onclick="go('attendance')">مراجعة</button></div></div>`).join('')}
    </div>`;
    if (el('prNotify')) el('prNotify').onclick = () => preClose(true);
    if (notify) toast('أُرسل الملخّص للإدارة', 'ok');
  };
  el('prCheck').onclick = () => preClose(false);

  const loadRuns = async () => {
    const runs = await api('/api/payroll/runs');
    const latest = runs[0];
    el('prKpis').innerHTML = latest ? `
      <div class="kpi primary"><div class="label">آخر مسير<span class="ico">${icon('calendar')}</span></div>
        <div class="value" style="font-size:19px">${MONTHS[latest.month - 1]} ${latest.year}</div>
        <div class="foot">${latest.employees} موظف — ${latest.status === 'approved' ? 'معتمد' : 'مسودة'}</div></div>
      <div class="kpi primary"><div class="label">الأساسي + البدلات<span class="ico">${icon('payroll')}</span></div>
        <div class="value">${money(latest.basic_total + (latest.allowances_total || 0))}</div>
        <div class="foot">أساسي ${money(latest.basic_total)} — بدلات ${money(latest.allowances_total || 0)}</div></div>
      <div class="kpi danger"><div class="label">الخصومات<span class="ico">${icon('minus')}</span></div>
        <div class="value danger">${money(latest.deductions_total)}</div>
        <div class="foot">غياب وتأخير ومخالفات</div></div>
      <div class="kpi ok"><div class="label">صافي المسير<span class="ico">${icon('bank')}</span></div>
        <div class="value ok">${money(latest.net_total)}</div>
        <div class="foot">بدل إضافي ${money(latest.overtime_total)}</div></div>` : '';
    el('prRuns').innerHTML = table(
      ['الفترة', 'الحالة', 'الموظفون', 'الأساسي', 'البدلات', 'الخصومات', 'الإضافي', 'صافي المسير', 'إجراءات'],
      runs,
      (r) => `<tr><td>${MONTHS[r.month - 1]} ${r.year}</td>
        <td><span class="tag ${r.status === 'approved' ? 'approved' : 'draft'}">${r.status === 'approved' ? 'معتمد' : 'مسودة'}</span></td>
        <td>${r.employees}</td><td class="money">${money(r.basic_total)}</td>
        <td class="money">${money(r.allowances_total || 0)}</td>
        <td class="money">${money(r.deductions_total)}</td><td class="money">${money(r.overtime_total)}</td>
        <td class="money">${money(r.net_total)}</td>
        <td><button class="btn sm" onclick="openRun(${r.id})">عرض القسائم</button>
            <button class="btn sm ghost" onclick="printRun(${r.id})">${icon('printer')} القسائم PDF</button>
            <button class="btn sm ghost" onclick="exportExcel(${r.id})">${icon('sheet')} Excel</button>
            <button class="btn sm ghost" onclick="exportRun(${r.id})">CSV</button>
            ${r.status !== 'approved'
              ? `<button class="btn sm ok" onclick="approveRun(${r.id})">اعتماد</button>
                 <button class="btn sm danger" onclick="deleteRun(${r.id})">حذف</button>`
              : `<button class="btn sm gray" onclick="revokeRun(${r.id})">إلغاء الاعتماد</button>
                 <button class="btn sm danger" onclick="deleteRun(${r.id}, true)">حذف</button>`}</td></tr>`,
      'لا توجد مسيّرات — اضغط «احتساب المسير»');
  };

  el('prRun').onclick = async () => {
    try {
      const run = await api(`/api/payroll/runs?year=${el('prYear').value}&month=${el('prMonth').value}`, { method: 'POST' });
      toast(`تم احتساب مسير ${MONTHS[run.month - 1]} لـ ${run.employees} موظف`, 'ok');
      await loadRuns(); openRun(run.id);
    } catch (e) { toast(e.message, 'err'); }
  };

  window.openRun = async (id) => {
    const [run, slips] = await Promise.all([
      api('/api/payroll/runs/' + id), api(`/api/payroll/runs/${id}/payslips`),
    ]);
    const locked = run.status === 'approved';
    el('prDetail').innerHTML = `<div class="card">
      <div class="card-head"><h3>قسائم ${MONTHS[run.month - 1]} ${run.year}</h3>
        <span class="muted">صافي المسير: <b class="money">${money(run.net_total)}</b> ريال</span></div>
      ${locked ? `<div class="card-body" style="padding-bottom:0"><div class="help">
        ${icon('lock', 'sm')} <b>الشهر مُقفل:</b> بياناته لا تتغيّر بعد الاعتماد — لا بصمة يدوية،
        ولا تعديل أو حذف بصمة، ولا تسجيل حضور جماعي، ولا يوم راحة، ولا إعادة احتساب.
        لتصحيح شيء: ألغِ اعتماد المسير، صحّح، ثم أعد الاعتماد.</div></div>` : ''}
      ${table(['رقم الموظف', 'الاسم', 'الأساسي', 'البدلات', 'حضور', 'غياب', 'تأخير (د)',
               'خروج مبكر (د)', 'إضافي معتمد (د)', 'زائد غير معتمد (د)',
               'خصم غياب', 'خصم تأخير', 'خصم خروج مبكر', 'إجازة بلا راتب', 'خصم مخالفات',
               'قسط سلفة', 'مشتريات',
               'مستحق مرحّل', 'خصم مرحّل', 'بدل إضافي', 'إضافات', 'خصومات', 'الصافي', ''],
        slips,
        (s) => `<tr><td>${esc(s.employee_code)}</td><td>${esc(s.employee_name)}</td>
          <td class="money">${money(s.basic_salary)}</td><td class="money">${money(s.allowances)}</td>
          <td>${s.present_days}</td><td>${s.absent_days}</td>
          <td>${s.late_minutes}</td><td>${s.early_leave_minutes || 0}</td><td>${s.overtime_minutes}</td>
          <td>${s.unapproved_overtime_minutes
            ? `<span class="tag pending">${s.unapproved_overtime_minutes}</span>` : 0}</td>
          <td class="money">${money(s.absence_deduction)}</td><td class="money">${money(s.late_deduction)}</td>
          <td class="money">${money(s.early_leave_deduction || 0)}</td>
          <td class="money">${money(s.unpaid_leave_deduction)}</td><td class="money">${money(s.violation_deduction)}</td>
          <td class="money">${money(s.loan_deduction)}</td>
          <td class="money">${money(s.purchases_deduction || 0)}</td>
          <td class="money">${money(s.carryover_earning || 0)}</td>
          <td class="money">${money(s.carryover_deduction || 0)}</td>
          <td class="money">${money(s.overtime_amount)}</td><td class="money">${money(s.other_additions)}</td>
          <td class="money">${money(s.other_deductions)}</td><td class="money"><b>${money(s.net_pay)}</b></td>
          <td><button class="btn sm ghost" onclick="printPayslip(${s.id})">${icon('printer')} قسيمة</button>
            <button class="btn sm gray" onclick="showPayslipDeductions(${s.id},'${esc(s.employee_name)}')">الخصومات</button>
            ${locked ? '' : `<button class="btn sm ghost" onclick="adjustSlip(${s.id},${s.other_additions},${s.other_deductions})">تعديل</button>`}</td></tr>`,
        'لا توجد قسائم')}
      </div>`;
  };
  window.exportRun = (id) => downloadCsv(`/api/payroll/runs/${id}/export.csv`, `payroll_${id}.csv`);
  // ملف Excel منسّق: مجاميع بمعادلات وفلاتر وإعداد طباعة أفقي
  window.exportExcel = (id) => downloadCsv(
    `/api/payroll/runs/${id}/export.xlsx`, `payroll_${id}.xlsx`);
  window.approveRun = async (id) => {
    if (!confirm('اعتماد المسير؟ لن يمكن تعديله بعد الاعتماد، وستصل قسائم الرواتب للموظفين.')) return;
    try { await api(`/api/payroll/runs/${id}/approve`, { method: 'POST' });
      toast('تم اعتماد المسير وإشعار الموظفين', 'ok'); loadRuns(); openRun(id); }
    catch (e) { toast(e.message, 'err'); }
  };
  // إلغاء اعتماد مسير معتمد: يعود مسودة قابلة للتعديل، والسبب يُحفظ في التدقيق
  window.revokeRun = (id) => modal({
    title: 'إلغاء اعتماد المسير',
    body: `<div class="help" style="margin-bottom:12px">سيعود المسير <b>مسودة</b> قابلة للتعديل
        وإعادة الاحتساب، وتختفي القسائم من شاشات الموظفين حتى تعتمده من جديد،
        ويصلهم إشعار بأن القسيمة قيد المراجعة. السبب يُحفظ في سجل التدقيق.</div>
      <div class="field"><label>سبب الإلغاء (إلزامي)</label>
        <input id="rvReason" placeholder="مثال: خطأ في بدلات الفترة المسائية" /></div>`,
    footer: '<button class="btn" id="rvSave">إلغاء الاعتماد</button><button class="btn gray" data-close>تراجع</button>',
    onOpen: (root) => {
      $('#rvSave', root).onclick = async () => {
        const reason = $('#rvReason', root).value.trim();
        if (reason.length < 3) return toast('اكتب سبب الإلغاء', 'err');
        try {
          await api(`/api/payroll/runs/${id}/revoke`, { method: 'POST', body: { reason } });
          toast('أُلغي الاعتماد وعاد المسير مسودة', 'ok');
          closeModal(); loadRuns(); openRun(id);
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
  window.deleteRun = async (id, approved) => {
    if (!approved) {
      if (!confirm('حذف المسير؟')) return;
      try { await api('/api/payroll/runs/' + id, { method: 'DELETE' });
        toast('تم الحذف', 'ok'); el('prDetail').innerHTML = ''; loadRuns(); }
      catch (e) { toast(e.message, 'err'); }
      return;
    }
    const reason = prompt('المسير معتمد. اكتب سبب الحذف (يُحفظ في سجل التدقيق):');
    if (!reason || reason.trim().length < 3) return;
    try {
      await api(`/api/payroll/runs/${id}?reason=${encodeURIComponent(reason.trim())}`,
        { method: 'DELETE' });
      toast('حُذف المسير وسُجّل الأثر', 'ok'); el('prDetail').innerHTML = ''; loadRuns();
    } catch (e) { toast(e.message, 'err'); }
  };
  window.adjustSlip = (id, additions, deductions) => modal({
    title: 'تعديل القسيمة',
    body: `<div class="field"><label>إضافات أخرى (بدلات)</label><input type="number" step="0.01" id="asAdd" value="${additions}" /></div>
      <div class="field"><label>خصومات أخرى</label><input type="number" step="0.01" id="asDed" value="${deductions}" /></div>
      <div class="field"><label>ملاحظة</label><input id="asNote" placeholder="بدل مواصلات / سلفة" /></div>`,
    footer: '<button class="btn" id="asSave">حفظ</button><button class="btn gray" data-close>إلغاء</button>',
    onOpen: (root) => { $('#asSave', root).onclick = async () => {
      try {
        const slip = await api('/api/payroll/payslips/' + id, { method: 'PATCH', body: {
          other_additions: Number(el('asAdd').value || 0),
          other_deductions: Number(el('asDed').value || 0),
          note: el('asNote').value || null } });
        toast('تم التعديل', 'ok'); closeModal(); openRun(slip.run_id); loadRuns();
      } catch (e) { toast(e.message, 'err'); }
    }; },
  });
  loadRuns();
};

async function myPayslipsView() {
  const slips = await api('/api/payroll/my-payslips');
  render(`<div class="card"><div class="card-head"><h3>قسائم رواتبي</h3></div>
    ${table(['الشهر', 'الراتب الأساسي', 'البدلات', 'أيام الحضور', 'أيام الغياب', 'خصومات', 'قسط السلفة', 'بدل الإضافي', 'صافي الراتب', ''],
      slips,
      (s) => {
        const deductions = s.absence_deduction + s.late_deduction + (s.early_leave_deduction || 0)
          + s.unpaid_leave_deduction + s.violation_deduction + s.other_deductions;
        return `<tr><td>مسير ${s.run_id}</td><td class="money">${money(s.basic_salary)}</td>
          <td class="money">${money(s.allowances)}</td><td>${s.present_days}</td><td>${s.absent_days}</td><td class="money">${money(deductions)}</td>
          <td class="money">${money(s.loan_deduction)}</td>
          <td class="money">${money(s.overtime_amount)}</td><td class="money"><b>${money(s.net_pay)}</b></td>
          <td><button class="btn sm ghost" onclick="printPayslip(${s.id})">${icon('printer')} قسيمتي</button>
            <button class="btn sm gray" onclick="showPayslipDeductions(${s.id},'')">الخصومات</button></td></tr>`;
      },
      'لا توجد قسائم معتمدة بعد')}</div>`);
}

/* ------------------------------ وثائق الموظفين ------------------------------ */
views.documents = async () => {
  const manage = isHR();
  const { employees } = manage ? await loadLookups() : { employees: [] };
  render(`
    <div class="card"><div class="card-body inline">
      ${manage ? '<button class="btn ok" id="dcNew">إضافة وثيقة</button>' : ''}
      <div class="field"><label>عرض</label><select id="dcFilter">
        <option value="">كل الوثائق</option><option value="30">تنتهي خلال 30 يوماً</option>
        <option value="90">تنتهي خلال 90 يوماً</option><option value="0">منتهية</option></select></div>
      ${manage ? `<div class="field"><label>الموظف</label><select id="dcEmp"><option value="">الكل</option>${options(employees, '', 'id', 'full_name')}</select></div>` : ''}
      <button class="btn ghost" id="dcLoad">عرض</button>
      ${manage ? '<button class="btn gray" id="dcScan">إرسال تنبيهات الانتهاء</button>' : ''}
    </div></div>
    <div class="card"><div class="card-head"><h3>الوثائق</h3><span class="muted" id="dcCount"></span></div>
      <div id="dcTable"><div class="empty">جارٍ التحميل…</div></div></div>`);

  const load = async () => {
    const q = new URLSearchParams();
    const filter = el('dcFilter').value;
    if (filter !== '') q.set('expiring_days', filter);
    if (el('dcEmp') && el('dcEmp').value) q.set('employee_id', el('dcEmp').value);
    const rows = await api('/api/documents?' + q);
    el('dcCount').textContent = `${rows.length} وثيقة`;
    el('dcTable').innerHTML = table(
      ['الموظف', 'نوع الوثيقة', 'الرقم', 'تاريخ الإصدار', 'تاريخ الانتهاء', 'المتبقي', 'الملف', ''],
      rows,
      (d) => {
        const left = d.days_left;
        const badge = left === null ? '—'
          : left < 0 ? `<span class="tag expired">منتهية منذ ${Math.abs(left)} يوم</span>`
          : left <= 30 ? `<span class="tag soon">${left} يوم</span>`
          : `${left} يوم`;
        return `<tr><td>${esc(d.employee_name)}</td><td>${esc(d.doc_type)}</td><td>${esc(d.number || '—')}</td>
          <td>${d.issue_date || '—'}</td><td>${d.expiry_date || '—'}</td><td>${badge}</td>
          <td>${d.file_path ? `<a href="/uploads/${encodeURIComponent(d.file_path)}" target="_blank">عرض</a>` : '—'}</td>
          <td>${manage ? `<button class="btn sm ghost" onclick="uploadDoc(${d.id})">رفع ملف</button>
               <button class="btn sm danger" onclick="delDoc(${d.id})">حذف</button>` : ''}</td></tr>`;
      },
      'لا توجد وثائق');
  };
  el('dcLoad').onclick = () => load().catch((e) => toast(e.message, 'err'));
  if (el('dcScan')) el('dcScan').onclick = async () => {
    try { const r = await api('/api/documents/scan-expiring', { method: 'POST' });
      toast(r.message, 'ok'); refreshBell(); } catch (e) { toast(e.message, 'err'); }
  };
  if (el('dcNew')) el('dcNew').onclick = () => modal({
    title: 'إضافة وثيقة',
    body: `<div class="grid cols-2">
        <div class="field"><label>الموظف</label><select id="dnEmp">${options(employees, '', 'id', 'full_name')}</select></div>
        <div class="field"><label>نوع الوثيقة</label><input id="dnType" list="docTypes" placeholder="إقامة" />
          <datalist id="docTypes">
            <option>إقامة</option><option>جواز سفر</option><option>عقد عمل</option>
            <option>رخصة قيادة</option><option>شهادة صحية</option><option>بطاقة تأمين</option>
            <option>مؤهل علمي</option><option>أخرى</option></datalist></div>
        <div class="field"><label>رقم الوثيقة</label><input id="dnNum" /></div>
        <div class="field"><label>تاريخ الإصدار</label><input type="date" id="dnIssue" /></div>
        <div class="field"><label>تاريخ الانتهاء</label><input type="date" id="dnExp" /></div>
        <div class="field"><label>ملاحظة</label><input id="dnNote" /></div>
      </div>`,
    width: 700,
    footer: '<button class="btn" id="dnSave">حفظ</button><button class="btn gray" data-close>إلغاء</button>',
    onOpen: (root) => { $('#dnSave', root).onclick = async () => {
      try {
        await api('/api/documents', { method: 'POST', body: {
          employee_id: Number(el('dnEmp').value), doc_type: el('dnType').value.trim() || 'أخرى',
          number: el('dnNum').value || null, issue_date: el('dnIssue').value || null,
          expiry_date: el('dnExp').value || null, note: el('dnNote').value || null } });
        toast('تمت إضافة الوثيقة', 'ok'); closeModal(); load();
      } catch (e) { toast(e.message, 'err'); }
    }; },
  });
  window.uploadDoc = (id) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.pdf,.png,.jpg,.jpeg,.webp';
    input.onchange = async () => {
      const fd = new FormData(); fd.append('file', input.files[0]);
      try { await api(`/api/documents/${id}/file`, { method: 'POST', body: fd });
        toast('تم رفع الملف', 'ok'); load(); } catch (e) { toast(e.message, 'err'); }
    };
    input.click();
  };
  window.delDoc = async (id) => {
    if (!confirm('حذف الوثيقة؟')) return;
    try { await api('/api/documents/' + id, { method: 'DELETE' }); toast('تم الحذف', 'ok'); load(); }
    catch (e) { toast(e.message, 'err'); }
  };
  load();
};

/* ------------------------------ التقارير ------------------------------ */
views.reports = async () => {
  const { departments } = await loadLookups();
  const now = new Date();
  render(`
    <div class="card"><div class="card-body inline">
      <div class="field"><label>السنة</label><input type="number" id="rYear" value="${now.getFullYear()}" /></div>
      <div class="field"><label>الشهر</label><select id="rMonth">${
        Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${i + 1 === now.getMonth() + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')
      }</select></div>
      <div class="field"><label>الإدارة</label><select id="rDep"><option value="">الكل</option>${options(departments)}</select></div>
      <button class="btn" id="rLoad">عرض الملخص الشهري</button>
      <button class="btn ghost" id="rExport">تصدير CSV</button>
    </div></div>
    <div class="grid cols-4 stagger" id="rKpis"></div>
    <div class="card"><div class="card-head"><h3>الملخص الشهري</h3></div>
      <div id="rTable"><div class="sk-rows">${'<div class="sk line"></div>'.repeat(4)}</div></div></div>
    <div class="card"><div class="card-head"><h3>تقرير الاستثناءات (غياب / تأخير / انصراف ناقص)</h3></div>
      <div class="card-body inline">
        <div class="field"><label>من</label><input type="date" id="xFrom" value="${monthStart()}" /></div>
        <div class="field"><label>إلى</label><input type="date" id="xTo" value="${today()}" /></div>
        <button class="btn" id="xLoad">عرض</button>
      </div>
      <div id="xTable"></div></div>`);
  const loadMonthly = async () => {
    const q = new URLSearchParams({ year: el('rYear').value, month: el('rMonth').value });
    if (el('rDep').value) q.set('department_id', el('rDep').value);
    const rows = await api('/api/reports/monthly?' + q);
    const sum = (key) => rows.reduce((total, r) => total + (r[key] || 0), 0);
    el('rKpis').innerHTML = rows.length ? `
      <div class="kpi ok"><div class="label">أيام الحضور<span class="ico">${icon('check')}</span></div>
        <div class="value ok">${sum('present_days')}</div><div class="foot">${rows.length} موظف</div></div>
      <div class="kpi danger"><div class="label">أيام الغياب<span class="ico">${icon('alert')}</span></div>
        <div class="value danger">${sum('absent_days')}</div></div>
      <div class="kpi warn"><div class="label">دقائق التأخير<span class="ico">${icon('clock')}</span></div>
        <div class="value warn">${sum('late_minutes')}</div><div class="foot">${sum('late_days')} يوم تأخير</div></div>
      <div class="kpi primary"><div class="label">ساعات العمل<span class="ico">${icon('clock')}</span></div>
        <div class="value">${Math.round(sum('worked_hours'))}</div>
        <div class="foot">إضافي ${sum('overtime_minutes')} دقيقة</div></div>` : '';
    el('rTable').innerHTML = table(
      ['الموظف', 'الإدارة', 'حضور', 'تأخير', 'غياب', 'إجازات', 'نسبة الحضور', 'ساعات العمل', 'دقائق تأخير', 'إضافي (د)'],
      rows,
      (r) => {
        const counted = r.present_days + r.late_days + r.absent_days;
        const pct = counted ? Math.round(((r.present_days + r.late_days) / counted) * 100) : 0;
        const tone = pct >= 90 ? 'ok' : pct >= 75 ? 'warn' : 'danger';
        return `<tr>
        <td><div style="display:flex;align-items:center;gap:9px">${avatar(r.employee_name, 'sm')}
          <div><div style="font-weight:600">${esc(r.employee_name)}</div>
          <div class="muted" style="font-size:11.5px">${esc(r.employee_code)}</div></div></div></td>
        <td>${esc(r.department_name || '—')}</td>
        <td>${r.present_days}</td><td>${r.late_days}</td><td>${r.absent_days}</td><td>${r.leave_days}</td>
        <td style="min-width:120px"><div class="progress ${tone}" title="${pct}%"><i style="width:${pct}%"></i></div>
          <span class="muted" style="font-size:11.5px">${pct}%</span></td>
        <td>${r.worked_hours}</td><td>${r.late_minutes}</td><td>${r.overtime_minutes}</td></tr>`;
      });
  };
  el('rLoad').onclick = () => loadMonthly().catch((e) => toast(e.message, 'err'));
  el('rExport').onclick = () => downloadCsv(
    `/api/reports/monthly-export.csv?year=${el('rYear').value}&month=${el('rMonth').value}`, 'summary.csv');
  el('xLoad').onclick = async () => {
    const rows = await api(`/api/reports/exceptions?date_from=${el('xFrom').value}&date_to=${el('xTo').value}`);
    el('xTable').innerHTML = table(
      ['التاريخ', 'رقم الموظف', 'الاسم', 'الحالة', 'وقت الحضور', 'وقت الانصراف', 'تأخير (د)', 'خروج مبكر (د)'],
      rows,
      (r) => `<tr><td>${r.work_date}</td><td>${esc(r.employee_code)}</td><td>${esc(r.employee_name)}</td>
        <td><span class="tag ${r.status === 'غائب' ? 'absent' : r.status === 'متأخر' ? 'late' : 'missing_out'}">${esc(r.status)}</span></td><td>${esc(r.check_in || '—')}</td><td>${esc(r.check_out || '—')}</td>
        <td>${r.late_minutes}</td><td>${r.early_leave_minutes}</td></tr>`,
      'لا توجد استثناءات في هذه الفترة');
  };
  loadMonthly().catch(() => {});
};

/* ------------------------------ الإعدادات ------------------------------ */
views.settings = async () => {
  render(`
    <div class="sub-tabs" id="setTabs">
      <button data-tab="departments" class="active">الإدارات</button>
      <button data-tab="shifts">الورديات</button>
      <button data-tab="leaveTypes">أنواع الإجازات</button>
      <button data-tab="holidays">العطل الرسمية</button>
      <button data-tab="sites">مواقع العمل والبصم الذاتي</button>
      <button data-tab="violationTypes">المخالفات والجزاءات</button>
      <button data-tab="attendanceRules">سياسة الحضور والاستراحة</button>
      <button data-tab="payrollRules">قواعد الرواتب</button>
      <button data-tab="alerts">التنبيهات وإشعارات الجوال</button>
      <button data-tab="branding">هوية المنشأة</button>
      <button data-tab="backup">النسخ الاحتياطي</button>
      <button data-tab="sheets">ربط جوجل شيت</button>
      <button data-tab="audit">سجل التدقيق</button>
      ${can('admin') ? '<button data-tab="users">المستخدمون</button>' : ''}
    </div><div id="setBody"></div>`);
  el('setTabs').querySelectorAll('button').forEach((b) => b.onclick = () => {
    el('setTabs').querySelectorAll('button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    settingsTabs[b.dataset.tab]();
  });
  settingsTabs.departments();
};

const settingsTabs = {};

settingsTabs.alerts = async () => {
  const st = await api('/api/settings');
  el('setBody').innerHTML = `<div class="card">
    <div class="card-head"><h3>تنبيه الغياب والتأخير</h3></div>
    <div class="card-body">
      <div class="grid cols-3">
        <div class="field"><label>تفعيل التنبيه اليومي</label><select id="alEnabled">
          <option value="true" ${st.attendance_alert_enabled ? 'selected' : ''}>مفعّل</option>
          <option value="false" ${st.attendance_alert_enabled ? '' : 'selected'}>معطّل</option></select></div>
        <div class="field"><label>بعد بداية الوردية بـ (دقيقة)</label>
          <input type="number" id="alAfter" min="5" max="600" value="${st.attendance_alert_after_minutes}" /></div>
        <div class="field"><label>تنبيه الموظف نفسه</label><select id="alEmp">
          <option value="true" ${st.attendance_alert_notify_employee ? 'selected' : ''}>نعم</option>
          <option value="false" ${st.attendance_alert_notify_employee ? '' : 'selected'}>لا</option></select></div>
      </div>
      <div class="inline">
        <button class="btn" id="alSave">حفظ</button>
        <button class="btn ghost" id="alScan">إرسال التنبيه الآن</button>
      </div>
      <div class="help">يُرسل مرة واحدة يومياً بعد مرور المدة أعلاه على بداية وردية كل موظف:
        قائمة من لم يبصم ومن تأخر، إلى الموارد البشرية ومدير الإدارة (وللموظف نفسه عند التفعيل).</div>
    </div></div>
    <div class="card">
      <div class="card-head"><h3>الإجازات والراحة الشهرية</h3></div>
      <div class="card-body">
        <div class="grid cols-3">
          <div class="field"><label>أيام الراحة الشهرية (الافتراضي للجميع)</label>
            <select id="alRest">${[0, 1, 2, 4, 6, 8].map((n) =>
              `<option value="${n}" ${n === st.monthly_rest_quota ? 'selected' : ''}>${
                n === 0 ? 'بلا راحة مجدولة' : n + ' ' + (n === 1 ? 'يوم' : n === 2 ? 'يومان' : 'أيام')
              }</option>`).join('')}${
              [0, 1, 2, 4, 6, 8].includes(st.monthly_rest_quota) ? ''
                : `<option value="${st.monthly_rest_quota}" selected>${st.monthly_rest_quota} أيام</option>`}
            </select>
            <div class="help">الشائع: يوم واحد، أو يومان، أو أربعة أيام في الشهر.
              هذا الرقم افتراضي فقط — ويمكن تحديد رصيد خاص لأي موظف من
              <a href="#" onclick="go('employees');return false">ملفه</a>.</div></div>
          <div class="field"><label>نظام أرصدة الإجازات</label><select id="alBalOn">
            <option value="false" ${st.leave_balances_enabled ? '' : 'selected'}>معطّل — الاعتماد على الطلبات</option>
            <option value="true" ${st.leave_balances_enabled ? 'selected' : ''}>يعمل — رصيد لكل نوع</option></select>
            <div class="help">وهو معطّل: لا تظهر الأرصدة في أي شاشة، ولا يُرفض طلب لنفاد الرصيد —
              القرار للإدارة عند الاعتماد. والسجلات محفوظة فتعود كما كانت بالتفعيل.</div></div>
          <div class="field"><label>احتساب العمل الإضافي</label><select id="alOt">
            <option value="true" ${st.overtime_requires_approval ? 'selected' : ''}>باعتماد الإدارة فقط</option>
            <option value="false" ${st.overtime_requires_approval ? '' : 'selected'}>تلقائي بلا اعتماد</option></select>
            <div class="help">الأصل: ما بعد نهاية الدوام يُسجَّل «وقتاً زائداً» ولا يدخل الراتب
              حتى تعتمده الإدارة، ويُحفظ اسم من اعتمده ووقته.</div></div>
          <div class="field"><label>إظهار رصيد الإجازات للموظف</label><select id="alBal">
            <option value="false" ${st.show_leave_balance_to_employee ? '' : 'selected'}>مخفي</option>
            <option value="true" ${st.show_leave_balance_to_employee ? 'selected' : ''}>ظاهر</option></select>
            <div class="help">لا أثر له وأرصدة الإجازات معطّلة.</div></div>
        </div>
        <button class="btn" id="alLeaveSave">حفظ</button>
      </div></div>
    <div class="card">
      <div class="card-head"><h3>حسابات دخول الموظفين</h3></div>
      <div class="card-body">
        <div class="field" style="max-width:320px"><label>إنشاء حساب تلقائياً عند إضافة رقم الجوال</label>
          <select id="alAuto">
            <option value="true" ${st.auto_account_on_phone ? 'selected' : ''}>مفعّل</option>
            <option value="false" ${st.auto_account_on_phone ? '' : 'selected'}>معطّل</option></select></div>
        <div class="inline">
          <button class="btn" id="alAutoSave">حفظ</button>
          <button class="btn ghost" id="alBackfill">إنشاء حسابات لكل من له رقم جوال</button>
        </div>
        <div class="help">عند التفعيل: أي موظف يُسجَّل له رقم جوال يصبح مصرَّحاً له بالدخول فوراً —
          اسم المستخدم وكلمة المرور المؤقتة هما رقم جواله، ويُلزم بتغييرها عند أول دخول.
          ولأن الرقم وسيلة دخول، لا يُقبل تكرار الرقم بين موظفَين.</div>
      </div></div>
    <div class="card">
      <div class="card-head"><h3>إشعارات الجوال (Web Push)</h3></div>
      <div class="card-body">
        <div class="field" style="max-width:260px"><label>تفعيل إشعارات الجوال للنظام كله</label>
          <select id="alPush">
            <option value="true" ${st.push_enabled ? 'selected' : ''}>مفعّلة</option>
            <option value="false" ${st.push_enabled ? '' : 'selected'}>معطّلة</option></select></div>
        <button class="btn" id="alPushSave">حفظ</button>
        <div class="help">كل مستخدم يفعّلها على جهازه من صفحة «حسابي ← إشعارات الجوال».
          تتطلب HTTPS، وعلى الآيفون تتطلب إضافة النظام إلى الشاشة الرئيسية.</div>
      </div></div>`;
  el('alSave').onclick = async () => {
    try {
      await api('/api/settings', { method: 'PUT', body: {
        attendance_alert_enabled: el('alEnabled').value === 'true',
        attendance_alert_after_minutes: Number(el('alAfter').value),
        attendance_alert_notify_employee: el('alEmp').value === 'true',
      } });
      toast('تم حفظ إعدادات التنبيه', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  el('alLeaveSave').onclick = async () => {
    try {
      await api('/api/settings', { method: 'PUT', body: {
        monthly_rest_quota: Number(el('alRest').value),
        leave_balances_enabled: el('alBalOn').value === 'true',
        overtime_requires_approval: el('alOt').value === 'true',
        show_leave_balance_to_employee: el('alBal').value === 'true' } });
      delete state.cache.settings;   // القائمة الجانبية تقرأ المفتاح من هنا
      toast('تم الحفظ — أعد تحميل الصفحة ليظهر أثر تغيير الأرصدة في القائمة', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  el('alAutoSave').onclick = async () => {
    try {
      await api('/api/settings', { method: 'PUT', body: {
        auto_account_on_phone: el('alAuto').value === 'true' } });
      toast('تم الحفظ', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  el('alBackfill').onclick = async () => {
    if (!confirm('سيُنشأ حساب دخول لكل موظف له رقم جوال ولا حساب له. متابعة؟')) return;
    try {
      const r = await api('/api/employees/ensure-accounts', { method: 'POST' });
      toast(r.message, 'ok');
      if (r.duplicates && r.duplicates.length) {
        modal({ title: 'أرقام مكررة لم يُنشأ لها حساب',
          body: `<div class="help">${r.duplicates.map(esc).join('<br>')}</div>`,
          footer: '<button class="btn gray" data-close>إغلاق</button>' });
      }
    } catch (e) { toast(e.message, 'err'); }
  };
  el('alPushSave').onclick = async () => {
    try {
      await api('/api/settings', { method: 'PUT', body: { push_enabled: el('alPush').value === 'true' } });
      toast('تم الحفظ', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  el('alScan').onclick = async () => {
    try {
      const r = await api('/api/attendance/alerts/scan', { method: 'POST' });
      toast(r.message, r.ok ? 'ok' : 'err'); refreshBell();
    } catch (e) { toast(e.message, 'err'); }
  };
};

settingsTabs.departments = async () => {
  const { employees } = await loadLookups();
  const rows = await api('/api/departments');
  el('setBody').innerHTML = `<div class="card">
    <div class="card-head"><h3>الإدارات</h3><button class="btn sm ok" id="depNew">إضافة إدارة</button></div>
    ${table(['الإدارة', 'عدد الموظفين', 'المدير', ''], rows, (d) => {
      const mgr = employees.find((e) => e.id === d.manager_id);
      return `<tr><td>${esc(d.name)}</td><td>${d.employees_count}</td><td>${esc(mgr ? mgr.full_name : '—')}</td>
        <td><button class="btn sm ghost" onclick="depEdit(${d.id})">تعديل</button>
            <button class="btn sm danger" onclick="depDel(${d.id})">حذف</button></td></tr>`;
    }, 'لا توجد إدارات')}</div>`;
  const form = (dep) => modal({
    title: dep ? 'تعديل إدارة' : 'إضافة إدارة',
    body: `<div class="field"><label>اسم الإدارة</label><input id="dpName" value="${esc(dep ? dep.name : '')}" /></div>
      <div class="field"><label>مدير الإدارة</label><select id="dpMgr"><option value="">—</option>${options(employees, dep && dep.manager_id, 'id', 'full_name')}</select></div>`,
    footer: `<button class="btn" id="dpSave">حفظ</button><button class="btn gray" data-close>إلغاء</button>`,
    onOpen: (root) => { $('#dpSave', root).onclick = async () => {
      const body = { name: el('dpName').value.trim(), manager_id: el('dpMgr').value ? Number(el('dpMgr').value) : null };
      try {
        if (dep) await api('/api/departments/' + dep.id, { method: 'PATCH', body });
        else await api('/api/departments', { method: 'POST', body });
        toast('تم الحفظ', 'ok'); closeModal(); loadLookups(true).then(settingsTabs.departments);
      } catch (e) { toast(e.message, 'err'); }
    }; },
  });
  el('depNew').onclick = () => form(null);
  window.depEdit = (id) => form(rows.find((d) => d.id === id));
  window.depDel = async (id) => {
    if (!confirm('حذف الإدارة؟')) return;
    try { await api('/api/departments/' + id, { method: 'DELETE' }); toast('تم الحذف', 'ok'); settingsTabs.departments(); }
    catch (e) { toast(e.message, 'err'); }
  };
};

settingsTabs.shifts = async () => {
  const rows = await api('/api/shifts');
  const daysText = (csv) => csv.split(',').filter(Boolean)
    .map((d) => (WEEK_DAYS.find((w) => w[0] === d.trim()) || ['', d])[1]).join('، ');
  el('setBody').innerHTML = `<div class="card">
    <div class="card-head"><h3>الورديات</h3><button class="btn sm ok" id="shNew">إضافة وردية</button></div>
    ${table(['الاسم', 'من', 'إلى', 'سماح دخول (د)', 'سماح خروج (د)', 'أيام العمل', ''], rows, (s) =>
      `<tr><td>${esc(s.name)}</td><td>${s.start_time.slice(0,5)}</td><td>${s.end_time.slice(0,5)}</td>
        <td>${s.grace_in_minutes}</td><td>${s.grace_out_minutes}</td><td>${esc(daysText(s.work_days))}</td>
        <td><button class="btn sm ghost" onclick="shEdit(${s.id})">تعديل</button>
            <button class="btn sm danger" onclick="shDel(${s.id})">حذف</button></td></tr>`, 'لا توجد ورديات')}
    </div>`;
  const form = (sh) => modal({
    title: sh ? 'تعديل وردية' : 'إضافة وردية',
    body: `<div class="grid cols-2">
        <div class="field"><label>اسم الوردية</label><input id="shName" value="${esc(sh ? sh.name : '')}" /></div>
        <div class="field"><label>بداية الدوام</label><input type="time" id="shStart" value="${sh ? sh.start_time.slice(0,5) : '08:00'}" /></div>
        <div class="field"><label>نهاية الدوام</label><input type="time" id="shEnd" value="${sh ? sh.end_time.slice(0,5) : '16:00'}" /></div>
        <div class="field"><label>سماح التأخير (دقائق)</label><input type="number" id="shGi" value="${sh ? sh.grace_in_minutes : 10}" /></div>
        <div class="field"><label>سماح الخروج المبكر (دقائق)</label><input type="number" id="shGo" value="${sh ? sh.grace_out_minutes : 10}" /></div>
        <div class="field"><label>استراحة (دقائق)</label><input type="number" id="shBrk" value="${sh ? sh.break_minutes : 0}" /></div>
      </div>
      <div class="field"><label>أيام العمل</label><div class="inline">${WEEK_DAYS.map(([v, t]) => {
        const on = sh ? sh.work_days.split(',').includes(v) : ['6','0','1','2','3'].includes(v);
        return `<label style="display:flex;gap:5px;align-items:center;font-size:13px">
          <input type="checkbox" class="shDay" value="${v}" ${on ? 'checked' : ''} style="width:auto" />${t}</label>`;
      }).join('')}</div></div>`,
    width: 700,
    footer: `<button class="btn" id="shSave">حفظ</button><button class="btn gray" data-close>إلغاء</button>`,
    onOpen: (root) => { $('#shSave', root).onclick = async () => {
      const days = Array.from(root.querySelectorAll('.shDay:checked')).map((c) => c.value).join(',');
      const body = { name: el('shName').value.trim(), start_time: el('shStart').value + ':00',
        end_time: el('shEnd').value + ':00', grace_in_minutes: Number(el('shGi').value),
        grace_out_minutes: Number(el('shGo').value), break_minutes: Number(el('shBrk').value),
        work_days: days, is_night_shift: el('shEnd').value <= el('shStart').value };
      try {
        if (sh) await api('/api/shifts/' + sh.id, { method: 'PATCH', body });
        else await api('/api/shifts', { method: 'POST', body });
        toast('تم الحفظ', 'ok'); closeModal(); loadLookups(true).then(settingsTabs.shifts);
      } catch (e) { toast(e.message, 'err'); }
    }; },
  });
  el('shNew').onclick = () => form(null);
  window.shEdit = (id) => form(rows.find((s) => s.id === id));
  window.shDel = async (id) => {
    if (!confirm('حذف الوردية؟')) return;
    try { await api('/api/shifts/' + id, { method: 'DELETE' }); toast('تم الحذف', 'ok'); settingsTabs.shifts(); }
    catch (e) { toast(e.message, 'err'); }
  };
};

settingsTabs.leaveTypes = async () => {
  const rows = await api('/api/leave-types');
  el('setBody').innerHTML = `<div class="card">
    <div class="card-head"><h3>أنواع الإجازات</h3><button class="btn sm ok" id="ltNew">إضافة نوع</button></div>
    ${table(['الرمز', 'الاسم', 'الرصيد السنوي', 'مدفوعة', 'تخصم من الرصيد', 'تتطلب مرفق', 'مفعّلة', ''], rows, (t) =>
      `<tr><td>${esc(t.code)}</td><td>${esc(t.name)}</td><td>${t.annual_quota_days}</td>
        <td>${t.is_paid ? 'نعم' : 'لا'}</td><td>${t.deducts_balance ? 'نعم' : 'لا'}</td>
        <td>${t.requires_attachment ? 'نعم' : 'لا'}</td>
        <td><span class="tag ${t.is_active ? 'on' : 'off'}">${t.is_active ? 'مفعّلة' : 'موقوفة'}</span></td>
        <td><button class="btn sm ghost" onclick="ltEdit(${t.id})">تعديل</button></td></tr>`, 'لا توجد أنواع')}</div>`;
  const form = (t) => modal({
    title: t ? 'تعديل نوع إجازة' : 'إضافة نوع إجازة',
    body: `<div class="grid cols-2">
      <div class="field"><label>الرمز (إنجليزي)</label><input id="ltCode" value="${esc(t ? t.code : '')}" ${t ? 'readonly' : ''} /></div>
      <div class="field"><label>الاسم</label><input id="ltName" value="${esc(t ? t.name : '')}" /></div>
      <div class="field"><label>الرصيد السنوي (أيام)</label><input type="number" step="0.5" id="ltQuota" value="${t ? t.annual_quota_days : 0}" /></div>
      <div class="field"><label>حد أقصى متصل (0 = بلا حد)</label><input type="number" id="ltMax" value="${t ? t.max_consecutive_days : 0}" /></div>
      <div class="field"><label>مدفوعة</label><select id="ltPaid"><option value="true" ${!t || t.is_paid ? 'selected' : ''}>نعم</option><option value="false" ${t && !t.is_paid ? 'selected' : ''}>لا</option></select></div>
      <div class="field"><label>تخصم من الرصيد</label><select id="ltDed"><option value="true" ${!t || t.deducts_balance ? 'selected' : ''}>نعم</option><option value="false" ${t && !t.deducts_balance ? 'selected' : ''}>لا</option></select></div>
      <div class="field"><label>استثناء العطل الأسبوعية</label><select id="ltWk"><option value="true" ${!t || t.exclude_weekends ? 'selected' : ''}>نعم</option><option value="false" ${t && !t.exclude_weekends ? 'selected' : ''}>لا</option></select></div>
      <div class="field"><label>استثناء العطل الرسمية</label><select id="ltHol"><option value="true" ${!t || t.exclude_holidays ? 'selected' : ''}>نعم</option><option value="false" ${t && !t.exclude_holidays ? 'selected' : ''}>لا</option></select></div>
      <div class="field"><label>تتطلب مرفقاً</label><select id="ltAtt"><option value="false" ${!t || !t.requires_attachment ? 'selected' : ''}>لا</option><option value="true" ${t && t.requires_attachment ? 'selected' : ''}>نعم</option></select></div>
      <div class="field"><label>مفعّلة</label><select id="ltAct"><option value="true" ${!t || t.is_active ? 'selected' : ''}>نعم</option><option value="false" ${t && !t.is_active ? 'selected' : ''}>لا</option></select></div>
    </div>`,
    width: 720,
    footer: `<button class="btn" id="ltSave">حفظ</button><button class="btn gray" data-close>إلغاء</button>`,
    onOpen: (root) => { $('#ltSave', root).onclick = async () => {
      const b = (id) => el(id).value === 'true';
      const body = { code: el('ltCode').value.trim(), name: el('ltName').value.trim(),
        annual_quota_days: Number(el('ltQuota').value), max_consecutive_days: Number(el('ltMax').value),
        is_paid: b('ltPaid'), deducts_balance: b('ltDed'), exclude_weekends: b('ltWk'),
        exclude_holidays: b('ltHol'), requires_attachment: b('ltAtt'), is_active: b('ltAct') };
      try {
        if (t) await api('/api/leave-types/' + t.id, { method: 'PATCH', body });
        else await api('/api/leave-types', { method: 'POST', body });
        toast('تم الحفظ', 'ok'); closeModal(); loadLookups(true).then(settingsTabs.leaveTypes);
      } catch (e) { toast(e.message, 'err'); }
    }; },
  });
  el('ltNew').onclick = () => form(null);
  window.ltEdit = (id) => form(rows.find((t) => t.id === id));
};

settingsTabs.holidays = async () => {
  const year = new Date().getFullYear();
  const rows = await api('/api/holidays?year=' + year);
  el('setBody').innerHTML = `<div class="card">
    <div class="card-head"><h3>العطل الرسمية لعام ${year}</h3></div>
    <div class="card-body inline">
      <div class="field"><label>التاريخ</label><input type="date" id="hDate" value="${today()}" /></div>
      <div class="field"><label>المناسبة</label><input id="hName" placeholder="عيد الفطر" /></div>
      <button class="btn ok" id="hAdd">إضافة</button>
    </div>
    ${table(['التاريخ', 'المناسبة', ''], rows, (h) =>
      `<tr><td>${h.holiday_date}</td><td>${esc(h.name)}</td>
        <td><button class="btn sm danger" onclick="holDel(${h.id})">حذف</button></td></tr>`, 'لا توجد عطل مسجلة')}
    </div>`;
  el('hAdd').onclick = async () => {
    try {
      await api('/api/holidays', { method: 'POST', body: { holiday_date: el('hDate').value, name: el('hName').value.trim() } });
      toast('تمت الإضافة', 'ok'); settingsTabs.holidays();
    } catch (e) { toast(e.message, 'err'); }
  };
  window.holDel = async (id) => {
    if (!confirm('حذف العطلة؟')) return;
    try { await api('/api/holidays/' + id, { method: 'DELETE' }); toast('تم الحذف', 'ok'); settingsTabs.holidays(); }
    catch (e) { toast(e.message, 'err'); }
  };
};

settingsTabs.sites = async () => {
  const [rows, settings] = await Promise.all([api('/api/sites'), api('/api/settings')]);
  state.cache.sites = rows;
  state.cache.settings = settings;
  el('setBody').innerHTML = `
    <div class="card"><div class="card-head"><h3>إعدادات البصم من التطبيق</h3></div>
      <div class="card-body">
        <div class="inline">
          <div class="field"><label>السماح بالبصم من التطبيق</label><select id="stEnabled">
            <option value="true" ${settings.web_punch_enabled ? 'selected' : ''}>مفعّل</option>
            <option value="false" ${!settings.web_punch_enabled ? 'selected' : ''}>معطّل</option></select></div>
          <div class="field"><label>إلزام التواجد داخل موقع العمل</label><select id="stGeo">
            <option value="true" ${settings.web_punch_requires_location ? 'selected' : ''}>إلزامي</option>
            <option value="false" ${!settings.web_punch_requires_location ? 'selected' : ''}>غير إلزامي</option></select></div>
          <div class="field"><label>أقصى هامش خطأ للموقع (متر)</label>
            <input type="number" id="stAcc" value="${settings.geo_max_accuracy_meters}" /></div>
          <button class="btn" id="stSave">حفظ الإعدادات</button>
        </div>
        <div class="help">عند تفعيل الإلزام، لا تُقبل بصمة الموظف من التطبيق إلا إذا كان داخل نطاق
          أحد مواقع العمل أدناه. الموظف المرتبط بموقع محدد يُقبل منه البصم من ذلك الموقع فقط.
          <br>ملاحظة: متصفحات الجوال تمنح صلاحية الموقع فقط عبر <b>HTTPS</b> (أو localhost أثناء التجربة).</div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>مواقع العمل المعتمدة</h3><button class="btn sm ok" id="siteNew">إضافة موقع</button></div>
      ${table(['الموقع', 'خط العرض', 'خط الطول', 'النطاق (متر)', 'العنوان', 'الموظفون', 'الحالة', ''], rows, (s) =>
        `<tr><td>${esc(s.name)}</td><td>${s.latitude.toFixed(6)}</td><td>${s.longitude.toFixed(6)}</td>
          <td>${s.radius_meters}</td><td>${esc(s.address || '—')}</td><td>${s.employees_count}</td>
          <td><span class="tag ${s.is_active ? 'on' : 'off'}">${s.is_active ? 'مفعّل' : 'موقوف'}</span></td>
          <td><a class="btn sm ghost" href="https://www.openstreetmap.org/?mlat=${s.latitude}&mlon=${s.longitude}#map=17/${s.latitude}/${s.longitude}" target="_blank" rel="noopener">الخريطة</a>
              <button class="btn sm ghost" onclick="siteEdit(${s.id})">تعديل</button>
              <button class="btn sm danger" onclick="siteDel(${s.id})">حذف</button></td></tr>`,
        'لا توجد مواقع معتمدة — أضف موقعاً حتى يتمكن الموظفون من البصم من التطبيق')}
    </div>`;

  el('stSave').onclick = async () => {
    try {
      state.cache.settings = await api('/api/settings', { method: 'PUT', body: {
        web_punch_enabled: el('stEnabled').value === 'true',
        web_punch_requires_location: el('stGeo').value === 'true',
        geo_max_accuracy_meters: Number(el('stAcc').value) } });
      toast('تم حفظ الإعدادات', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  const form = (site) => modal({
    title: site ? 'تعديل موقع عمل' : 'إضافة موقع عمل',
    body: `<div class="grid cols-2">
        <div class="field"><label>اسم الموقع</label><input id="siName" value="${esc(site ? site.name : '')}" placeholder="المقر الرئيسي" /></div>
        <div class="field"><label>النطاق المسموح (متر)</label><input type="number" id="siRad" value="${site ? site.radius_meters : 150}" /></div>
        <div class="field"><label>خط العرض (Latitude)</label><input id="siLat" value="${site ? site.latitude : ''}" placeholder="24.774265" /></div>
        <div class="field"><label>خط الطول (Longitude)</label><input id="siLng" value="${site ? site.longitude : ''}" placeholder="46.738586" /></div>
        <div class="field"><label>العنوان</label><input id="siAddr" value="${esc(site ? site.address || '' : '')}" /></div>
        <div class="field"><label>الحالة</label><select id="siAct">
          <option value="true" ${!site || site.is_active ? 'selected' : ''}>مفعّل</option>
          <option value="false" ${site && !site.is_active ? 'selected' : ''}>موقوف</option></select></div>
      </div>
      <button class="btn ghost" id="siHere"> التقاط موقعي الحالي</button>
      <div class="help" id="siHint">قف داخل موقع العمل واضغط الزر لتعبئة الإحداثيات تلقائياً،
        أو انسخها من خرائط Google بالضغط المطوّل على المكان.</div>`,
    width: 700,
    footer: `<button class="btn" id="siSave">حفظ</button><button class="btn gray" data-close>إلغاء</button>`,
    onOpen: (root) => {
      $('#siHere', root).onclick = async () => {
        el('siHint').textContent = 'جارٍ تحديد الموقع…';
        try {
          const pos = await currentPosition();
          el('siLat').value = pos.latitude.toFixed(6);
          el('siLng').value = pos.longitude.toFixed(6);
          el('siHint').textContent = `تم التقاط الموقع بدقة ${pos.accuracy_meters} متر.`;
        } catch (e) { el('siHint').textContent = e.message; }
      };
      $('#siSave', root).onclick = async () => {
        const body = { name: el('siName').value.trim(), latitude: Number(el('siLat').value),
          longitude: Number(el('siLng').value), radius_meters: Number(el('siRad').value),
          address: el('siAddr').value || null, is_active: el('siAct').value === 'true' };
        if (!body.latitude || !body.longitude) { toast('أدخل إحداثيات الموقع', 'err'); return; }
        try {
          if (site) await api('/api/sites/' + site.id, { method: 'PATCH', body });
          else await api('/api/sites', { method: 'POST', body });
          toast('تم الحفظ', 'ok'); closeModal(); loadLookups(true).then(settingsTabs.sites);
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
  el('siteNew').onclick = () => form(null);
  window.siteEdit = (id) => form(rows.find((s) => s.id === id));
  window.siteDel = async (id) => {
    if (!confirm('حذف الموقع؟ سيتمكن الموظفون المرتبطون به من البصم من أي موقع معتمد آخر.')) return;
    try { await api('/api/sites/' + id, { method: 'DELETE' }); toast('تم الحذف', 'ok'); settingsTabs.sites(); }
    catch (e) { toast(e.message, 'err'); }
  };
};

settingsTabs.violationTypes = async () => {
  const rows = await api('/api/violation-types');
  el('setBody').innerHTML = `<div class="card">
    <div class="card-head"><h3>أنواع المخالفات وسلّم الجزاءات</h3>
      <button class="btn sm ok" id="vtNew">إضافة نوع</button></div>
    <div class="card-body help">سلّم الجزاءات يُطبَّق تلقائياً حسب تكرار المخالفة خلال المدة النظامية
      (افتراضياً 180 يوماً، قابلة للتعديل من «قواعد الرواتب»). تأكد من مطابقة القيم للائحة تنظيم العمل
      المعتمدة لدى منشأتك.</div>
    ${table(['التصنيف', 'المخالفة', 'الأولى', 'الثانية', 'الثالثة', 'الرابعة فأكثر', 'الحالة', ''], rows, (t) =>
      `<tr><td>${esc(t.category)}</td><td>${esc(t.name)}</td>
        <td>${penaltyText(t.level1_action, t.level1_value)}</td>
        <td>${penaltyText(t.level2_action, t.level2_value)}</td>
        <td>${penaltyText(t.level3_action, t.level3_value)}</td>
        <td>${penaltyText(t.level4_action, t.level4_value)}</td>
        <td><span class="tag ${t.is_active ? 'on' : 'off'}">${t.is_active ? 'مفعّل' : 'موقوف'}</span></td>
        <td><button class="btn sm ghost" onclick="vtEdit(${t.id})">تعديل</button></td></tr>`,
      'لا توجد أنواع')}</div>`;

  const levelFields = (t, n) => `
    <div class="field"><label>المخالفة ${['الأولى','الثانية','الثالثة','الرابعة فأكثر'][n-1]}</label>
      <div class="inline">
        <select id="vt${n}a" style="flex:2">${Object.entries(PENALTY_ACTIONS).map(([k, v]) =>
          `<option value="${k}" ${t && t[`level${n}_action`] === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <input type="number" step="0.5" id="vt${n}v" style="flex:1" value="${t ? t[`level${n}_value`] : [0,5,10,1][n-1]}" />
      </div></div>`;

  const form = (t) => modal({
    title: t ? 'تعديل نوع مخالفة' : 'إضافة نوع مخالفة',
    width: 720,
    body: `<div class="grid cols-2">
        <div class="field"><label>الرمز (إنجليزي)</label><input id="vtCode" value="${esc(t ? t.code : '')}" ${t ? 'readonly' : ''} /></div>
        <div class="field"><label>التصنيف</label><input id="vtCat" list="vtCats" value="${esc(t ? t.category : '')}" placeholder="النظافة والسلامة" />
          <datalist id="vtCats"><option>المظهر والزي</option><option>النظافة والسلامة</option>
            <option>الالتزام بموقع العمل</option><option>الانضباط الوظيفي</option><option>سلوك عام</option></datalist></div>
      </div>
      <div class="field"><label>وصف المخالفة</label><input id="vtName" value="${esc(t ? t.name : '')}" /></div>
      <div class="grid cols-2">${[1,2,3,4].map((n) => levelFields(t, n)).join('')}</div>
      <div class="field"><label>الحالة</label><select id="vtAct">
        <option value="true" ${!t || t.is_active ? 'selected' : ''}>مفعّل</option>
        <option value="false" ${t && !t.is_active ? 'selected' : ''}>موقوف</option></select></div>
      <div class="help">قيمة الخصم: نسبة مئوية من أجر اليوم عند اختيار «خصم نسبة»، أو عدد الأيام عند اختيار «خصم أيام».</div>`,
    footer: '<button class="btn" id="vtSave">حفظ</button><button class="btn gray" data-close>إلغاء</button>',
    onOpen: (root) => { $('#vtSave', root).onclick = async () => {
      const body = { code: el('vtCode').value.trim(), name: el('vtName').value.trim(),
        category: el('vtCat').value.trim() || 'سلوك عام', is_active: el('vtAct').value === 'true' };
      [1,2,3,4].forEach((n) => {
        body[`level${n}_action`] = el(`vt${n}a`).value;
        body[`level${n}_value`] = Number(el(`vt${n}v`).value || 0);
      });
      try {
        if (t) await api('/api/violation-types/' + t.id, { method: 'PATCH', body });
        else await api('/api/violation-types', { method: 'POST', body });
        toast('تم الحفظ', 'ok'); closeModal(); settingsTabs.violationTypes();
      } catch (e) { toast(e.message, 'err'); }
    }; },
  });
  el('vtNew').onclick = () => form(null);
  window.vtEdit = (id) => form(rows.find((t) => t.id === id));
};

settingsTabs.payrollRules = async () => {
  const st = await api('/api/settings');
  state.cache.settings = st;
  el('setBody').innerHTML = `<div class="card">
    <div class="card-head"><h3>قواعد احتساب الرواتب والمخالفات</h3></div>
    <div class="card-body">
      <div class="grid cols-3">
        <div class="field"><label>أيام الشهر لاحتساب أجر اليوم</label><input type="number" id="pyDays" value="${st.payroll_days_per_month}" /></div>
        <div class="field"><label>ساعات يوم العمل</label><input type="number" id="pyHours" value="${st.payroll_workday_hours}" /></div>
        <div class="field"><label>معامل أجر الساعة الإضافية</label><input type="number" step="0.1" id="pyOt" value="${st.payroll_overtime_multiplier}" /></div>
        <div class="field"><label>خصم التأخير</label><select id="pyLate">
          <option value="proportional" ${st.payroll_late_deduction_mode === 'proportional' ? 'selected' : ''}>بمقدار زمن التأخير</option>
          <option value="none" ${st.payroll_late_deduction_mode === 'none' ? 'selected' : ''}>بدون خصم</option></select></div>
        <div class="field"><label>خصم الخروج المبكر</label><select id="pyEarly">
          <option value="proportional" ${st.payroll_early_leave_deduction_mode !== 'none' ? 'selected' : ''}>بمقدار زمن الخروج المبكر</option>
          <option value="none" ${st.payroll_early_leave_deduction_mode === 'none' ? 'selected' : ''}>بدون خصم</option></select>
          <div class="help">من خرج قبل نهاية الدوام بأكثر من دقائق السماح (${st.early_leave_grace_minutes} دقيقة
            في سياسة الحضور) يُخصم عنه كامل زمن خروجه المبكر بأجر الساعة.</div></div>
        <div class="field"><label>خصم يوم الغياب بدون إذن (بالأيام)</label>
          <input type="number" step="0.5" min="0" max="3" id="pyAbs" value="${st.payroll_absence_multiplier}" />
          <div class="help">2 = يُخصم أجر يومين عن كل يوم غياب بدون إذن.</div></div>
        <div class="field"><label>أساس احتساب الخصم وأجر اليوم</label><select id="pyBase">
          <option value="total" ${st.payroll_deduction_base !== 'basic' ? 'selected' : ''}>الأساسي + البدلات (الإجمالي)</option>
          <option value="basic" ${st.payroll_deduction_base === 'basic' ? 'selected' : ''}>الأساسي فقط</option></select></div>
        <div class="field"><label>مدة محو تكرار المخالفة (يوم)</label><input type="number" id="pyReset" value="${st.violation_reset_days}" /></div>
        <div class="field"><label>التنبيه قبل انتهاء الوثيقة (يوم)</label><input type="number" id="pyDoc" value="${st.document_alert_days}" /></div>
      </div>
      <button class="btn" id="pySave">حفظ القواعد</button>
      <div class="help">نظام العمل السعودي: أجر الساعة الإضافية = أجر الساعة + 50% (المعامل 1.5)،
        والمخالفة تُمحى من سجل التكرار بعد 180 يوماً.<br>
        الغياب <b>بدون إذن</b> يُخصم بالمعامل أعلاه، أما الغياب <b>بإذن</b> فيُسجَّل إجازة:
        «إجازة بدون راتب» تُخصم يوماً واحداً فقط، والإجازة المدفوعة بلا خصم.</div>
    </div></div>`;
  el('pySave').onclick = async () => {
    try {
      state.cache.settings = await api('/api/settings', { method: 'PUT', body: {
        payroll_days_per_month: Number(el('pyDays').value),
        payroll_workday_hours: Number(el('pyHours').value),
        payroll_overtime_multiplier: Number(el('pyOt').value),
        payroll_late_deduction_mode: el('pyLate').value,
        payroll_early_leave_deduction_mode: el('pyEarly').value,
        payroll_absence_multiplier: Number(el('pyAbs').value),
        payroll_deduction_base: el('pyBase').value,
        violation_reset_days: Number(el('pyReset').value),
        document_alert_days: Number(el('pyDoc').value) } });
      toast('تم حفظ القواعد', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
};

const POLICY_SCOPES = { default: 'افتراضية (كل الموظفين)', site: 'فرع', department: 'إدارة', shift: 'وردية' };

settingsTabs.attendanceRules = async () => {
  const [st, policies, sites, departments, shifts] = await Promise.all([
    api('/api/settings'), api('/api/attendance-policies'),
    api('/api/sites'), api('/api/departments'), api('/api/shifts'),
  ]);
  state.cache.settings = st;
  const num = (id, label, value, help) =>
    `<div class="field"><label>${label}</label>
      <input type="number" min="0" id="${id}" value="${value}" />
      ${help ? `<div class="help">${help}</div>` : ''}</div>`;

  el('setBody').innerHTML = `
    <div class="card"><div class="card-head"><h3>السياسة الافتراضية</h3></div>
      <div class="card-body">
        <div class="help" style="margin-bottom:14px">تُطبَّق على كل الموظفين، ويمكن تجاوزها
          بسياسة أخص لفرع أو إدارة أو وردية في البطاقة أدناه.</div>
        <div class="grid cols-3">
          ${num('arAllow', 'مدة الاستراحة المسموحة يومياً (دقيقة)', st.break_allowance_minutes)}
          ${num('arGrace', 'دقائق السماح فوق المسموح', st.break_grace_minutes)}
          ${num('arMaxCount', 'حد عدد الاستراحات في اليوم', st.break_max_count, '0 = بلا حد لعدد مرات الاستراحة')}
          ${num('arMaxTotal', 'الحد الأعلى لإجمالي وقت الاستراحة', st.break_max_total_minutes, '0 = يساوي المسموح')}
          <div class="field"><label>خصم وقت الاستراحة من ساعات العمل</label>
            <select id="arDeduct">
              <option value="true" ${st.break_deducted ? 'selected' : ''}>يُخصم</option>
              <option value="false" ${!st.break_deducted ? 'selected' : ''}>لا يُخصم</option></select></div>
          ${num('arOut', 'وقت السماح بالانصراف (دقيقة قبل نهاية الوردية)', st.clock_out_from_minutes,
                'البصم بعد هذا الوقت يُفهم انصرافاً، وقبله استراحة.')}
          ${num('arEarly', 'سياسة الخروج المبكر: دقائق السماح', st.early_leave_grace_minutes,
                'من خرج قبل نهاية الدوام بأقل من هذا لا يُحتسب عليه شيء، وبأكثر منه يُخصم كامل زمنه.')}
          ${num('arLate', 'سياسة التأخير: دقائق السماح', st.late_grace_minutes)}
          ${num('arDebounce', 'تجاهل البصمات المكررة (ثانية)', st.punch_debounce_seconds,
                'يُنصح بـ 10 إلى 30 ثانية لمنع تكرار بصمة الجهاز.')}
        </div>
        <button class="btn" id="arSave">حفظ السياسة الافتراضية</button>
        <div class="help" style="margin-top:12px">تجاوز الاستراحة <b>لا يمنع</b> الموظف من تسجيل
          العودة: يُسجَّل التجاوز ويصل تنبيه للإدارة.<br>
          ولا استراحة أصلاً داخل «وقت السماح بالانصراف»: أي بصمة فيه تُفهم انصرافاً.</div>
      </div></div>

    <div class="card"><div class="card-head"><h3>عند تجاوز وقت الاستراحة</h3></div>
      <div class="card-body">
        <div class="grid cols-3">
          <div class="field"><label>تنبيه الموظف نفسه</label><select id="arEmpAlert">
            <option value="true" ${st.break_alert_employee ? 'selected' : ''}>يصله تنبيه</option>
            <option value="false" ${!st.break_alert_employee ? 'selected' : ''}>الإدارة فقط</option></select></div>
          <div class="field"><label>تسجيل مخالفة تلقائية</label><select id="arViol">
            <option value="true" ${st.break_violation_enabled ? 'selected' : ''}>نعم</option>
            <option value="false" ${!st.break_violation_enabled ? 'selected' : ''}>لا</option></select></div>
          <div class="field"><label>حد التجاوز لتسجيل المخالفة (دقيقة)</label>
            <input type="number" min="1" id="arViolAfter" value="${st.break_violation_after_minutes}" />
            <div class="help">التجاوز الأقل من هذا يُسجَّل وينبَّه عليه بلا مخالفة.</div></div>
        </div>
        <button class="btn" id="arViolSave">حفظ</button>
        <div class="help" style="margin-top:12px">المخالفة تُسجَّل باسم «تجاوز وقت الاستراحة»
          بحالة <b>بانتظار إقرار الموظف</b>، فله أن يقرّ أو يتظلّم، ولا تُخصم من راتبه
          إلا بعد اعتماد الموارد البشرية — وجزاؤها يتصاعد مع التكرار كبقية المخالفات.</div>
      </div></div>

    <div class="card"><div class="card-head"><h3>سياسات الفروع والإدارات والورديات</h3>
      <button class="btn sm" id="arAdd">إضافة سياسة</button></div>
      <div id="arList"></div></div>`;

  const scopeOptions = (scope, id) => {
    const source = scope === 'site' ? sites : scope === 'department' ? departments : shifts;
    return options(source, id, 'id', 'name');
  };

  const renderList = () => {
    el('arList').innerHTML = table(
      ['السياسة', 'النطاق', 'الاستراحة المسموحة', 'حد العدد', 'الخصم', 'وقت الانصراف', ''],
      policies,
      (r) => `<tr><td><b>${esc(r.name)}</b></td>
        <td>${esc(r.scope_label)}${r.scope_name ? ' — ' + esc(r.scope_name) : ''}</td>
        <td>${r.break_allowance_minutes ?? '—'}</td>
        <td>${r.max_break_count === null ? '—' : (r.max_break_count || 'بلا حد')}</td>
        <td>${r.deduct_breaks === null ? '—' : (r.deduct_breaks ? 'يُخصم' : 'لا يُخصم')}</td>
        <td>${r.clock_out_from_minutes ?? '—'}</td>
        <td><button class="btn sm ghost" onclick="policyEdit(${r.id})">تعديل</button>
          <button class="btn sm danger" onclick="policyDelete(${r.id})">حذف</button></td></tr>`,
      'لا سياسات خاصة — الجميع على السياسة الافتراضية');
  };
  renderList();

  const form = (row) => modal({
    title: row ? 'تعديل سياسة' : 'سياسة جديدة',
    body: `<div class="help" style="margin-bottom:12px">اترك أي حقل فارغاً ليرث قيمته من
        السياسة الأعم. الأخص يغلب: الوردية ثم الإدارة ثم الفرع ثم الافتراضية.</div>
      <div class="field"><label>اسم السياسة</label>
        <input id="poName" value="${esc(row?.name || '')}" placeholder="مثال: استراحة المطبخ" /></div>
      <div class="field"><label>النطاق</label><select id="poScope">
        ${Object.entries(POLICY_SCOPES).map(([k, v]) =>
          `<option value="${k}" ${row?.scope === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field ${!row || row.scope === 'default' ? 'hidden' : ''}" id="poTargetWrap">
        <label>الجهة</label><select id="poTarget">${
          row && row.scope !== 'default' ? scopeOptions(row.scope, row.scope_id) : ''}</select></div>
      <div class="grid cols-2">
        <div class="field"><label>الاستراحة المسموحة (دقيقة)</label>
          <input type="number" min="0" id="poAllow" value="${row?.break_allowance_minutes ?? ''}" /></div>
        <div class="field"><label>دقائق السماح</label>
          <input type="number" min="0" id="poGrace" value="${row?.break_grace_minutes ?? ''}" /></div>
        <div class="field"><label>حد عدد الاستراحات (0 = بلا حد)</label>
          <input type="number" min="0" id="poCount" value="${row?.max_break_count ?? ''}" /></div>
        <div class="field"><label>الحد الأعلى لإجمالي الاستراحة</label>
          <input type="number" min="0" id="poTotal" value="${row?.max_total_break_minutes ?? ''}" /></div>
        <div class="field"><label>خصم الاستراحة من ساعات العمل</label><select id="poDeduct">
          <option value="">حسب الأعم</option>
          <option value="true" ${row?.deduct_breaks === true ? 'selected' : ''}>يُخصم</option>
          <option value="false" ${row?.deduct_breaks === false ? 'selected' : ''}>لا يُخصم</option></select></div>
        <div class="field"><label>وقت السماح بالانصراف (دقيقة)</label>
          <input type="number" min="0" id="poOut" value="${row?.clock_out_from_minutes ?? ''}" /></div>
        <div class="field"><label>سماح الخروج المبكر</label>
          <input type="number" min="0" id="poEarly" value="${row?.early_leave_grace_minutes ?? ''}" /></div>
        <div class="field"><label>سماح التأخير</label>
          <input type="number" min="0" id="poLate" value="${row?.late_grace_minutes ?? ''}" /></div>
        <div class="field"><label>تجاهل التكرار (ثانية)</label>
          <input type="number" min="0" id="poDebounce" value="${row?.debounce_seconds ?? ''}" /></div>
      </div>`,
    footer: '<button class="btn" id="poSave">حفظ</button><button class="btn gray" data-close>إلغاء</button>',
    onOpen: (root) => {
      const scopeSel = $('#poScope', root);
      scopeSel.onchange = () => {
        const scope = scopeSel.value;
        $('#poTargetWrap', root).classList.toggle('hidden', scope === 'default');
        if (scope !== 'default') $('#poTarget', root).innerHTML = scopeOptions(scope, null);
      };
      $('#poSave', root).onclick = async () => {
        const numOrNull = (id) => {
          const raw = $('#' + id, root).value.trim();
          return raw === '' ? null : Number(raw);
        };
        const deduct = $('#poDeduct', root).value;
        const scope = scopeSel.value;
        const body = {
          name: $('#poName', root).value.trim(),
          scope,
          scope_id: scope === 'default' ? null : Number($('#poTarget', root).value),
          is_active: true,
          break_allowance_minutes: numOrNull('poAllow'),
          break_grace_minutes: numOrNull('poGrace'),
          max_break_count: numOrNull('poCount'),
          max_total_break_minutes: numOrNull('poTotal'),
          deduct_breaks: deduct === '' ? null : deduct === 'true',
          clock_out_from_minutes: numOrNull('poOut'),
          early_leave_grace_minutes: numOrNull('poEarly'),
          late_grace_minutes: numOrNull('poLate'),
          debounce_seconds: numOrNull('poDebounce'),
        };
        try {
          await api(row ? '/api/attendance-policies/' + row.id : '/api/attendance-policies',
            { method: row ? 'PUT' : 'POST', body });
          toast('حُفظت السياسة', 'ok'); closeModal(); settingsTabs.attendanceRules();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });

  el('arAdd').onclick = () => form(null);
  window.policyEdit = (id) => form(policies.find((r) => r.id === id));
  window.policyDelete = async (id) => {
    if (!confirm('حذف هذه السياسة؟ سيعود موظفوها إلى السياسة الأعم.')) return;
    try { await api('/api/attendance-policies/' + id, { method: 'DELETE' });
      toast('حُذفت السياسة', 'ok'); settingsTabs.attendanceRules(); }
    catch (e) { toast(e.message, 'err'); }
  };

  el('arSave').onclick = async () => {
    try {
      state.cache.settings = await api('/api/settings', { method: 'PUT', body: {
        break_allowance_minutes: Number(el('arAllow').value),
        break_grace_minutes: Number(el('arGrace').value),
        break_max_count: Number(el('arMaxCount').value),
        break_max_total_minutes: Number(el('arMaxTotal').value),
        break_deducted: el('arDeduct').value === 'true',
        clock_out_from_minutes: Number(el('arOut').value),
        early_leave_grace_minutes: Number(el('arEarly').value),
        late_grace_minutes: Number(el('arLate').value),
        punch_debounce_seconds: Number(el('arDebounce').value) } });
      toast('حُفظت السياسة الافتراضية', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  el('arViolSave').onclick = async () => {
    try {
      state.cache.settings = await api('/api/settings', { method: 'PUT', body: {
        break_alert_employee: el('arEmpAlert').value === 'true',
        break_violation_enabled: el('arViol').value === 'true',
        break_violation_after_minutes: Number(el('arViolAfter').value) } });
      toast('حُفظت إعدادات التجاوز', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
};

settingsTabs.branding = async () => {
  const b = await api('/api/branding');
  el('setBody').innerHTML = `
    <div class="card"><div class="card-head"><h3>شعار المنشأة واسمها</h3></div>
      <div class="card-body">
        <div class="grid cols-2">
          <div>
            <div class="field"><label>اسم المنشأة (يظهر في شاشة الدخول والقائمة)</label>
              <input id="brName" value="${esc(b.company_name)}" placeholder="مثال: مارا لاونج" /></div>
            <div class="field"><label>الشعار</label>
              <input type="file" id="brFile" accept=".png,.jpg,.jpeg,.webp,.svg" /></div>
            <div class="inline">
              <button class="btn" id="brSave">حفظ</button>
              ${b.logo_url ? '<button class="btn danger" id="brDel">حذف الشعار</button>' : ''}
            </div>
            <div class="help" style="margin-top:10px">يُفضّل ملف PNG بخلفية شفافة، عرضه 400–800 بكسل.
              الشعار نفسه يصبح أيقونة التطبيق على شاشة الجوال.</div>
          </div>
          <div style="text-align:center;padding:14px;background:var(--surface-2);border-radius:10px">
            <div class="muted" style="font-size:12.5px;margin-bottom:10px">الشعار الحالي</div>
            ${b.logo_url
              ? `<img src="${esc(b.logo_url)}" alt="الشعار" style="max-width:100%;max-height:130px;object-fit:contain" />`
              : '<div class="muted">لا يوجد شعار — سيظهر اسم النظام فقط</div>'}
          </div>
        </div>
      </div>
    </div>

    <div class="card"><div class="card-head"><h3>أيقونة التطبيق على شاشة الجوال</h3></div>
      <div class="card-body">
        <div class="grid cols-2">
          <div>
            <div class="help" style="margin-bottom:12px">هذه هي الأيقونة التي تظهر خارج التطبيق
              على شاشة الجوال بعد «إضافة إلى الشاشة الرئيسية». تُبنى تلقائياً من الشعار المرفوع
              فوق الخلفية المختارة.</div>
            <div class="field"><label>خلفية الأيقونة</label>
              <input type="color" id="brIconBg" value="${esc(b.app_icon_bg || '#000000')}"
                     style="height:44px;padding:4px" /></div>
            <button class="btn" id="brIconSave">حفظ الخلفية وإعادة بناء الأيقونة</button>
            <div class="help" style="margin-top:10px">بعد التحديث احذف اختصار التطبيق من شاشة
              الآيفون وأضفه من جديد — نظام iOS يحتفظ بالأيقونة القديمة في ذاكرته.</div>
          </div>
          <div style="text-align:center;padding:14px;background:var(--surface-2);border-radius:10px">
            <div class="muted" style="font-size:12.5px;margin-bottom:10px">الأيقونة الحالية</div>
            <img id="brIconPreview" src="${esc(b.app_icon_url)}" alt="أيقونة التطبيق"
                 style="width:96px;height:96px;border-radius:22px;object-fit:cover;
                        box-shadow:0 6px 18px rgba(15,23,42,.22)" />
          </div>
        </div>
      </div>
    </div>

    <div class="card"><div class="card-head"><h3>العبارة التحفيزية اليومية</h3></div>
      <div class="card-body">
        <div class="help" style="margin-bottom:14px">تظهر في شاشة الدخول، وتُرسل إشعاراً لكل الموظفين
          مرة واحدة كل صباح. عبارة اليوم: <b>${esc(b.quote)}</b></div>
        <div class="inline">
          <div class="field"><label>الإشعار اليومي</label><select id="brQuote">
            <option value="true" ${b.daily_quote_enabled ? 'selected' : ''}>مفعّل</option>
            <option value="false" ${!b.daily_quote_enabled ? 'selected' : ''}>معطّل</option></select></div>
          <div class="field"><label>ساعة الإرسال</label><select id="brHour">
            ${Array.from({ length: 24 }, (_, h) =>
              `<option value="${h}" ${h === b.daily_quote_hour ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}
          </select></div>
          <button class="btn" id="brQuoteSave">حفظ</button>
          <button class="btn ghost" id="brSendNow">إرسال عبارة اليوم الآن</button>
        </div>
      </div>
    </div>`;

  el('brSave').onclick = async () => {
    try {
      let updated = await api('/api/branding', { method: 'PUT', body: { company_name: el('brName').value.trim() } });
      const input = el('brFile');
      if (input.files.length) {
        const fd = new FormData();
        fd.append('file', input.files[0]);
        updated = await api('/api/branding/logo', { method: 'POST', body: fd });
      }
      applyBranding(updated);
      toast('تم حفظ هوية المنشأة', 'ok');
      settingsTabs.branding();
    } catch (e) { toast(e.message, 'err'); }
  };
  if (el('brDel')) el('brDel').onclick = async () => {
    if (!confirm('حذف الشعار؟')) return;
    try { applyBranding(await api('/api/branding/logo', { method: 'DELETE' }));
      toast('تم حذف الشعار', 'ok'); settingsTabs.branding(); }
    catch (e) { toast(e.message, 'err'); }
  };
  el('brIconSave').onclick = async () => {
    try {
      const updated = await api('/api/branding', { method: 'PUT', body: { app_icon_bg: el('brIconBg').value } });
      applyBranding(updated);
      el('brIconPreview').src = updated.app_icon_url + '&t=' + Date.now();
      toast('تم تحديث أيقونة التطبيق', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  el('brQuoteSave').onclick = async () => {
    try {
      applyBranding(await api('/api/branding', { method: 'PUT', body: {
        daily_quote_enabled: el('brQuote').value === 'true',
        daily_quote_hour: Number(el('brHour').value) } }));
      toast('تم حفظ إعدادات العبارة اليومية', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  el('brSendNow').onclick = async () => {
    try { const r = await api('/api/branding/send-quote', { method: 'POST' });
      toast(`أُرسلت العبارة إلى ${r.sent} مستخدم`, 'ok'); refreshBell(); }
    catch (e) { toast(e.message, 'err'); }
  };
};

settingsTabs.backup = async () => {
  const info = await api('/api/backup/info');
  el('setBody').innerHTML = `
    <div class="card"><div class="card-head"><h3>النسخة الاحتياطية</h3></div>
      <div class="card-body">
        <div class="help" style="margin-bottom:16px;line-height:2.1">
          تُنزّل نسخة كاملة تحوي <b>قاعدة البيانات</b> و<b>كل المرفقات</b>
          (وثائق الموظفين، مرفقات الإجازات والمخالفات، الشعار) في ملف واحد مضغوط،
          مع ملف تعليمات الاسترجاع بداخله.
          <br>احفظها في جوجل درايف أو على جهازك — المهم أن تكون <b>خارج الخادم</b>.
        </div>
        <div class="grid cols-3" style="margin-bottom:16px">
          <div class="kpi"><div class="label">حجم البيانات</div><div class="value">${info.size_mb} م.ب</div></div>
          <div class="kpi"><div class="label">الموظفون</div><div class="value">${info.records.employees}</div></div>
          <div class="kpi"><div class="label">البصمات</div><div class="value">${info.records.punches}</div></div>
        </div>
        <button class="btn ok" id="bkDownload">⬇️ تنزيل نسخة احتياطية الآن</button>
        <span class="help" id="bkStatus" style="margin-right:12px"></span>
      </div>
    </div>

    <div class="card"><div class="card-head"><h3>الأتمتة والاسترجاع</h3></div>
      <div class="card-body help" style="line-height:2.1">
        <b>نسخة يومية تلقائية على الخادم</b> (نفّذها مرة واحدة عبر SSH):
        <br><code>sudo crontab -e</code> ثم أضف السطر:
        <br><code>0 2 * * * tar czf /var/backups/hr-$(date +\%F).tar.gz -C /opt/hr data && find /var/backups -name 'hr-*.tar.gz' -mtime +14 -delete</code>
        <br><span class="muted">تحفظ نسخة كل ليلة 2 صباحاً وتبقي آخر 14 يوماً — لكنها على نفس الخادم،
        فلا تُغني عن تنزيل نسخة خارجية بين حين وآخر.</span>
        <br><br>
        <b>الاسترجاع:</b> فك ضغط الملف، انسخ <code>hr.db</code> و<code>uploads/</code> إلى
        <code>/opt/hr/data</code> على الخادم، ثم <code>sudo systemctl restart hr</code>.
      </div>
    </div>`;

  el('bkDownload').onclick = async () => {
    const btn = el('bkDownload');
    btn.disabled = true;
    el('bkStatus').textContent = 'جارٍ تجهيز النسخة…';
    try {
      const res = await fetch('/api/backup/download', {
        headers: { Authorization: 'Bearer ' + state.token },
      });
      if (!res.ok) throw new Error('تعذّر إنشاء النسخة');
      const blob = await res.blob();
      const name = (res.headers.get('content-disposition') || '').match(/filename="?([^";]+)/);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name ? name[1] : 'hr-backup.tar.gz';
      a.click();
      URL.revokeObjectURL(a.href);
      el('bkStatus').textContent = `تم التنزيل (${(blob.size / 1048576).toFixed(2)} م.ب) — ارفعها إلى جوجل درايف.`;
      toast('تم تنزيل النسخة الاحتياطية', 'ok');
    } catch (e) {
      el('bkStatus').textContent = e.message;
      toast(e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  };
};

settingsTabs.sheets = async () => {
  const st = await api('/api/sheets/status');
  const sets = [
    ['punches', 'البصمات (كل حضور وانصراف فور تسجيله)'],
    ['attendance', 'ملخص الحضور اليومي'],
    ['leaves', 'الإجازات المعتمدة والمرفوضة'],
    ['violations', 'المخالفات المعتمدة'],
    ['payroll', 'قسائم الرواتب بعد الاعتماد'],
  ];
  el('setBody').innerHTML = `
    <div class="card"><div class="card-head"><h3>ربط جوجل شيت</h3>
      <span class="tag ${st.enabled ? 'on' : 'off'}">${st.enabled ? 'مفعّل' : 'غير مفعّل'}</span></div>
      <div class="card-body">
        <div class="help" style="margin-bottom:14px;line-height:2.1">
          <b>الإعداد مرة واحدة (٥ خطوات، بدون حساب Google Cloud):</b><br>
          ١) أنشئ ملف Google Sheets جديداً.<br>
          ٢) من قائمة <b>الإضافات (Extensions) ← Apps Script</b>.<br>
          ٣) احذف الكود والصق محتوى الملف <code>deploy/google_apps_script.gs</code> من المستودع.<br>
          ٤) غيّر <code>SECRET</code> في أول السكربت إلى كلمة سر، ثم
             <b>Deploy ← New deployment ← Web app</b> مع
             <b>Execute as: Me</b> و<b>Who has access: Anyone</b>.<br>
          ٥) انسخ الرابط الناتج (ينتهي بـ <code>/exec</code>) وضعه أدناه مع نفس كلمة السر.
        </div>
        <div class="grid cols-2">
          <div class="field"><label>رابط تطبيق الويب (Apps Script)</label>
            <input id="shUrl" value="${esc(st.webhook_url)}" placeholder="https://script.google.com/macros/s/AKfy.../exec" /></div>
          <div class="field"><label>كلمة السر المشتركة</label>
            <input id="shSecret" type="text" placeholder="${st.has_secret ? '••••••• (محفوظة)' : 'نفس قيمة SECRET في السكربت'}" /></div>
        </div>
        <div class="field"><label>البيانات المُرسَلة تلقائياً</label>
          <div class="grid cols-2">${sets.map(([k, label]) => `
            <label style="display:flex;gap:7px;align-items:center;font-size:13px">
              <input type="checkbox" class="shSet" value="${k}" ${st.datasets.includes(k) ? 'checked' : ''} style="width:auto" />
              ${esc(label)}</label>`).join('')}</div></div>
        <div class="field"><label>الحالة</label><select id="shEnabled">
          <option value="true" ${st.enabled ? 'selected' : ''}>مفعّل</option>
          <option value="false" ${!st.enabled ? 'selected' : ''}>معطّل</option></select></div>
        <div class="inline">
          <button class="btn" id="shSave">حفظ</button>
          <button class="btn ghost" id="shTest">اختبار الاتصال</button>
          <button class="btn gray" id="shFlush">إرسال المعلّق الآن</button>
          ${st.failed ? '<button class="btn danger" id="shRetry">إعادة محاولة الفاشل</button>' : ''}
        </div>
      </div>
    </div>

    <div class="grid cols-4">
      <div class="kpi"><div class="label">دفعات بانتظار الإرسال</div><div class="value ${st.pending ? 'warn' : ''}">${st.pending}</div></div>
      <div class="kpi"><div class="label">أُرسلت اليوم</div><div class="value ok">${st.sent_today}</div></div>
      <div class="kpi"><div class="label">فشلت نهائياً</div><div class="value ${st.failed ? 'danger' : ''}">${st.failed}</div></div>
      <div class="kpi"><div class="label">آخر خطأ</div><div class="value" style="font-size:13px">${esc(st.last_error || '—')}</div></div>
    </div>

    <div class="card"><div class="card-head"><h3>إعادة مزامنة فترة كاملة</h3></div>
      <div class="card-body inline">
        <div class="field"><label>البيانات</label><select id="shDataset">
          ${sets.map(([k, label]) => `<option value="${k}">${esc(label.split(' (')[0])}</option>`).join('')}</select></div>
        <div class="field"><label>من</label><input type="date" id="shFrom" value="${monthStart()}" /></div>
        <div class="field"><label>إلى</label><input type="date" id="shTo" value="${today()}" /></div>
        <button class="btn" id="shSync">إرسال إلى الشيت</button>
        <span class="help">يستبدل محتوى الورقة بالكامل حتى لا تتكرر الصفوف.</span>
      </div></div>`;

  const save = async () => {
    const body = {
      sheets_enabled: el('shEnabled').value === 'true',
      sheets_webhook_url: el('shUrl').value.trim(),
      sheets_datasets: Array.from(document.querySelectorAll('.shSet:checked')).map((c) => c.value).join(','),
    };
    if (el('shSecret').value.trim()) body.sheets_secret = el('shSecret').value.trim();
    await api('/api/sheets/settings', { method: 'PUT', body });
  };

  el('shSave').onclick = async () => {
    try { await save(); toast('تم حفظ إعدادات الربط', 'ok'); settingsTabs.sheets(); }
    catch (e) { toast(e.message, 'err'); }
  };
  el('shTest').onclick = async () => {
    try { await save(); const r = await api('/api/sheets/test', { method: 'POST' }); toast(r.message, 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  el('shFlush').onclick = async () => {
    try { const r = await api('/api/sheets/flush', { method: 'POST' }); toast(r.message, 'ok'); settingsTabs.sheets(); }
    catch (e) { toast(e.message, 'err'); }
  };
  if (el('shRetry')) el('shRetry').onclick = async () => {
    try { const r = await api('/api/sheets/retry-failed', { method: 'POST' }); toast(r.message, 'ok'); settingsTabs.sheets(); }
    catch (e) { toast(e.message, 'err'); }
  };
  el('shSync').onclick = async () => {
    const q = new URLSearchParams({ dataset: el('shDataset').value, date_from: el('shFrom').value,
      date_to: el('shTo').value, replace: 'true' });
    try { const r = await api('/api/sheets/sync?' + q, { method: 'POST' }); toast(r.message, 'ok'); settingsTabs.sheets(); }
    catch (e) { toast(e.message, 'err'); }
  };
};

settingsTabs.audit = async () => {
  el('setBody').innerHTML = `<div class="card">
    <div class="card-head"><h3>سجل التدقيق</h3></div>
    <div class="card-body inline">
      <div class="field"><label>من</label><input type="date" id="auFrom" value="${monthStart()}" /></div>
      <div class="field"><label>إلى</label><input type="date" id="auTo" value="${today()}" /></div>
      <div class="field"><label>الكيان</label><select id="auEntity"><option value="">الكل</option>
        ${Object.entries({employee:'موظف', punch:'بصمة', attendance_day:'يوم حضور', leave_request:'طلب إجازة',
          violation:'مخالفة', payroll:'مسير رواتب', device:'جهاز بصمة', site:'موقع عمل', user:'مستخدم',
          settings:'الإعدادات', document:'وثيقة'}).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
      </select></div>
      <button class="btn" id="auLoad">عرض</button>
    </div>
    <div id="auTable"><div class="empty">جارٍ التحميل…</div></div></div>`;
  const load = async () => {
    const q = new URLSearchParams({ date_from: el('auFrom').value, date_to: el('auTo').value, limit: 500 });
    if (el('auEntity').value) q.set('entity', el('auEntity').value);
    const rows = await api('/api/audit-logs?' + q);
    el('auTable').innerHTML = table(
      ['الوقت', 'المستخدم', 'الإجراء', 'الكيان', 'المعرّف', 'التفاصيل'],
      rows,
      (r) => `<tr><td>${fmtDateTime(r.created_at)}</td><td>${esc(r.username || 'النظام')}</td>
        <td>${esc(r.action_label)}</td><td>${esc(r.entity_label)}</td><td>${esc(r.entity_id || '—')}</td>
        <td>${esc(r.detail || '')}</td></tr>`,
      'لا توجد سجلات في هذه الفترة');
  };
  el('auLoad').onclick = () => load().catch((e) => toast(e.message, 'err'));
  load();
};

settingsTabs.users = async () => {
  const rows = await api('/api/users');
  el('setBody').innerHTML = `<div class="card">
    <div class="card-head"><h3>مستخدمو النظام</h3></div>
    ${table(['المستخدم', 'الصلاحية', 'الموظف المرتبط', 'الحالة', ''], rows, (u) =>
      `<tr><td>${esc(u.username)}</td><td>${esc(ROLES[u.role])}</td><td>${esc(u.employee_name || '—')}</td>
        <td><span class="tag ${u.is_active ? 'on' : 'off'}">${u.is_active ? 'نشط' : 'موقوف'}</span></td>
        <td><button class="btn sm ghost" onclick="usrPass(${u.id})">كلمة مرور</button>
            <button class="btn sm gray" onclick="usrToggle(${u.id},${u.is_active})">${u.is_active ? 'إيقاف' : 'تفعيل'}</button>
            <button class="btn sm danger" onclick="usrDel(${u.id})">حذف</button></td></tr>`, 'لا يوجد مستخدمون')}
    </div>`;
  window.usrPass = async (id) => {
    const p = prompt('كلمة المرور الجديدة (٦ أحرف على الأقل)');
    if (!p) return;
    try { await api('/api/users/' + id, { method: 'PATCH', body: { password: p } }); toast('تم التحديث', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  window.usrToggle = async (id, active) => {
    try { await api('/api/users/' + id, { method: 'PATCH', body: { is_active: !active } }); settingsTabs.users(); }
    catch (e) { toast(e.message, 'err'); }
  };
  window.usrDel = async (id) => {
    if (!confirm('حذف المستخدم؟')) return;
    try { await api('/api/users/' + id, { method: 'DELETE' }); toast('تم الحذف', 'ok'); settingsTabs.users(); }
    catch (e) { toast(e.message, 'err'); }
  };
};

/* ------------------------------ حسابي ------------------------------ */
views.account = async () => {
  render(`<div class="card" style="max-width:520px">
    <div class="card-head"><h3>${icon('bell')} إشعارات الجوال</h3></div>
    <div class="card-body">
      <div class="help" id="pnState">جارٍ فحص حالة الإشعارات…</div>
      <div class="inline" style="margin-top:10px">
        <button class="btn" id="pnEnable">تفعيل على هذا الجهاز</button>
        <button class="btn ghost" id="pnTest">إرسال إشعار تجريبي</button>
        <button class="btn gray" id="pnDisable">إيقاف</button>
      </div>
      <div class="help" style="margin-top:8px">
        يصلك الإشعار بنغمة الجهاز حتى والتطبيق مغلق. على الآيفون: أضف النظام إلى الشاشة الرئيسية
        أولاً (مشاركة ← إضافة إلى الشاشة الرئيسية) ثم فعّل الإشعارات من هنا.
      </div>
    </div></div>
    <div class="card" style="max-width:520px">
    <div class="card-head"><h3>تغيير كلمة المرور</h3></div>
    <div class="card-body">
      <div class="field"><label>كلمة المرور الحالية</label><input type="password" id="acOld" /></div>
      <div class="field"><label>كلمة المرور الجديدة</label><input type="password" id="acNew" /></div>
      <button class="btn" id="acSave">حفظ</button>
    </div></div>
    <div class="card" style="max-width:520px">
    <div class="card-head"><h3>${icon('shield')} حماية الحساب</h3></div>
    <div class="card-body">
      <div class="row-item" style="padding-inline:0">
        <span class="ri" id="twoIcon">${icon('key')}</span>
        <div class="rt"><b>التحقق بخطوتين</b><span id="twoState">جارٍ الفحص…</span></div>
        <div class="rv"><button class="btn sm" id="twoBtn">…</button></div>
      </div>
      <div class="row-item" style="padding-inline:0">
        <span class="ri">${icon('logout')}</span>
        <div class="rt"><b>الخروج من كل الأجهزة</b>
          <span>يُنهي كل الجلسات فوراً — استخدمه إن فقدت جهازك</span></div>
        <div class="rv"><button class="btn sm gray" id="logoutAll">تنفيذ</button></div>
      </div>
      <div class="row-item" style="padding-inline:0;cursor:pointer" id="historyRow">
        <span class="ri">${icon('clock')}</span>
        <div class="rt"><b>سجل الدخول</b><span>آخر محاولات الدخول على حسابك</span></div>
        <div class="rv">${icon('chevron')}</div>
      </div>
      <div class="help" style="margin-top:10px">
        تغيير كلمة المرور يُنهي جلساتك على الأجهزة الأخرى تلقائياً.
        وتُغلق الجلسة وحدها بعد ${IDLE_MINUTES} دقيقة بلا استخدام.
      </div>
    </div></div>
    <div class="card" style="max-width:520px"><div class="card-head"><h3>بيانات الحساب</h3></div>
    <div class="card-body help">
      إصدار الواجهة: <b>${APP_VERSION}</b><br>
      المستخدم: <b>${esc(state.user.username)}</b><br>
      الصلاحية: <b>${esc(ROLES[state.user.role])}</b><br>
      الموظف المرتبط: <b>${esc(state.user.employee_name || 'غير مرتبط')}</b>
    </div></div>`);
  el('acSave').onclick = async () => {
    try {
      const res = await api('/api/auth/change-password', { method: 'POST',
        body: { current_password: el('acOld').value, new_password: el('acNew').value } });
      // الجلسات الأخرى أُبطلت؛ نحدّث توكن هذا الجهاز حتى لا يخرج المستخدم
      if (res.access_token) {
        state.token = res.access_token;
        localStorage.setItem('hr_token', state.token);
      }
      toast(res.message || 'تم تغيير كلمة المرور', 'ok');
      el('acOld').value = ''; el('acNew').value = '';
    } catch (e) { toast(e.message, 'err'); }
  };

  /* ------------------------------ حماية الحساب ------------------------------ */
  const refreshTwoFactor = async () => {
    try {
      const st = await api('/api/auth/2fa/status');
      el('twoState').innerHTML = st.enabled
        ? '<span class="tag on">مفعّل</span> يُطلب رمز عند كل دخول'
        : '<span class="tag pending">غير مفعّل</span> ننصح بتفعيله لحسابات الإدارة';
      el('twoBtn').textContent = st.enabled ? 'إيقاف' : 'تفعيل';
      el('twoBtn').className = st.enabled ? 'btn sm gray' : 'btn sm ok';
      el('twoBtn').onclick = st.enabled ? disableTwoFactor : setupTwoFactor;
    } catch (e) { el('twoState').textContent = e.message; }
  };

  const setupTwoFactor = async () => {
    let setup;
    try { setup = await api('/api/auth/2fa/setup', { method: 'POST' }); }
    catch (e) { return toast(e.message, 'err'); }
    modal({
      title: 'تفعيل التحقق بخطوتين',
      body: `<div class="help" style="margin-bottom:12px">افتح تطبيق مصادقة
          (Google Authenticator أو Microsoft Authenticator)، أضف حساباً يدوياً،
          والصق المفتاح التالي، ثم أدخل الرمز الظاهر لتأكيد التفعيل.</div>
        <div class="field"><label>المفتاح السرّي</label>
          <input id="twoSecret" value="${esc(setup.secret_grouped)}" readonly
                 style="letter-spacing:2px;font-family:monospace" /></div>
        <button class="btn ghost sm" id="twoCopy" type="button">نسخ المفتاح</button>
        <div class="field" style="margin-top:12px"><label>الرمز من التطبيق</label>
          <input id="twoCode" inputmode="numeric" maxlength="6" placeholder="000000" /></div>
        <div class="help">احتفظ بالمفتاح في مكان آمن: تفقده يعني فقدان الدخول إن ضاع جوالك.</div>`,
      footer: '<button class="btn" id="twoSave">تأكيد التفعيل</button><button class="btn gray" data-close>إلغاء</button>',
      onOpen: (root) => {
        $('#twoCopy', root).onclick = () => {
          navigator.clipboard?.writeText(setup.secret).then(
            () => toast('نُسخ المفتاح', 'ok'), () => toast('انسخه يدوياً', 'err'));
        };
        $('#twoSave', root).onclick = async () => {
          try {
            const r = await api('/api/auth/2fa/enable', { method: 'POST',
              body: { code: $('#twoCode', root).value.trim() } });
            toast(r.message, 'ok'); closeModal(); refreshTwoFactor();
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  };

  const disableTwoFactor = () => modal({
    title: 'إيقاف التحقق بخطوتين',
    body: `<div class="help" style="margin-bottom:12px">سيصبح حسابك محمياً بكلمة المرور وحدها.</div>
      <div class="field"><label>كلمة المرور للتأكيد</label>
        <input type="password" id="twoPass" /></div>`,
    footer: '<button class="btn danger" id="twoOff">إيقاف</button><button class="btn gray" data-close>تراجع</button>',
    onOpen: (root) => {
      $('#twoOff', root).onclick = async () => {
        try {
          const r = await api('/api/auth/2fa/disable', { method: 'POST',
            body: { password: $('#twoPass', root).value } });
          toast(r.message, 'ok'); closeModal(); refreshTwoFactor();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });

  el('logoutAll').onclick = async () => {
    if (!confirm('إنهاء كل الجلسات على كل الأجهزة؟ ستحتاج لتسجيل الدخول من جديد.')) return;
    try { await api('/api/auth/logout-all', { method: 'POST' }); logout(); }
    catch (e) { toast(e.message, 'err'); }
  };

  el('historyRow').onclick = async () => {
    let rows = [];
    try { rows = await api('/api/auth/login-history?limit=25'); }
    catch (e) { return toast(e.message, 'err'); }
    modal({
      title: 'سجل الدخول',
      body: rows.length ? `<div class="timeline">${rows.map((r) => `
          <div class="ev ${r.success ? 'CLOCK_IN' : 'CLOCK_OUT'}">
            <b>${r.success ? 'دخول ناجح' : 'محاولة فاشلة'}</b>
            <span>${fmtDateTime(r.at)}</span>
            <div class="muted" style="font-size:11.5px;margin-top:3px">
              ${esc(r.ip || '')}${r.reason ? ' · ' + esc(r.reason) : ''}<br>
              ${esc((r.device || '').slice(0, 90))}</div>
          </div>`).join('')}</div>`
        : '<div class="empty">لا سجل بعد</div>',
      footer: '<button class="btn gray" data-close>إغلاق</button>',
    });
  };
  refreshTwoFactor();

  const refreshPushState = async () => {
    const st = await pushState();
    if (!st.supported) {
      el('pnState').innerHTML = `<span class="tag off">غير مدعوم</span> ${esc(st.reason)}`;
      ['pnEnable', 'pnTest', 'pnDisable'].forEach((id) => el(id).disabled = true);
      return;
    }
    let devices = 0, enabled = true;
    try {
      const info = await api('/api/push/key');
      devices = info.devices; enabled = info.enabled;
    } catch (e) { /* تجاهل */ }
    el('pnState').innerHTML = !enabled
      ? '<span class="tag off">معطّل من إعدادات النظام</span>'
      : st.subscribed
        ? `<span class="tag on">مفعّل على هذا الجهاز</span> — أجهزتك المسجّلة: <b>${devices}</b>`
        : `<span class="tag pending">غير مفعّل على هذا الجهاز</span> — أجهزتك المسجّلة: <b>${devices}</b>`;
    el('pnEnable').disabled = !enabled || st.subscribed;
    el('pnDisable').disabled = !st.subscribed;
  };
  el('pnEnable').onclick = async () => {
    try { if (await enablePush()) refreshPushState(); } catch (e) { toast(e.message, 'err'); }
  };
  el('pnDisable').onclick = async () => {
    try { await disablePush(); refreshPushState(); } catch (e) { toast(e.message, 'err'); }
  };
  el('pnTest').onclick = async () => {
    try { const r = await api('/api/push/test', { method: 'POST' }); toast(r.message, r.ok ? 'ok' : 'err'); }
    catch (e) { toast(e.message, 'err'); }
  };
  refreshPushState();
};

/* ------------------------------ الإقلاع ------------------------------ */
el('loginForm').onsubmit = login;
el('logoutBtn').onclick = logout;
el('langBtn').onclick = () => I18N.set(I18N.isEnglish() ? 'ar' : 'en');
el('loginLang').onclick = () => I18N.set(I18N.isEnglish() ? 'ar' : 'en');
I18N.apply(document.body);
initShell();

// فتح الصفحة المطلوبة عند الضغط على إشعار الجوال
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'open-page' && state.user) go(event.data.page);
  });
}
const requestedPage = new URLSearchParams(location.search).get('page');
if (requestedPage) state.page = requestedPage;
el('helpBtn').insertAdjacentHTML('afterbegin', icon('info'));
el('helpBtn').onclick = () => toggleHelp();
el('helpClose').onclick = () => toggleHelp(false);
el('helpScrim').onclick = () => toggleHelp(false);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el('helpPanel').hidden) toggleHelp(false);
});
el('selfPunchBtn').onclick = selfPunch;
el('bellBtn').onclick = () => openNotifications().catch((e) => toast(e.message, 'err'));
window.go = go;

// عرض زر «تثبيت التطبيق» عندما يسمح المتصفح بذلك
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  const btn = el('installBtn');
  if (btn) btn.classList.remove('hidden');
});
window.installApp = async () => {
  if (!installPrompt) { toast('لتثبيت التطبيق: افتح قائمة المتصفح ثم «إضافة إلى الشاشة الرئيسية»'); return; }
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  el('installBtn').classList.add('hidden');
};

// تحديث عداد الإشعارات كل دقيقة
setInterval(() => { if (state.token) refreshBell(); }, 60000);

// تسجيل عامل الخدمة (يجعل النظام قابلاً للتثبيت كتطبيق على الجوال)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/app/sw.js').catch(() => {}));
}

// هوية المنشأة (الشعار والاسم) وعبارة اليوم — تُجلب من الخادم
function applyBranding(b) {
  state.cache.branding = b;
  const quote = el('loginQuote');
  if (quote && b.quote) quote.textContent = b.quote;

  const title = b.company_name ? b.company_name : 'نظام الموارد البشرية';
  const loginTitle = el('loginTitle');
  if (loginTitle) loginTitle.textContent = title;
  const sideTitle = el('sideTitle');
  if (sideTitle) sideTitle.textContent = b.company_name || 'الموارد البشرية';
  const barName = el('brandBarName');
  const barSub = el('brandBarSub');
  if (barName) barName.textContent = b.company_name || 'الموارد البشرية';
  // لا نكرّر الاسم في السطرين إن لم تُضبط هوية المنشأة بعد
  if (barSub) barSub.classList.toggle('hidden', !b.company_name);
  const barMark = el('brandBarMark');
  if (barMark) {
    barMark.innerHTML = b.logo_url
      ? `<img src="${esc(b.logo_url)}" alt="" />`
      : icon('employees');
  }
  const mark = el('brandMark');
  if (mark) {
    const words = (b.company_name || 'HR').trim().split(/\s+/).slice(0, 2);
    mark.textContent = words.map((w) => w[0]).join('') || 'HR';
  }
  document.title = b.company_name ? `${b.company_name} — الحضور والإجازات` : document.title;

  [['loginLogo', b.logo_url], ['sideLogo', b.logo_url]].forEach(([id, url]) => {
    const img = el(id);
    if (!img) return;
    if (url) { img.src = url; img.classList.remove('hidden'); }
    else img.classList.add('hidden');
  });
}

fetch('/api/branding').then((r) => r.json()).then(applyBranding).catch(() => {});

// إظهار تنبيه كلمة المرور الافتراضية فقط إن لم تُغيَّر بعد
fetch('/api/health')
  .then((r) => r.json())
  .then((d) => { if (d.setup_pending) el('loginHint').classList.remove('hidden'); })
  .catch(() => {});

(async () => {
  if (!state.token) return;
  try {
    state.user = await api('/api/auth/me');
    localStorage.setItem('hr_user', JSON.stringify(state.user));
    startApp();
  } catch { logout(); }
})();
