import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { useRealtimeEvent } from '../lib/realtime.js';
import { Empty, Modal, Spinner, Stat, useToast, ConfirmReason } from '../components/ui.js';
import { dateTime, since } from '../lib/format.js';

/**
 * Printer and queue health.
 *
 * The kitchen, bar and shisha stations have no screens — they work from paper —
 * so a stuck queue is an operational emergency, and this screen is where it
 * surfaces.
 */
export function Printers() {
  const { can } = useSession();
  const { push } = useToast();
  const [health, setHealth] = useState<any | null>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [reprinting, setReprinting] = useState<any | null>(null);
  const [showAgentToken, setShowAgentToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [h, j] = await Promise.all([
        api<any>('/printers'),
        can('print_jobs.read')
          ? api<{ jobs: any[] }>('/print-jobs?limit=50') : Promise.resolve({ jobs: [] }),
      ]);
      setHealth(h);
      setJobs(j.jobs);
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setLoading(false); }
  }, [can, push]);

  useEffect(() => { void load(); }, [load]);
  useRealtimeEvent(['print.failed', 'printer.status', 'print.queue_stuck'], () => { void load(); });

  useEffect(() => {
    const timer = window.setInterval(() => { void load(); }, 20_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (loading) return <Spinner label="جارٍ فحص الطابعات…" />;
  if (!health) return null;

  const stats = health.stats ?? {};

  return (
    <>
      <div className="grid cols-4">
        <Stat label="في الانتظار" value={stats.queued ?? 0}
              tone={(stats.queued ?? 0) > 5 ? 'warn' : undefined} />
        <Stat label="قيد الطباعة" value={stats.claimed ?? 0} />
        <Stat label="فشل" value={stats.failed ?? 0}
              tone={(stats.failed ?? 0) > 0 ? 'alert' : undefined} />
        <Stat label="طُبع آخر ساعة" value={stats.printed_last_hour ?? 0} />
      </div>

      {stats.oldest_pending && (
        <div className="alert-box warn" style={{ marginTop: 12 }}>
          ⚠️ أقدم أمر طباعة معلّق منذ {since(stats.oldest_pending)} — تحقق من
          اتصال وكيل الطباعة والطابعات.
        </div>
      )}

      <div className="card" style={{ marginTop: 12 }}>
        <h3 className="card-title">
          🖨️ الطابعات
          {can('printers.manage') && (
            <NewAgentButton className="spacer" onCreated={setShowAgentToken} />
          )}
        </h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>الاسم</th><th>القسم</th><th>العنوان</th><th>المنفذ</th>
                <th>الحالة</th><th>آخر ظهور</th>
              </tr>
            </thead>
            <tbody>
              {health.printers.map((p: any) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{p.department}</td>
                  <td className="num">{p.ip}</td>
                  <td className="num">{p.port}</td>
                  <td>
                    <span className={`badge ${p.status === 'online' ? 'green'
                      : p.status === 'error' || p.status === 'offline' ? 'red' : ''}`}>
                      {p.status === 'online' ? 'متصلة'
                        : p.status === 'offline' ? 'غير متصلة'
                        : p.status === 'error' ? 'خطأ' : 'غير معروف'}
                    </span>
                    {p.status_message && (
                      <div className="small faint">{p.status_message}</div>
                    )}
                  </td>
                  <td className="small faint">{since(p.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">وكلاء الطباعة المحليون</h3>
        <p className="small muted">
          الوكيل يعمل داخل شبكة الفرع ويسحب أوامر الطباعة من السحابة ثم يرسلها
          للطابعات — الآيباد لا يتصل بالطابعة مباشرة.
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>الاسم</th><th>الحالة</th><th>الإصدار</th><th>آخر اتصال</th></tr>
            </thead>
            <tbody>
              {health.agents.map((a: any) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>
                    <span className={`badge ${a.online ? 'green' : 'red'}`}>
                      {a.online ? 'يعمل' : 'غير متصل'}
                    </span>
                  </td>
                  <td className="num small">{a.agent_version ?? '—'}</td>
                  <td className="small faint">{since(a.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {health.agents.length === 0 && <Empty icon="🔌" text="لم يُسجَّل أي وكيل طباعة" />}
      </div>

      <div className="card">
        <h3 className="card-title">أوامر الطباعة الأخيرة</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>النوع</th><th>الطلب</th><th>الطابعة</th><th>الحالة</th>
                <th>المحاولات</th><th>الخطأ</th><th>الوقت</th><th></th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>
                    <span className={`badge ${j.kind === 'void' ? 'red'
                      : j.is_reprint ? 'purple' : j.kind === 'add_item' ? 'blue' : ''}`}>
                      {j.kind === 'new_order' ? 'طلب'
                        : j.kind === 'add_item' ? 'ADD ITEM'
                        : j.kind === 'void' ? 'VOID'
                        : j.kind === 'reprint' ? 'REPRINT'
                        : j.kind === 'charcoal_request' ? 'فحم' : j.kind}
                    </span>
                  </td>
                  <td className="num small">{j.order_number ?? '—'}</td>
                  <td className="small">{j.printer_name}</td>
                  <td>
                    <span className={`badge ${j.status === 'printed' ? 'green'
                      : j.status === 'failed' ? 'red' : 'amber'}`}>
                      {j.status}
                    </span>
                  </td>
                  <td className="num">{j.attempt_count}</td>
                  <td className="small faint">{j.last_error ?? '—'}</td>
                  <td className="small faint">{dateTime(j.created_at)}</td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      {j.status === 'failed' && can('print_jobs.retry') && (
                        <button
                          className="btn sm"
                          onClick={async () => {
                            await api(`/print-jobs/${j.id}/retry`, { method: 'POST' });
                            push('أُعيد الأمر للطابور', 'ok');
                            void load();
                          }}
                        >
                          إعادة المحاولة
                        </button>
                      )}
                      {can('orders.reprint') && (
                        <button className="btn ghost sm" onClick={() => setReprinting(j)}>
                          إعادة طباعة
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

      {reprinting && (
        <ConfirmReason
          title="إعادة طباعة"
          message="ستُطبع النسخة مختومة بكلمة REPRINT، وسيُسجَّل اسمك والسبب والوقت."
          confirmLabel="إعادة الطباعة"
          onCancel={() => setReprinting(null)}
          onConfirm={async (reason) => {
            try {
              await api(`/print-jobs/${reprinting.id}/reprint`, {
                method: 'POST', body: { reason },
              });
              push('تم إرسال أمر إعادة الطباعة', 'ok');
              setReprinting(null);
              void load();
            } catch (err) { push((err as Error).message, 'error'); }
          }}
        />
      )}

      {showAgentToken && (
        <Modal title="رمز وكيل الطباعة" onClose={() => setShowAgentToken(null)}>
          <div className="alert-box warn">
            احفظ هذا الرمز الآن — لن يظهر مرة أخرى. ضعه في ملف إعدادات الوكيل
            على جهاز الفرع.
          </div>
          <code className="card num" style={{ display: 'block', wordBreak: 'break-all' }}>
            {showAgentToken}
          </code>
        </Modal>
      )}
    </>
  );
}

function NewAgentButton({
  className, onCreated,
}: { className?: string; onCreated: (token: string) => void }) {
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={`btn sm ${className ?? ''}`} disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await api<{ token: string }>('/print-agents', {
            method: 'POST', body: { name: `Agent ${new Date().toISOString().slice(0, 10)}` },
          });
          onCreated(res.token);
        } catch (err) { push((err as Error).message, 'error'); }
        finally { setBusy(false); }
      }}
    >
      + وكيل طباعة جديد
    </button>
  );
}
