import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { Empty, Modal, Spinner, useToast } from '../components/ui.js';
import { dateTime } from '../lib/format.js';

/**
 * Users and employees.
 *
 * Role assignment and permission overrides are shown only to Owner/Super Admin
 * — and refused by the server for anyone else, including a branch manager
 * trying to promote themselves.
 */
export function Admin() {
  const { can, me } = useSession();
  const { push } = useToast();
  const [tab, setTab] = useState<'employees' | 'users'>('employees');
  const [employees, setEmployees] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [resettingPin, setResettingPin] = useState<any | null>(null);

  const isRoleAdmin = ['owner', 'super_admin'].includes(me?.user.role ?? '');

  const load = useCallback(async () => {
    try {
      const [e, u, r] = await Promise.all([
        can('employees.read')
          ? api<{ employees: any[] }>('/admin/employees?includeInactive=true')
          : Promise.resolve({ employees: [] }),
        can('admin.users.read')
          ? api<{ users: any[] }>('/admin/users') : Promise.resolve({ users: [] }),
        can('admin.roles.read')
          ? api<{ roles: any[] }>('/admin/roles') : Promise.resolve({ roles: [] }),
      ]);
      setEmployees(e.employees);
      setUsers(u.users);
      setRoles(r.roles);
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setLoading(false); }
  }, [can, push]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <Spinner label="جارٍ التحميل…" />;

  return (
    <>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <div className="tabs" style={{ flex: '0 0 auto', width: 260, marginBottom: 0 }}>
          <button className={tab === 'employees' ? 'active' : ''} onClick={() => setTab('employees')}>
            الموظفون
          </button>
          {can('admin.users.read') && (
            <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>
              الحسابات
            </button>
          )}
        </div>
        <div className="spacer" />
        {can('employees.create', 'admin.users.create') && (
          <button className="btn primary" onClick={() => setCreating(true)}>+ حساب جديد</button>
        )}
      </div>

      {!isRoleAdmin && (
        <div className="alert-box info">
          إنشاء الحسابات الإدارية وتغيير الأدوار والصلاحيات الحساسة مقصور على
          المالك ومدير النظام.
        </div>
      )}

      {tab === 'employees' && (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>الرقم</th><th>الاسم</th><th>الوظيفة</th><th>القسم</th>
                  <th>الدور</th><th>الحالة</th><th>آخر دخول</th><th></th>
                </tr>
              </thead>
              <tbody>
                {employees.map((e) => (
                  <tr key={e.id}>
                    <td className="num">{e.employee_code}</td>
                    <td>{e.full_name}</td>
                    <td className="small">{e.job_title}</td>
                    <td className="small muted">{e.department}</td>
                    <td><span className="badge">{e.role_name}</span></td>
                    <td>
                      {e.locked_until && new Date(e.locked_until) > new Date() ? (
                        <span className="badge red">مقفل مؤقتاً</span>
                      ) : (
                        <span className={`badge ${e.is_active ? 'green' : ''}`}>
                          {e.is_active ? 'نشط' : 'معطّل'}
                        </span>
                      )}
                    </td>
                    <td className="small faint">{dateTime(e.last_login_at)}</td>
                    <td>
                      {can('employees.pin.reset') && (
                        <button className="btn sm" onClick={() => setResettingPin(e)}>
                          إعادة PIN
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {employees.length === 0 && <Empty icon="👤" text="لا يوجد موظفون" />}
        </div>
      )}

      {tab === 'users' && (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>الاسم</th><th>البريد</th><th>الدور</th><th>الفرع</th>
                  <th>MFA</th><th>الجلسات</th><th>آخر دخول</th><th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.full_name}</td>
                    <td className="num small">{u.email ?? '—'}</td>
                    <td><span className="badge">{u.role_name}</span></td>
                    <td className="small muted">{u.branch_name ?? 'كل الفروع'}</td>
                    <td>
                      {u.email ? (
                        <span className={`badge ${u.mfa_enabled ? 'green' : 'red'}`}>
                          {u.mfa_enabled ? 'مفعّل' : 'غير مفعّل'}
                        </span>
                      ) : <span className="small faint">PIN</span>}
                    </td>
                    <td className="num">{u.active_sessions}</td>
                    <td className="small faint">{dateTime(u.last_login_at)}</td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        {isRoleAdmin && u.id !== me?.user.id && (
                          <RoleSelect
                            user={u} roles={roles}
                            onChanged={async () => { await load(); }}
                          />
                        )}
                        {can('admin.sessions.revoke') && u.active_sessions > 0 && (
                          <button
                            className="btn ghost sm"
                            onClick={async () => {
                              await api(`/auth/sessions/${u.id}/revoke-all`, { method: 'POST' });
                              push('تم إنهاء جلسات المستخدم', 'ok');
                              void load();
                            }}
                          >
                            إنهاء الجلسات
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {creating && (
        <CreateUser
          roles={roles} isRoleAdmin={isRoleAdmin}
          onClose={() => setCreating(false)}
          onCreated={async () => { setCreating(false); await load(); }}
        />
      )}

      {resettingPin && (
        <ResetPin
          employee={resettingPin}
          onClose={() => setResettingPin(null)}
          onDone={async () => { setResettingPin(null); await load(); }}
        />
      )}
    </>
  );
}

function RoleSelect({
  user, roles, onChanged,
}: { user: any; roles: any[]; onChanged: () => void }) {
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <select
      className="select" style={{ minHeight: 34, width: 150 }} value={user.role}
      disabled={busy}
      onChange={async (e) => {
        setBusy(true);
        try {
          await api(`/admin/users/${user.id}/role`, {
            method: 'POST', body: { roleCode: e.target.value },
          });
          push('تم تغيير الدور وإنهاء جلسات المستخدم', 'ok');
          onChanged();
        } catch (err) { push((err as Error).message, 'error'); }
        finally { setBusy(false); }
      }}
    >
      {roles.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
    </select>
  );
}

function CreateUser({
  roles, isRoleAdmin, onClose, onCreated,
}: { roles: any[]; isRoleAdmin: boolean; onClose: () => void; onCreated: () => void }) {
  const { push } = useToast();
  const [form, setForm] = useState({
    fullName: '', roleCode: 'waiter', email: '', password: '',
    employeeCode: '', pin: '', jobTitle: '', department: 'FLOOR',
  });
  const [busy, setBusy] = useState(false);

  const role = roles.find((r) => r.code === form.roleCode);
  const isAdminRole = role?.is_admin ?? false;

  return (
    <Modal
      title="إنشاء حساب" onClose={onClose}
      footer={
        <button
          className="btn primary" disabled={busy || !form.fullName}
          onClick={async () => {
            setBusy(true);
            try {
              await api('/admin/users', {
                method: 'POST',
                body: {
                  fullName: form.fullName,
                  roleCode: form.roleCode,
                  email: isAdminRole ? form.email : null,
                  password: isAdminRole ? form.password : null,
                  employeeCode: isAdminRole ? null : form.employeeCode || null,
                  pin: isAdminRole ? null : form.pin || null,
                  jobTitle: form.jobTitle || null,
                  department: form.department,
                },
              });
              push('تم إنشاء الحساب', 'ok');
              onCreated();
            } catch (err) { push((err as Error).message, 'error'); }
            finally { setBusy(false); }
          }}
        >
          {busy ? '...' : 'إنشاء'}
        </button>
      }
    >
      <div className="field">
        <label className="label">الاسم الكامل</label>
        <input
          className="input" value={form.fullName} autoFocus
          onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
        />
      </div>
      <div className="field">
        <label className="label">الدور</label>
        <select
          className="select" value={form.roleCode}
          onChange={(e) => setForm((f) => ({ ...f, roleCode: e.target.value }))}
        >
          {roles
            .filter((r) => r.code !== 'customer' && (isRoleAdmin || !r.is_admin))
            .map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
        </select>
      </div>

      {isAdminRole ? (
        <>
          <div className="alert-box info">
            حساب إداري: يدخل بالبريد وكلمة المرور والتحقق الثنائي. لا يُمنح
            رمز PIN.
          </div>
          <div className="field">
            <label className="label">البريد الإلكتروني</label>
            <input
              className="input ltr" type="email" value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
          </div>
          <div className="field">
            <label className="label">كلمة المرور المؤقتة</label>
            <input
              className="input ltr" type="text" value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              placeholder="12 حرفاً على الأقل مع أحرف كبيرة وصغيرة ورقم ورمز"
            />
          </div>
        </>
      ) : (
        <>
          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label className="label">رقم الموظف</label>
              <input
                className="input ltr" inputMode="numeric" value={form.employeeCode}
                onChange={(e) => setForm(
                  (f) => ({ ...f, employeeCode: e.target.value.replace(/\D/g, '') }),
                )}
                placeholder="1042"
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label className="label">الرمز السري (PIN)</label>
              <input
                className="input ltr" inputMode="numeric" value={form.pin}
                onChange={(e) => setForm(
                  (f) => ({ ...f, pin: e.target.value.replace(/\D/g, '').slice(0, 6) }),
                )}
                placeholder="4-6 أرقام"
              />
            </div>
          </div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label className="label">المسمى الوظيفي</label>
              <input
                className="input" value={form.jobTitle}
                onChange={(e) => setForm((f) => ({ ...f, jobTitle: e.target.value }))}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label className="label">القسم</label>
              <select
                className="select" value={form.department}
                onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))}
              >
                {['BAR', 'KITCHEN', 'SHISHA', 'FLOOR', 'ADMIN', 'OTHER'].map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

function ResetPin({
  employee, onClose, onDone,
}: { employee: any; onClose: () => void; onDone: () => void }) {
  const { push } = useToast();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      title={`إعادة تعيين PIN — ${employee.full_name}`} onClose={onClose}
      footer={
        <button
          className="btn primary" disabled={busy || pin.length < 4}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/admin/employees/${employee.id}/pin`, {
                method: 'POST', body: { pin },
              });
              push('تم تعيين رمز جديد', 'ok');
              onDone();
            } catch (err) { push((err as Error).message, 'error'); }
            finally { setBusy(false); }
          }}
        >
          {busy ? '...' : 'حفظ'}
        </button>
      }
    >
      <div className="field">
        <label className="label">الرمز الجديد</label>
        <input
          className="input ltr" inputMode="numeric" value={pin} autoFocus
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="4-6 أرقام"
        />
        <div className="small faint">
          لا تُقبل الأرقام المتكررة (1111) ولا المتسلسلة (1234).
        </div>
      </div>
    </Modal>
  );
}
