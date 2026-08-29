import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { useRealtimeEvent } from '../lib/realtime.js';
import { Empty, Modal, Spinner, useToast, ConfirmReason } from '../components/ui.js';
import { dateTime, quantity, riyal } from '../lib/format.js';

const STATUS_LABEL: Record<string, string> = {
  draft: 'مسودة', submitted: 'مُرسل', pending_branch_manager: 'بانتظار مدير الفرع',
  approved: 'معتمد', rejected: 'مرفوض', sent_to_buyer: 'أُرسل للمندوب',
  purchasing: 'جاري الشراء', purchased: 'تم الشراء', in_transit: 'في الطريق',
  delivered: 'تم التسليم', received: 'تم الاستلام', closed: 'مغلق', cancelled: 'ملغي',
};
const STATUS_TONE: Record<string, string> = {
  pending_branch_manager: 'amber', approved: 'green', rejected: 'red',
  purchasing: 'blue', purchased: 'blue', in_transit: 'purple',
  delivered: 'gold', received: 'green', closed: '', cancelled: 'red',
};

const DEPARTMENTS = ['BAR', 'KITCHEN', 'SHISHA', 'FLOOR', 'OTHER'] as const;
const DEPT_LABEL: Record<string, string> = {
  BAR: 'البار', KITCHEN: 'المطبخ', SHISHA: 'المعسل', FLOOR: 'الصالة', OTHER: 'أخرى',
};

/**
 * Purchasing.
 *
 * Departments raise requests, the branch manager approves (and may cut the
 * quantity), and only then does the request become visible to the purchasing
 * rep — a rule the server enforces, so this screen simply reflects it.
 */
