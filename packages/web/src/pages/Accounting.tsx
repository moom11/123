import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, download } from '../lib/api.js';
import { Empty, Spinner, Stat, useToast } from '../components/ui.js';
import { money } from '../lib/format.js';

/**
 * The month, in the shape a ledger wants it.
 *
 * Everything on this screen is read-only, and deliberately so: the export
 * never marks a period as taken, so it can be pulled again — and again next
 * year when someone asks. A period you can only export once is a period that
 * gets lost the first time an email fails to send.
 */

const METHOD_LABEL: Record<string, string> = {
  cash: 'نقداً',
  mada: 'مدى',
  visa: 'فيزا',
  mastercard: 'ماستركارد',
  apple_pay: 'أبل باي',
  wallet_points: 'نقاط',
};

interface Summary {
  branch: { name: string; vatNumber: string | null };
  sales: { gross: number; discounts: number; vat: number; billed: number;
           net: number; count: number; creditNotes: number };
  payments: { byMethod: Record<string, number>; collected: number; refunded: number };
  unreconciled: number;
  purchases: { net: number; vat: number; total: number; count: number };
  waste: { cost: number };
  vat: { output: number; input: number; net: number };
  journal: { lines: number; debit: number; credit: number; imbalance: number };
}

interface JournalLine {
  date: string; account: string; accountName: string;
  description: string; debit: number; credit: number; reference: string;
}

/** Last calendar month: what someone opening this screen almost always wants. */
function lastMonth(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: iso(first), to: iso(last) };
}

