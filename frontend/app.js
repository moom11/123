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
  { id: 'dashboard',  title: 'لوحة المؤشرات', icon: '📊', roles: ['admin','hr','manager','employee'] },
  { id: 'attendance', title: 'الحضور اليومي', icon: '🕒', roles: ['admin','hr','manager','employee'] },
  { id: 'punches',    title: 'سجل البصمات',   icon: '🖐', roles: ['admin','hr','manager','employee'] },
  { id: 'leaves',     title: 'الإجازات',       icon: '🌴', roles: ['admin','hr','manager','employee'] },
  { id: 'balances',   title: 'أرصدة الإجازات', icon: '⚖️', roles: ['admin','hr','manager','employee'] },
  { id: 'violations', title: 'المخالفات',      icon: '⚠️', roles: ['admin','hr','manager','employee'] },
  { id: 'payroll',    title: 'الرواتب',        icon: '💰', roles: ['admin','hr','manager','employee'] },
  { id: 'employees',  title: 'الموظفون',       icon: '👥', roles: ['admin','hr','manager'] },
  { id: 'documents',  title: 'وثائق الموظفين', icon: '📁', roles: ['admin','hr','manager','employee'] },
  { id: 'devices',    title: 'أجهزة البصمة',   icon: '📟', roles: ['admin','hr'] },
  { id: 'reports',    title: 'التقارير',       icon: '📑', roles: ['admin','hr','manager'] },
  { id: 'settings',   title: 'الإعدادات',      icon: '⚙️', roles: ['admin','hr'] },
  { id: 'account',    title: 'حسابي',          icon: '🔑', roles: ['admin','hr','manager','employee'] },
];

const DAY_STATUS = {
  present: 'حاضر', late: 'متأخر', absent: 'غائب', leave: 'إجازة',
  holiday: 'عطلة رسمية', weekend: 'راحة أسبوعية', missing_out: 'انصراف ناقص',
  scheduled: 'لم يحن بعد',
};
const LEAVE_STATUS = { pending:'قيد الاعتماد', approved:'معتمدة', rejected:'مرفوضة', cancelled:'ملغاة' };
const ROLES = { admin:'مدير النظام', hr:'موارد بشرية', manager:'مدير إدارة', employee:'موظف' };
const SOURCES = { device_pull:'جهاز (سحب)', device_push:'جهاز (دفع)', manual:'إدخال يدوي', web:'ويب' };
const VIOLATION_STATUS = { pending:'بانتظار إقرار الموظف', acknowledged:'أقرّ بالاطلاع',
  objected:'تظلّم الموظف', approved:'معتمدة', cancelled:'ملغاة' };
const PENALTY_ACTIONS = { warning:'إنذار كتابي', deduction_percent_day:'خصم نسبة من أجر يوم',
  deduction_days:'خصم أجر أيام', suspension:'إيقاف بدون أجر', termination:'الفصل من العمل' };
const MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
const money = (v) => (Number(v || 0)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

function toast(message, type = '') {
  const node = document.createElement('div');
  node.className = 'toast ' + type;
  node.textContent = message;
  el('toasts').appendChild(node);
  setTimeout(() => node.remove(), 4200);
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
  if (res.status === 401) { logout(); throw new Error('انتهت الجلسة، سجّل الدخول من جديد'); }
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
  return `<div class="table-wrap"><table><thead><tr>${
    columns.map((c) => `<th>${esc(c)}</th>`).join('')
  }</tr></thead><tbody>${rows.map(renderRow).join('')}</tbody></table></div>`;
}

const can = (...roles) => state.user && roles.includes(state.user.role);
const isHR = () => can('admin', 'hr');

/* ------------------------------ الدخول والخروج ------------------------------ */
async function login(ev) {
  ev.preventDefault();
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      form: { username: el('username').value.trim(), password: el('password').value },
    });
    state.token = data.access_token;
    state.user = data.user;
    localStorage.setItem('hr_token', state.token);
    localStorage.setItem('hr_user', JSON.stringify(state.user));
    startApp();
  } catch (e) { toast(e.message, 'err'); }
}

