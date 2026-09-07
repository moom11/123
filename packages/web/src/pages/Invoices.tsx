import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { Empty, Modal, Spinner, Stat, useToast } from '../components/ui.js';
import { dateTime, money } from '../lib/format.js';

/**
 * E-invoicing (فاتورة).
 *
 * Two things matter on this screen and nothing else does: whether every sale
 * has been reported to ZATCA, and whether the chain has a hole in it. Both are
 * silent failures — the restaurant keeps trading normally while a compliance
 * problem accumulates — so they are shown before anything else.
 */

const STATUS_LABEL: Record<string, string> = {
  pending: 'بانتظار الإبلاغ',
  reported: 'مُبلَّغ',
  warning: 'مُبلَّغ بملاحظات',
  failed: 'فشل الإبلاغ',
};

/** Only the states that need attention carry a tone; 'reported' is the norm. */
const STATUS_TONE: Record<string, string> = {
  reported: 'ok',
  warning: 'warn',
  failed: 'alert',
};

export function Invoices() {
  const { can } = useSession();
  const { push } = useToast();
  const [invoices, setInvoices] = useState<any[]>([]);
  const [chain, setChain] = useState<{ checked: number; breaks: any[] } | null>(null);
  const [credentials, setCredentials] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('');
  const [detail, setDetail] = useState<any | null>(null);
  const [reporting, setReporting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, verify, creds] = await Promise.all([
        api<{ invoices: any[] }>(`/invoices?limit=100${filter ? `&status=${filter}` : ''}`),
        api<{ checked: number; breaks: any[] }>('/invoices/chain/verify'),
        can('invoices.manage_credentials')
          ? api<{ credentials: any }>('/invoices/credentials')
          : Promise.resolve({ credentials: null }),
      ]);
      setInvoices(list.invoices);
      setChain(verify);
      setCredentials(creds.credentials);
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setLoading(false); }
  }, [can, filter, push]);

  useEffect(() => { void load(); }, [load]);

  const flush = async () => {
    setReporting(true);
    try {
      const result = await api<{ attempted: number; reported: number; failed: number }>(
        '/invoices/report', { method: 'POST', body: { limit: 100 } },
      );
      push(
        result.failed > 0
          ? `أُبلغت ${result.reported} وفشلت ${result.failed}`
          : `أُبلغت ${result.reported} فاتورة`,
        result.failed > 0 ? 'error' : 'ok',
      );
      await load();
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setReporting(false); }
  };

  if (loading) return <Spinner label="جارٍ تحميل الفواتير…" />;

  const pending = invoices.filter((i) => i.report_status === 'pending').length;
  const failed = invoices.filter((i) => i.report_status === 'failed').length;
  const reported = invoices.filter((i) => i.report_status === 'reported').length;

  // Anything issued more than 24 hours ago and still unreported is past the
  // deadline, not merely queued.
  const overdue = invoices.filter(
    (i) => ['pending', 'failed'].includes(i.report_status)
      && Date.now() - new Date(i.issued_at).getTime() > 24 * 3600 * 1000,
  ).length;

  return (
    <>
      <div className="grid cols-4">
        <Stat label="مُبلَّغة" value={reported} />
        <Stat label="بانتظار الإبلاغ" value={pending} tone={pending > 0 ? 'warn' : undefined} />
        <Stat label="فشل الإبلاغ" value={failed} tone={failed > 0 ? 'alert' : undefined} />
        <Stat label="تجاوزت 24 ساعة" value={overdue} tone={overdue > 0 ? 'alert' : undefined} />
      </div>

      {chain && chain.breaks.length > 0 && (
        <div className="card alert" style={{ marginTop: 16 }}>
          <h3>انقطاع في سلسلة الفواتير</h3>
          <p>
            {chain.breaks.length} فاتورة لا تتسلسل مع سابقتها. هذا لا يُصلَح بإعادة الإصدار —
            اعرف السبب أولاً (استرجاع نسخة احتياطية قديمة هو السبب الأشيع).
          </p>
          <ul>
            {chain.breaks.slice(0, 10).map((b: any) => (
              <li key={b.icv}>#{b.icv} — {b.problem}</li>
            ))}
          </ul>
        </div>
      )}

      {credentials && !credentials.is_production && (
        <div className="card warn" style={{ marginTop: 16 }}>
          <h3>بيانات اعتماد تجريبية</h3>
          <p>
            هذا الفرع يعمل على بيئة <strong>{credentials.environment}</strong>
            {credentials.has_certificate ? '' : ' وبلا شهادة CSID'} —
            الفواتير تُختم وتُطبع، لكنها لا تُقبل لدى الهيئة. أكمل التسجيل في «فاتورة»
            واحفظ الشهادة الإنتاجية قبل الافتتاح.
          </p>
        </div>
      )}

      <div className="toolbar" style={{ marginTop: 16 }}>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">كل الحالات</option>
          <option value="pending">بانتظار الإبلاغ</option>
          <option value="reported">مُبلَّغ</option>
          <option value="warning">بملاحظات</option>
          <option value="failed">فشل</option>
        </select>
        {can('invoices.report') && (
          <button className="btn" onClick={flush} disabled={reporting || pending + failed === 0}>
            {reporting ? 'جارٍ الإبلاغ…' : `أبلغ الهيئة الآن (${pending + failed})`}
          </button>
        )}
      </div>

      {invoices.length === 0 ? (
        <Empty icon="🧾" text="لا فواتير بعد" />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>العدّاد</th>
              <th>الرقم</th>
              <th>النوع</th>
              <th>الإجمالي</th>
              <th>الضريبة</th>
              <th>الإصدار</th>
              <th>الإبلاغ</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id} onClick={() => void openDetail(inv.id)} className="clickable">
                <td className="num">{inv.icv}</td>
                <td>{inv.invoice_number}</td>
                <td>{inv.document_type === 'credit_note' ? 'إشعار دائن' : 'فاتورة'}</td>
                <td className="num">{money(Number(inv.grand_total))}</td>
                <td className="num">{money(Number(inv.vat_amount))}</td>
                <td>{dateTime(inv.issued_at)}</td>
                <td>
                  <span className={`pill ${STATUS_TONE[inv.report_status] ?? ''}`}>
                    {STATUS_LABEL[inv.report_status] ?? inv.report_status}
                  </span>
                  {inv.last_error && (
                    <div className="muted small">{String(inv.last_error).slice(0, 80)}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detail && (
        <Modal title={`فاتورة ${detail.invoice_number}`} onClose={() => setDetail(null)}>
          <dl className="pairs">
            <dt>المعرّف (UUID)</dt><dd className="mono">{detail.invoice_uuid}</dd>
            <dt>العدّاد (ICV)</dt><dd className="mono">{detail.icv}</dd>
            <dt>بصمة الفاتورة</dt><dd className="mono break">{detail.invoice_hash}</dd>
            <dt>بصمة السابقة (PIH)</dt><dd className="mono break">{detail.pih}</dd>
            <dt>الإجمالي</dt><dd>{money(Number(detail.grand_total))}</dd>
            <dt>الضريبة</dt><dd>{money(Number(detail.vat_amount))} ({detail.vat_percent}%)</dd>
          </dl>
          <h4>رمز QR كما يقرؤه المفتّش</h4>
          <pre className="break small">{detail.qr_tlv}</pre>
          <h4>المستند (UBL 2.1)</h4>
          <pre className="break small" style={{ maxHeight: 300, overflow: 'auto' }}>{detail.xml}</pre>
        </Modal>
      )}
    </>
  );

  async function openDetail(id: string) {
    try {
      const res = await api<{ invoice: any }>(`/invoices/${id}`);
      setDetail(res.invoice);
    } catch (err) { push((err as Error).message, 'error'); }
  }
}
