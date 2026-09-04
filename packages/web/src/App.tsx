import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './lib/session.js';
import { api, rememberBranch, rememberedBranch } from './lib/api.js';
import { RealtimeProvider, useRealtime, useRealtimeEvent } from './lib/realtime.js';
import { useToast } from './components/ui.js';
import { Login } from './pages/Login.js';
import { Floor } from './pages/Floor.js';
import { Pos } from './pages/Pos.js';
import { Approvals } from './pages/Approvals.js';
import { Dashboard } from './pages/Dashboard.js';
import { Purchasing } from './pages/Purchasing.js';
import { Inventory } from './pages/Inventory.js';
import { Customers } from './pages/Customers.js';
import { Reports } from './pages/Reports.js';
import { AuditLog } from './pages/AuditLog.js';
import { Printers } from './pages/Printers.js';
import { Invoices } from './pages/Invoices.js';
import { Devices } from './pages/Devices.js';
import { Menu } from './pages/Menu.js';
import { Admin } from './pages/Admin.js';
import { CustomerMenu } from './pages/CustomerMenu.js';

/**
 * The application shell.
 *
 * `/menu/:qrValue` is the guest-facing route and is deliberately outside the
 * staff session entirely — a customer scanning a QR never touches the POS
 * bundle's auth path.
 */
export function App() {
  const location = useLocation();
  const isGuestRoute = location.pathname.startsWith('/menu/');

  if (isGuestRoute) {
    return (
      <Routes>
        <Route path="/menu/:qrValue" element={<CustomerMenu />} />
      </Routes>
    );
  }
  return <StaffApp />;
}

function StaffApp() {
  const { me, loading } = useSession();

  if (loading) {
    return (
      <div className="login-wrap">
        <div className="center">
          <span className="spinner" />
          <p className="muted" style={{ marginTop: 12 }}>جارٍ التحميل…</p>
        </div>
      </div>
    );
  }

  if (!me) return <Login />;

  return (
    <RealtimeProvider enabled>
      <Shell />
    </RealtimeProvider>
  );
}

interface NavEntry {
  to: string;
  label: string;
  icon: string;
  /** Any one of these permissions reveals the entry. */
  permissions: string[];
  badge?: 'approvals' | 'purchasing';
}

const NAV: Array<{ section: string; items: NavEntry[] }> = [
  {
    section: 'التشغيل',
    items: [
      { to: '/', label: 'الطاولات', icon: '🍽️', permissions: ['tables.read'] },
      { to: '/pos', label: 'نقطة البيع', icon: '🧾', permissions: ['pos.use'] },
      {
        to: '/approvals', label: 'طلبات العملاء', icon: '🔔',
        permissions: ['orders.approve_customer_order'], badge: 'approvals',
      },
    ],
  },
  {
    section: 'الإدارة',
    items: [
      { to: '/dashboard', label: 'لوحة المؤشرات', icon: '📊', permissions: ['reports.sales'] },
      { to: '/catalog', label: 'المنيو', icon: '🍔', permissions: ['menu.manage', 'menu.availability.update'] },
      { to: '/customers', label: 'العملاء', icon: '👥', permissions: ['customers.read'] },
      { to: '/inventory', label: 'المخزون', icon: '📦', permissions: ['inventory.read'] },
      {
        to: '/purchasing', label: 'المشتريات', icon: '🛒',
        permissions: ['purchase_requests.read.own_department', 'purchase_requests.read.branch',
                      'purchase_requests.read.all', 'purchasing.buyer'],
        badge: 'purchasing',
      },
      { to: '/reports', label: 'التقارير', icon: '📈', permissions: ['reports.products', 'reports.employees'] },
      { to: '/invoices', label: 'الفواتير', icon: '🧾', permissions: ['invoices.read'] },
    ],
  },
  {
    section: 'النظام',
    items: [
      { to: '/printers', label: 'الطابعات', icon: '🖨️', permissions: ['printers.read'] },
      { to: '/devices', label: 'الأجهزة', icon: '🖥️', permissions: ['devices.read'] },
      { to: '/admin', label: 'المستخدمون', icon: '⚙️', permissions: ['admin.users.read', 'employees.read'] },
      { to: '/audit', label: 'سجل العمليات', icon: '🔎', permissions: ['audit.read'] },
    ],
  },
];

/**
 * Branch picker, shown only to a principal with no home branch — the owner,
 * super admin and executives. Everyone else is pinned to their own branch by
 * the server and has nothing to choose. Switching reloads so every open screen
 * refetches against the new branch rather than showing a mix of the two.
 */
