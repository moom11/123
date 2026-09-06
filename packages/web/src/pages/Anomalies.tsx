import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { useRealtimeEvent } from '../lib/realtime.js';
import { ConfirmReason, Empty, Modal, Spinner, Stat, useToast } from '../components/ui.js';
import { dateTime, money, since } from '../lib/format.js';

/**
 * Findings: patterns worth a question, with the rows behind them.
 *
 * Written to be answered, not admired. Every card carries the evidence that
 * produced it, because a manager who cannot see what was counted has only two
 * options — believe the machine or ignore it — and the second one wins.
 *
 * There is no "delete". A finding is acknowledged (I am dealing with it) or
 * dismissed with a reason (I looked, here is the explanation), and either way
 * the answer keeps the name of whoever gave it.
 */

const STATUS_LABEL: Record<string, string> = {
  open: 'لم تُراجع',
  acknowledged: 'قيد المتابعة',
  dismissed: 'مستبعدة',
};

interface Anomaly {
  id: string; code: string; severity: 'warning' | 'critical';
  subject_type: string; subject_id: string | null; subject_label: string;
  period_key: string; title_ar: string; detail_ar: string;
  metric: string; threshold: string; evidence: Record<string, unknown>;
  status: string; detections: number;
  first_detected_at: string; last_detected_at: string;
  reviewed_at: string | null; review_note: string | null; reviewed_by: string | null;
}