export function Accounting() {
  const { push } = useToast();
  const initial = useMemo(lastMonth, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [lines, setLines] = useState<JournalLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = `from=${from}&to=${to}`;
      const [s, j] = await Promise.all([
        api<Summary>(`/accounting/summary?${query}`),
        api<{ lines: JournalLine[] }>(`/accounting/journal?${query}`),
      ]);
      setSummary(s);
      setLines(j.lines);
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setLoading(false); }
  }, [from, to, push]);

  useEffect(() => { void load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="card">
        <div className="row wrap">
          <div className="field">
            <label className="label">من</label>
            <input className="input ltr" type="date" value={from}
                   onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label className="label">إلى</label>
            <input className="input ltr" type="date" value={to}
                   onChange={(e) => setTo(e.target.value)} />
          </div>
          <button className="btn primary" onClick={() => void load()}>اعرض الفترة</button>
        </div>
        <div className="row wrap" style={{ marginTop: 10 }}>
          <button className="btn ghost" disabled={busy !== null}
                  onClick={() => void save('journal', 'القيود')}>
            قيود اليومية (CSV)
          </button>
          <button className="btn ghost" disabled={busy !== null}
                  onClick={() => void save('invoices', 'الفواتير')}>
            سجل الفواتير (CSV)
          </button>
          <button className="btn ghost" disabled={busy !== null}
                  onClick={() => void save('purchases', 'المشتريات')}>
            المشتريات (CSV)
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          الملفات بترميز UTF-8 مع علامة ترتيب البايت، فتفتح في إكسل بالعربية دون عبث.
          كل تصدير مسجّل في سجل العمليات باسم من سحبه.
        </p>
      </div>

      {loading ? <Spinner label="جارٍ حساب الفترة…" /> : !summary ? (
        <Empty icon="📚" text="اختر فترة" />
      ) : (
        <>
          <div className="grid cols-4" style={{ marginTop: 16 }}>
            <Stat label="المبيعات بعد الخصم" value={money(summary.sales.billed)} />
            <Stat label="الوعاء الضريبي" value={money(summary.sales.net)} />
            <Stat label="ضريبة المخرجات" value={money(summary.vat.output)} />
            <Stat label="صافي الضريبة المستحقة" value={money(summary.vat.net)}
                  tone={summary.vat.net > 0 ? 'warn' : undefined} />
          </div>

          {/* The two numbers that decide whether anything else here is
              believable. Both must be zero. */}
          <div className="grid cols-2" style={{ marginTop: 12 }}>
            <Stat label="فرق بين الفواتير والمقبوضات" value={money(summary.unreconciled)}
                  tone={summary.unreconciled !== 0 ? 'alert' : undefined} />
            <Stat label="اتزان القيود" value={money(summary.journal.imbalance)}
                  tone={summary.journal.imbalance !== 0 ? 'alert' : undefined} />
          </div>

          {summary.unreconciled !== 0 && (
            <div className="card alert" style={{ marginTop: 12 }}>
              <h3>الفواتير والمقبوضات لا تتطابق</h3>
              <p>
                الفرق {money(summary.unreconciled)} مُقيَّد في حساب فروق مؤقت باسم
                {' '}<span className="mono">{'9999'}</span> بدل إخفائه في الصندوق.
                الأسباب المعتادة: فاتورة أُقفلت ولم تُحصَّل، أو دفعة سُجّلت في يوم
                والفاتورة في يوم آخر. عالجه قبل تسليم الفترة للمحاسب.
              </p>
            </div>
          )}

          <div className="grid cols-2" style={{ marginTop: 16 }}>
            <div className="card">
              <h3>المتحصلات</h3>
              <table className="data">
                <tbody>
                  {Object.entries(summary.payments.byMethod).map(([method, value]) => (
                    <tr key={method}>
                      <td>{METHOD_LABEL[method] ?? method}</td>
                      <td className="num">{money(value)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td><strong>الإجمالي</strong></td>
                    <td className="num"><strong>{money(summary.payments.collected)}</strong></td>
                  </tr>
                  {summary.payments.refunded > 0 && (
                    <tr>
                      <td className="muted">منها مبالغ مُعادة</td>
                      <td className="num muted">{money(summary.payments.refunded)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="card">
              <h3>الفترة</h3>
              <dl className="pairs">
                <dt>الفواتير</dt><dd>{summary.sales.count}</dd>
                <dt>منها إشعارات دائنة</dt><dd>{summary.sales.creditNotes}</dd>
                <dt>المبيعات قبل الخصم</dt><dd>{money(summary.sales.gross)}</dd>
                <dt>الخصومات</dt><dd>{money(summary.sales.discounts)}</dd>
                <dt>المشتريات ({summary.purchases.count})</dt>
                <dd>{money(summary.purchases.total)}</dd>
                <dt>ضريبة المدخلات</dt><dd>{money(summary.vat.input)}</dd>
                <dt>الهدر</dt><dd>{money(summary.waste.cost)}</dd>
                <dt>الرقم الضريبي</dt>
                <dd className="mono">{summary.branch.vatNumber ?? '—'}</dd>
              </dl>
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h3>القيود ({summary.journal.lines})</h3>
            {lines.length === 0 ? (
              <Empty icon="🧾" text="لا حركة في هذه الفترة" />
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th>التاريخ</th><th>الحساب</th><th>البيان</th>
                      <th>مدين</th><th>دائن</th><th>المرجع</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* A preview, not the file: a busy month is thousands of
                        lines and the browser is not where they get read. */}
                    {lines.slice(0, 200).map((l, i) => (
                      <tr key={i}>
                        <td className="mono">{l.date}</td>
                        <td className="mono">{l.account} — {l.accountName}</td>
                        <td>{l.description}</td>
                        <td className="num">{l.debit ? money(l.debit) : ''}</td>
                        <td className="num">{l.credit ? money(l.credit) : ''}</td>
                        <td className="mono">{l.reference}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {lines.length > 200 && (
                  <p className="muted small">
                    تُعرض أول 200 قيد — الملف يحتوي {lines.length}.
                  </p>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );

  async function save(kind: string, label: string) {
    setBusy(kind);
    try {
      await download(`/accounting/${kind}.csv?from=${from}&to=${to}`,
        `mara-${kind}-${from}_${to}.csv`);
      push(`نُزّل ملف ${label}`, 'ok');
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setBusy(null); }
  }
}
