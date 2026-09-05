import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { Empty, Modal, Spinner, useToast, ConfirmReason } from '../components/ui.js';
import { riyal } from '../lib/format.js';

interface Product {
  id: string; category_id: string; name: string; price: number;
  production_department: string; is_available: boolean;
  has_modifiers: boolean; has_variants: boolean; specialPrice: number | null;
}
interface Category { id: string; name: string }

interface CartLine {
  key: string;
  productId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  modifierOptionIds: string[];
  modifierNames: string[];
  modifiersTotal: number;
  notes: string | null;
  department: string;
}

const DEPT_LABEL: Record<string, string> = {
  BAR: 'بار', KITCHEN: 'مطبخ', SHISHA: 'معسل', OTHER: 'أخرى',
};

/**
 * Point of sale.
 *
 * Optimised for the fewest taps: pick a table, tap products, send. Items
 * without required options go straight into the cart; only items that need a
 * choice open a sheet. Prices are always the server's — nothing here can set
 * one.
 */
export function Pos() {
  const { tableId } = useParams();
  const { can } = useSession();
  const { push } = useToast();

  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [tables, setTables] = useState<any[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(tableId ?? null);
  const [customer, setCustomer] = useState<any | null>(null);
  const [openOrder, setOpenOrder] = useState<any | null>(null);
  const [optionsFor, setOptionsFor] = useState<Product | null>(null);
  const [showCustomer, setShowCustomer] = useState(false);
  const [showPay, setShowPay] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  const loadMenu = useCallback(async () => {
    try {
      const [menu, t] = await Promise.all([
        api<{ categories: Category[]; products: Product[] }>('/menu'),
        api<{ tables: any[] }>('/tables'),
      ]);
      setCategories(menu.categories);
      setProducts(menu.products);
      setTables(t.tables);
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [push]);

  useEffect(() => { void loadMenu(); }, [loadMenu]);

  // When a table is chosen, surface whatever is already open on it so items can
  // be added to the running bill rather than starting a second order.
  const loadOpenOrder = useCallback(async (id: string | null) => {
    if (!id) { setOpenOrder(null); return; }
    try {
      const res = await api<{ orders: any[] }>(`/orders?tableId=${id}`);
      const open = res.orders.find(
        (o) => !['paid', 'cancelled'].includes(o.status),
      );
      if (!open) { setOpenOrder(null); return; }
      const full = await api<{ order: any }>(`/orders/${open.id}`);
      setOpenOrder(full.order);
      if (full.order.customer_id && !customer) {
        try {
          const c = await api<{ customer: any }>(`/customers/${full.order.customer_id}`);
          setCustomer(c.customer);
        } catch { /* staff may lack customer read */ }
      }
    } catch { setOpenOrder(null); }
  }, [customer]);

  useEffect(() => { void loadOpenOrder(selectedTable); }, [selectedTable, loadOpenOrder]);

  const filtered = useMemo(() => products.filter((p) => {
    if (search) {
      return p.name.toLowerCase().includes(search.toLowerCase());
    }
    return activeCategory === 'all' || p.category_id === activeCategory;
  }), [products, activeCategory, search]);

  const addToCart = (
    product: Product,
    modifierOptionIds: string[] = [],
    modifierNames: string[] = [],
    modifiersTotal = 0,
    notes: string | null = null,
  ) => {
    // Identical configurations stack rather than filling the cart with
    // duplicate lines.
    const key = `${product.id}:${[...modifierOptionIds].sort().join(',')}:${notes ?? ''}`;
    setCart((current) => {
      const existing = current.find((l) => l.key === key);
      if (existing) {
        return current.map((l) => l.key === key ? { ...l, quantity: l.quantity + 1 } : l);
      }
      return [...current, {
        key, productId: product.id, name: product.name,
        unitPrice: product.price, quantity: 1,
        modifierOptionIds, modifierNames, modifiersTotal, notes,
        department: product.production_department,
      }];
    });
  };

  const onProductTap = async (product: Product) => {
    if (!product.is_available) return;
    if (product.has_modifiers || product.has_variants) {
      setOptionsFor(product);
      return;
    }
    addToCart(product);
  };

  const cartTotal = cart.reduce(
    (sum, l) => sum + (l.unitPrice + l.modifiersTotal) * l.quantity, 0,
  );

  const send = async () => {
    if (cart.length === 0) return;
    setSending(true);
    try {
      const lines = cart.map((l) => ({
        productId: l.productId,
        quantity: l.quantity,
        modifierOptionIds: l.modifierOptionIds,
        notes: l.notes,
      }));

      if (openOrder) {
        await api(`/orders/${openOrder.id}/items`, { method: 'POST', body: { lines } });
        push('تمت إضافة الأصناف وطباعة ADD ITEM', 'ok');
      } else {
        // The idempotency key makes a retry on a flaky connection safe: the
        // server returns the original order instead of creating a second one.
        await api('/orders', {
          method: 'POST',
          idempotencyKey: `pos-${crypto.randomUUID()}`,
          body: {
            tableId: selectedTable, customerId: customer?.id ?? null, lines,
          },
        });
        push('تم إرسال الطلب للأقسام', 'ok');
      }
      setCart([]);
      await loadOpenOrder(selectedTable);
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'تعذّر إرسال الطلب', 'error');
    } finally {
      setSending(false);
    }
  };

  if (loading) return <Spinner label="جارٍ تحميل المنيو…" />;

  return (
    <div className="pos">
      <div className="pos-menu">
        <div className="row">
          <select
            className="select" style={{ maxWidth: 200 }}
            value={selectedTable ?? ''}
            onChange={(e) => setSelectedTable(e.target.value || null)}
          >
            <option value="">بدون طاولة (سفري)</option>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                طاولة {t.table_number}{t.status !== 'available' ? ' • مشغولة' : ''}
              </option>
            ))}
          </select>
          <input
            className="input" placeholder="بحث في المنيو…"
            value={search} onChange={(e) => setSearch(e.target.value)}
          />
          {can('customers.read') && (
            <button className="btn" onClick={() => setShowCustomer(true)}>
              {customer ? `🎫 ${customer.fullName ?? customer.customerCode}` : '👤 عميل'}
            </button>
          )}
        </div>

        {!search && (
          <div className="category-bar">
            <button
              className={`chip${activeCategory === 'all' ? ' active' : ''}`}
              onClick={() => setActiveCategory('all')}
            >
              الكل
            </button>
            {categories.map((c) => (
              <button
                key={c.id}
                className={`chip${activeCategory === c.id ? ' active' : ''}`}
                onClick={() => setActiveCategory(c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}

        <div className="product-grid">
          {filtered.map((p) => (
            <button
              key={p.id}
              className={`product-tile${p.is_available ? '' : ' unavailable'}`}
              onClick={() => void onProductTap(p)}
              disabled={!p.is_available}
            >
              <div className="name">{p.name}</div>
              <div className="dept">{DEPT_LABEL[p.production_department]}</div>
              {p.specialPrice != null ? (
                <div className="price">
                  <span className="struck">{riyal(p.price)}</span>{' '}
                  <span className="special">{riyal(p.specialPrice)}</span>
                </div>
              ) : (
                <div className="price">{riyal(p.price)}</div>
              )}
              {!p.is_available && <span className="badge red">غير متوفر</span>}
            </button>
          ))}
          {filtered.length === 0 && <Empty icon="🔍" text="لا توجد منتجات" />}
        </div>
      </div>

      <aside className="cart">
        <div className="cart-header row">
          <strong>{openOrder ? `طلب ${openOrder.order_number}` : 'طلب جديد'}</strong>
          <div className="spacer" />
          {cart.length > 0 && (
            <button className="btn ghost sm" onClick={() => setCart([])}>تفريغ</button>
          )}
        </div>

        <div className="cart-lines">
          {openOrder && (
            <div className="card" style={{ marginBottom: 10, background: 'var(--surface-2)' }}>
              <div className="small muted">أصناف مُرسلة سابقاً</div>
              {openOrder.items
                .filter((i: any) => i.status !== 'voided')
                .map((i: any) => (
                  <div key={i.id} className="row small" style={{ marginTop: 6 }}>
                    <span>{i.quantity}× {i.product_name_ar}</span>
                    <span className="spacer num">{riyal(i.line_total)}</span>
                  </div>
                ))}
              <div className="row" style={{ marginTop: 8 }}>
                <strong className="num">{riyal(openOrder.grand_total)}</strong>
                <div className="spacer" />
                {can('payments.take') && (
                  <button className="btn success sm" onClick={() => setShowPay(true)}>
                    الدفع
                  </button>
                )}
              </div>
            </div>
          )}

          {cart.length === 0 && !openOrder && <Empty icon="🧾" text="اختر أصنافاً من المنيو" />}

          {cart.map((line) => (
            <div key={line.key} className="cart-line">
              <div className="row">
                <span className="name">{line.name}</span>
                <span className="num">{riyal((line.unitPrice + line.modifiersTotal) * line.quantity)}</span>
              </div>
              {line.modifierNames.length > 0 && (
                <div className="mods">{line.modifierNames.join(' • ')}</div>
              )}
              {line.notes && <div className="note">📝 {line.notes}</div>}
              <div className="row" style={{ marginTop: 8 }}>
                <div className="qty">
                  <button onClick={() => setCart((c) => c
                    .map((l) => l.key === line.key ? { ...l, quantity: l.quantity - 1 } : l)
                    .filter((l) => l.quantity > 0))}
                  >−</button>
                  <span className="value">{line.quantity}</span>
                  <button onClick={() => setCart((c) => c.map(
                    (l) => l.key === line.key ? { ...l, quantity: l.quantity + 1 } : l,
                  ))}>+</button>
                </div>
                <div className="spacer" />
                <button
                  className="btn ghost sm"
                  onClick={() => setCart((c) => c.filter((l) => l.key !== line.key))}
                >
                  حذف
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="cart-footer">
          {customer && (
            <div className="row small" style={{ marginBottom: 8 }}>
              <span className="muted">العميل</span>
              <span className="spacer" />
              <strong>{customer.fullName ?? customer.customerCode}</strong>
              <span className="badge gold">{customer.points} نقطة</span>
            </div>
          )}
          <div className="total-row">
            <span>الأصناف الجديدة</span>
            <span className="amount">{riyal(cartTotal)}</span>
          </div>
          {openOrder && (
            <div className="total-row">
              <span>المُرسل سابقاً</span>
              <span className="amount">{riyal(openOrder.grand_total)}</span>
            </div>
          )}
          <div className="total-row grand">
            <span>الإجمالي</span>
            <span className="amount">
              {riyal(cartTotal + (openOrder?.grand_total ?? 0))}
            </span>
          </div>
          <button
            className="btn primary block lg"
            disabled={cart.length === 0 || sending}
            onClick={() => void send()}
          >
            {sending ? '...' : openOrder ? 'إضافة وطباعة' : 'إرسال للأقسام'}
          </button>
        </div>
      </aside>

      {optionsFor && (
        <OptionsSheet
          product={optionsFor}
          onClose={() => setOptionsFor(null)}
          onAdd={(optionIds, names, total, notes) => {
            addToCart(optionsFor, optionIds, names, total, notes);
            setOptionsFor(null);
          }}
        />
      )}

      {showCustomer && (
        <CustomerPicker
          onClose={() => setShowCustomer(false)}
          onPick={(c) => { setCustomer(c); setShowCustomer(false); }}
        />
      )}

      {showPay && openOrder && (
        <PaymentSheet
          order={openOrder}
          customer={customer}
          onClose={() => setShowPay(false)}
          onDone={async () => {
            setShowPay(false);
            setCustomer(null);
            await loadOpenOrder(selectedTable);
          }}
        />
      )}
    </div>
  );
}

/** Modifier and size picker. Required groups must be answered before adding. */
function OptionsSheet({
  product, onClose, onAdd,
}: {
  product: Product;
  onClose: () => void;
  onAdd: (optionIds: string[], names: string[], total: number, notes: string | null) => void;
}) {
  const [data, setData] = useState<any | null>(null);
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState('');

  useEffect(() => {
    api<any>(`/menu/products/${product.id}/options`).then((d) => {
      setData(d);
      // Pre-select defaults so the common case is a single tap.
      const initial: Record<string, string[]> = {};
      for (const m of d.modifiers) {
        const def = m.options.find((o: any) => o.is_default);
        if (def) initial[m.id] = [def.id];
      }
      setChosen(initial);
    }).catch(() => {});
  }, [product.id]);

  if (!data) {
    return <Modal title={product.name} onClose={onClose}><Spinner /></Modal>;
  }

  const missing = data.modifiers.filter(
    (m: any) => m.is_required && (chosen[m.id]?.length ?? 0) === 0,
  );

  const selectedIds = Object.values(chosen).flat();
  const total = data.modifiers.flatMap((m: any) => m.options)
    .filter((o: any) => selectedIds.includes(o.id))
    .reduce((s: number, o: any) => s + o.price_delta, 0);
  const names = data.modifiers.flatMap((m: any) => m.options)
    .filter((o: any) => selectedIds.includes(o.id))
    .map((o: any) => o.name);

  return (
    <Modal
      title={product.name}
      onClose={onClose}
      footer={
        <button
          className="btn primary block lg"
          disabled={missing.length > 0}
          onClick={() => onAdd(selectedIds, names, total, notes.trim() || null)}
        >
          {missing.length > 0
            ? `اختر: ${missing.map((m: any) => m.name).join('، ')}`
            : `إضافة — ${riyal(product.price + total)}`}
        </button>
      }
    >
      {data.modifiers.map((m: any) => (
        <div key={m.id} className="field">
          <label className="label">
            {m.name}
            {m.is_required && <span className="badge red" style={{ marginInlineStart: 6 }}>إلزامي</span>}
          </label>
          <div className="row wrap">
            {m.options.map((o: any) => {
              const active = chosen[m.id]?.includes(o.id) ?? false;
              return (
                <button
                  key={o.id}
                  className={`chip${active ? ' active' : ''}`}
                  onClick={() => setChosen((c) => {
                    const currentForGroup = c[m.id] ?? [];
                    if (m.selection === 'single') {
                      return { ...c, [m.id]: active ? [] : [o.id] };
                    }
                    return {
                      ...c,
                      [m.id]: active
                        ? currentForGroup.filter((id) => id !== o.id)
                        : [...currentForGroup, o.id],
                    };
                  })}
                >
                  {o.name}
                  {o.price_delta !== 0 && ` (+${riyal(o.price_delta)})`}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="field">
        <label className="label">ملاحظات للمطبخ / البار</label>
        <textarea
          className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="مثال: بدون ثلج"
        />
      </div>
    </Modal>
  );
}

function CustomerPicker({
  onClose, onPick,
}: { onClose: () => void; onPick: (c: any) => void }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const { push } = useToast();

  const search = async () => {
    if (term.trim().length < 2) return;
    setBusy(true);
    try {
      const res = await api<{ customers: any[] }>(
        `/customers/search?term=${encodeURIComponent(term.trim())}`,
      );
      setResults(res.customers);
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <Modal title="اختيار العميل" onClose={onClose}>
      <div className="row" style={{ marginBottom: 12 }}>
        <input
          className="input" value={term} autoFocus
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
          placeholder="الاسم أو رقم الجوال أو رقم العميل"
        />
        <button className="btn primary" onClick={() => void search()} disabled={busy}>
          بحث
        </button>
      </div>

      {results.map((c) => (
        <button
          key={c.id} className="btn block"
          style={{ justifyContent: 'flex-start', marginBottom: 8 }}
          onClick={() => onPick(c)}
        >
          <div style={{ textAlign: 'start' }}>
            <div>{c.fullName ?? c.customerCode}</div>
            <div className="small faint num">{c.phone} · {c.points} نقطة</div>
          </div>
        </button>
      ))}
      {results.length === 0 && !busy && (
        <p className="muted small">
          ابحث بالاسم أو الجوال. رقم الجوال يظهر مُقنّعاً إن لم تكن لديك صلاحية عرضه كاملاً.
        </p>
      )}
    </Modal>
  );
}

/**
 * Payment, discounts and points — each protected step routed through the
 * server's OTP flow. The UI never applies a price itself.
 */
function PaymentSheet({
  order, customer, onClose, onDone,
}: { order: any; customer: any | null; onClose: () => void; onDone: () => void }) {
  const { can } = useSession();
  const { push } = useToast();
  const [method, setMethod] = useState<'cash' | 'mada' | 'visa' | 'mastercard' | 'apple_pay'>('mada');
  const [tendered, setTendered] = useState('');
  const [busy, setBusy] = useState(false);
  const [total, setTotal] = useState(order.grand_total);
  const [otpFlow, setOtpFlow] = useState<null | {
    kind: 'discount' | 'points';
    otpRequestId: string; operationRef: string; hint: string; points?: number;
  }>(null);
  const [otpCode, setOtpCode] = useState('');

  const outstanding = total - (order.paid_total ?? 0);

  const requestDiscountOtp = async () => {
    if (!customer) return;
    setBusy(true);
    try {
      const res = await api<any>(`/orders/${order.id}/discount/request-otp`, {
        method: 'POST', body: { customerId: customer.id },
      });
      setOtpFlow({
        kind: 'discount',
        otpRequestId: res.otpRequestId,
        operationRef: res.operationRef,
        hint: `خصم ${riyal(res.preview.totalDiscount)} — أُرسل رمز تحقق لجوال العميل`,
      });
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  const requestPointsOtp = async (points: number) => {
    if (!customer) return;
    setBusy(true);
    try {
      const res = await api<any>(`/orders/${order.id}/points/request-otp`, {
        method: 'POST', body: { customerId: customer.id, points },
      });
      setOtpFlow({
        kind: 'points',
        otpRequestId: res.otpRequestId,
        operationRef: res.operationRef,
        points,
        hint: `${points} نقطة = ${riyal(res.value)} — أُرسل رمز تحقق لجوال العميل`,
      });
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  const confirmOtp = async () => {
    if (!otpFlow || !customer) return;
    setBusy(true);
    try {
      const url = otpFlow.kind === 'discount'
        ? `/orders/${order.id}/discount/apply`
        : `/orders/${order.id}/points/redeem`;
      const res = await api<any>(url, {
        method: 'POST',
        body: {
          customerId: customer.id,
          otpRequestId: otpFlow.otpRequestId,
          operationRef: otpFlow.operationRef,
          code: otpCode,
        },
      });
      setTotal(res.grandTotal);
      setOtpFlow(null);
      setOtpCode('');
      push(otpFlow.kind === 'discount' ? 'تم تطبيق السعر الخاص' : 'تم خصم النقاط', 'ok');
    } catch (err) {
      push((err as Error).message, 'error');
    } finally { setBusy(false); }
  };

  const pay = async () => {
    setBusy(true);
    try {
      const res = await api<any>(`/orders/${order.id}/pay`, {
        method: 'POST',
        idempotencyKey: `pay-${order.id}-${crypto.randomUUID()}`,
        body: {
          parts: [{
            method,
            amount: outstanding,
            tendered: method === 'cash' && tendered
              ? Math.round(Number(tendered) * 100) : null,
          }],
        },
      });
      if (res.changeGiven > 0) push(`الباقي: ${riyal(res.changeGiven)}`, 'ok');
      if (res.pointsEarned > 0) push(`العميل كسب ${res.pointsEarned} نقطة`, 'ok');
      push('تم الدفع وإقفال الفاتورة', 'ok');
      onDone();
    } catch (err) {
      push((err as Error).message, 'error');
    } finally { setBusy(false); }
  };

  if (otpFlow) {
    return (
      <Modal title="تحقق العميل" onClose={() => setOtpFlow(null)}>
        <div className="alert-box info">{otpFlow.hint}</div>
        <p className="muted small">
          اطلب من العميل الرمز الذي وصله على واتساب، ثم أدخله هنا. لا يمكن تطبيق
          الخصم أو استخدام النقاط بدون هذا التحقق.
        </p>
        <div className="field">
          <label className="label">رمز التحقق</label>
          <input
            className="input ltr" inputMode="numeric" autoFocus value={otpCode}
            onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
            placeholder="000000"
          />
        </div>
        <button
          className="btn primary block lg" disabled={busy || otpCode.length < 4}
          onClick={() => void confirmOtp()}
        >
          {busy ? '...' : 'تحقق وتطبيق'}
        </button>
      </Modal>
    );
  }

  return (
    <Modal title={`الدفع — ${order.order_number}`} onClose={onClose}>
      <div className="total-row grand">
        <span>المستحق</span>
        <span className="amount">{riyal(outstanding)}</span>
      </div>

      {customer && (
        <div className="card" style={{ background: 'var(--surface-2)', marginBottom: 12 }}>
          <div className="row">
            <strong>{customer.fullName ?? customer.customerCode}</strong>
            <span className="spacer" />
            <span className="badge gold">{customer.points} نقطة</span>
          </div>
          <div className="row wrap" style={{ marginTop: 10 }}>
            {can('orders.discount.apply') && (
              <button className="btn sm" disabled={busy} onClick={() => void requestDiscountOtp()}>
                تطبيق سعر العميل الخاص
              </button>
            )}
            {can('customers.points.redeem') && customer.points >= 100 && (
              <button className="btn sm" disabled={busy} onClick={() => void requestPointsOtp(100)}>
                استخدام 100 نقطة
              </button>
            )}
          </div>
          <div className="small faint" style={{ marginTop: 6 }}>
            كل عملية منهما تتطلب رمز تحقق مستقلاً يصل لجوال العميل.
          </div>
        </div>
      )}

      <div className="field">
        <label className="label">طريقة الدفع</label>
        <div className="row wrap">
          {([
            ['cash', 'نقدي'], ['mada', 'مدى'], ['visa', 'فيزا'],
            ['mastercard', 'ماستركارد'], ['apple_pay', 'Apple Pay'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              className={`chip${method === value ? ' active' : ''}`}
              onClick={() => setMethod(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {method === 'cash' && (
        <div className="field">
          <label className="label">المبلغ المستلم</label>
          <input
            className="input ltr" inputMode="decimal" value={tendered}
            onChange={(e) => setTendered(e.target.value)}
            placeholder={(outstanding / 100).toFixed(2)}
          />
          {tendered && Number(tendered) * 100 > outstanding && (
            <div className="small" style={{ color: 'var(--green)', marginTop: 4 }}>
              الباقي: {riyal(Math.round(Number(tendered) * 100) - outstanding)}
            </div>
          )}
        </div>
      )}

      <button className="btn success block lg" disabled={busy} onClick={() => void pay()}>
        {busy ? '...' : `تأكيد الدفع ${riyal(outstanding)}`}
      </button>
    </Modal>
  );
}