export function Anomalies() {
  const { can } = useSession();
  const { push } = useToast();
  const [items, setItems] = useState<Anomaly[]>([]);
  const [detectors, setDetectors] = useState<Array<{ code: string; label: string }>>([]);
  const [status, setStatus] = useState<string>('open');
  const [code, setCode] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<Anomaly | null>(null);
  const [detail, setDetail] = useState<Anomaly | null>(null);

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams();
      if (status) query.set('status', status);
      if (code) query.set('code', code);
      const [list, defs] = await Promise.all([
        api<{ anomalies: Anomaly[] }>(`/anomalies?${query}`),
        detectors.length
          ? Promise.resolve({ detectors })
          : api<{ detectors: Array<{ code: string; label: string }> }>('/anomalies/detectors'),
      ]);
      setItems(list.anomalies);
      setDetectors(defs.detectors);
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setLoading(false); }
  }, [status, code, detectors, push]);

  useEffect(() => { void load(); }, [status, code]);   // eslint-disable-line react-hooks/exhaustive-deps

  // A finding raised while the screen is open belongs on the screen.
  useRealtimeEvent(['notification'], (e) => {
    if (String(e.payload?.kind ?? '').startsWith('anomaly_')) void load();
  });

  if (loading) return <Spinner label="جارٍ تحميل الملاحظات…" />;

  const open = items.filter((a) => a.status === 'open');
  const critical = open.filter((a) => a.severity === 'critical');

  return (
    <>
      <div className="grid cols-4">
        <Stat label="لم تُراجع" value={open.length}
              tone={open.length > 0 ? 'warn' : undefined} />
        <Stat label="حرجة" value={critical.length}
              tone={critical.length > 0 ? 'alert' : undefined} />
        <Stat label="المعروضة" value={items.length} />
        <Stat label="أنواع الفحص" value={detectors.length} />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="row wrap">
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">لم تُراجع</option>
            <option value="acknowledged">قيد المتابعة</option>
            <option value="dismissed">مستبعدة</option>
            <option value="">الكل</option>
          </select>
          <select className="input" value={code} onChange={(e) => setCode(e.target.value)}>
            <option value="">كل أنواع الفحص</option>
            {detectors.map((d) => (
              <option key={d.code} value={d.code}>{d.label}</option>
            ))}
          </select>
          {can('anomalies.review') && (
            <button className="btn ghost" disabled={busy === 'sweep'}
                    onClick={() => void sweep()}>
              افحص الآن
            </button>
          )}
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          الفحص يعمل تلقائياً كل ساعة. هذه ليست اتهامات — كل ملاحظة سؤال ومعه ما يُجيب عنه.
        </p>
      </div>

      {items.length === 0 ? (
        <Empty icon="✅" text={status === 'open' ? 'لا ملاحظات بانتظار المراجعة' : 'لا شيء هنا'} />
      ) : (
        <div className="cards" style={{ marginTop: 16 }}>
          {items.map((a) => (
            <div key={a.id}
                 className={`card anomaly${a.severity === 'critical' ? ' alert' : ''}`}>
              <div className="anomaly__head">
                <span className={`pill ${a.severity === 'critical' ? 'alert' : 'warn'}`}>
                  {a.severity === 'critical' ? 'حرجة' : 'للمراجعة'}
                </span>
                <strong>{a.title_ar}</strong>
                <span className="muted small">{since(a.last_detected_at)}</span>
              </div>

              <p>{a.detail_ar}</p>

              <div className="anomaly__meta muted small">
                <span>{labelOf(detectors, a.code)}</span>
                <span>الحد: {Number(a.threshold).toLocaleString('ar-SA')}</span>
                <span>القيمة: {Number(a.metric).toLocaleString('ar-SA')}</span>
                {/* A finding still being re-detected after it was answered is
                    the single most useful number here. */}
                {a.detections > 1 && <span>تكرر الرصد {a.detections} مرة</span>}
                <span className="pill">{STATUS_LABEL[a.status] ?? a.status}</span>
              </div>

              {a.review_note && (
                <div className="note small">
                  {a.reviewed_by ?? 'مراجع'}: {a.review_note}
                </div>
              )}

              <div className="anomaly__actions">
                <button className="btn small ghost" onClick={() => setDetail(a)}>
                  الأدلة
                </button>
                {can('anomalies.review') && a.status === 'open' && (
                  <button className="btn small" disabled={busy === a.id}
                          onClick={() => void acknowledge(a)}>
                    أتابعها
                  </button>
                )}
                {can('anomalies.review') && a.status !== 'dismissed' && (
                  <button className="btn small ghost" onClick={() => setDismissing(a)}>
                    استبعدها
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {detail && (
        <Modal title={detail.title_ar} onClose={() => setDetail(null)} wide>
          <dl className="pairs">
            <dt>الفحص</dt><dd>{labelOf(detectors, detail.code)}</dd>
            <dt>الموضوع</dt><dd>{detail.subject_label}</dd>
            <dt>الفترة</dt><dd className="mono">{detail.period_key}</dd>
            <dt>أول رصد</dt><dd>{since(detail.first_detected_at)}</dd>
            <dt>آخر رصد</dt><dd>{since(detail.last_detected_at)}</dd>
          </dl>
          <h4>الأدلة</h4>
          <Evidence evidence={detail.evidence} />
        </Modal>
      )}

      {dismissing && (
        <ConfirmReason
          title={`استبعاد: ${dismissing.title_ar}`}
          message="السبب يُحفظ باسمك ولا يُحذف. اكتب ما يفسّر الملاحظة، لا ما يُغلقها."
          confirmLabel="استبعدها"
          requireReason
          onCancel={() => setDismissing(null)}
          onConfirm={async (reason) => {
            await review(dismissing, 'dismissed', reason);
            setDismissing(null);
          }}
        />
      )}
    </>
  );

  async function sweep() {
    setBusy('sweep');
    try {
      const res = await api<{ findings: number; opened: number }>(
        '/anomalies/sweep', { method: 'POST' },
      );
      push(res.opened > 0
        ? `${res.opened} ملاحظة جديدة`
        : 'الفحص تم — لا جديد', res.opened > 0 ? 'warn' : 'ok');
      await load();
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setBusy(null); }
  }

  async function acknowledge(a: Anomaly) {
    await review(a, 'acknowledged', '');
  }

  async function review(a: Anomaly, next: 'acknowledged' | 'dismissed', note: string) {
    setBusy(a.id);
    try {
      await api(`/anomalies/${a.id}/review`, {
        method: 'POST', body: { status: next, note: note || undefined },
      });
      push(next === 'dismissed' ? 'استُبعدت الملاحظة' : 'سُجّلت للمتابعة', 'ok');
      await load();
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setBusy(null); }
  }
}

function labelOf(detectors: Array<{ code: string; label: string }>, code: string): string {
  return detectors.find((d) => d.code === code)?.label ?? code;
}

/**
 * The rows behind a finding.
 *
 * Deliberately generic: each detector attaches whatever made its case, and a
 * screen that only rendered the fields it knew about would quietly hide the
 * evidence of any detector added later.
 */
function Evidence({ evidence }: { evidence: Record<string, unknown> }) {
  const entries = Object.entries(evidence ?? {});
  if (entries.length === 0) return <p className="muted">لا تفاصيل إضافية.</p>;

  return (
    <>
      {entries.map(([key, value]) => (
        Array.isArray(value) ? (
          <div key={key} style={{ marginBottom: 12 }}>
            <div className="muted small">{FIELD[key] ?? key}</div>
            {/* Evidence is as wide as the detector that produced it. It scrolls
                inside its own box rather than clipping the last column, which
                is often the one carrying the reason someone typed. */}
            <div style={{ overflowX: 'auto' }}>
            <table className="data evidence">
              <tbody>
                {value.slice(0, 50).map((row: any, i: number) => (
                  <tr key={i}>
                    {Object.entries(row ?? {}).map(([k, v]) => (
                      <td key={k}>{cell(k, v)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        ) : (
          <div key={key} className="row">
            <span className="muted small">{FIELD[key] ?? key}</span>
            <span>{cell(key, value)}</span>
          </div>
        )
      ))}
    </>
  );
}

const FIELD: Record<string, string> = {
  day: 'اليوم', week: 'الأسبوع', value: 'القيمة', items: 'الأصناف',
  orders: 'الطلبات', times: 'الأوقات', amount: 'المبلغ', order: 'الطلب',
  item: 'الصنف', reason: 'السبب', at: 'الوقت', actor: 'المنفّذ',
  baseline: 'المعتاد', department: 'القسم', sampleDays: 'أيام المقارنة',
  voided: 'الملغاة', total: 'الإجمالي', branchRatePercent: 'متوسط الفرع %',
  customerName: 'العميل', paymentNumber: 'رقم الدفعة', method: 'الطريقة',
  countNumber: 'رقم الجرد', location: 'الموقع', variancePercent: 'نسبة الفرق',
  varianceValue: 'قيمة الفرق', paidAt: 'وقت الإقفال', voidedAt: 'وقت الإلغاء',
  approvedAt: 'وقت الاعتماد',
};

/** Money is stored in halalas everywhere, so the amount fields are formatted as money. */
function cell(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (['amount', 'value', 'baseline', 'varianceValue'].includes(key)) {
    return money(Number(value));
  }
  // The same calendar the rest of the app shows. Two calendars in one dialog
  // is a worse problem than either one.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return dateTime(value);
  return String(value);
}
