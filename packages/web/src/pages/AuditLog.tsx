import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Empty, Modal, Spinner, useToast } from '../components/ui.js';
import { dateTime } from '../lib/format.js';

const ACTION_GROUPS: Array<[string, string]> = [
  ['', 'كل العمليات'],
  ['auth.', 'الدخول والجلسات'],
  ['order.', 'الطلبات'],
  ['wallet.', 'المحفظة والنقاط'],
  ['otp.', 'رموز التحقق'],
  ['print.', 'الطباعة'],
  ['inventory.', 'المخزون والهدر'],
  ['purchase', 'المشتريات'],
  ['admin.', 'إدارة المستخدمين'],
  ['menu.', 'المنيو والأسعار'],
];

/**
 * The audit trail, read-only by construction — the API exposes no way to write
 * or erase it, so this screen is purely a window onto what happened.
 */
export function AuditLog() {
  const { push } = useToast();
  const [entries, setEntries] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [prefix, setPrefix] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<any | null>(null);
  const limit = 50;

  useEffect(() => {
    setLoading(true);
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (prefix) query.set('actionPrefix', prefix);
    api<any>(`/audit?${query}`)
      .then((r) => { setEntries(r.entries); setTotal(r.total); })
      .catch((err) => push((err as Error).message, 'error'))
      .finally(() => setLoading(false));
  }, [prefix, offset, push]);

  return (
    <>
      <div className="card">
        <h3 className="card-title">
          🔎 سجل العمليات
          <span className="badge spacer">{total.toLocaleString('en-US')} عملية</span>
        </h3>
        <p className="small muted">
          سجل غير قابل للتعديل أو الحذف — كل عملية حساسة تُكتب هنا مرة واحدة مع
          المنفّذ والقيمة قبل وبعد ووقت التنفيذ.
        </p>
        <div className="category-bar" style={{ marginTop: 10 }}>
          {ACTION_GROUPS.map(([value, label]) => (
            <button
              key={value} className={`chip${prefix === value ? ' active' : ''}`}
              onClick={() => { setPrefix(value); setOffset(0); }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {loading ? <Spinner /> : (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>الوقت</th><th>العملية</th><th>المنفّذ</th>
                  <th>الكيان</th><th>IP</th><th></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="small faint">{dateTime(e.occurred_at)}</td>
                    <td className="small num">{e.action}</td>
                    <td>
                      {e.employee_name ?? e.user_name ?? e.actor_label ?? '—'}
                      {e.employee_code && (
                        <span className="small faint num"> ({e.employee_code})</span>
                      )}
                    </td>
                    <td className="small muted">{e.entity_type ?? '—'}</td>
                    <td className="small faint num">{e.ip ?? '—'}</td>
                    <td>
                      {(e.old_value || e.new_value) && (
                        <button className="btn ghost sm" onClick={() => setDetail(e)}>
                          تفاصيل
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {entries.length === 0 && <Empty icon="🔎" text="لا توجد عمليات" />}

          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="btn sm" disabled={offset === 0}
              onClick={() => setOffset((o) => Math.max(0, o - limit))}
            >
              السابق
            </button>
            <span className="spacer small muted">
              {offset + 1} – {Math.min(offset + limit, total)} من {total}
            </span>
            <button
              className="btn sm" disabled={offset + limit >= total}
              onClick={() => setOffset((o) => o + limit)}
            >
              التالي
            </button>
          </div>
        </div>
      )}

      {detail && (
        <Modal title={detail.action} onClose={() => setDetail(null)}>
          <div className="stack">
            <div className="row small">
              <span className="muted">الوقت</span>
              <span className="spacer">{dateTime(detail.occurred_at)}</span>
            </div>
            <div className="row small">
              <span className="muted">المنفّذ</span>
              <span className="spacer">
                {detail.employee_name ?? detail.user_name ?? detail.actor_label}
              </span>
            </div>
            {detail.old_value && (
              <div>
                <div className="label">القيمة قبل</div>
                <pre className="card num small" style={{ overflowX: 'auto', direction: 'ltr' }}>
                  {JSON.stringify(detail.old_value, null, 2)}
                </pre>
              </div>
            )}
            {detail.new_value && (
              <div>
                <div className="label">القيمة بعد</div>
                <pre className="card num small" style={{ overflowX: 'auto', direction: 'ltr' }}>
                  {JSON.stringify(detail.new_value, null, 2)}
                </pre>
              </div>
            )}
            {detail.metadata && Object.keys(detail.metadata).length > 0 && (
              <div>
                <div className="label">بيانات إضافية</div>
                <pre className="card num small" style={{ overflowX: 'auto', direction: 'ltr' }}>
                  {JSON.stringify(detail.metadata, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
