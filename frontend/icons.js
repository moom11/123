/* ==========================================================================
   مجموعة الأيقونات: SVG خطية موحّدة (24×24، سماكة 1.8، ترث لون النص)
   الاستخدام: icon('users')  أو  icon('clock', 'lg')
   ========================================================================== */
const ICON_PATHS = {
  // ------- التنقل -------
  dashboard: '<rect x="3" y="3" width="7.5" height="8.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="5.5" rx="1.6"/><rect x="3" y="14.5" width="7.5" height="6.5" rx="1.6"/><rect x="13.5" y="11.5" width="7.5" height="9.5" rx="1.6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  coffee: '<path d="M4 8.5h12v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M16 10h1.8a2.7 2.7 0 0 1 0 5.4H16"/><path d="M7 3.2v2.2M11 3.2v2.2"/>',
  play: '<circle cx="12" cy="12" r="8.5"/><path d="M10.2 8.8l5 3.2-5 3.2z"/>',
  pulse: '<path d="M3.5 12h4l2.5-6 3.5 12 2.5-6h4.5"/>',
  fingerprint: '<path d="M12 4.5a7.5 7.5 0 0 0-7.5 7.5v2"/><path d="M19.5 12a7.5 7.5 0 0 0-7.5-7.5"/><path d="M12 8.5A3.5 3.5 0 0 0 8.5 12v4"/><path d="M15.5 12A3.5 3.5 0 0 0 12 8.5"/><path d="M12 12v6"/><path d="M15.5 12v3.5"/><path d="M19 14.5c0 2-.4 3.6-1 5"/><path d="M5 18.5c-.4-1.4-.5-2.6-.5-4"/>',
  leave: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.2"/><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3"/><path d="M9 14.5l2 2 4-4"/>',
  balance: '<path d="M12 4.5v15M6.5 19.5h11"/><path d="M4 8.5h16M7 8.5l-3 5.5h6zM17 8.5l-3 5.5h6z"/>',
  violation: '<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4M12 16.8v.2"/>',
  payroll: '<rect x="2.5" y="6" width="19" height="12" rx="2.2"/><circle cx="12" cy="12" r="2.8"/><path d="M6 10v4M18 10v4"/>',
  loans: '<rect x="2.5" y="5.5" width="19" height="13" rx="2.2"/><path d="M2.5 10h19M6 15h4"/>',
  employees: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><path d="M16 6.2a3.2 3.2 0 0 1 0 6.1M17.5 19.5c0-2.3-.7-3.9-2-4.8"/>',
  documents: '<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2.5h7.4a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  idcard: '<rect x="2.5" y="5" width="19" height="14" rx="2.2"/><circle cx="8.5" cy="11" r="2.2"/><path d="M5 16.5c.6-1.6 2-2.4 3.5-2.4s2.9.8 3.5 2.4"/><path d="M15 10h4M15 13.5h4"/>',
  device: '<rect x="5.5" y="2.5" width="13" height="19" rx="2.4"/><path d="M9.5 6h5M9 10h6M9 13.5h6"/><circle cx="12" cy="18" r="1.1"/>',
  reports: '<path d="M6 3.5h8l5 5v12a1.8 1.8 0 0 1-1.8 1.8H6A1.8 1.8 0 0 1 4.2 20.5V5.3A1.8 1.8 0 0 1 6 3.5z"/><path d="M14 3.5V9h5"/><path d="M8.5 17v-3M12 17v-5.5M15.5 17v-2"/>',
  settings: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h7M15 17h5"/><circle cx="15" cy="7" r="2.1"/><circle cx="9" cy="12" r="2.1"/><circle cx="13" cy="17" r="2.1"/>',
  key: '<circle cx="8" cy="12" r="3.8"/><path d="M11.8 12H21M18 12v3.2M15 12v2.4"/>',
  bed: '<path d="M3 19.5v-11M3 13.5h18v6M21 19.5v-4"/><circle cx="7.5" cy="10.5" r="2"/><path d="M11 13.5v-2.2a1.8 1.8 0 0 1 1.8-1.8H19a2 2 0 0 1 2 2v2"/>',
  profile: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c0-3.6 3.2-6 7.5-6s7.5 2.4 7.5 6"/>',
  // ------- إجراءات -------
  bell: '<path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5S6.5 14 6.5 10z"/><path d="M10.2 19a2 2 0 0 0 3.6 0"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5s-1.1 6.1-3.3 8.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  collapse: '<path d="M20 5v14M15.5 12H5M9 8l-4 4 4 4"/>',
  expand: '<path d="M4 5v14M8.5 12H19M15 8l4 4-4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  cart: '<path d="M3 4.5h2.3l2.1 10.2a1.7 1.7 0 0 0 1.7 1.3h7.8a1.7 1.7 0 0 0 1.7-1.3l1.4-6.4H6.1"/><circle cx="9.6" cy="19.4" r="1.3"/><circle cx="17.4" cy="19.4" r="1.3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l4.5 4.5"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 19.5h14"/>',
  printer: '<path d="M7 8.5V3.5h10v5"/><rect x="3.5" y="8.5" width="17" height="7.5" rx="1.8"/><rect x="7" y="14" width="10" height="6.5" rx="1.2"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 3.5V8h-4.5"/>',
  check: '<path d="M5 12.5 10 17.5 19 7"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>',
  money: '<rect x="2.8" y="6" width="18.4" height="12" rx="2.2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevron: '<path d="M14.5 6.5 9 12l5.5 5.5"/>',
  home: '<path d="M3.5 10.5 12 4l8.5 6.5V19a1.6 1.6 0 0 1-1.6 1.6H5.1A1.6 1.6 0 0 1 3.5 19z"/><path d="M9.6 20.6v-6h4.8v6"/>',
  sheet: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 9h17M3.5 14.5h17M9.5 4v16M15 4v16"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  building: '<path d="M4 20.5V6.2a1.7 1.7 0 0 1 1.7-1.7h6.6A1.7 1.7 0 0 1 14 6.2v14.3"/><path d="M14 10.5h4.3a1.7 1.7 0 0 1 1.7 1.7v8.3"/><path d="M2.8 20.5h18.4"/><path d="M7 8.5h4M7 12h4M7 15.5h4M17 14h0M17 17.5h0"/>',
  login: '<path d="M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14"/><path d="M10 15.5 13.5 12 10 8.5"/><path d="M13.5 12H4"/>',
  edit: '<path d="M4 20h4l10-10a2.4 2.4 0 0 0-3.4-3.4L4.6 16.6z"/><path d="M13.5 7.5 16.5 10.5"/>',
  trash: '<path d="M4 6.5h16M9.5 6.5V4h5v2.5M6.5 6.5l1 13a1.6 1.6 0 0 0 1.6 1.5h5.8a1.6 1.6 0 0 0 1.6-1.5l1-13"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.2"/><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3"/>',
  location: '<path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2.2"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>',
  unlock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2.2"/><path d="M8 10V7.5a4 4 0 0 1 7.6-1.7"/>',
  bolt: '<path d="M13.5 2.5 5 13.5h6l-.5 8L19 10.5h-6z"/>',
  filetext: '<path d="M6 3.5h8l5 5v12a1.8 1.8 0 0 1-1.8 1.8H6A1.8 1.8 0 0 1 4.2 20.5V5.3A1.8 1.8 0 0 1 6 3.5z"/><path d="M14 3.5V9h5M8 13h8M8 16.5h5"/>',
  usercheck: '<circle cx="9.5" cy="8.5" r="3.4"/><path d="M3.5 19.5c0-3.2 2.7-5.4 6-5.4 1.2 0 2.3.3 3.2.8"/><path d="M15 16.5 17 18.5 21 14.5"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.2"/><path d="M3.5 7.5 12 13.5l8.5-6"/>',
  phone: '<path d="M7 3.5h10a1.8 1.8 0 0 1 1.8 1.8v13.4A1.8 1.8 0 0 1 17 20.5H7a1.8 1.8 0 0 1-1.8-1.8V5.3A1.8 1.8 0 0 1 7 3.5z"/><path d="M10.5 17.3h3"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 20v-6M12.5 20V8M17 20v-9"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V13M12 16.3v.2"/>',
  shield: '<path d="M12 3 19 6v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><path d="M16 6.2a3.2 3.2 0 0 1 0 6.1M17.5 19.5c0-2.3-.7-3.9-2-4.8"/>',
  minus: '<path d="M5 12h14"/>',
  bank: '<path d="M3.5 9.5 12 4l8.5 5.5M5 9.5v9M19 9.5v9M3.5 20.5h17M9 12.5v5M15 12.5v5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6"/>',
  logout: '<path d="M15 5.5V4a1.8 1.8 0 0 0-1.8-1.8H5.8A1.8 1.8 0 0 0 4 4v16a1.8 1.8 0 0 0 1.8 1.8h7.4A1.8 1.8 0 0 0 15 20v-1.5"/><path d="M9.5 12H21M17.5 8.5 21 12l-3.5 3.5"/>',
};

/** يعيد وسم SVG لأيقونة، أو الاسم كما هو إن لم تكن معرّفة (مثل الإيموجي) */
function icon(name, extraClass = '') {
  const paths = ICON_PATHS[name];
  if (!paths) return name || '';
  return `<svg class="i ${extraClass}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}
