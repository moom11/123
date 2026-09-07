import { useCallback, useEffect, useState } from 'react';
import {
  act, api, apiBase, ApiError, clearTokens, flush, hasSession, lastSync,
  online, pendingCount, setApiBase, setTokens, syncDown,
} from './api.js';

/**
 * MARA Buyer.
 *
 * Deliberately narrow: approved purchase requests, the aggregated shopping
 * list, price history, purchase entry, invoice capture and delivery status.
 * There is no POS, no customer data and no financial reporting here — not
 * hidden, simply absent, and refused by the server for this role in any case.
 */

interface Me {
  user: { id: string; name: string; role: string; roleLabel: string; branchId: string | null };
  branch: { name: string } | null;
  permissions: string[];
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [isOnline, setIsOnline] = useState(online());
  const [pending, setPending] = useState(0);
  const [toasts, setToasts] = useState<Array<{ id: number; text: string; kind: string }>>([]);

  const toast = useCallback((text: string, kind = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const load = useCallback(async () => {
    if (!hasSession()) { setMe(null); setLoading(false); return; }
    try {
      setMe(await api<Me>('/auth/me'));
    } catch (err) {
      // Offline at launch is normal for this app: keep the cached session and
      // let the screens work from IndexedDB.
      if (!online()) setMe({ user: { id: '', name: 'مندوب المشتريات', role: 'buyer',
        roleLabel: 'مندوب المشتريات', branchId: null }, branch: null,
        permissions: ['purchasing.buyer'] });
      else { clearTokens(); setMe(null); }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Replay whatever was recorded offline as soon as the signal returns.
  useEffect(() => {
    const goOnline = async () => {
      setIsOnline(true);
      const result = await flush();
      if (result.sent > 0) toast(`تمت مزامنة ${result.sent} عملية`, 'ok');
      for (const message of result.errors) toast(message, 'error');
      setPending(await pendingCount());
    };
    const goOffline = () => { setIsOnline(false); toast('انقطع الاتصال — سيتم الحفظ محلياً', 'warn'); };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    void pendingCount().then(setPending);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [toast]);

  if (loading) {
    return <div className="login-wrap"><div className="center muted">جارٍ التحميل…</div></div>;
  }
  if (!me) return <Login onSignedIn={load} toast={toast} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">MARA BUYER<small>{me.branch?.name ?? 'المشتريات'}</small></div>
        <div className="spacer" />
        <span className={`badge ${isOnline ? 'green' : 'amber'}`}>
          {isOnline ? '● متصل' : '○ بدون اتصال'}
        </span>
        <button
          className="btn ghost sm"
          onClick={() => { clearTokens(); setMe(null); }}
        >
          خروج
        </button>
      </header>

      {!isOnline && (
        <div className="offline-bar">
          تعمل بدون اتصال — يمكنك متابعة الشراء وسيُرسل كل شيء عند عودة الشبكة
        </div>
      )}
      {pending > 0 && isOnline && (
        <div className="sync-bar">{pending} عملية بانتظار المزامنة</div>
      )}

      <main className="content">
        <Home toast={toast} onPendingChange={setPending} />
      </main>

      <div className="toast-stack">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </div>
  );
}

function Login({
  onSignedIn, toast,
}: { onSignedIn: () => void; toast: (t: string, k?: string) => void }) {
  const [base, setBase] = useState(apiBase());
  const [branches, setBranches] = useState<any[]>([]);
  const [branchId, setBranchId] = useState('');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  const [reachable, setReachable] = useState(true);

  // An empty base means same-origin, which is how the browser build is served;
  // the Android build sets an absolute URL. Either way the branch list is
  // fetched on mount, and only a genuine failure reveals the server field.
  const loadBranches = useCallback(async (url: string) => {
    setApiBase(url);
    try {
      const res = await api<{ branches: any[] }>('/auth/branches');
      setBranches(res.branches);
      setBranchId((b) => b || res.branches[0]?.id || '');
      setReachable(true);
    } catch {
      setReachable(false);
      toast('تعذّر الاتصال بالخادم', 'error');
    }
  }, [toast]);

  useEffect(() => { void loadBranches(base); }, []);

  const submit = async (finalPin: string) => {
    if (!branchId || !code) return;
    setBusy(true);
    try {
      const res = await api<{ tokens: any; employee: any }>('/auth/employee/login', {
        method: 'POST', body: { branchId, employeeCode: code, pin: finalPin },
      });
      if (res.employee.role !== 'buyer') {
        toast('هذا التطبيق مخصص لمندوب المشتريات فقط', 'error');
        setPin('');
        return;
      }
      setTokens(res.tokens);
      onSignedIn();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'تعذّر تسجيل الدخول', 'error');
      setPin('');
    } finally { setBusy(false); }
  };

  const press = (d: string) => {
    const next = (pin + d).slice(0, 6);
    setPin(next);
    if (next.length === 4) void submit(next);
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="center" style={{ marginBottom: 22 }}>
          <div style={{ fontSize: 34, fontWeight: 800, color: 'var(--gold)', letterSpacing: 3 }}>
            MARA
          </div>
          <div className="muted small">تطبيق مندوب المشتريات</div>
        </div>

        <div className="card">
          {!reachable && (
            <div className="field">
              <label className="label">عنوان الخادم</label>
              <input
                className="input ltr" value={base} placeholder="https://api.maralounge.sa"
                onChange={(e) => setBase(e.target.value)}
                onBlur={() => void loadBranches(base)}
              />
            </div>
          )}

          <div className="field">
            <label className="label">الفرع</label>
            <select className="select" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>

          <div className="field">
            <label className="label">رقم الموظف</label>
            <input
              className="input ltr" inputMode="numeric" value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="4001"
            />
          </div>

          <div className="pin-dots">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className={`pin-dot${pin.length > i ? ' filled' : ''}`} />
            ))}
          </div>

          <div className="keypad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button key={d} onClick={() => press(d)} disabled={busy}>{d}</button>
            ))}
            <button onClick={() => setPin('')} disabled={busy}>مسح</button>
            <button onClick={() => press('0')} disabled={busy}>0</button>
            <button onClick={() => setPin((p) => p.slice(0, -1))} disabled={busy}>⌫</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Home({
  toast, onPendingChange,
}: { toast: (t: string, k?: string) => void; onPendingChange: (n: number) => void }) {
  const [tab, setTab] = useState<'requests' | 'list'>('requests');
  const [requests, setRequests] = useState<any[]>([]);
  const [shoppingList, setShoppingList] = useState<any[]>([]);
  const [summary, setSummary] = useState<any | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await syncDown();
    setRequests(res.requests);
    setFromCache(res.fromCache);
    setSyncedAt(await lastSync());
    if (online()) {
      try {
        setSummary(await api('/buyer/summary'));
        setShoppingList((await api<{ items: any[] }>('/buyer/shopping-list')).items);
      } catch { /* summary is a nicety; the work list is what matters */ }
    }
    onPendingChange(await pendingCount());
    setLoading(false);
  }, [onPendingChange]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <div className="center muted" style={{ padding: 40 }}>جارٍ التحميل…</div>;

  return (
    <>
      {summary && (
        <div className="grid cols-3" style={{ marginBottom: 12 }}>
          <div className="stat">
            <div className="label">للبدء</div><div className="value">{summary.to_start}</div>
          </div>
          <div className="stat">
            <div className="label">جاري الشراء</div><div className="value">{summary.in_progress}</div>
          </div>
          <div className={`stat${summary.urgent > 0 ? ' alert' : ''}`}>
            <div className="label">عاجل</div><div className="value">{summary.urgent}</div>
          </div>
        </div>
      )}

      {fromCache && (
        <div className="alert-box warn" style={{ marginBottom: 12 }}>
          نسخة محفوظة محلياً{syncedAt ? ` — آخر مزامنة ${new Date(syncedAt).toLocaleString('ar-SA')}` : ''}
        </div>
      )}

      <div className="tabs">
        <button className={tab === 'requests' ? 'active' : ''} onClick={() => setTab('requests')}>
          الطلبات ({requests.length})
        </button>
        <button className={tab === 'list' ? 'active' : ''} onClick={() => setTab('list')}>
          قائمة الشراء
        </button>
      </div>

      {tab === 'requests' && (
        <>
          {requests.length === 0 && (
            <div className="empty">
              <span className="icon">✅</span>
              لا توجد طلبات معتمدة حالياً
            </div>
          )}
          {requests.map((r) => (
            <div key={r.id} className={`request-card${r.priority === 'urgent' ? ' urgent' : ''}`}>
              <div className="row">
                <strong className="num">{r.request_number}</strong>
                <span className={`badge ${STATUS_TONE[r.status] ?? ''}`}>
                  {STATUS_LABEL[r.status] ?? r.status}
                </span>
                {r.priority === 'urgent' && <span className="badge red">عاجل</span>}
              </div>
              <div className="small muted" style={{ marginTop: 4 }}>
                {DEPT_LABEL[r.department] ?? r.department} · {r.items?.length ?? 0} صنف
              </div>
              <button
                className="btn block" style={{ marginTop: 10 }}
                onClick={() => setDetail(r)}
              >
                فتح
              </button>
            </div>
          ))}
        </>
      )}

      {tab === 'list' && (
        <div className="card">
          <h3 className="card-title">قائمة الشراء المجمعة</h3>
          <p className="small muted">
            نفس الصنف من عدة أقسام مجموع في سطر واحد، مع توزيع الكمية لكل قسم.
          </p>
          {shoppingList.length === 0 && <div className="empty">لا توجد أصناف</div>}
          {shoppingList.map((item) => (
            <div key={item.item_id} className="item-row" style={{ display: 'block' }}>
              <div className="row">
                <span className="name">{item.name_ar}</span>
                <span className="qty">
                  {formatQty(Number(item.total_quantity), item.base_unit)}
                </span>
              </div>
              <div className="row wrap small muted" style={{ marginTop: 6 }}>
                {item.breakdown.map((b: any, i: number) => (
                  <span key={i} className="badge">
                    {DEPT_LABEL[b.department] ?? b.department}: {formatQty(Number(b.quantity), item.base_unit)}
                  </span>
                ))}
              </div>
              {item.last_price && (
                <div className="small faint" style={{ marginTop: 6 }}>
                  آخر سعر {money(Number(item.last_price) * baseFactor(item.base_unit))} /
                  {item.base_unit === 'g' ? ' كجم' : item.base_unit === 'ml' ? ' لتر' : ' حبة'}
                  {item.lowest_recent_price && (
                    <> · أقل سعر حديث {money(Number(item.lowest_recent_price) * baseFactor(item.base_unit))}</>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {detail && (
        <RequestSheet
          request={detail} toast={toast}
          onClose={() => setDetail(null)}
          onChanged={async () => { setDetail(null); await load(); }}
        />
      )}
    </>
  );
}

const STATUS_LABEL: Record<string, string> = {
  approved: 'معتمد', sent_to_buyer: 'أُرسل لك', purchasing: 'جاري الشراء',
  purchased: 'تم الشراء', in_transit: 'في الطريق', delivered: 'تم التسليم',
  received: 'تم الاستلام', closed: 'مغلق',
};
const STATUS_TONE: Record<string, string> = {
  approved: 'green', sent_to_buyer: 'green', purchasing: 'blue',
  purchased: 'blue', in_transit: 'amber', delivered: 'gold', received: 'green',
};
const DEPT_LABEL: Record<string, string> = {
  BAR: 'البار', KITCHEN: 'المطبخ', SHISHA: 'المعسل', FLOOR: 'الصالة', OTHER: 'أخرى',
};

function baseFactor(baseUnit: string): number {
  return baseUnit === 'g' || baseUnit === 'ml' ? 1000 : 1;
}
function formatQty(value: number, unit: string): string {
  if (unit === 'g' && Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)} كجم`;
  if (unit === 'ml' && Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)} لتر`;
  const rounded = Number.isInteger(value) ? value : Number(value.toFixed(2));
  return `${rounded} ${unit === 'g' ? 'جم' : unit === 'ml' ? 'مل' : 'حبة'}`;
}
function money(minor: number): string {
  return `${(minor / 100).toFixed(2)} ر.س`;
}

/**
 * One approved request: what to buy, how much was approved, and the actions
 * available. The approved quantity is the ceiling — buying more is refused by
 * the server and must go back to the manager through Request Change.
 */
function RequestSheet({
  request, toast, onClose, onChanged,
}: {
  request: any; toast: (t: string, k?: string) => void;
  onClose: () => void; onChanged: () => void;
}) {
  const [mode, setMode] = useState<'view' | 'purchase' | 'change'>('view');
  const [busy, setBusy] = useState(false);

  const advance = async (status: string) => {
    setBusy(true);
    try {
      const res = await act('status', request.id, { status });
      if (res.rejected) { toast(res.error ?? 'رُفضت العملية', 'error'); return; }
      toast(res.sent ? 'تم تحديث الحالة' : 'حُفظ محلياً — سيُرسل عند عودة الشبكة',
        res.sent ? 'ok' : 'warn');
      onChanged();
    } catch (err) { toast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  const nextStatus = {
    approved: 'purchasing', sent_to_buyer: 'purchasing', purchasing: 'purchased',
    purchased: 'in_transit', in_transit: 'delivered',
  }[request.status as string];
  const nextLabel = {
    purchasing: 'بدء الشراء', purchased: 'تم الشراء',
    in_transit: 'في الطريق', delivered: 'تم التسليم',
  }[nextStatus ?? ''];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="num">{request.request_number}</span>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {mode === 'view' && (
            <>
              <div className="row" style={{ marginBottom: 12 }}>
                <span className={`badge ${STATUS_TONE[request.status] ?? ''}`}>
                  {STATUS_LABEL[request.status] ?? request.status}
                </span>
                <span className="badge">{DEPT_LABEL[request.department]}</span>
              </div>

              {request.manager_comment && (
                <div className="alert-box" style={{ marginBottom: 12 }}>
                  ملاحظة المدير: {request.manager_comment}
                </div>
              )}

              <h4 className="card-title">الأصناف المعتمدة</h4>
              {(request.items ?? []).map((i: any) => (
                <div key={i.id} className="item-row">
                  <span className="name">{i.name_ar}</span>
                  <span className="qty">
                    {formatQty(Number(i.approved_quantity ?? 0), i.base_unit)}
                  </span>
                </div>
              ))}
              <p className="small faint" style={{ marginTop: 10 }}>
                هذه هي الكميات التي اعتمدها مدير الفرع. لا يمكن شراء أكثر منها —
                استخدم «طلب تعديل» إن احتجت كمية مختلفة.
              </p>
            </>
          )}

          {mode === 'purchase' && (
            <PurchaseForm
              request={request} toast={toast}
              onDone={onChanged} onCancel={() => setMode('view')}
            />
          )}

          {mode === 'change' && (
            <ChangeRequestForm
              request={request} toast={toast}
              onDone={onChanged} onCancel={() => setMode('view')}
            />
          )}
        </div>

        {mode === 'view' && (
          <div className="modal-footer" style={{ flexWrap: 'wrap' }}>
            {nextStatus && (
              <button
                className="btn primary" disabled={busy}
                onClick={() => void advance(nextStatus)}
              >
                {nextLabel}
              </button>
            )}
            {['approved', 'sent_to_buyer', 'purchasing'].includes(request.status) && (
              <>
                <button className="btn success" onClick={() => setMode('purchase')}>
                  تسجيل الشراء
                </button>
                <button className="btn ghost" onClick={() => setMode('change')}>
                  طلب تعديل
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PurchaseForm({
  request, toast, onDone, onCancel,
}: {
  request: any; toast: (t: string, k?: string) => void;
  onDone: () => void; onCancel: () => void;
}) {
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [lines, setLines] = useState<Record<string, { qty: string; price: string }>>(() => {
    const initial: Record<string, { qty: string; price: string }> = {};
    for (const i of request.items ?? []) {
      initial[i.item_id] = {
        // Default to the approved amount in the unit the requester typed.
        qty: String(Number(i.approved_quantity ?? 0) / baseFactor(i.base_unit)),
        price: '',
      };
    }
    return initial;
  });
  const [busy, setBusy] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);

  useEffect(() => {
    if (!online()) return;
    api<{ suppliers: any[] }>('/suppliers')
      .then((r) => { setSuppliers(r.suppliers); setSupplierId(r.suppliers[0]?.id ?? ''); })
      .catch(() => {});
  }, []);

  const submit = async () => {
    setBusy(true);
    try {
      const items = (request.items ?? [])
        .filter((i: any) => Number(lines[i.item_id]?.qty) > 0)
        .map((i: any) => ({
          itemId: i.item_id,
          quantity: Number(lines[i.item_id].qty),
          unit: i.entered_unit ?? (i.base_unit === 'g' ? 'kg' : i.base_unit === 'ml' ? 'l' : 'piece'),
          unitPrice: Math.round(Number(lines[i.item_id].price || 0) * 100),
        }));
      if (items.length === 0) { toast('أدخل كمية صنف واحد على الأقل', 'error'); return; }

      const res = await act('purchase', request.id, {
        supplierId: supplierId || null,
        invoiceNumber: invoiceNumber || null,
        items,
      });

      if (res.rejected) {
        // The server refused it — keep the form open with the reason so the rep
        // can correct the quantity or raise a change request.
        setRejection(res.error ?? 'رُفضت العملية');
        toast(res.error ?? 'رُفضت العملية', 'error');
        return;
      }
      setRejection(null);
      toast(res.sent ? 'تم تسجيل الشراء' : 'حُفظ محلياً — سيُرسل عند عودة الشبكة',
        res.sent ? 'ok' : 'warn');
      onDone();
    } catch (err) { toast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <>
      {rejection && <div className="alert-box error" style={{ marginBottom: 12 }}>{rejection}</div>}
      <div className="field">
        <label className="label">المورد</label>
        <select className="select" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">— بدون —</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <div className="field">
        <label className="label">رقم الفاتورة</label>
        <input
          className="input ltr" value={invoiceNumber}
          onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="INV-0001"
        />
      </div>

      {(request.items ?? []).map((i: any) => {
        const unit = i.entered_unit
          ?? (i.base_unit === 'g' ? 'kg' : i.base_unit === 'ml' ? 'l' : 'piece');
        const approved = Number(i.approved_quantity ?? 0) / baseFactor(i.base_unit);
        const entered = Number(lines[i.item_id]?.qty ?? 0);
        const over = entered > approved + 1e-9;
        return (
          <div key={i.id} className="card" style={{ marginBottom: 10, background: 'var(--surface-2)' }}>
            <div className="row">
              <strong style={{ flex: 1 }}>{i.name_ar}</strong>
              <span className="badge gold">معتمد {approved} {unit}</span>
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <div style={{ flex: 1 }}>
                <label className="label">الكمية ({unit})</label>
                <input
                  className="input ltr" inputMode="decimal"
                  value={lines[i.item_id]?.qty ?? ''}
                  onChange={(e) => setLines((l) => ({
                    ...l, [i.item_id]: { ...l[i.item_id], qty: e.target.value },
                  }))}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label className="label">السعر / {unit}</label>
                <input
                  className="input ltr" inputMode="decimal"
                  value={lines[i.item_id]?.price ?? ''}
                  placeholder="0.00"
                  onChange={(e) => setLines((l) => ({
                    ...l, [i.item_id]: { ...l[i.item_id], price: e.target.value },
                  }))}
                />
              </div>
            </div>
            {over && (
              <div className="alert-box error" style={{ marginTop: 8 }}>
                الكمية تتجاوز المعتمد — سيرفضها النظام. استخدم «طلب تعديل».
              </div>
            )}
          </div>
        );
      })}

      <div className="row">
        <button className="btn success" disabled={busy} onClick={() => void submit()}>
          {busy ? '...' : 'حفظ الشراء'}
        </button>
        <button className="btn ghost" onClick={onCancel}>رجوع</button>
      </div>
      <p className="small faint" style={{ marginTop: 10 }}>
        صورة الفاتورة تُرفع بعد المزامنة من صفحة الطلب.
      </p>
    </>
  );
}

function ChangeRequestForm({
  request, toast, onDone, onCancel,
}: {
  request: any; toast: (t: string, k?: string) => void;
  onDone: () => void; onCancel: () => void;
}) {
  const [itemId, setItemId] = useState(request.items?.[0]?.item_id ?? '');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const item = (request.items ?? []).find((i: any) => i.item_id === itemId);
  const unit = item?.entered_unit
    ?? (item?.base_unit === 'g' ? 'kg' : item?.base_unit === 'ml' ? 'l' : 'piece');

  return (
    <>
      <div className="alert-box warn" style={{ marginBottom: 12 }}>
        سيعود الطلب لمدير الفرع لاعتماد الكمية الجديدة، ولن يظهر لك حتى يقرر.
      </div>
      <div className="field">
        <label className="label">الصنف</label>
        <select className="select" value={itemId} onChange={(e) => setItemId(e.target.value)}>
          {(request.items ?? []).map((i: any) => (
            <option key={i.item_id} value={i.item_id}>{i.name_ar}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="label">الكمية المطلوبة ({unit})</label>
        <input
          className="input ltr" inputMode="decimal" value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="label">السبب (إلزامي)</label>
        <textarea
          className="input" style={{ minHeight: 90 }} value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="مثال: العرض على 60 لتر أرخص للتر"
        />
      </div>
      <div className="row">
        <button
          className="btn primary"
          disabled={busy || !quantity || !reason.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              const res = await act('change_request', request.id, {
                changes: [{
                  itemId, requestedQuantity: Number(quantity), unit, reason: reason.trim(),
                }],
              });
              if (res.rejected) { toast(res.error ?? 'رُفضت العملية', 'error'); return; }
              toast(res.sent ? 'أُرسل الطلب للمدير' : 'حُفظ محلياً — سيُرسل عند عودة الشبكة',
                res.sent ? 'ok' : 'warn');
              onDone();
            } catch (err) { toast((err as Error).message, 'error'); }
            finally { setBusy(false); }
          }}
        >
          {busy ? '...' : 'إرسال للمدير'}
        </button>
        <button className="btn ghost" onClick={onCancel}>رجوع</button>
      </div>
    </>
  );
}
