import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useRealtimeEvent } from '../lib/realtime.js';
import { Empty, Modal, Spinner, useToast, ConfirmReason } from '../components/ui.js';
import { riyal, since } from '../lib/format.js';

/**
 * The waiter's inbox for orders placed by guests from their own phones.
 *
 * Nothing here has reached a printer yet — that is the point. The waiter
 * reviews, then confirms (which sends it to the departments) or rejects with a
 * reason.
 */
export function Approvals({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const { push } = useToast();
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<any | null>(null);
  const [rejecting, setRejecting] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<{ orders: any[] }>('/orders/pending-approval');
      setOrders(res.orders);
      onCountChange?.(res.orders.length);
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [push, onCountChange]);

  useEffect(() => { void load(); }, [load]);
  useRealtimeEvent(['order.pending_approval', 'order.updated'], () => { void load(); });

  const open = async (order: any) => {
    try {
      const res = await api<{ order: any }>(`/orders/${order.id}`);
      setDetail(res.order);
    } catch (err) { push((err as Error).message, 'error'); }
  };

  const approve = async (orderId: string) => {
    setBusy(true);
    try {
      const res = await api<any>(`/orders/${orderId}/review`, {
        method: 'POST', body: { decision: 'approve' },
      });
      push(`تم التأكيد وإرسال ${res.printJobs?.length ?? 0} تذكرة للأقسام`, 'ok');
      setDetail(null);
      await load();
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  if (loading) return <Spinner label="جارٍ التحميل…" />;

  return (
    <>
      <div className="card">
        <h3 className="card-title">
          🔔 طلبات بانتظار تأكيد الويتر
          <span className="badge purple spacer">{orders.length}</span>
        </h3>
        <p className="small muted">
          هذه الطلبات وصلت من جوال العميل ولم تُرسل لأي طابعة بعد. لن يصل الطلب
          للمطبخ أو البار أو المعسل إلا بعد تأكيدك.
        </p>
      </div>

      {orders.length === 0 && <Empty icon="✅" text="لا توجد طلبات بانتظار المراجعة" />}

      <div className="grid auto" style={{ marginTop: 12 }}>
        {orders.map((o) => (
          <div key={o.id} className="card">
            <div className="row">
              <strong style={{ fontSize: 22 }}>طاولة {o.table_number ?? '—'}</strong>
              <span className="spacer" />
              <span className="badge amber">{since(o.created_at)}</span>
            </div>
            <div className="small muted" style={{ marginTop: 4 }}>
              {o.order_number} · {o.item_count} صنف
              {o.customer_name ? ` · ${o.customer_name}` : ''}
            </div>
            <div className="num" style={{ fontSize: 20, fontWeight: 800, margin: '10px 0' }}>
              {riyal(o.grand_total)}
            </div>
            {o.notes && <div className="small" style={{ color: 'var(--amber)' }}>📝 {o.notes}</div>}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" onClick={() => void open(o)}>مراجعة</button>
              <button
                className="btn success spacer" disabled={busy}
                onClick={() => void approve(o.id)}
              >
                تأكيد وإرسال
              </button>
            </div>
          </div>
        ))}
      </div>

      {detail && (
        <Modal
          title={`${detail.order_number} — طاولة ${detail.table_number ?? '—'}`}
          onClose={() => setDetail(null)}
          footer={
            <>
              <button
                className="btn success" disabled={busy}
                onClick={() => void approve(detail.id)}
              >
                تأكيد وإرسال للأقسام
              </button>
              <button
                className="btn danger" disabled={busy}
                onClick={() => { setRejecting(detail); setDetail(null); }}
              >
                رفض
              </button>
            </>
          }
        >
          <div className="stack">
            {detail.items.map((i: any) => (
              <div key={i.id} className="card" style={{ background: 'var(--surface-2)' }}>
                <div className="row">
                  <strong>{i.quantity}× {i.product_name_ar}</strong>
                  <span className="spacer num">{riyal(i.line_total)}</span>
                </div>
                <div className="small faint">القسم: {i.production_department}</div>
                {i.modifiers?.length > 0 && (
                  <div className="small muted">
                    {i.modifiers.map((m: any) => m.name).join(' • ')}
                  </div>
                )}
                {i.notes && <div className="small" style={{ color: 'var(--amber)' }}>📝 {i.notes}</div>}
              </div>
            ))}
            <div className="total-row grand">
              <span>الإجمالي</span>
              <span className="amount">{riyal(detail.grand_total)}</span>
            </div>
          </div>
        </Modal>
      )}

      {rejecting && (
        <ConfirmReason
          title="رفض الطلب" danger confirmLabel="رفض الطلب"
          message="سيُبلَّغ العميل بأن الطلب لم يُقبل، ولن يُرسل لأي قسم."
          onCancel={() => setRejecting(null)}
          onConfirm={async (reason) => {
            try {
              await api(`/orders/${rejecting.id}/review`, {
                method: 'POST', body: { decision: 'reject', reason },
              });
              push('تم رفض الطلب', 'warn');
              setRejecting(null);
              await load();
            } catch (err) { push((err as Error).message, 'error'); }
          }}
        />
      )}
    </>
  );
}