function logout() {
  state.token = ''; state.user = null;
  localStorage.removeItem('hr_token'); localStorage.removeItem('hr_user');
  el('app').classList.add('hidden');
  el('login').classList.remove('hidden');
}

function startApp() {
  el('login').classList.add('hidden');
  el('app').classList.remove('hidden');
  const pages = PAGES.filter((p) => p.roles.includes(state.user.role));
  el('nav').innerHTML = pages.map((p) =>
    `<a data-page="${p.id}"><span class="ico">${p.icon}</span>${esc(p.title)}</a>`).join('');
  el('nav').querySelectorAll('a').forEach((a) => a.onclick = () => go(a.dataset.page));
  el('sideUser').innerHTML = `${esc(state.user.username)} — ${esc(ROLES[state.user.role])}`;
  el('topWho').textContent = state.user.employee_name || ROLES[state.user.role];
  el('selfPunchBtn').classList.toggle('hidden', !state.user.employee_id);
  refreshBell();
  go(pages.some((p) => p.id === state.page) ? state.page : 'dashboard');
}

function go(page) {
  state.page = page;
  const meta = PAGES.find((p) => p.id === page);
  el('pageTitle').textContent = meta ? meta.title : '';
  el('nav').querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  el('view').innerHTML = '<div class="empty">جارٍ التحميل…</div>';
  const fn = views[page];
  Promise.resolve(fn ? fn() : '<div class="empty">صفحة غير متاحة</div>')
    .catch((e) => { toast(e.message, 'err'); el('view').innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
}
const render = (html) => { el('view').innerHTML = html; };

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

async function openNotifications() {
  const rows = await api('/api/notifications?limit=50');
  const body = rows.length
    ? rows.map((n) => `<div class="notif ${n.is_read ? '' : 'unread'}" data-id="${n.id}" data-page="${n.link_page || ''}">
        <div class="t">${esc(n.title)}</div>
        ${n.body ? `<div class="b">${esc(n.body)}</div>` : ''}
        <div class="d">${fmtDateTime(n.created_at)}</div></div>`).join('')
    : '<div class="empty">لا توجد إشعارات</div>';
  modal({
    title: 'الإشعارات',
    body: `<div style="margin:-18px">${body}</div>`,
    footer: '<button class="btn ghost" id="readAll">تعليم الكل كمقروء</button><button class="btn gray" data-close>إغلاق</button>',
    width: 560,
    onOpen: (root) => {
      root.querySelectorAll('.notif').forEach((node) => node.onclick = async () => {
        try { await api(`/api/notifications/${node.dataset.id}/read`, { method: 'POST' }); } catch {}
        refreshBell();
        if (node.dataset.page) { closeModal(); go(node.dataset.page); }
        else node.classList.remove('unread');
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
      <div class="inline"><button class="btn ghost" id="viHere">📍 إرفاق موقعي الحالي</button>
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


/* ------------------------------ لوحة المؤشرات ------------------------------ */
views.dashboard = async () => {
  const stats = await api('/api/reports/dashboard');
  const max = Math.max(1, ...stats.weekly_trend.map((d) => d.present + d.late + d.absent + d.leave));
  const bar = (d) => {
    const seg = (k, v) => v ? `<div class="seg ${k}" style="height:${(v / max) * 100}%" title="${DAY_STATUS[k] || k}: ${v}"></div>` : '';
    return `<div class="col"><div class="stack">
        ${seg('present', d.present)}${seg('late', d.late)}${seg('leave', d.leave)}${seg('absent', d.absent)}
      </div><div class="cap">${d.date.slice(5)}</div></div>`;
  };
  render(`
    <div class="grid cols-4">
      <div class="kpi"><div class="label">إجمالي الموظفين</div><div class="value">${stats.employees_total}</div></div>
      <div class="kpi"><div class="label">الحضور اليوم</div><div class="value ok">${stats.present}</div></div>
      <div class="kpi"><div class="label">متأخرون</div><div class="value warn">${stats.late}</div></div>
      <div class="kpi"><div class="label">غياب</div><div class="value danger">${stats.absent}</div></div>
      <div class="kpi"><div class="label">في إجازة</div><div class="value info">${stats.on_leave}</div></div>
      <div class="kpi"><div class="label">طلبات إجازة معلّقة</div><div class="value warn">${stats.pending_leaves}</div></div>
      <div class="kpi"><div class="label">أجهزة البصمة المتصلة</div><div class="value">${stats.devices_online}/${stats.devices_total}</div></div>
      <div class="kpi"><div class="label">تاريخ اليوم</div><div class="value" style="font-size:19px">${stats.date}</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>الحضور خلال آخر ٧ أيام</h3>
        <div class="legend">
          <span><i style="background:#3f9d6a"></i>حاضر</span><span><i style="background:#e0a33c"></i>متأخر</span>
          <span><i style="background:#5f8fd8"></i>إجازة</span><span><i style="background:#d05a52"></i>غياب</span>
        </div>
      </div>
      <div class="card-body"><div class="bars">${stats.weekly_trend.map(bar).join('')}</div></div>
    </div>
    ${state.user.employee_id ? `<div class="card"><div class="card-head"><h3>تسجيل حضوري من التطبيق</h3>
      <button class="btn sm ghost" id="checkLoc">التحقق من موقعي</button></div>
      <div class="card-body inline">
        <button class="btn ok" id="punchNow">🕒 تسجيل حضور / انصراف</button>
        <span class="help" id="locHint">يجب أن تكون داخل نطاق موقع العمل المعتمد عند التسجيل.</span>
      </div></div>` : ''}
    <div class="card"><div class="card-head"><h3>حضور اليوم</h3>
      <button class="btn sm ghost" onclick="go('attendance')">فتح الكشف اليومي</button></div>
      <div id="todayTable"><div class="empty">جارٍ التحميل…</div></div>
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
    ['رقم الموظف', 'الاسم', 'الحضور', 'الانصراف', 'ساعات', 'التأخير (د)', 'الحالة'],
    rows,
    (r) => `<tr><td>${esc(r.employee_code)}</td><td>${esc(r.employee_name)}</td>
      <td>${fmtTime(r.check_in)}</td><td>${fmtTime(r.check_out)}</td><td>${hours(r.worked_minutes)}</td>
      <td>${r.late_minutes || 0}</td><td><span class="tag ${r.status}">${DAY_STATUS[r.status]}</span></td></tr>`,
    'لا توجد سجلات لهذا اليوم');
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
    </div></div>
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
    el('attTable').innerHTML = table(
      ['رقم الموظف', 'الاسم', 'الحضور', 'الانصراف', 'ساعات', 'تأخير (د)', 'خروج مبكر (د)', 'إضافي (د)', 'الحالة', 'ملاحظة'],
      rows,
      (r) => `<tr><td>${esc(r.employee_code)}</td><td>${esc(r.employee_name)}</td>
        <td>${fmtTime(r.check_in)}</td><td>${fmtTime(r.check_out)}</td><td>${hours(r.worked_minutes)}</td>
        <td>${r.late_minutes || 0}</td><td>${r.early_leave_minutes || 0}</td><td>${r.overtime_minutes || 0}</td>
        <td><span class="tag ${r.status}">${DAY_STATUS[r.status]}</span></td><td>${esc(r.note || '')}</td></tr>`);
  };
  el('attLoad').onclick = () => load().catch((e) => toast(e.message, 'err'));
  el('attExport').onclick = () => downloadCsv(
    `/api/attendance/export.csv?date_from=${el('attDate').value}&date_to=${el('attDate').value}`, 'attendance.csv');
  if (el('attRecompute')) el('attRecompute').onclick = async () => {
    const d = el('attDate').value;
    const r = await api(`/api/attendance/recompute?date_from=${d}&date_to=${d}`, { method: 'POST' });
    toast(r.message, 'ok'); load();
  };
  if (el('attManual')) el('attManual').onclick = () => manualPunchModal(employees, load);

  el('empLoad').onclick = async () => {
    const id = el('empSel').value;
    const rows = await api(`/api/attendance/employee/${id}?date_from=${el('empFrom').value}&date_to=${el('empTo').value}`);
    el('empTable').innerHTML = table(
      ['التاريخ', 'الحضور', 'الانصراف', 'ساعات', 'تأخير (د)', 'إضافي (د)', 'الحالة', 'ملاحظة'],
      rows,
      (r) => `<tr><td>${r.work_date}</td><td>${fmtTime(r.check_in)}</td><td>${fmtTime(r.check_out)}</td>
        <td>${hours(r.worked_minutes)}</td><td>${r.late_minutes || 0}</td><td>${r.overtime_minutes || 0}</td>
        <td><span class="tag ${r.status}">${DAY_STATUS[r.status]}</span></td><td>${esc(r.note || '')}</td></tr>`);
  };
  load().catch(() => {});
};

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
  const load = async () => {
    const q = new URLSearchParams({ date_from: el('pFrom').value, date_to: el('pTo').value, limit: 500 });
    if (el('pEmp').value) q.set('employee_id', el('pEmp').value);
    const rows = await api('/api/attendance/punches?' + q);
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
        <td>${isHR() ? `<button class="btn sm danger" onclick="deletePunch(${r.id})">حذف</button>` : ''}</td></tr>`,
      'لا توجد بصمات في هذه الفترة');
  };
  el('pLoad').onclick = () => load().catch((e) => toast(e.message, 'err'));
  if (el('pManual')) el('pManual').onclick = () => manualPunchModal(employees, load);
  window.deletePunch = async (id) => {
    if (!confirm('حذف هذه البصمة؟')) return;
    try { await api('/api/attendance/punches/' + id, { method: 'DELETE' }); toast('تم الحذف', 'ok'); load(); }
    catch (e) { toast(e.message, 'err'); }
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
    <div class="card"><div class="card-head"><h3>طلبات الإجازة</h3><span class="muted" id="lCount"></span></div>
      <div id="lTable"><div class="empty">جارٍ التحميل…</div></div></div>`);

  const load = async () => {
    const q = new URLSearchParams();
    if (el('lStatus').value) q.set('status', el('lStatus').value);
    if (el('lEmp') && el('lEmp').value) q.set('employee_id', el('lEmp').value);
    const rows = await api('/api/leave-requests?' + q);
    el('lCount').textContent = `${rows.length} طلب`;
    el('lTable').innerHTML = table(
      ['#', 'الموظف', 'النوع', 'من', 'إلى', 'الأيام', 'الحالة', 'السبب', 'إجراءات'],
      rows,
      (r) => {
        const mine = state.user.employee_id === r.employee_id;
        let actions = '';
        if (r.status === 'pending' && canDecide) {
          actions += `<button class="btn sm ok" onclick="decideLeave(${r.id},'approve')">اعتماد</button>
                      <button class="btn sm danger" onclick="decideLeave(${r.id},'reject')">رفض</button> `;
        }
        if (r.status === 'pending' && mine) actions += `<button class="btn sm gray" onclick="decideLeave(${r.id},'cancel')">إلغاء</button>`;
        if (r.status === 'approved' && isHR()) actions += `<button class="btn sm gray" onclick="decideLeave(${r.id},'cancel')">إلغاء</button>`;
        if (r.attachment_path) actions += ` <a class="btn sm ghost" href="/uploads/${encodeURIComponent(r.attachment_path)}" target="_blank">المرفق</a>`;
        if (r.status === 'pending' && mine) actions += ` <button class="btn sm ghost" onclick="attachLeave(${r.id})">إرفاق</button>`;
        return `<tr><td>${r.id}</td><td>${esc(r.employee_name)}</td><td>${esc(r.leave_type_name)}</td>
          <td>${r.start_date}</td><td>${r.end_date}</td><td>${r.days}</td>
          <td><span class="tag ${r.status}">${LEAVE_STATUS[r.status]}</span></td>
          <td>${esc(r.reason || '')}</td><td>${actions}</td></tr>`;
      },
      'لا توجد طلبات');
  };

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
          el('lrPreview').innerHTML = `عدد الأيام المحتسبة: <b>${r.days}</b> — الرصيد الحالي: <b>${r.remaining_days}</b>` +
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

/* ------------------------------ أرصدة الإجازات ------------------------------ */
views.balances = async () => {
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
  render(`
    <div class="card"><div class="card-body inline">
      <div class="field"><label>بحث</label><input id="eQ" placeholder="الاسم أو رقم الموظف" /></div>
      <div class="field"><label>الإدارة</label><select id="eDep"><option value="">الكل</option>${options(departments)}</select></div>
      <button class="btn" id="eLoad">بحث</button>
      ${isHR() ? '<button class="btn ok" id="eNew">إضافة موظف</button>' : ''}
      ${isHR() ? '<button class="btn ghost" id="eExport">تصدير CSV</button>' : ''}
      ${isHR() ? '<button class="btn gray" id="eImport">استيراد من Excel</button>' : ''}
    </div></div>
    <div class="card"><div class="card-head"><h3>قائمة الموظفين</h3><span class="muted" id="eCount"></span></div>
      <div id="eTable"><div class="empty">جارٍ التحميل…</div></div></div>`);
  const load = async () => {
    const q = new URLSearchParams();
    if (el('eQ').value) q.set('q', el('eQ').value);
    if (el('eDep').value) q.set('department_id', el('eDep').value);
    const rows = await api('/api/employees?' + q);
    state.cache.lookups.employees = rows;
    el('eCount').textContent = `${rows.length} موظف`;
    el('eTable').innerHTML = table(
      ['رقم الموظف', 'الاسم', 'الإدارة', 'المسمى الوظيفي', 'الوردية', 'تاريخ التعيين', 'الحالة', ''],
      rows,
      (r) => `<tr><td>${esc(r.code)}</td><td>${esc(r.full_name)}</td><td>${esc(r.department_name || '—')}</td>
        <td>${esc(r.job_title || '—')}</td><td>${esc(r.shift_name || '—')}</td><td>${r.hire_date || '—'}</td>
        <td><span class="tag ${r.status === 'active' ? 'on' : 'off'}">${r.status === 'active' ? 'على رأس العمل' : 'موقوف/منتهي'}</span></td>
        <td>${isHR() ? `<button class="btn sm ghost" onclick="editEmployee(${r.id})">تعديل</button>
             <button class="btn sm gray" onclick="makeUser(${r.id},'${esc(r.code)}')">حساب دخول</button>` : ''}</td></tr>`,
      'لا يوجد موظفون');
  };
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
          <option value="hr">موارد بشرية</option><option value="admin">مدير النظام</option></select></div>`,
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

function employeeModal(emp, departments, shifts, after) {
  const v = (k, d = '') => (emp && emp[k] !== null && emp[k] !== undefined ? emp[k] : d);
  modal({
    title: emp ? `تعديل بيانات ${emp.full_name}` : 'إضافة موظف',
    body: `<div class="grid cols-2">
      <div class="field"><label>رقم الموظف (نفس الرقم في جهاز البصمة)</label><input id="fCode" value="${esc(v('code'))}" /></div>
      <div class="field"><label>الاسم الكامل</label><input id="fName" value="${esc(v('full_name'))}" /></div>
      <div class="field"><label>الهوية / الإقامة</label><input id="fNid" value="${esc(v('national_id'))}" /></div>
      <div class="field"><label>الجوال</label><input id="fPhone" value="${esc(v('phone'))}" /></div>
      <div class="field"><label>البريد</label><input id="fEmail" value="${esc(v('email'))}" /></div>
      <div class="field"><label>المسمى الوظيفي</label><input id="fTitle" value="${esc(v('job_title'))}" /></div>
      <div class="field"><label>الإدارة</label><select id="fDep"><option value="">—</option>${options(departments, v('department_id'))}</select></div>
      <div class="field"><label>الوردية</label><select id="fShift"><option value="">—</option>${options(shifts, v('shift_id'))}</select></div>
      <div class="field"><label>موقع العمل (للبصم من التطبيق)</label><select id="fSite"><option value="">كل المواقع المعتمدة</option>${options(state.cache.sites || [], v('site_id'))}</select></div>
      <div class="field"><label>تاريخ التعيين</label><input type="date" id="fHire" value="${v('hire_date')}" /></div>
      <div class="field"><label>الراتب الأساسي</label><input type="number" id="fSalary" value="${v('basic_salary', 0)}" /></div>
      <div class="field"><label>الحالة</label><select id="fStatus">
        <option value="active" ${v('status') === 'active' ? 'selected' : ''}>على رأس العمل</option>
        <option value="suspended" ${v('status') === 'suspended' ? 'selected' : ''}>موقوف</option>
        <option value="terminated" ${v('status') === 'terminated' ? 'selected' : ''}>منتهية خدمته</option></select></div>
      </div>`,
    footer: `<button class="btn" id="fSave">حفظ</button>
      ${emp ? `<button class="btn danger" id="fDel">حذف</button>` : ''}
      <button class="btn gray" data-close>إلغاء</button>`,
    width: 720,
    onOpen: (root) => {
      $('#fSave', root).onclick = async () => {
        const body = {
          code: el('fCode').value.trim(), full_name: el('fName').value.trim(),
          national_id: el('fNid').value || null, phone: el('fPhone').value || null,
          email: el('fEmail').value || null, job_title: el('fTitle').value || null,
          department_id: el('fDep').value ? Number(el('fDep').value) : null,
          shift_id: el('fShift').value ? Number(el('fShift').value) : null,
          site_id: el('fSite').value ? Number(el('fSite').value) : null,
          hire_date: el('fHire').value || null, basic_salary: Number(el('fSalary').value || 0),
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
            ✅ ${esc(r.message)}
            ${r.errors.length ? `<div style="margin-top:8px;color:var(--danger)">تحذيرات:<br>${r.errors.map(esc).join('<br>')}</div>` : ''}
          </div>`;
          toast(r.message, 'ok');
          loadLookups(true).then(after);
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

/* ------------------------------ أجهزة البصمة ------------------------------ */
views.devices = async () => {
  render(`
    <div class="card"><div class="card-body inline">
      <button class="btn ok" id="dNew">إضافة جهاز</button>
      <button class="btn" id="dSyncAll">مزامنة كل الأجهزة</button>
      <button class="btn ghost" id="dLoad">تحديث</button>
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
            <td>${u.exists_in_system ? '✅' : '❌'}</td></tr>`, 'لا يوجد مستخدمون على الجهاز'),
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
      <span class="help">يُحتسب من الحضور والإجازات والمخالفات المعتمدة تلقائياً.</span>
    </div></div>
    <div class="card"><div class="card-head"><h3>مسيّرات الرواتب</h3></div>
      <div id="prRuns"><div class="empty">جارٍ التحميل…</div></div></div>
    <div id="prDetail"></div>`);

  const loadRuns = async () => {
    const runs = await api('/api/payroll/runs');
    el('prRuns').innerHTML = table(
      ['الفترة', 'الحالة', 'الموظفون', 'إجمالي الأساسي', 'الخصومات', 'الإضافي', 'صافي المسير', 'إجراءات'],
      runs,
      (r) => `<tr><td>${MONTHS[r.month - 1]} ${r.year}</td>
        <td><span class="tag ${r.status === 'approved' ? 'approved' : 'draft'}">${r.status === 'approved' ? 'معتمد' : 'مسودة'}</span></td>
        <td>${r.employees}</td><td class="money">${money(r.basic_total)}</td>
        <td class="money">${money(r.deductions_total)}</td><td class="money">${money(r.overtime_total)}</td>
        <td class="money">${money(r.net_total)}</td>
        <td><button class="btn sm" onclick="openRun(${r.id})">عرض القسائم</button>
            <button class="btn sm ghost" onclick="exportRun(${r.id})">CSV</button>
            ${r.status !== 'approved' ? `<button class="btn sm ok" onclick="approveRun(${r.id})">اعتماد</button>
              <button class="btn sm danger" onclick="deleteRun(${r.id})">حذف</button>` : ''}</td></tr>`,
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
      ${table(['رقم الموظف', 'الاسم', 'الأساسي', 'حضور', 'غياب', 'تأخير (د)', 'إضافي (د)',
               'خصم غياب', 'خصم تأخير', 'إجازة بلا راتب', 'خصم مخالفات', 'بدل إضافي',
               'إضافات', 'خصومات', 'الصافي', ''],
        slips,
        (s) => `<tr><td>${esc(s.employee_code)}</td><td>${esc(s.employee_name)}</td>
          <td class="money">${money(s.basic_salary)}</td><td>${s.present_days}</td><td>${s.absent_days}</td>
          <td>${s.late_minutes}</td><td>${s.overtime_minutes}</td>
          <td class="money">${money(s.absence_deduction)}</td><td class="money">${money(s.late_deduction)}</td>
          <td class="money">${money(s.unpaid_leave_deduction)}</td><td class="money">${money(s.violation_deduction)}</td>
          <td class="money">${money(s.overtime_amount)}</td><td class="money">${money(s.other_additions)}</td>
          <td class="money">${money(s.other_deductions)}</td><td class="money"><b>${money(s.net_pay)}</b></td>
          <td>${locked ? '' : `<button class="btn sm ghost" onclick="adjustSlip(${s.id},${s.other_additions},${s.other_deductions})">تعديل</button>`}</td></tr>`,
        'لا توجد قسائم')}
      </div>`;
  };
  window.exportRun = (id) => downloadCsv(`/api/payroll/runs/${id}/export.csv`, `payroll_${id}.csv`);
  window.approveRun = async (id) => {
    if (!confirm('اعتماد المسير؟ لن يمكن تعديله بعد الاعتماد، وستصل قسائم الرواتب للموظفين.')) return;
    try { await api(`/api/payroll/runs/${id}/approve`, { method: 'POST' });
      toast('تم اعتماد المسير وإشعار الموظفين', 'ok'); loadRuns(); openRun(id); }
    catch (e) { toast(e.message, 'err'); }
  };
  window.deleteRun = async (id) => {
    if (!confirm('حذف المسير؟')) return;
    try { await api('/api/payroll/runs/' + id, { method: 'DELETE' });
      toast('تم الحذف', 'ok'); el('prDetail').innerHTML = ''; loadRuns(); }
    catch (e) { toast(e.message, 'err'); }
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
    ${table(['الشهر', 'الراتب الأساسي', 'أيام الحضور', 'أيام الغياب', 'خصومات', 'بدل الإضافي', 'صافي الراتب'],
      slips,
      (s) => {
        const deductions = s.absence_deduction + s.late_deduction + s.unpaid_leave_deduction
          + s.violation_deduction + s.other_deductions;
        return `<tr><td>مسير ${s.run_id}</td><td class="money">${money(s.basic_salary)}</td>
          <td>${s.present_days}</td><td>${s.absent_days}</td><td class="money">${money(deductions)}</td>
          <td class="money">${money(s.overtime_amount)}</td><td class="money"><b>${money(s.net_pay)}</b></td></tr>`;
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
    <div class="card"><div class="card-head"><h3>الملخص الشهري</h3></div><div id="rTable"><div class="empty">جارٍ التحميل…</div></div></div>
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
    el('rTable').innerHTML = table(
      ['رقم الموظف', 'الاسم', 'الإدارة', 'حضور', 'تأخير', 'غياب', 'إجازات', 'ساعات العمل', 'دقائق تأخير', 'إضافي (د)'],
      rows,
      (r) => `<tr><td>${esc(r.employee_code)}</td><td>${esc(r.employee_name)}</td><td>${esc(r.department_name || '—')}</td>
        <td>${r.present_days}</td><td>${r.late_days}</td><td>${r.absent_days}</td><td>${r.leave_days}</td>
        <td>${r.worked_hours}</td><td>${r.late_minutes}</td><td>${r.overtime_minutes}</td></tr>`);
  };
  el('rLoad').onclick = () => loadMonthly().catch((e) => toast(e.message, 'err'));
  el('rExport').onclick = () => downloadCsv(
    `/api/reports/monthly-export.csv?year=${el('rYear').value}&month=${el('rMonth').value}`, 'summary.csv');
  el('xLoad').onclick = async () => {
    const rows = await api(`/api/reports/exceptions?date_from=${el('xFrom').value}&date_to=${el('xTo').value}`);
    el('xTable').innerHTML = table(
      ['التاريخ', 'رقم الموظف', 'الاسم', 'الحالة', 'الحضور', 'الانصراف', 'تأخير (د)', 'خروج مبكر (د)'],
      rows,
      (r) => `<tr><td>${r.work_date}</td><td>${esc(r.employee_code)}</td><td>${esc(r.employee_name)}</td>
        <td>${esc(r.status)}</td><td>${esc(r.check_in || '—')}</td><td>${esc(r.check_out || '—')}</td>
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
      <button data-tab="payrollRules">قواعد الرواتب</button>
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
      <button class="btn ghost" id="siHere">📍 التقاط موقعي الحالي</button>
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
        <div class="field"><label>معامل خصم يوم الغياب</label><input type="number" step="0.5" id="pyAbs" value="${st.payroll_absence_multiplier}" /></div>
        <div class="field"><label>مدة محو تكرار المخالفة (يوم)</label><input type="number" id="pyReset" value="${st.violation_reset_days}" /></div>
        <div class="field"><label>التنبيه قبل انتهاء الوثيقة (يوم)</label><input type="number" id="pyDoc" value="${st.document_alert_days}" /></div>
      </div>
      <button class="btn" id="pySave">حفظ القواعد</button>
      <div class="help">نظام العمل السعودي: أجر الساعة الإضافية = أجر الساعة + 50% (المعامل 1.5)،
        والمخالفة تُمحى من سجل التكرار بعد 180 يوماً.</div>
    </div></div>`;
  el('pySave').onclick = async () => {
    try {
      state.cache.settings = await api('/api/settings', { method: 'PUT', body: {
        payroll_days_per_month: Number(el('pyDays').value),
        payroll_workday_hours: Number(el('pyHours').value),
        payroll_overtime_multiplier: Number(el('pyOt').value),
        payroll_late_deduction_mode: el('pyLate').value,
        payroll_absence_multiplier: Number(el('pyAbs').value),
        violation_reset_days: Number(el('pyReset').value),
        document_alert_days: Number(el('pyDoc').value) } });
      toast('تم حفظ القواعد', 'ok');
    } catch (e) { toast(e.message, 'err'); }
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
    <div class="card-head"><h3>تغيير كلمة المرور</h3></div>
    <div class="card-body">
      <div class="field"><label>كلمة المرور الحالية</label><input type="password" id="acOld" /></div>
      <div class="field"><label>كلمة المرور الجديدة</label><input type="password" id="acNew" /></div>
      <button class="btn" id="acSave">حفظ</button>
    </div></div>
    <div class="card" style="max-width:520px"><div class="card-head"><h3>بيانات الحساب</h3></div>
    <div class="card-body help">
      المستخدم: <b>${esc(state.user.username)}</b><br>
      الصلاحية: <b>${esc(ROLES[state.user.role])}</b><br>
      الموظف المرتبط: <b>${esc(state.user.employee_name || 'غير مرتبط')}</b>
    </div></div>`);
  el('acSave').onclick = async () => {
    try {
      await api('/api/auth/change-password', { method: 'POST',
        body: { current_password: el('acOld').value, new_password: el('acNew').value } });
      toast('تم تغيير كلمة المرور', 'ok'); el('acOld').value = ''; el('acNew').value = '';
    } catch (e) { toast(e.message, 'err'); }
  };
};

/* ------------------------------ الإقلاع ------------------------------ */
el('loginForm').onsubmit = login;
el('logoutBtn').onclick = logout;
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

(async () => {
  if (!state.token) return;
  try {
    state.user = await api('/api/auth/me');
    localStorage.setItem('hr_user', JSON.stringify(state.user));
    startApp();
  } catch { logout(); }
})();