function BranchPicker() {
  const { me } = useSession();
  const [branches, setBranches] = useState<Array<{ id: string; name: string }>>([]);
  const current = rememberedBranch() ?? '';

  const spansAllBranches = me != null && me.user.branchId == null;

  useEffect(() => {
    if (!spansAllBranches) return;
    api<{ branches: Array<{ id: string; name: string }> }>('/auth/branches')
      .then((r) => setBranches(r.branches))
      .catch(() => { /* the topbar is not the place to report this */ });
  }, [spansAllBranches]);

  if (!spansAllBranches || branches.length === 0) return null;

  return (
    <select
      className="select sm"
      value={current}
      aria-label="الفرع"
      onChange={(e) => { rememberBranch(e.target.value); window.location.reload(); }}
    >
      {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
    </select>
  );
}

function Shell() {
  const { me, can, signOut } = useSession();
  const { connected } = useRealtime();
  const { push } = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [pendingPurchases, setPendingPurchases] = useState(0);
  const location = useLocation();

  useEffect(() => { setMenuOpen(false); }, [location.pathname]);

  // Live badges and floor alerts, straight off the websocket.
  useRealtimeEvent(['order.pending_approval'], (e) => {
    setPendingApprovals((n) => n + 1);
    push(`طلب جديد من طاولة ${e.payload?.tableNumber ?? ''} بانتظار التأكيد`, 'warn');
  });
  useRealtimeEvent(['service.request'], (e) => {
    push(`${e.payload?.label ?? 'طلب خدمة'} — طاولة ${e.payload?.tableNumber ?? ''}`, 'warn');
  });
  useRealtimeEvent(['print.failed', 'print.queue_stuck'], () => {
    push('تنبيه: مشكلة في الطباعة، راجع شاشة الطابعات', 'error');
  });
  useRealtimeEvent(['purchase_request.pending_approval'], () => {
    setPendingPurchases((n) => n + 1);
    push('طلب شراء بانتظار الاعتماد', 'warn');
  });

  const badge = (kind?: 'approvals' | 'purchasing'): number => {
    if (kind === 'approvals') return pendingApprovals;
    if (kind === 'purchasing') return pendingPurchases;
    return 0;
  };

  const visible = NAV
    .map((s) => ({ ...s, items: s.items.filter((i) => can(...i.permissions)) }))
    .filter((s) => s.items.length > 0);

  return (
    <div className="app">
      <header className="topbar">
        <button
          className="btn ghost sm" onClick={() => setMenuOpen((o) => !o)}
          style={{ display: 'none' }} id="menu-toggle" aria-label="القائمة"
        >☰</button>
        <div className="brand">
          MARA
          <small>{me?.branch?.name ?? 'مارا لاونج'}</small>
        </div>
        <div className="spacer" />
        <BranchPicker />
        <span
          className={`badge ${connected ? 'green' : 'red'}`}
          title={connected ? 'التحديثات الفورية تعمل' : 'انقطع الاتصال الفوري'}
        >
          {connected ? '● مباشر' : '○ غير متصل'}
        </span>
        <div className="row" style={{ gap: 6 }}>
          <div style={{ textAlign: 'start' }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{me?.user.name}</div>
            <div className="small faint">
              {me?.user.roleLabel}
              {me?.user.employeeCode ? ` · ${me.user.employeeCode}` : ''}
            </div>
          </div>
          <button className="btn ghost sm" onClick={() => void signOut()}>خروج</button>
        </div>
      </header>

      <div className="body">
        <aside className={`sidebar${menuOpen ? ' open' : ''}`}>
          {visible.map((section) => (
            <div key={section.section}>
              <div className="nav-section">{section.section}</div>
              {section.items.map((item) => (
                <NavLink
                  key={item.to} to={item.to} end={item.to === '/'}
                  className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                >
                  <span className="icon">{item.icon}</span>
                  <span>{item.label}</span>
                  {badge(item.badge) > 0 && (
                    <span className="nav-badge">{badge(item.badge)}</span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </aside>

        <main className="content">
          <Routes>
            <Route path="/" element={<Guard perm={['tables.read']}><Floor /></Guard>} />
            <Route path="/pos" element={<Guard perm={['pos.use']}><Pos /></Guard>} />
            <Route
              path="/pos/:tableId"
              element={<Guard perm={['pos.use']}><Pos /></Guard>}
            />
            <Route
              path="/approvals"
              element={
                <Guard perm={['orders.approve_customer_order']}>
                  <Approvals onCountChange={setPendingApprovals} />
                </Guard>
              }
            />
            <Route path="/dashboard" element={<Guard perm={['reports.sales']}><Dashboard /></Guard>} />
            <Route path="/customers" element={<Guard perm={['customers.read']}><Customers /></Guard>} />
            <Route path="/inventory" element={<Guard perm={['inventory.read']}><Inventory /></Guard>} />
            <Route
              path="/purchasing"
              element={
                <Guard perm={['purchase_requests.read.own_department',
                              'purchase_requests.read.branch',
                              'purchase_requests.read.all', 'purchasing.buyer']}>
                  <Purchasing onCountChange={setPendingPurchases} />
                </Guard>
              }
            />
            <Route
              path="/reports"
              element={<Guard perm={['reports.products', 'reports.employees']}><Reports /></Guard>}
            />
            <Route path="/catalog" element={<Guard perm={['menu.manage', 'menu.availability.update']}><Menu /></Guard>} />
            <Route path="/printers" element={<Guard perm={['printers.read']}><Printers /></Guard>} />
            <Route path="/invoices" element={<Guard perm={['invoices.read']}><Invoices /></Guard>} />
            <Route path="/devices" element={<Guard perm={['devices.read']}><Devices /></Guard>} />
            <Route
              path="/admin"
              element={<Guard perm={['admin.users.read', 'employees.read']}><Admin /></Guard>}
            />
            <Route path="/audit" element={<Guard perm={['audit.read']}><AuditLog /></Guard>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

/**
 * Client-side gate. Convenience only — the server rejects the underlying
 * request regardless, so this never stands alone as a security control.
 */
function Guard({ perm, children }: { perm: string[]; children: JSX.Element }) {
  const { can } = useSession();
  if (!can(...perm)) {
    return (
      <div className="card">
        <div className="empty">
          <span className="icon">🔒</span>
          ليست لديك صلاحية للوصول إلى هذه الشاشة.
        </div>
      </div>
    );
  }
  return children;
}
