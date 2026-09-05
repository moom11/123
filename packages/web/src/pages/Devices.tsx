import { useCallback, useEffect, useState } from 'react';
import { api, deviceToken, setDeviceToken } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { Empty, Modal, Spinner, useToast, ConfirmReason } from '../components/ui.js';
import { dateTime, since } from '../lib/format.js';

/**
 * The terminals on the floor.
 *
 * Two jobs on one screen, because they are the same decision: saying what a
 * machine is (a till closes bills, a tablet does not), and getting the till a
 * certificate so the bills it closes are legal.
 */

const KIND_LABEL: Record<string, string> = {
  cashier: 'كاشير', waiter: 'نادل', kiosk: 'طلب ذاتي', display: 'شاشة عرض',
};

const STEP_LABEL: Record<string, string> = {
  keys: 'مفتاح فقط',
  csr: 'طلب شهادة جاهز',
  compliance: 'شهادة امتثال',
  checks_passed: 'اجتاز الفحوص',
  production: 'شهادة إنتاجية',
};

export function Devices() {
  const { can } = useSession();
  const { push } = useToast();
  const [devices, setDevices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [issued, setIssued] = useState<{ label: string; token: string } | null>(null);
  const [onboarding, setOnboarding] = useState<any | null>(null);
  const [csr, setCsr] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [retiring, setRetiring] = useState<any | null>(null);
  const [thisDevice, setThisDevice] = useState<any | null>(null);
  const [pairing, setPairing] = useState('');

  const load = useCallback(async () => {
    try {
      const [list, me] = await Promise.all([
        api<{ devices: any[] }>('/devices'),
        api<{ registered: boolean; device?: any }>('/devices/me'),
      ]);
      setDevices(list.devices);
      setThisDevice(me.registered ? me.device : null);
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setLoading(false); }
  }, [push]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <Spinner label="جارٍ تحميل الأجهزة…" />;

  return (
    <>
      {/* What this machine is, before anything about other machines. */}
      <div className={`card ${thisDevice ? '' : 'warn'}`}>
        <h3>هذا الجهاز</h3>
        {thisDevice ? (
          <p>
            مسجَّل باسم <strong>{thisDevice.label}</strong> — {KIND_LABEL[thisDevice.kind]}.
            {thisDevice.canSettle
              ? ' يستطيع إقفال الفواتير.'
              : ' لا يُقفل الفواتير — الإقفال من جهاز الكاشير.'}
          </p>
        ) : (
          <>
            <p>
              هذا الجهاز غير مرتبط بأي طرفية مسجَّلة، فلن يستطيع إقفال أي فاتورة.
              الصق رمز الجهاز الذي ظهر مرة واحدة عند تسجيله.
            </p>
            <div className="toolbar">
              <input
                type="password" value={pairing} placeholder="رمز الجهاز"
                onChange={(e) => setPairing(e.target.value)}
                style={{ minWidth: 280 }}
              />
              <button
                className="btn"
                disabled={!pairing.trim()}
                onClick={() => { setDeviceToken(pairing); setPairing(''); void load(); }}
              >
                اربط الجهاز
              </button>
            </div>
          </>
        )}
        {deviceToken() && (
          <button className="btn ghost" onClick={() => { setDeviceToken(''); void load(); }}>
            فك الارتباط عن هذا المتصفح
          </button>
        )}
      </div>

      {can('devices.manage') && (
        <div className="toolbar" style={{ marginTop: 16 }}>
          <button className="btn" onClick={() => setAdding(true)}>سجّل طرفية جديدة</button>
        </div>
      )}

      {devices.length === 0 ? (
        <Empty icon="🖥️" text="لا أجهزة مسجَّلة" />
      ) : (
        <table className="data" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>الجهاز</th>
              <th>النوع</th>
              <th>الرقم التسلسلي</th>
              <th>آخر ظهور</th>
              <th>الفوترة</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id} className={d.is_active ? '' : 'muted'}>
                <td>{d.label}</td>
                <td>{KIND_LABEL[d.kind] ?? d.kind}</td>
                <td className="mono">{d.serial_number}</td>
                <td>{d.last_seen_at ? since(d.last_seen_at) : '—'}</td>
                <td>
                  {d.kind !== 'cashier' ? (
                    <span className="muted">لا ينطبق</span>
                  ) : d.is_production ? (
                    <span className="pill ok">شهادة إنتاجية</span>
                  ) : (
                    <span className="pill warn">
                      {STEP_LABEL[d.onboarding_step] ?? 'لم يبدأ'}
                    </span>
                  )}
                </td>
                <td className="actions">
                  {d.kind === 'cashier' && can('invoices.manage_credentials') && !d.is_production && (
                    <button className="btn small" onClick={() => void beginOnboarding(d)}>
                      سجّل لدى الهيئة
                    </button>
                  )}
                  {can('devices.manage') && (
                    <>
                      <button className="btn small ghost" onClick={() => void rotate(d)}>
                        رمز جديد
                      </button>
                      <button className="btn small ghost" onClick={() => setRetiring(d)}>
                        إيقاف
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adding && (
        <Modal title="تسجيل طرفية" onClose={() => setAdding(false)}>
          <form onSubmit={register}>
            <label>
              النوع
              <select name="kind" defaultValue="waiter">
                <option value="cashier">كاشير — يُقفل الفواتير</option>
                <option value="waiter">نادل — يأخذ الطلبات فقط</option>
                <option value="kiosk">طلب ذاتي</option>
                <option value="display">شاشة عرض</option>
              </select>
            </label>
            <label>
              الاسم
              <input name="label" required maxLength={80} placeholder="كاشير الصالة" />
            </label>
            <label>
              الرقم التسلسلي
              <input name="serialNumber" required maxLength={40} placeholder="TILL-02" />
              <small className="muted">
                يدخل في شهادة الهيئة كما هو — لا تغيّره بعد التسجيل.
              </small>
            </label>
            <button className="btn" type="submit" disabled={busy}>سجّل</button>
          </form>
        </Modal>
      )}

      {issued && (
        <Modal title={`رمز ${issued.label}`} onClose={() => setIssued(null)}>
          <p>
            انسخه الآن وأدخله في الجهاز نفسه. <strong>لن يظهر مرة أخرى</strong> —
            محفوظ مُجزَّأً، فلا سبيل لاسترجاعه، وإنما إصدار رمز جديد.
          </p>
          <pre className="break">{issued.token}</pre>
          <button className="btn" onClick={() => {
            void navigator.clipboard?.writeText(issued.token);
            push('نُسخ الرمز', 'ok');
          }}>انسخ</button>
        </Modal>
      )}

      {onboarding && (
        <Modal
          title={`تسجيل ${onboarding.label} لدى هيئة الزكاة والضريبة`}
          onClose={() => { setOnboarding(null); setCsr(null); setOtp(''); }}
        >
          <ol className="steps">
            <li>
              <strong>طلب الشهادة (CSR)</strong>
              <p className="muted">
                يُولَّد مفتاح خاص للجهاز ولا يغادره أبداً. ما يُرسل للهيئة وصف موقَّع للجهاز.
              </p>
              {csr ? (
                <pre className="break small" style={{ maxHeight: 140, overflow: 'auto' }}>{csr}</pre>
              ) : (
                <button className="btn" disabled={busy} onClick={() => void makeCsr()}>
                  أنشئ طلب الشهادة
                </button>
              )}
            </li>
            <li>
              <strong>رمز التحقق من بوابة «فاتورة»</strong>
              <p className="muted">
                ادخل إلى بوابة فاتورة، اطلب رمز تسجيل جهاز جديد، والصقه هنا.
                صلاحيته دقائق معدودة.
              </p>
              <input
                value={otp} onChange={(e) => setOtp(e.target.value)}
                placeholder="رمز البوابة" disabled={!csr}
              />
              <button className="btn" disabled={!csr || !otp.trim() || busy}
                      onClick={() => void finishOnboarding()}>
                {busy ? 'جارٍ التسجيل…' : 'أكمل التسجيل'}
              </button>
            </li>
          </ol>
          <p className="muted small">
            حتى تكتمل هذه الخطوة، الفواتير تُختم وتُطبع لكنها لا تُقبل لدى الهيئة —
            وفحص ما قبل الافتتاح يرفض التشغيل بها.
          </p>
        </Modal>
      )}

      {retiring && (
        <ConfirmReason
          title={`إيقاف ${retiring.label}`}
          message="الجهاز الموقوف لا يُحذف — فواتيره تشير إليه وتبقى مقروءة."
          confirmLabel="أوقف الجهاز"
          requireReason
          onCancel={() => setRetiring(null)}
          onConfirm={async (reason) => {
            try {
              await api(`/devices/${retiring.id}/retire`, { method: 'POST', body: { reason } });
              push('أُوقف الجهاز', 'ok');
              setRetiring(null);
              await load();
            } catch (err) { push((err as Error).message, 'error'); }
          }}
        />
      )}
    </>
  );

  async function register(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const created = await api<{ token: string; label: string }>('/devices', {
        method: 'POST',
        body: {
          kind: form.get('kind'),
          label: form.get('label'),
          serialNumber: form.get('serialNumber'),
        },
      });
      setAdding(false);
      setIssued({ label: created.label, token: created.token });
      await load();
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setBusy(false); }
  }

  async function rotate(device: any) {
    try {
      const res = await api<{ token: string }>(`/devices/${device.id}/rotate-token`,
        { method: 'POST' });
      setIssued({ label: device.label, token: res.token });
    } catch (err) { push((err as Error).message, 'error'); }
  }

  function beginOnboarding(device: any) {
    setOnboarding(device);
    setCsr(null);
    setOtp('');
  }

  async function makeCsr() {
    setBusy(true);
    try {
      const res = await api<{ csr: string; egsSerial: string }>(
        `/devices/${onboarding.id}/zatca/csr`,
        { method: 'POST', body: { environment: 'production' } },
      );
      setCsr(res.csr);
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setBusy(false); }
  }

  async function finishOnboarding() {
    setBusy(true);
    try {
      await api(`/devices/${onboarding.id}/zatca/onboard`,
        { method: 'POST', body: { otp: otp.trim() } });
      push('صدرت الشهادة الإنتاجية', 'ok');
      setOnboarding(null);
      setCsr(null);
      setOtp('');
      await load();
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setBusy(false); }
  }
}
