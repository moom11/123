import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError, setTokens } from '../lib/api.js';
import { Empty, Modal, Spinner, useToast } from '../components/ui.js';
import { riyal } from '../lib/format.js';

interface CartLine {
  key: string; productId: string; name: string; unitPrice: number;
  quantity: number; modifierOptionIds: string[]; modifierNames: string[];
  modifiersTotal: number; notes: string | null;
}

/**
 * The guest's phone.
 *
 * The table comes from the scanned QR alone — never typed, never editable —
 * and the order goes to the responsible waiter for confirmation before it
 * reaches any printer. Browsing needs no account; sending an order does.
 */
export function CustomerMenu() {
  const { qrValue = '' } = useParams();
  const { push } = useToast();

  const [data, setData] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [category, setCategory] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [customer, setCustomer] = useState<any | null>(null);
  const [optionsFor, setOptionsFor] = useState<any | null>(null);
  const [showCart, setShowCart] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [wallet, setWallet] = useState<any | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<any>(`/public/menu/${encodeURIComponent(qrValue)}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذّر تحميل المنيو');
    }
  }, [qrValue]);

  useEffect(() => { void load(); }, [load]);

  const loadWallet = useCallback(async () => {
    try { setWallet(await api<any>('/public/me/wallet')); } catch { /* not verified */ }
  }, []);

  if (error) {
    return (
      <div className="menu-page">
        <div className="menu-hero"><div className="mark">MARA</div></div>
        <div className="alert-box" style={{ margin: 16 }}>{error}</div>
        <p className="center muted small">
          امسح رمز QR الموجود على طاولتك مرة أخرى.
        </p>
      </div>
    );
  }
  if (!data) return <Spinner label="جارٍ تحميل المنيو…" />;

  const products = data.menu.products.filter((p: any) => {
    if (search) return p.name.toLowerCase().includes(search.toLowerCase());
    return category === 'all' || p.category_id === category;
  });

  const cartTotal = cart.reduce(
    (s, l) => s + (l.unitPrice + l.modifiersTotal) * l.quantity, 0,
  );
  const cartCount = cart.reduce((s, l) => s + l.quantity, 0);

  const addToCart = (
    product: any, optionIds: string[] = [], names: string[] = [],
    modsTotal = 0, notes: string | null = null,
  ) => {
    const price = product.specialPrice ?? product.price;
    const key = `${product.id}:${[...optionIds].sort().join(',')}:${notes ?? ''}`;
    setCart((c) => {
      const existing = c.find((l) => l.key === key);
      if (existing) {
        return c.map((l) => l.key === key ? { ...l, quantity: l.quantity + 1 } : l);
      }
      return [...c, {
        key, productId: product.id, name: product.name, unitPrice: price,
        quantity: 1, modifierOptionIds: optionIds, modifierNames: names,
        modifiersTotal: modsTotal, notes,
      }];
    });
    push(`أُضيف ${product.name}`, 'ok');
  };

  const serviceRequest = async (kind: 'waiter' | 'charcoal' | 'bill') => {
    try {
      const res = await api<any>('/public/service-request', {
        method: 'POST', body: { qrValue, kind },
      });
      push(res.message, res.deduplicated ? 'warn' : 'ok');
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'تعذّر إرسال الطلب', 'error');
    }
  };

  const sendOrder = async () => {
    if (!customer) { setVerifying(true); return; }
    try {
      const res = await api<any>('/public/orders', {
        method: 'POST',
        body: {
          qrValue,
          lines: cart.map((l) => ({
            productId: l.productId, quantity: l.quantity,
            modifierOptionIds: l.modifierOptionIds, notes: l.notes,
          })),
          idempotencyKey: `guest-${crypto.randomUUID()}`,
        },
      });
      push(res.message ?? 'تم إرسال طلبك', 'ok');
      setCart([]);
      setShowCart(false);
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'تعذّر إرسال الطلب', 'error');
    }
  };

  return (
    <div className="menu-page">
      <div className="menu-hero">
        <div className="mark">MARA</div>
        <div className="table">
          {data.table.branchName} — طاولة <strong>{data.table.number}</strong>
        </div>
        {customer && (
          <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
            <span className="badge gold">
              {wallet?.points ?? 0} نقطة
              {wallet?.pointsValue ? ` = ${riyal(wallet.pointsValue)}` : ''}
            </span>
          </div>
        )}
      </div>

      <div className="service-buttons">
        <button className="btn" onClick={() => void serviceRequest('waiter')}>🙋 طلب ويتر</button>
        <button className="btn" onClick={() => void serviceRequest('charcoal')}>🔥 طلب فحم</button>
        <button className="btn" onClick={() => void serviceRequest('bill')}>🧾 طلب الحساب</button>
      </div>

      <div style={{ padding: '0 16px 12px' }}>
        <input
          className="input" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="ابحث في المنيو…"
        />
      </div>

      {!search && (
        <div className="category-bar" style={{ padding: '0 16px 12px' }}>
          <button
            className={`chip${category === 'all' ? ' active' : ''}`}
            onClick={() => setCategory('all')}
          >
            الكل
          </button>
          {data.menu.categories.map((c: any) => (
            <button
              key={c.id} className={`chip${category === c.id ? ' active' : ''}`}
              onClick={() => setCategory(c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      {products.length === 0 && <Empty icon="🔍" text="لا توجد أصناف" />}

      {products.map((p: any) => (
        <div
          key={p.id}
          className={`menu-item${p.is_available ? '' : ' sold-out'}`}
          onClick={() => {
            if (!p.is_available) return;
            if (p.has_modifiers || p.has_variants) setOptionsFor(p);
            else addToCart(p);
          }}
        >
          <div className="info">
            <div className="name">{p.name}</div>
            {p.description && <div className="desc">{p.description}</div>}
            {!p.is_available && <span className="badge red">غير متوفر حالياً</span>}
          </div>
          <div className="price">
            {p.specialPrice != null ? (
              <>
                <div className="small" style={{
                  textDecoration: 'line-through', color: 'var(--text-faint)',
                }}>
                  {riyal(p.price)}
                </div>
                <div style={{ color: 'var(--green)' }}>{riyal(p.specialPrice)}</div>
              </>
            ) : riyal(p.price)}
          </div>
        </div>
      ))}

      {cartCount > 0 && (
        <div className="sticky-cart">
          <div>
            <div style={{ fontWeight: 700 }}>{cartCount} صنف</div>
            <div className="num" style={{ color: 'var(--gold)' }}>{riyal(cartTotal)}</div>
          </div>
          <button className="btn primary spacer lg" onClick={() => setShowCart(true)}>
            مراجعة الطلب
          </button>
        </div>
      )}

      {optionsFor && (
        <GuestOptions
          product={optionsFor}
          onClose={() => setOptionsFor(null)}
          onAdd={(ids, names, total, notes) => {
            addToCart(optionsFor, ids, names, total, notes);
            setOptionsFor(null);
          }}
        />
      )}

      {showCart && (
        <Modal
          title="طلبك" onClose={() => setShowCart(false)}
          footer={
            <button
              className="btn primary block lg"
              disabled={cart.length === 0}
              onClick={() => void sendOrder()}
            >
              {customer ? `إرسال الطلب — ${riyal(cartTotal)}` : 'تسجيل الجوال وإرسال الطلب'}
            </button>
          }
        >
          {cart.map((l) => (
            <div key={l.key} className="cart-line">
              <div className="row">
                <span className="name">{l.name}</span>
                <span className="num">{riyal((l.unitPrice + l.modifiersTotal) * l.quantity)}</span>
              </div>
              {l.modifierNames.length > 0 && (
                <div className="mods">{l.modifierNames.join(' • ')}</div>
              )}
              {l.notes && <div className="note">📝 {l.notes}</div>}
              <div className="qty" style={{ marginTop: 8 }}>
                <button onClick={() => setCart((c) => c
                  .map((x) => x.key === l.key ? { ...x, quantity: x.quantity - 1 } : x)
                  .filter((x) => x.quantity > 0))}
                >−</button>
                <span className="value">{l.quantity}</span>
                <button onClick={() => setCart((c) => c.map(
                  (x) => x.key === l.key ? { ...x, quantity: x.quantity + 1 } : x,
                ))}>+</button>
              </div>
            </div>
          ))}
          {cart.length === 0 && <Empty icon="🧾" text="سلتك فارغة" />}
          <div className="alert-box info" style={{ marginTop: 12 }}>
            سيصل طلبك للويتر المسؤول عن طاولتك لمراجعته وتأكيده قبل تحضيره.
          </div>
        </Modal>
      )}

      {verifying && (
        <VerifyPhone
          qrValue={qrValue}
          onClose={() => setVerifying(false)}
          onVerified={async (c) => {
            setCustomer(c);
            setVerifying(false);
            await loadWallet();
            await load();
            push(`أهلاً ${c.name ?? ''}`, 'ok');
          }}
        />
      )}
    </div>
  );
}

function GuestOptions({
  product, onClose, onAdd,
}: {
  product: any; onClose: () => void;
  onAdd: (ids: string[], names: string[], total: number, notes: string | null) => void;
}) {
  const [data, setData] = useState<any | null>(null);
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState('');

  useEffect(() => {
    api<any>(`/public/products/${product.id}/options`).then((d) => {
      setData(d);
      const initial: Record<string, string[]> = {};
      for (const m of d.modifiers) {
        const def = m.options.find((o: any) => o.is_default);
        if (def) initial[m.id] = [def.id];
      }
      setChosen(initial);
    }).catch(() => {});
  }, [product.id]);

  if (!data) return <Modal title={product.name} onClose={onClose}><Spinner /></Modal>;

  const missing = data.modifiers.filter(
    (m: any) => m.is_required && (chosen[m.id]?.length ?? 0) === 0,
  );
  const ids = Object.values(chosen).flat();
  const allOptions = data.modifiers.flatMap((m: any) => m.options);
  const total = allOptions.filter((o: any) => ids.includes(o.id))
    .reduce((s: number, o: any) => s + o.price_delta, 0);
  const names = allOptions.filter((o: any) => ids.includes(o.id)).map((o: any) => o.name);
  const base = product.specialPrice ?? product.price;

  return (
    <Modal
      title={product.name} onClose={onClose}
      footer={
        <button
          className="btn primary block lg" disabled={missing.length > 0}
          onClick={() => onAdd(ids, names, total, notes.trim() || null)}
        >
          {missing.length > 0
            ? `اختر: ${missing.map((m: any) => m.name).join('، ')}`
            : `إضافة — ${riyal(base + total)}`}
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
                  key={o.id} className={`chip${active ? ' active' : ''}`}
                  onClick={() => setChosen((c) => {
                    const group = c[m.id] ?? [];
                    if (m.selection === 'single') {
                      return { ...c, [m.id]: active ? [] : [o.id] };
                    }
                    return {
                      ...c,
                      [m.id]: active ? group.filter((x) => x !== o.id) : [...group, o.id],
                    };
                  })}
                >
                  {o.name}{o.price_delta !== 0 && ` (+${riyal(o.price_delta)})`}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="field">
        <label className="label">ملاحظات</label>
        <textarea
          className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="مثال: بدون ثلج"
        />
      </div>
    </Modal>
  );
}

/** Phone verification over WhatsApp. Marketing consent is asked separately. */
function VerifyPhone({
  qrValue, onClose, onVerified,
}: { qrValue: string; onClose: () => void; onVerified: (c: any) => void }) {
  const { push } = useToast();
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [consent, setConsent] = useState(false);
  const [otpRequestId, setOtpRequestId] = useState('');
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);

  const request = async () => {
    setBusy(true);
    try {
      const res = await api<any>('/public/auth/request-otp', {
        method: 'POST', body: { phone, qrValue },
      });
      setOtpRequestId(res.otpRequestId);
      setHint(res.phoneHint);
      setStage('code');
      push('أُرسل رمز التحقق على واتساب', 'ok');
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'تعذّر إرسال الرمز', 'error');
    } finally { setBusy(false); }
  };

  const verify = async () => {
    setBusy(true);
    try {
      const res = await api<any>('/public/auth/verify-otp', {
        method: 'POST',
        body: {
          otpRequestId, code, qrValue,
          name: name.trim() || null,
          marketingConsent: consent,
        },
      });
      setTokens({ accessToken: res.accessToken, refreshToken: res.refreshToken });
      onVerified(res.customer);
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'رمز غير صحيح', 'error');
      setCode('');
    } finally { setBusy(false); }
  };

  return (
    <Modal title="تأكيد رقم الجوال" onClose={onClose}>
      {stage === 'phone' ? (
        <>
          <p className="muted small">
            لإرسال طلبك نحتاج توثيق رقم جوالك عبر واتساب. تصفّح المنيو لا يحتاج
            تسجيلاً.
          </p>
          <div className="field">
            <label className="label">الاسم (اختياري)</label>
            <input
              className="input" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="خالد"
            />
          </div>
          <div className="field">
            <label className="label">رقم الجوال</label>
            <input
              className="input ltr" inputMode="tel" value={phone} autoFocus
              onChange={(e) => setPhone(e.target.value)}
              placeholder="05xxxxxxxx"
            />
          </div>
          <label className="row" style={{ cursor: 'pointer', marginBottom: 12 }}>
            <input
              type="checkbox" checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span className="small">أوافق على استقبال عروض مارا عبر واتساب</span>
          </label>
          <p className="small faint">
            توثيق الرقم لإرسال الطلب لا يعني موافقتك على العروض التسويقية — الموافقة
            أعلاه اختيارية ويمكن سحبها لاحقاً.
          </p>
          <button
            className="btn primary block lg" disabled={busy || phone.length < 9}
            onClick={() => void request()}
          >
            {busy ? '...' : 'إرسال رمز التحقق'}
          </button>
        </>
      ) : (
        <>
          <p className="muted small">أُرسل الرمز إلى {hint} عبر واتساب.</p>
          <div className="field">
            <label className="label">رمز التحقق</label>
            <input
              className="input ltr" inputMode="numeric" value={code} autoFocus
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
              placeholder="000000"
              style={{ fontSize: 24, letterSpacing: 6, textAlign: 'center' }}
            />
          </div>
          <button
            className="btn primary block lg" disabled={busy || code.length < 4}
            onClick={() => void verify()}
          >
            {busy ? '...' : 'تأكيد'}
          </button>
          <button
            className="btn ghost block" style={{ marginTop: 8 }}
            onClick={() => { setStage('phone'); setCode(''); }}
          >
            تغيير الرقم
          </button>
        </>
      )}
    </Modal>
  );
}
