import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { Empty, Modal, Spinner, useToast } from '../components/ui.js';
import { dateTime, riyal } from '../lib/format.js';

/** Customer directory, wallet and special prices. */
export function Customers() {
  const { can } = useSession();
  const { push } = useToast();
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState<any | null>(null);

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
    <>
      <div className="card">
        <h3 className="card-title">👥 العملاء</h3>
        <div className="row">
          <input
            className="input" value={term} autoFocus
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
            placeholder="ابحث بالاسم أو رقم الجوال أو رقم العميل"
          />
          <button className="btn primary" onClick={() => void search()} disabled={busy}>
            بحث
          </button>
        </div>
        {!can('customers.read.full_phone') && (
          <p className="small faint" style={{ marginTop: 8 }}>
            أرقام الجوال تظهر مُقنّعة — عرض الرقم كاملاً يتطلب صلاحية إضافية.
          </p>
        )}
      </div>

      {results.length > 0 && (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>الرقم</th><th>الاسم</th><th>الجوال</th><th>الزيارات</th>
                  <th>الطلبات</th><th>الإنفاق</th><th>متوسط الفاتورة</th>
                  <th>النقاط</th><th>آخر زيارة</th><th></th>
                </tr>
              </thead>
              <tbody>
                {results.map((c) => (
                  <tr key={c.id}>
                    <td className="num small">{c.customerCode}</td>
                    <td>{c.fullName ?? '—'}</td>
                    <td className="num small">{c.phone}</td>
                    <td className="num">{c.visitCount}</td>
                    <td className="num">{c.orderCount}</td>
                    <td className="num">{riyal(c.totalSpend)}</td>
                    <td className="num">{riyal(c.averageTicket)}</td>
                    <td className="num">
                      <span className="badge gold">{c.points}</span>
                    </td>
                    <td className="small faint">{dateTime(c.lastVisitAt)}</td>
                    <td>
                      <button
                        className="btn sm"
                        onClick={async () => {
                          const res = await api<{ customer: any }>(`/customers/${c.id}`);
                          setProfile(res.customer);
                        }}
                      >
                        الملف
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {results.length === 0 && !busy && (
        <Empty icon="🔍" text="ابدأ بالبحث عن عميل" />
      )}

      {profile && (
        <CustomerProfile
          customer={profile}
          onClose={() => setProfile(null)}
          onChanged={async () => {
            const res = await api<{ customer: any }>(`/customers/${profile.id}`);
            setProfile(res.customer);
          }}
        />
      )}
    </>
  );
}

function CustomerProfile({
  customer, onClose, onChanged,
}: { customer: any; onClose: () => void; onChanged: () => void }) {
  const { can } = useSession();
  const { push } = useToast();
  const [wallet, setWallet] = useState<any[]>([]);
  const [addingPrice, setAddingPrice] = useState(false);

  useEffect(() => {
    if (!can('customers.wallet.read')) return;
    api<{ transactions: any[] }>(`/customers/${customer.id}/wallet`)
      .then((r) => setWallet(r.transactions)).catch(() => {});
  }, [customer.id, can]);

  return (
    <Modal wide title={customer.fullName ?? customer.customerCode} onClose={onClose}>
      <div className="grid cols-4">
        <div className="stat">
          <div className="label">الزيارات</div><div className="value">{customer.visitCount}</div>
        </div>
        <div className="stat">
          <div className="label">إجمالي الإنفاق</div>
          <div className="value">{riyal(customer.totalSpend)}</div>
        </div>
        <div className="stat">
          <div className="label">متوسط الفاتورة</div>
          <div className="value">{riyal(customer.averageTicket)}</div>
        </div>
        <div className="stat">
          <div className="label">النقاط</div>
          <div className="value">{customer.points}</div>
          <div className="sub">= {riyal(customer.pointsValue)}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12, background: 'var(--surface-2)' }}>
        <div className="row small">
          <span className="muted">الجوال</span>
          <span className="spacer num">{customer.phone}</span>
          {customer.phoneVerified && <span className="badge green">مُوثّق</span>}
        </div>
        <div className="row small" style={{ marginTop: 6 }}>
          <span className="muted">الموافقة التسويقية</span>
          <span className="spacer" />
          <span className={`badge ${customer.marketingConsent.granted ? 'green' : ''}`}>
            {customer.marketingConsent.granted ? 'موافق' : 'غير موافق'}
          </span>
        </div>
        <div className="small faint" style={{ marginTop: 6 }}>
          توثيق رقم الجوال لا يُعتبر موافقة تسويقية — الاثنان مُسجَّلان بشكل منفصل.
        </div>
      </div>

      {customer.favouriteProducts?.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <h4 className="card-title">المنتجات المفضلة</h4>
          <div className="row wrap">
            {customer.favouriteProducts.map((p: any) => (
              <span key={p.id} className="badge gold">
                {p.name} × {Math.round(p.quantity)}
              </span>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <h4 className="card-title">
          الأسعار الخاصة
          {can('customers.special_prices.manage') && (
            <button className="btn sm spacer" onClick={() => setAddingPrice(true)}>
              + سعر خاص
            </button>
          )}
        </h4>
        {customer.specialPrices?.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>المنتج / التصنيف</th><th>السعر</th><th>يتطلب OTP</th><th></th></tr>
              </thead>
              <tbody>
                {customer.specialPrices.map((p: any) => (
                  <tr key={p.id}>
                    <td>{p.product_name ?? p.category_name ?? '—'}</td>
                    <td className="num">
                      {p.price != null ? riyal(p.price) : `${p.discount_percent}%`}
                    </td>
                    <td>
                      <span className={`badge ${p.requires_otp ? 'green' : 'amber'}`}>
                        {p.requires_otp ? 'نعم' : 'لا'}
                      </span>
                    </td>
                    <td>
                      {can('customers.special_prices.manage') && (
                        <button
                          className="btn ghost sm"
                          onClick={async () => {
                            await api(`/customers/special-prices/${p.id}`, { method: 'DELETE' });
                            push('تم إيقاف السعر الخاص', 'ok');
                            onChanged();
                          }}
                        >
                          إيقاف
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted small">لا توجد أسعار خاصة</p>}
      </div>

      {wallet.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <h4 className="card-title">سجل المحفظة</h4>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>النوع</th><th>النقاط</th><th>الرصيد بعدها</th>
                  <th>الفاتورة</th><th>بواسطة</th><th>التاريخ</th>
                </tr>
              </thead>
              <tbody>
                {wallet.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <span className={`badge ${t.points_delta > 0 ? 'green' : 'amber'}`}>
                        {t.kind === 'earn' ? 'اكتساب' : t.kind === 'redeem' ? 'استبدال' : t.kind}
                      </span>
                    </td>
                    <td className="num">{t.points_delta > 0 ? `+${t.points_delta}` : t.points_delta}</td>
                    <td className="num">{t.points_balance_after}</td>
                    <td className="num small faint">{t.order_number ?? '—'}</td>
                    <td className="small muted">{t.performed_by ?? '—'}</td>
                    <td className="small faint">{dateTime(t.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {addingPrice && (
        <SpecialPriceForm
          customerId={customer.id}
          onClose={() => setAddingPrice(false)}
          onSaved={async () => { setAddingPrice(false); onChanged(); }}
        />
      )}
    </Modal>
  );
}

function SpecialPriceForm({
  customerId, onClose, onSaved,
}: { customerId: string; onClose: () => void; onSaved: () => void }) {
  const { push } = useToast();
  const [products, setProducts] = useState<any[]>([]);
  const [productId, setProductId] = useState('');
  const [price, setPrice] = useState('');
  const [requiresOtp, setRequiresOtp] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ products: any[] }>('/menu').then((r) => setProducts(r.products)).catch(() => {});
  }, []);

  const selected = products.find((p) => p.id === productId);

  return (
    <Modal
      title="سعر خاص للعميل" onClose={onClose}
      footer={
        <button
          className="btn primary" disabled={busy || !productId || !price}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/customers/${customerId}/special-prices`, {
                method: 'POST',
                body: {
                  productId,
                  price: Math.round(Number(price) * 100),
                  requiresOtp,
                },
              });
              push('تم حفظ السعر الخاص', 'ok');
              onSaved();
            } catch (err) { push((err as Error).message, 'error'); }
            finally { setBusy(false); }
          }}
        >
          {busy ? '...' : 'حفظ'}
        </button>
      }
    >
      <div className="field">
        <label className="label">المنتج</label>
        <select className="select" value={productId} onChange={(e) => setProductId(e.target.value)}>
          <option value="">— اختر —</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.name} — {riyal(p.price)}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="label">
          السعر الخاص بالريال
          {selected && <span className="faint"> (السعر العام {riyal(selected.price)})</span>}
        </label>
        <input
          className="input ltr" inputMode="decimal" value={price}
          onChange={(e) => setPrice(e.target.value)} placeholder="45.00"
        />
      </div>
      <label className="row" style={{ cursor: 'pointer' }}>
        <input
          type="checkbox" checked={requiresOtp}
          onChange={(e) => setRequiresOtp(e.target.checked)}
        />
        <span>يتطلب رمز تحقق من العميل عند التطبيق</span>
      </label>
      <p className="small faint" style={{ marginTop: 8 }}>
        عند التفعيل لن يستطيع أي موظف تطبيق هذا السعر إلا بعد أن يعطيه العميل
        رمزاً يصله على واتساب.
      </p>
    </Modal>
  );
}