export function Purchasing({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const { can, me } = useSession();
  const { push } = useToast();
  const isBuyer = can('purchasing.buyer') && !can('purchase_requests.approve');

  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<any | null>(null);
  const [creating, setCreating] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('');

  const load = useCallback(async () => {
    try {
      const res = isBuyer
        ? await api<{ requests: any[] }>('/buyer/requests')
        : await api<{ requests: any[] }>(
            `/purchase-requests${statusFilter ? `?status=${statusFilter}` : ''}`,
          );
      setRequests(res.requests);
      onCountChange?.(res.requests.filter(
        (r: any) => r.status === 'pending_branch_manager',
      ).length);
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [isBuyer, statusFilter, push, onCountChange]);

  useEffect(() => { void load(); }, [load]);
  useRealtimeEvent(['purchase_request.pending_approval', 'purchase_request.status'],
    () => { void load(); });

  const open = async (id: string) => {
    try {
      const res = await api<{ request: any }>(`/purchase-requests/${id}`);
      setDetail(res.request);
    } catch (err) { push((err as Error).message, 'error'); }
  };

  if (loading) return <Spinner label="جارٍ التحميل…" />;

  return (
    <>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <h3 className="card-title" style={{ margin: 0 }}>
          {isBuyer ? '🛒 طلبات الشراء المعتمدة' : '🛒 طلبات الشراء'}
        </h3>
        <div className="spacer" />
        {!isBuyer && (
          <select
            className="select" style={{ maxWidth: 200 }}
            value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">كل الحالات</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        )}
        {can('purchase_requests.create') && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            + طلب شراء جديد
          </button>
        )}
      </div>

      {isBuyer && (
        <div className="alert-box info">
          تظهر لك فقط الطلبات التي اعتمدها مدير الفرع، وبالكميات المعتمدة. إذا
          احتجت كمية مختلفة استخدم «طلب تعديل» ليعود الطلب للمدير.
        </div>
      )}

      {isBuyer && <BuyerSummary />}

      {requests.length === 0 && <Empty icon="📋" text="لا توجد طلبات" />}

      <div className="card">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>الرقم</th><th>القسم</th><th>الحالة</th><th>الأولوية</th>
                <th>الأصناف</th><th>التاريخ</th><th></th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="num">{r.request_number}</td>
                  <td>{DEPT_LABEL[r.department] ?? r.department}</td>
                  <td>
                    <span className={`badge ${STATUS_TONE[r.status] ?? ''}`}>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </span>
                  </td>
                  <td>
                    {r.priority === 'urgent'
                      ? <span className="badge red">عاجل</span>
                      : r.priority === 'high' ? <span className="badge amber">مرتفع</span>
                      : <span className="muted small">عادي</span>}
                  </td>
                  <td className="num">{r.item_count ?? '—'}</td>
                  <td className="small muted">{dateTime(r.created_at)}</td>
                  <td>
                    <button className="btn sm" onClick={() => void open(r.id)}>عرض</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {detail && (
        <RequestDetail
          request={detail} isBuyer={isBuyer}
          onClose={() => setDetail(null)}
          onChanged={async () => { await load(); setDetail(null); }}
        />
      )}

      {creating && (
        <CreateRequest
          department={(me?.user.department as string) ?? 'OTHER'}
          onClose={() => setCreating(false)}
          onCreated={async () => { setCreating(false); await load(); }}
        />
      )}
    </>
  );
}

function BuyerSummary() {
  const [summary, setSummary] = useState<any | null>(null);
  useEffect(() => { api<any>('/buyer/summary').then(setSummary).catch(() => {}); }, []);
  if (!summary) return null;

  return (
    <div className="grid cols-4" style={{ marginBottom: 12 }}>
      <div className="stat">
        <div className="label">للبدء</div><div className="value">{summary.to_start}</div>
        <div className="sub">{summary.itemCount} صنف</div>
      </div>
      <div className="stat">
        <div className="label">جاري الشراء</div><div className="value">{summary.in_progress}</div>
      </div>
      <div className="stat">
        <div className="label">في الطريق</div><div className="value">{summary.in_transit}</div>
      </div>
      <div className={`stat${summary.urgent > 0 ? ' alert' : ''}`}>
        <div className="label">عاجل</div><div className="value">{summary.urgent}</div>
      </div>
    </div>
  );
}

function RequestDetail({
  request, isBuyer, onClose, onChanged,
}: { request: any; isBuyer: boolean; onClose: () => void; onChanged: () => void }) {
  const { can } = useSession();
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  const [approvedQty, setApprovedQty] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const i of request.items ?? []) {
      initial[i.item_id] = String(i.entered_quantity ?? i.requested_quantity ?? '');
    }
    return initial;
  });
  const [rejecting, setRejecting] = useState(false);

  const decide = async (decision: 'approve' | 'reject', comment?: string) => {
    setBusy(true);
    try {
      await api(`/purchase-requests/${request.id}/decide`, {
        method: 'POST',
        body: {
          decision, comment: comment ?? null,
          itemQuantities: decision === 'approve'
            ? (request.items ?? []).map((i: any) => ({
                itemId: i.item_id,
                approvedQuantity: Number(approvedQty[i.item_id] ?? 0),
                unit: i.entered_unit,
              }))
            : undefined,
        },
      });
      push(decision === 'approve' ? 'تم الاعتماد — الطلب الآن ظاهر للمندوب' : 'تم الرفض',
        decision === 'approve' ? 'ok' : 'warn');
      onChanged();
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  const advance = async (status: string) => {
    setBusy(true);
    try {
      await api(`/buyer/requests/${request.id}/status`, { method: 'POST', body: { status } });
      push('تم تحديث الحالة', 'ok');
      onChanged();
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  const canApprove = can('purchase_requests.approve')
    && ['pending_branch_manager', 'submitted'].includes(request.status);

  return (
    <>
      <Modal
        wide title={`${request.request_number} — ${DEPT_LABEL[request.department] ?? ''}`}
        onClose={onClose}
        footer={
          <>
            {canApprove && (
              <>
                <button className="btn success" disabled={busy} onClick={() => void decide('approve')}>
                  اعتماد
                </button>
                <button className="btn danger" disabled={busy} onClick={() => setRejecting(true)}>
                  رفض
                </button>
              </>
            )}
            {isBuyer && ['approved', 'sent_to_buyer'].includes(request.status) && (
              <button className="btn primary" disabled={busy} onClick={() => void advance('purchasing')}>
                بدء الشراء
              </button>
            )}
            {isBuyer && request.status === 'purchased' && (
              <button className="btn primary" disabled={busy} onClick={() => void advance('in_transit')}>
                في الطريق
              </button>
            )}
            {isBuyer && request.status === 'in_transit' && (
              <button className="btn primary" disabled={busy} onClick={() => void advance('delivered')}>
                تم التسليم
              </button>
            )}
          </>
        }
      >
        <div className="row" style={{ marginBottom: 12 }}>
          <span className={`badge ${STATUS_TONE[request.status] ?? ''}`}>
            {STATUS_LABEL[request.status]}
          </span>
          {request.requested_by_name && (
            <span className="small muted">طلب: {request.requested_by_name}</span>
          )}
          {request.approved_by_name && (
            <span className="small muted">اعتماد: {request.approved_by_name}</span>
          )}
        </div>

        {request.manager_comment && (
          <div className="alert-box info">ملاحظة المدير: {request.manager_comment}</div>
        )}
        {request.reject_reason && (
          <div className="alert-box">سبب الرفض: {request.reject_reason}</div>
        )}

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>الصنف</th>
                {!isBuyer && <th>المطلوب</th>}
                <th>{canApprove ? 'المعتمد (قابل للتعديل)' : 'المعتمد'}</th>
                <th>المشترى</th><th>المستلم</th>
                {!isBuyer && <th>المخزون الحالي</th>}
              </tr>
            </thead>
            <tbody>
              {(request.items ?? []).map((i: any) => (
                <tr key={i.id}>
                  <td>{i.name_ar}</td>
                  {!isBuyer && (
                    <td className="num">{quantity(Number(i.requested_quantity ?? 0), i.base_unit)}</td>
                  )}
                  <td className="num">
                    {canApprove ? (
                      <div className="row" style={{ gap: 4 }}>
                        <input
                          className="input ltr" style={{ width: 90, minHeight: 36 }}
                          value={approvedQty[i.item_id] ?? ''}
                          onChange={(e) => setApprovedQty(
                            (q) => ({ ...q, [i.item_id]: e.target.value }),
                          )}
                        />
                        <span className="small faint">{i.entered_unit}</span>
                      </div>
                    ) : (
                      i.approved_quantity != null
                        ? quantity(Number(i.approved_quantity), i.base_unit)
                        : '—'
                    )}
                  </td>
                  <td className="num">
                    {i.purchased_quantity != null
                      ? quantity(Number(i.purchased_quantity), i.base_unit) : '—'}
                  </td>
                  <td className="num">
                    {i.received_quantity != null
                      ? quantity(Number(i.received_quantity), i.base_unit) : '—'}
                  </td>
                  {!isBuyer && (
                    <td className="num small muted">
                      {quantity(Number(i.current_stock ?? 0), i.base_unit)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {request.approvals?.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <h4 className="card-title">سجل القرارات</h4>
            {request.approvals.map((a: any) => (
              <div key={a.id} className="row small" style={{ marginBottom: 6 }}>
                <span className="badge">{a.decision}</span>
                <span>{a.approver_name}</span>
                <span className="spacer faint">{dateTime(a.decided_at)}</span>
              </div>
            ))}
          </div>
        )}

        {can('purchases.receive') && ['delivered', 'purchased', 'in_transit'].includes(request.status) && (
          <ReceivePanel request={request} onDone={onChanged} />
        )}
      </Modal>

      {rejecting && (
        <ConfirmReason
          title="رفض طلب الشراء" danger confirmLabel="رفض"
          onCancel={() => setRejecting(false)}
          onConfirm={async (reason) => { await decide('reject', reason); }}
        />
      )}
    </>
  );
}

/** The department confirming what physically arrived — the only path that moves stock. */
function ReceivePanel({ request, onDone }: { request: any; onDone: () => void }) {
  const { push } = useToast();
  const [locations, setLocations] = useState<any[]>([]);
  const [locationId, setLocationId] = useState('');
  const [received, setReceived] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ locations: any[] }>('/inventory/locations').then((r) => {
      setLocations(r.locations);
      const match = r.locations.find((l) => l.department === request.department);
      setLocationId(match?.id ?? r.locations[0]?.id ?? '');
    }).catch(() => {});
    const initial: Record<string, string> = {};
    for (const i of request.items ?? []) {
      // Default to what the buyer says was purchased; the receiver corrects it.
      initial[i.item_id] = i.purchased_quantity != null
        ? String(Number(i.purchased_quantity) / baseFactor(i.base_unit, i.entered_unit))
        : '';
    }
    setReceived(initial);
  }, [request]);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await api<any>(`/purchase-requests/${request.id}/receive`, {
        method: 'POST',
        body: {
          locationId,
          items: (request.items ?? [])
            .filter((i: any) => received[i.item_id])
            .map((i: any) => ({
              itemId: i.item_id,
              receivedQuantity: Number(received[i.item_id]),
              unit: i.entered_unit,
            })),
        },
      });
      if (res.discrepancies?.length > 0) {
        push(`تم الاستلام مع ${res.discrepancies.length} فرق في الكميات`, 'warn');
      } else {
        push('تم الاستلام وتحديث المخزون', 'ok');
      }
      onDone();
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ marginTop: 14, background: 'var(--surface-2)' }}>
      <h4 className="card-title">📥 تأكيد الاستلام</h4>
      <p className="small muted">
        لا تدخل الكمية للمخزون إلا بتأكيدك أنت. أي فرق بين المشترى والمستلم
        سيُسجَّل ويُنبَّه عليه.
      </p>
      <div className="field">
        <label className="label">موقع الاستلام</label>
        <select className="select" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>
      {(request.items ?? []).map((i: any) => (
        <div key={i.id} className="row" style={{ marginBottom: 8 }}>
          <span style={{ flex: 1 }}>{i.name_ar}</span>
          <input
            className="input ltr" style={{ width: 100 }}
            value={received[i.item_id] ?? ''}
            onChange={(e) => setReceived((r) => ({ ...r, [i.item_id]: e.target.value }))}
          />
          <span className="small faint">{i.entered_unit}</span>
        </div>
      ))}
      <button className="btn success block" disabled={busy || !locationId} onClick={() => void submit()}>
        {busy ? '...' : 'تأكيد الاستلام'}
      </button>
    </div>
  );
}

/** Base units per entered unit, for pre-filling the receive form. */
function baseFactor(baseUnit: string, enteredUnit: string): number {
  if (baseUnit === enteredUnit) return 1;
  if ((baseUnit === 'g' && enteredUnit === 'kg') || (baseUnit === 'ml' && enteredUnit === 'l')) {
    return 1000;
  }
  return 1;
}

function CreateRequest({
  department, onClose, onCreated,
}: { department: string; onClose: () => void; onCreated: () => void }) {
  const { push } = useToast();
  const [items, setItems] = useState<any[]>([]);
  const [lines, setLines] = useState<Array<{ itemId: string; quantity: string; unit: string }>>([]);
  const [dept, setDept] = useState(DEPARTMENTS.includes(department as any) ? department : 'OTHER');
  const [priority, setPriority] = useState('normal');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ items: any[] }>('/inventory/items').then((r) => setItems(r.items)).catch(() => {});
  }, []);

  const submit = async () => {
    const valid = lines.filter((l) => l.itemId && Number(l.quantity) > 0);
    if (valid.length === 0) { push('أضف صنفاً واحداً على الأقل', 'error'); return; }
    setBusy(true);
    try {
      await api('/purchase-requests', {
        method: 'POST',
        body: {
          department: dept, priority, reason: reason || null, submit: true,
          items: valid.map((l) => ({
            itemId: l.itemId, quantity: Number(l.quantity), unit: l.unit,
          })),
        },
      });
      push('تم إرسال الطلب لمدير الفرع', 'ok');
      onCreated();
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <Modal
      wide title="طلب شراء جديد" onClose={onClose}
      footer={
        <button className="btn primary" disabled={busy} onClick={() => void submit()}>
          {busy ? '...' : 'إرسال لمدير الفرع'}
        </button>
      }
    >
      <div className="grid cols-3">
        <div className="field">
          <label className="label">القسم</label>
          <select className="select" value={dept} onChange={(e) => setDept(e.target.value)}>
            {DEPARTMENTS.map((d) => <option key={d} value={d}>{DEPT_LABEL[d]}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="label">الأولوية</label>
          <select className="select" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="low">منخفضة</option>
            <option value="normal">عادية</option>
            <option value="high">مرتفعة</option>
            <option value="urgent">عاجلة</option>
          </select>
        </div>
        <div className="field">
          <label className="label">السبب</label>
          <input
            className="input" value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="Low Stock"
          />
        </div>
      </div>

      {lines.map((line, index) => {
        const item = items.find((i) => i.id === line.itemId);
        return (
          <div key={index} className="row" style={{ marginBottom: 8 }}>
            <select
              className="select" value={line.itemId}
              onChange={(e) => {
                const chosen = items.find((i) => i.id === e.target.value);
                setLines((l) => l.map((x, i) => i === index
                  ? { ...x, itemId: e.target.value, unit: chosen?.stock_unit ?? 'piece' } : x));
              }}
            >
              <option value="">— اختر صنفاً —</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}{i.is_low_stock ? ' ⚠️ منخفض' : ''}
                </option>
              ))}
            </select>
            <input
              className="input ltr" style={{ width: 110 }} inputMode="decimal"
              value={line.quantity} placeholder="الكمية"
              onChange={(e) => setLines((l) => l.map(
                (x, i) => i === index ? { ...x, quantity: e.target.value } : x,
              ))}
            />
            <span className="small faint" style={{ width: 50 }}>{line.unit}</span>
            {item && (
              <span className="small muted" style={{ width: 130 }}>
                المتوفر {quantity(Number(item.total_quantity ?? 0), item.base_unit)}
              </span>
            )}
            <button
              className="btn ghost sm"
              onClick={() => setLines((l) => l.filter((_, i) => i !== index))}
            >
              ✕
            </button>
          </div>
        );
      })}

      <button
        className="btn block"
        onClick={() => setLines((l) => [...l, { itemId: '', quantity: '', unit: 'piece' }])}
      >
        + إضافة صنف
      </button>
    </Modal>
  );
}
