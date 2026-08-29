import { useEffect, useState } from 'react';
import { api, ApiError, rememberBranch, rememberedBranch } from '../lib/api.js';
import { useSession } from '../lib/session.js';

/**
 * Two distinct doors, matching the specification exactly.
 *
 * Management signs in with email + password + MFA. Operational staff sign in
 * with an employee number and a PIN on a shared shop-floor device. The two
 * flows share no code path, and the PIN keypad is never offered for an
 * administrative account — the server refuses it regardless.
 */
export function Login() {
  const { signIn } = useSession();
  const [mode, setMode] = useState<'staff' | 'admin'>('staff');
  const [branches, setBranches] = useState<Array<{ id: string; name: string }>>([]);
  const [branchId, setBranchId] = useState(rememberedBranch() ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ branches: Array<{ id: string; name: string }> }>('/auth/branches')
      .then((r) => {
        setBranches(r.branches);
        setBranchId((current) => current || r.branches[0]?.id || '');
      })
      .catch(() => setError('تعذّر الاتصال بالخادم'));
  }, []);

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-logo">
          <div className="mark">MARA</div>
          <div className="sub">نظام إدارة مارا لاونج</div>
        </div>

        <div className="card">
          <div className="tabs">
            <button
              className={mode === 'staff' ? 'active' : ''}
              onClick={() => { setMode('staff'); setError(null); }}
            >
              موظف
            </button>
            <button
              className={mode === 'admin' ? 'active' : ''}
              onClick={() => { setMode('admin'); setError(null); }}
            >
              إدارة
            </button>
          </div>

          {error && <div className="alert-box">{error}</div>}

          <div className="field">
            <label className="label">الفرع</label>
            <select
              className="select" value={branchId}
              onChange={(e) => { setBranchId(e.target.value); rememberBranch(e.target.value); }}
            >
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>

          {mode === 'staff'
            ? <StaffLogin branchId={branchId} onError={setError} signIn={signIn}
                          busy={busy} setBusy={setBusy} />
            : <AdminLogin onError={setError} signIn={signIn} busy={busy} setBusy={setBusy} />}
        </div>

        <p className="small faint center" style={{ marginTop: 14 }}>
          الحسابات الإدارية تدخل بالبريد وكلمة المرور والتحقق الثنائي فقط.
        </p>
      </div>
    </div>
  );
}

function StaffLogin({
  branchId, onError, signIn, busy, setBusy,
}: {
  branchId: string; onError: (m: string | null) => void;
  signIn: (t: { accessToken: string; refreshToken: string }) => Promise<void>;
  busy: boolean; setBusy: (b: boolean) => void;
}) {
  const [employeeCode, setEmployeeCode] = useState('');
  const [pin, setPin] = useState('');

  const submit = async (finalPin: string) => {
    if (!employeeCode || finalPin.length < 4) return;
    setBusy(true); onError(null);
    try {
      const res = await api<{ tokens: any }>('/auth/employee/login', {
        method: 'POST',
        body: { branchId, employeeCode, pin: finalPin },
      });
      await signIn(res.tokens);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'تعذّر تسجيل الدخول');
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  const press = (digit: string) => {
    const next = (pin + digit).slice(0, 6);
    setPin(next);
    // Four digits is the standard PIN length; submit as soon as it is complete
    // so a waiter is one tap from the floor board.
    if (next.length === 4) void submit(next);
  };

  return (
    <>
      <div className="field">
        <label className="label">رقم الموظف</label>
        <input
          className="input ltr" inputMode="numeric" value={employeeCode}
          onChange={(e) => setEmployeeCode(e.target.value.replace(/\D/g, ''))}
          placeholder="1042" autoFocus
        />
      </div>

      <div className="pin-dots" aria-label="الرمز السري">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`pin-dot${pin.length > i ? ' filled' : ''}`} />
        ))}
      </div>

      <div className="keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} onClick={() => press(d)} disabled={busy}>{d}</button>
        ))}
        <button onClick={() => setPin('')} disabled={busy}>مسح</button>
        <button onClick={() => press('0')} disabled={busy}>0</button>
        <button onClick={() => setPin((p) => p.slice(0, -1))} disabled={busy}>⌫</button>
      </div>

      {busy && <div className="center" style={{ marginTop: 12 }}><span className="spinner" /></div>}
    </>
  );
}

function AdminLogin({
  onError, signIn, busy, setBusy,
}: {
  onError: (m: string | null) => void;
  signIn: (t: { accessToken: string; refreshToken: string }) => Promise<void>;
  busy: boolean; setBusy: (b: boolean) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [stage, setStage] = useState<'credentials' | 'mfa' | 'enroll'>('credentials');
  const [mfaToken, setMfaToken] = useState('');
  const [code, setCode] = useState('');
  const [enrollment, setEnrollment] = useState<{ secret: string; uri: string } | null>(null);

  const submitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); onError(null);
    try {
      const res = await api<any>('/auth/login', { method: 'POST', body: { email, password } });
      if (res.status === 'ok') {
        await signIn(res.tokens);
        return;
      }
      setMfaToken(res.mfaToken);
      if (res.status === 'mfa_enrollment_required') {
        setEnrollment(res.enrollment);
        setStage('enroll');
      } else {
        setStage('mfa');
      }
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'تعذّر تسجيل الدخول');
    } finally {
      setBusy(false);
    }
  };

  const submitMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); onError(null);
    try {
      const res = await api<{ tokens: any }>('/auth/mfa/verify', {
        method: 'POST', body: { mfaToken, code },
      });
      await signIn(res.tokens);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'رمز التحقق غير صحيح');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  if (stage === 'credentials') {
    return (
      <form onSubmit={submitCredentials}>
        <div className="field">
          <label className="label">البريد الإلكتروني</label>
          <input
            className="input ltr" type="email" value={email} autoComplete="username"
            onChange={(e) => setEmail(e.target.value)} required autoFocus
          />
        </div>
        <div className="field">
          <label className="label">كلمة المرور</label>
          <input
            className="input ltr" type="password" value={password} autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)} required
          />
        </div>
        <button className="btn primary block lg" disabled={busy}>
          {busy ? '...' : 'تسجيل الدخول'}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={submitMfa}>
      {stage === 'enroll' && enrollment && (
        <div className="alert-box info">
          <div style={{ marginBottom: 8 }}>
            التحقق الثنائي إلزامي للحسابات الإدارية. أضف المفتاح التالي في تطبيق
            المصادقة (Google Authenticator أو ما شابه) ثم أدخل الرمز الظاهر.
          </div>
          <code
            className="num"
            style={{ display: 'block', wordBreak: 'break-all', fontSize: 13 }}
          >
            {enrollment.secret}
          </code>
        </div>
      )}
      <div className="field">
        <label className="label">رمز التحقق</label>
        <input
          className="input ltr" inputMode="numeric" value={code} autoFocus
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
          placeholder="000000" maxLength={8}
        />
      </div>
      <button className="btn primary block lg" disabled={busy || code.length < 6}>
        {busy ? '...' : 'تأكيد'}
      </button>
      <button
        type="button" className="btn ghost block" style={{ marginTop: 8 }}
        onClick={() => { setStage('credentials'); setCode(''); }}
      >
        رجوع
      </button>
    </form>
  );
}
