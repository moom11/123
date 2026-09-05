import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { useRealtimeEvent } from '../lib/realtime.js';
import { Empty, Modal, Spinner, Stat, useToast, ConfirmReason } from '../components/ui.js';
import { money, since } from '../lib/format.js';

/**
 * Delivery orders, from every platform, on one board.
 *
 * The reason this screen exists is the counter covered in tablets: one per
 * aggregator, each with its own sound, and a person retyping orders into the
 * POS. Everything here is already a real order — this is only where someone
 * says yes, and where the ones that could not be read are fixed.
 *
 * Ordered oldest first and never paginated: an order further down the list is
 * a customer waiting longer, not a row of less interest.
 */

const STATUS_LABEL: Record<string, string> = {
  pending: 'بانتظار القبول',
  accepted: 'مقبول',
  preparing: 'قيد التحضير',
  ready: 'جاهز للاستلام',
  picked_up: 'مع المندوب',
};

export function Delivery() {
  const { can } = useSession();
  const { push } = useToast();
  const [orders, setOrders] = useState<any[]>([]);
  const [failed, setFailed] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [rejecting, setRejecting] = useState<any | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);

  const load = useCallback(async () => {
    try {
      const [live, bad] = await Promise.all([
        api<{ orders: any[] }>('/delivery/orders'),
        can('delivery.manage')
          ? api<{ events: any[] }>('/delivery/failed')
          : Promise.resolve({ events: [] }),
      ]);
      setOrders(live.orders);
      setFailed(bad.events);
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setLoading(false); }
  }, [can, push]);

  useEffect(() => { void load(); }, [load]);

  useRealtimeEvent(
    ['delivery.order.received', 'delivery.order.cancelled', 'delivery.order.status'],
    () => { void load(); },
  );

  // A platform order that nobody accepts is a customer waiting, so this polls
  // even if the socket is down — the one screen where staleness costs money.
  useEffect(() => {
    const timer = window.setInterval(() => { void load(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (loading) return <Spinner label="جارٍ تحميل طلبات التوصيل…" />;

  const waiting = orders.filter((o) => o.status === 'pending');
  const cooking = orders.filter((o) => ['accepted', 'preparing'].includes(o.status));
  const ready = orders.filter((o) => o.status === 'ready');

  return (
    <>
      <div className="grid cols-4">
        <Stat label="بانتظار القبول" value={waiting.length}
              tone={waiting.length > 0 ? 'warn' : undefined} />
        <Stat label="قيد التحضير" value={cooking.length} />
        <Stat label="جاهز للمندوب" value={ready.length} />
        <Stat label="لم تُقرأ" value={failed.length}
              tone={failed.length > 0 ? 'alert' : undefined} />
      </div>

      {failed.length > 0 && can('delivery.manage') && (
        <div className="card alert" style={{ marginTop: 16 }}>
          <h3>طلبات وصلت ولم تُقرأ</h3>
          <p>
            هذه دفع أصحابها وينتظرون. الحمولة محفوظة — اربط الصنف الناقص ثم أعد المعالجة.
          </p>
          <table className="data">
            <tbody>
              {failed.map((e) => (
                <tr key={e.id}>
                  <td>{e.partner_name}</td>
                  <td className="mono">{e.external_order_id ?? '—'}</td>
                  <td>{e.error}</td>
                  <td>{since(e.received_at)}</td>
                  <td>
                    <button className="btn small" disabled={busy === e.id}
                            onClick={() => void replay(e)}>
                      أعد المعالجة
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {orders.length === 0 ? (
        <Empty icon="🛵" text="لا طلبات توصيل مفتوحة" />
      ) : (
        <div className="cards" style={{ marginTop: 16 }}>
          {orders.map((o) => (
            <div key={o.order_id}
                 className={`card delivery${o.status === 'pending' ? ' warn' : ''}`}>
              <div className="delivery__head">
                <span className="pill">{o.partner_name}</span>
                <strong className="mono">{o.external_reference}</strong>
                <span className="muted">{since(o.created_at)}</span>
              </div>

              <div className="delivery__body">
                <div>{o.customer_name ?? 'عميل'}</div>
                {o.address && <div className="muted small">{o.address}</div>}
                {o.customer_note && (
                  <div className="note small">ملاحظة: {o.customer_note}</div>
                )}
                {/* What was ordered, on the card. Accepting is a judgement
                    about whether the kitchen can cook these, so they cannot
                    sit behind a click. An item marked unavailable is flagged
                    here rather than discovered at the pass. */}
                <ul className="delivery__items">
                  {(o.items ?? []).map((item: any, i: number) => (
                    <li key={i} className={item.available === false ? 'out' : undefined}>
                      <span className="qty">{item.quantity}×</span> {item.name}
                      {item.available === false && <span className="flag"> غير متوفر</span>}
                      {item.notes && <span className="muted small"> — {item.notes}</span>}
                    </li>
                  ))}
                </ul>

                <div className="delivery__money">
                  <span>{money(Number(o.grand_total))}</span>
                  {o.is_prepaid
                    ? <span className="pill ok">مدفوع مسبقاً</span>
                    : <span className="pill warn">يُحصَّل عند التسليم</span>}
                </div>
                {/* A mismatch against the platform's own total is shown, not
                    silently absorbed — it usually means a stale menu there. */}
                {o.platform_total && Number(o.platform_total) !== Number(o.grand_total) && (
                  <div className="muted small">
                    المنصة تقول {money(Number(o.platform_total))} — راجع الأسعار
                  </div>
                )}
                {o.last_push_error && (
                  <div className="muted small">
                    لم تُبلَّغ المنصة بآخر حالة — سيُعاد المحاولة تلقائياً
                  </div>
                )}
              </div>

              <div className="delivery__actions">
                <span className="pill">{STATUS_LABEL[o.status] ?? o.status}</span>
                <button className="btn small ghost" onClick={() => setDetail(o)}>
                  التفاصيل
                </button>
                {o.status === 'pending' && can('delivery.accept') && (
                  <>
                    <button className="btn small" disabled={busy === o.order_id}
                            onClick={() => void accept(o)}>
                      اقبل
                    </button>
                    <button className="btn small ghost" onClick={() => setRejecting(o)}>
                      ارفض
                    </button>
                  </>
                )}
                {['accepted', 'preparing'].includes(o.status) && can('delivery.accept') && (
                  <button className="btn small" disabled={busy === o.order_id}
                          onClick={() => void ready_(o)}>
                    جاهز
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {detail && (
        <Modal title={`طلب ${detail.partner_name} — ${detail.external_reference}`}
               onClose={() => setDetail(null)}>
          <dl className="pairs">
            <dt>رقمنا</dt><dd className="mono">{detail.order_number}</dd>
            <dt>العميل</dt><dd>{detail.customer_name ?? '—'}</dd>
            <dt>الجوال</dt><dd className="mono">{detail.customer_phone ?? '—'}</dd>
            <dt>العنوان</dt><dd>{detail.address ?? '—'}</dd>
            <dt>الإجمالي عندنا</dt><dd>{money(Number(detail.grand_total))}</dd>
            <dt>إجمالي المنصة</dt>
            <dd>{detail.platform_total ? money(Number(detail.platform_total)) : '—'}</dd>
            <dt>عمولة المنصة</dt><dd>{money(Number(detail.commission ?? 0))}</dd>
            <dt>المندوب</dt><dd>{detail.rider_name ?? 'لم يُسنَد بعد'}</dd>
          </dl>
        </Modal>
      )}

      {rejecting && (
        <ConfirmReason
          title={`رفض طلب ${rejecting.partner_name}`}
          message="السبب يصل إلى المنصة وإلى العميل، فاكتبه كما تريده أن يقرأه."
          confirmLabel="ارفض الطلب"
          requireReason
          danger
          onCancel={() => setRejecting(null)}
          onConfirm={async (reason) => {
            try {
              await api(`/delivery/orders/${rejecting.order_id}/reject`,
                { method: 'POST', body: { reason } });
              push('رُفض الطلب وأُبلغت المنصة', 'ok');
              setRejecting(null);
              await load();
            } catch (err) { push((err as Error).message, 'error'); }
          }}
        />
      )}
    </>
  );

  async function accept(order: any) {
    setBusy(order.order_id);
    try {
      await api(`/delivery/orders/${order.order_id}/accept`, { method: 'POST' });
      push('قُبل الطلب وطُبعت التذكرة', 'ok');
      await load();
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setBusy(null); }
  }

  async function ready_(order: any) {
    setBusy(order.order_id);
    try {
      await api(`/delivery/orders/${order.order_id}/ready`, { method: 'POST' });
      push('أُبلغت المنصة أن الطلب جاهز', 'ok');
      await load();
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setBusy(null); }
  }

  async function replay(event: any) {
    setBusy(event.id);
    try {
      const res = await api<{ status: string; message?: string }>(
        `/delivery/failed/${event.id}/replay`, { method: 'POST' },
      );
      push(
        res.status === 'processed' ? 'استُرجع الطلب' : (res.message ?? res.status),
        res.status === 'processed' ? 'ok' : 'warn',
      );
      await load();
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setBusy(null); }
  }
}
