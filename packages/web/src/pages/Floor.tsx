import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { useRealtimeEvent } from '../lib/realtime.js';
import { Empty, Modal, Spinner, useToast } from '../components/ui.js';
import { riyal, since } from '../lib/format.js';

interface TableRow {
  id: string; table_number: string; area: string | null; seats: number | null;
  status: string; waiter_name: string | null; customer_name: string | null;
  session_total: number; pending_orders: number; open_requests: number;
  opened_at: string | null; guest_count: number | null; is_mine: boolean;
  current_session_id: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  available: 'متاحة',
  occupied: 'مشغولة',
  new_order: 'طلب جديد',
  waiter_requested: 'طلب ويتر',
  charcoal_requested: 'طلب فحم',
  bill_requested: 'طلب الحساب',
};

/**
 * The floor board — the screen a waiter lives on.
 *
 * Tiles are large enough to hit reliably on an iPad, colour-coded by what the
 * table needs, and updated live so a charcoal request appears without anyone
 * refreshing.
 */
export function Floor() {
  const navigate = useNavigate();
  const { can } = useSession();
  const { push } = useToast();
  const [tables, setTables] = useState<TableRow[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'mine' | 'needs'>('all');
  const [selected, setSelected] = useState<TableRow | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, r] = await Promise.all([
        api<{ tables: TableRow[] }>('/tables'),
        can('service.requests.read')
          ? api<{ requests: any[] }>('/service-requests')
          : Promise.resolve({ requests: [] }),
      ]);
      setTables(t.tables);
      setRequests(r.requests);
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [can, push]);

  useEffect(() => { void load(); }, [load]);

  // The board must reflect the room, so any relevant event refreshes it.
  useRealtimeEvent(
    ['table.status', 'order.pending_approval', 'service.request', 'service.resolved', 'order.paid'],
    () => { void load(); },
  );

  // A slow poll as a safety net if the socket is down.
  useEffect(() => {
    const timer = window.setInterval(() => { void load(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const shown = tables.filter((t) => {
    if (filter === 'mine') return t.is_mine;
    if (filter === 'needs') return t.status !== 'available' && t.status !== 'occupied';
    return true;
  });

  const areas = [...new Set(shown.map((t) => t.area ?? 'أخرى'))];

  if (loading) return <Spinner label="جارٍ تحميل الطاولات…" />;

  return (
    <>
      {requests.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <h3 className="card-title">
            🔔 طلبات الخدمة المفتوحة
            <span className="badge amber spacer">{requests.length}</span>
          </h3>
          <div className="stack">
            {requests.map((r) => (
              <div key={r.id} className="row" style={{
                padding: 10, background: 'var(--surface-2)', borderRadius: 12,
              }}>
                <span className={`badge ${r.kind === 'charcoal' ? 'red'
                  : r.kind === 'bill' ? 'green' : 'amber'}`}>
                  {r.kind === 'waiter' ? 'طلب ويتر'
                    : r.kind === 'charcoal' ? 'طلب فحم' : 'طلب الحساب'}
                </span>
                <strong>طاولة {r.table_number}</strong>
                <span className="small faint">{since(r.created_at)}</span>
                <div className="spacer" />
                {can('service.requests.resolve') && (
                  <button
                    className="btn success sm"
                    onClick={async () => {
                      try {
                        await api(`/service-requests/${r.id}/resolve`, { method: 'POST' });
                        push('تمت الخدمة', 'ok');
                        void load();
                      } catch (err) { push((err as Error).message, 'error'); }
                    }}
                  >
                    تمت الخدمة
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="row wrap" style={{ marginBottom: 12 }}>
        <div className="tabs" style={{ flex: '0 0 auto', width: 300, marginBottom: 0 }}>
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
            الكل
          </button>
          <button className={filter === 'mine' ? 'active' : ''} onClick={() => setFilter('mine')}>
            طاولاتي
          </button>
          <button className={filter === 'needs' ? 'active' : ''} onClick={() => setFilter('needs')}>
            تحتاج تدخّل
          </button>
        </div>
        <div className="spacer" />
        <span className="small muted">
          {tables.filter((t) => t.status !== 'available').length} مشغولة من {tables.length}
        </span>
      </div>

      {areas.map((area) => (
        <div key={area} style={{ marginBottom: 18 }}>
          <h3 className="card-title" style={{ marginBottom: 8 }}>{area}</h3>
          <div className="floor">
            {shown.filter((t) => (t.area ?? 'أخرى') === area).map((t) => (
              <button
                key={t.id} className={`table-tile ${t.status}`}
                onClick={() => setSelected(t)}
              >
                <div className="num">{t.table_number}</div>
                <div className="meta">{STATUS_LABEL[t.status] ?? t.status}</div>
                {t.waiter_name && <div className="meta">👤 {t.waiter_name}</div>}
                {t.customer_name && <div className="meta">🎫 {t.customer_name}</div>}
                {t.pending_orders > 0 && (
                  <span className="badge purple">{t.pending_orders} بانتظار التأكيد</span>
                )}
                <div className="total">
                  {t.session_total > 0 ? riyal(t.session_total) : ''}
                </div>
                {t.opened_at && <div className="meta">{since(t.opened_at)}</div>}
              </button>
            ))}
          </div>
        </div>
      ))}

      {shown.length === 0 && <Empty icon="🍽️" text="لا توجد طاولات مطابقة" />}

      {selected && (
        <Modal title={`طاولة ${selected.table_number}`} onClose={() => setSelected(null)}>
          <div className="stack">
            <div className="row">
              <span className="muted">الحالة</span>
              <span className="spacer" />
              <span className="badge">{STATUS_LABEL[selected.status] ?? selected.status}</span>
            </div>
            <div className="row">
              <span className="muted">الويتر</span>
              <span className="spacer" />
              <strong>{selected.waiter_name ?? '—'}</strong>
            </div>
            <div className="row">
              <span className="muted">إجمالي الجلسة</span>
              <span className="spacer" />
              <strong className="num">{riyal(selected.session_total)}</strong>
            </div>

            {can('pos.use') && (
              <button
                className="btn primary block lg"
                onClick={() => navigate(`/pos/${selected.id}`)}
              >
                فتح نقطة البيع لهذه الطاولة
              </button>
            )}

            {can('tables.manage') && <QrPanel tableId={selected.id} />}
          </div>
        </Modal>
      )}
    </>
  );
}

/** Shows the guest URL for a table so it can be printed onto a sticker. */
function QrPanel({ tableId }: { tableId: string }) {
  const [qr, setQr] = useState<{ menuUrl: string; tableNumber: string } | null>(null);
  const { push } = useToast();

  useEffect(() => {
    api<{ menuUrl: string; tableNumber: string }>(`/tables/${tableId}/qr`)
      .then(setQr)
      .catch(() => {});
  }, [tableId]);

  if (!qr) return null;
  return (
    <div className="card" style={{ background: 'var(--surface-2)' }}>
      <div className="small muted">رابط منيو الطاولة (للطباعة على ملصق QR)</div>
      <code className="num small" style={{ wordBreak: 'break-all', display: 'block', margin: '6px 0' }}>
        {qr.menuUrl}
      </code>
      <div className="row">
        <button
          className="btn sm"
          onClick={() => {
            void navigator.clipboard?.writeText(qr.menuUrl);
            push('تم نسخ الرابط', 'ok');
          }}
        >
          نسخ الرابط
        </button>
        <button
          className="btn ghost sm"
          onClick={async () => {
            try {
              await api(`/tables/${tableId}/rotate-qr`, { method: 'POST' });
              push('تم تغيير رمز الطاولة — الملصقات القديمة لم تعد صالحة', 'warn');
              const next = await api<{ menuUrl: string; tableNumber: string }>(`/tables/${tableId}/qr`);
              setQr(next);
            } catch (err) { push((err as Error).message, 'error'); }
          }}
        >
          تجديد الرمز
        </button>
      </div>
    </div>
  );
}
