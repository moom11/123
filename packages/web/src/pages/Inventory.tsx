import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { Empty, Modal, Spinner, useToast } from '../components/ui.js';
import { dateTime, quantity, riyal } from '../lib/format.js';

const WASTE_REASONS: Array<[string, string]> = [
  ['expired', 'منتهي الصلاحية'], ['damaged', 'تالف'], ['preparation_error', 'خطأ تحضير'],
  ['dropped', 'سقوط'], ['customer_return', 'إرجاع عميل'], ['trial', 'تجربة'],
  ['staff_consumption', 'استهلاك موظفين'], ['overuse', 'استخدام زائد'], ['other', 'أخرى'],
];

/** Stock, waste and counting. Departments use this from a phone or a shared tablet. */
export function Inventory() {
  const { can } = useSession();
  const { push } = useToast();
  const [tab, setTab] = useState<'stock' | 'waste' | 'counts'>('stock');
  const [stock, setStock] = useState<any[]>([]);
  const [waste, setWaste] = useState<any[]>([]);
  const [counts, setCounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [recordingWaste, setRecordingWaste] = useState(false);
  const [countDetail, setCountDetail] = useState<any | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, w, c] = await Promise.all([
        api<{ stock: any[] }>('/inventory/stock'),
        can('waste.read') ? api<{ records: any[] }>('/waste') : Promise.resolve({ records: [] }),
        can('stock_counts.read')
          ? api<{ counts: any[] }>('/stock-counts') : Promise.resolve({ counts: [] }),
      ]);
      setStock(s.stock);
      setWaste(w.records);
      setCounts(c.counts);
    } catch (err) {
      push((err as Error).message, 'error');
    } finally { setLoading(false); }
  }, [can, push]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <Spinner label="جارٍ التحميل…" />;

  const lowStock = stock.filter((s) => s.is_low_stock);

  return (
    <>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <div className="tabs" style={{ flex: '0 0 auto', width: 340, marginBottom: 0 }}>
          <button className={tab === 'stock' ? 'active' : ''} onClick={() => setTab('stock')}>
            المخزون
          </button>
          <button className={tab === 'waste' ? 'active' : ''} onClick={() => setTab('waste')}>
            الهدر
          </button>
          <button className={tab === 'counts' ? 'active' : ''} onClick={() => setTab('counts')}>
            الجرد
          </button>
        </div>
        <div className="spacer" />
        {can('waste.create') && (
          <button className="btn primary" onClick={() => setRecordingWaste(true)}>
            + تسجيل هدر
          </button>
        )}
        {can('stock_counts.create') && tab === 'counts' && (
          <OpenCountButton onOpened={async (c) => { await load(); setCountDetail(c); }} />
        )}
      </div>

      {lowStock.length > 0 && tab === 'stock' && (
        <div className="alert-box warn">
          ⚠️ {lowStock.length} صنفاً تحت الحد الأدنى. أنشئ طلب شراء من شاشة
          المشتريات — النظام لا ينشئ طلبات تلقائياً.
        </div>
      )}

      {tab === 'stock' && (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>SKU</th><th>الصنف</th><th>المتوفر</th><th>الحد الأدنى</th>
                  <th>متوسط التكلفة</th><th>القيمة</th><th></th>
                </tr>
              </thead>
              <tbody>
                {stock.map((s) => (
                  <tr key={s.item_id}>
                    <td className="num small faint">{s.sku}</td>
                    <td>{s.name_ar}</td>
                    <td className="num">
                      {quantity(Number(s.total_quantity ?? s.quantity ?? 0), s.base_unit)}
                    </td>
                    <td className="num small muted">{quantity(Number(s.min_level), s.base_unit)}</td>
                    <td className="num small">{riyal(Math.round(Number(s.average_cost) * 100) / 100)}</td>
                    <td className="num">{riyal(s.total_value ?? s.stock_value ?? 0)}</td>
                    <td>
                      {s.is_low_stock && <span className="badge red">منخفض</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {stock.length === 0 && <Empty icon="📦" text="لا توجد أصناف" />}
        </div>
      )}

      {tab === 'waste' && (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>الرقم</th><th>الصنف</th><th>الكمية</th><th>السبب</th>
                  <th>القيمة</th><th>الحالة</th><th>بواسطة</th><th>التاريخ</th><th></th>
                </tr>
              </thead>
              <tbody>
                {waste.map((w) => (
                  <tr key={w.id}>
                    <td className="num small">{w.waste_number}</td>
                    <td>{w.item_name}</td>
                    <td className="num">{w.entered_quantity} {w.entered_unit}</td>
                    <td className="small">
                      {WASTE_REASONS.find(([k]) => k === w.reason)?.[1] ?? w.reason}
                    </td>
                    <td className="num">{riyal(w.estimated_cost)}</td>
                    <td>
                      <span className={`badge ${w.status === 'posted' ? 'green'
                        : w.status === 'rejected' ? 'red' : 'amber'}`}>
                        {w.status === 'posted' ? 'مُثبت'
                          : w.status === 'rejected' ? 'مرفوض' : 'بانتظار الموافقة'}
                      </span>
                    </td>
                    <td className="small muted">{w.recorded_by}</td>
                    <td className="small faint">{dateTime(w.occurred_at)}</td>
                    <td>
                      {w.status === 'pending_approval' && can('waste.approve') && (
                        <div className="row" style={{ gap: 4 }}>
                          <button
                            className="btn success sm"
                            onClick={async () => {
                              await api(`/waste/${w.id}/approve`, {
                                method: 'POST', body: { approve: true },
                              });
                              push('تمت الموافقة وخُصمت الكمية', 'ok');
                              void load();
                            }}
                          >
                            موافقة
                          </button>
                          <button
                            className="btn danger sm"
                            onClick={async () => {
                              await api(`/waste/${w.id}/approve`, {
                                method: 'POST', body: { approve: false, reason: 'غير مبرر' },
                              });
                              push('تم الرفض', 'warn');
                              void load();
                            }}
                          >
                            رفض
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {waste.length === 0 && <Empty icon="🗑️" text="لا توجد سجلات هدر" />}
        </div>
      )}

      {tab === 'counts' && (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>الرقم</th><th>الموقع</th><th>النوع</th><th>الحالة</th>
                  <th>قيمة الفرق</th><th>نسبة الفرق</th><th>التاريخ</th><th></th>
                </tr>
              </thead>
              <tbody>
                {counts.map((c) => (
                  <tr key={c.id}>
                    <td className="num small">{c.count_number}</td>
                    <td>{c.location_name}</td>
                    <td className="small">{c.count_type}</td>
                    <td>
                      <span className={`badge ${c.status === 'approved' ? 'green'
                        : c.status === 'submitted' ? 'amber' : ''}`}>
                        {c.status}
                      </span>
                    </td>
                    <td className="num">{riyal(c.total_variance_value)}</td>
                    <td className="num">
                      {c.variance_percent != null ? (
                        <span className={Math.abs(c.variance_percent) >= 3 ? 'badge red' : ''}>
                          {c.variance_percent}%
                        </span>
                      ) : '—'}
                    </td>
                    <td className="small faint">{dateTime(c.created_at)}</td>
                    <td>
                      <button
                        className="btn sm"
                        onClick={async () => {
                          const res = await api<{ count: any }>(`/stock-counts/${c.id}`);
                          setCountDetail(res.count);
                        }}
                      >
                        فتح
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {counts.length === 0 && <Empty icon="📋" text="لا توجد عمليات جرد" />}
        </div>
      )}

      {recordingWaste && (
        <WasteForm onClose={() => setRecordingWaste(false)}
                   onSaved={async () => { setRecordingWaste(false); await load(); }} />
      )}

      {countDetail && (
        <CountSheet
          count={countDetail}
          onClose={() => setCountDetail(null)}
          onChanged={async () => {
            const res = await api<{ count: any }>(`/stock-counts/${countDetail.id}`);
            setCountDetail(res.count);
            await load();
          }}
        />
      )}
    </>
  );
}

function OpenCountButton({ onOpened }: { onOpened: (count: any) => void }) {
  const { push } = useToast();
  const [open, setOpen] = useState(false);
  const [locations, setLocations] = useState<any[]>([]);
  const [locationId, setLocationId] = useState('');
  const [type, setType] = useState('daily');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api<{ locations: any[] }>('/inventory/locations').then((r) => {
      setLocations(r.locations);
      setLocationId(r.locations[0]?.id ?? '');
    }).catch(() => {});
  }, [open]);

  if (!open) {
    return <button className="btn" onClick={() => setOpen(true)}>+ فتح جرد</button>;
  }

  return (
    <Modal title="فتح جرد جديد" onClose={() => setOpen(false)}
      footer={
        <button
          className="btn primary" disabled={busy || !locationId}
          onClick={async () => {
            setBusy(true);
            try {
              const res = await api<any>('/stock-counts', {
                method: 'POST', body: { locationId, countType: type },
              });
              const full = await api<{ count: any }>(`/stock-counts/${res.id}`);
              push('تم فتح الجرد', 'ok');
              setOpen(false);
              onOpened(full.count);
            } catch (err) { push((err as Error).message, 'error'); }
            finally { setBusy(false); }
          }}
        >
          {busy ? '...' : 'فتح'}
        </button>
      }
    >
      <div className="field">
        <label className="label">الموقع</label>
        <select className="select" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>
      <div className="field">
        <label className="label">نوع الجرد</label>
        <select className="select" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="daily">يومي</option>
          <option value="weekly">أسبوعي</option>
          <option value="monthly">شهري</option>
          <option value="ad_hoc">طارئ</option>
        </select>
      </div>
      <p className="small muted">
        سيحسب النظام الكمية المتوقعة من حركة المخزون (الوارد + التحويلات −
        الاستهلاك حسب الوصفات − الهدر) ثم يقارنها بالجرد الفعلي.
      </p>
    </Modal>
  );
}

function CountSheet({
  count, onClose, onChanged,
}: { count: any; onClose: () => void; onChanged: () => void }) {
  const { can } = useSession();
  const { push } = useToast();
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const payload = Object.entries(entries)
        .filter(([, v]) => v !== '')
        .map(([itemId, v]) => {
          const item = count.items.find((i: any) => i.item_id === itemId);
          return { itemId, countedQuantity: Number(v), unit: item?.base_unit ?? 'g' };
        });
      if (payload.length > 0) {
        await api(`/stock-counts/${count.id}/entries`, {
          method: 'POST', body: { entries: payload },
        });
      }
      push('تم حفظ الجرد الفعلي', 'ok');
      onChanged();
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    setBusy(true);
    try {
      const res = await api<any>(`/stock-counts/${count.id}/submit`, { method: 'POST' });
      push(
        `تم الإرسال — فرق ${riyal(res.totalVarianceValue)}`
        + (res.flagged.length ? ` مع ${res.flagged.length} صنفاً خارج الحد` : ''),
        res.flagged.length ? 'warn' : 'ok',
      );
      onChanged();
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <Modal
      wide title={`جرد ${count.count_number} — ${count.location_name}`} onClose={onClose}
      footer={
        <>
          {count.status === 'open' && (
            <>
              <button className="btn" disabled={busy} onClick={() => void save()}>حفظ</button>
              <button className="btn primary" disabled={busy} onClick={() => void submit()}>
                إرسال للاعتماد
              </button>
            </>
          )}
          {count.status === 'submitted' && can('stock_counts.approve') && (
            <button
              className="btn success" disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`/stock-counts/${count.id}/approve`, {
                    method: 'POST', body: { approve: true },
                  });
                  push('تم اعتماد الجرد وتسوية المخزون', 'ok');
                  onChanged();
                } catch (err) { push((err as Error).message, 'error'); }
                finally { setBusy(false); }
              }}
            >
              اعتماد وتسوية
            </button>
          )}
        </>
      }
    >
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>الصنف</th><th>افتتاحي</th><th>وارد</th><th>استهلاك</th><th>هدر</th>
              <th>المتوقع</th><th>الفعلي</th><th>الفرق</th><th>قيمة الفرق</th>
            </tr>
          </thead>
          <tbody>
            {count.items.map((i: any) => (
              <tr key={i.id}>
                <td>{i.name_ar}</td>
                <td className="num small faint">{Number(i.opening_quantity).toFixed(0)}</td>
                <td className="num small faint">{Number(i.received_quantity).toFixed(0)}</td>
                <td className="num small faint">{Number(i.recipe_consumption).toFixed(0)}</td>
                <td className="num small faint">{Number(i.waste_quantity).toFixed(0)}</td>
                <td className="num">{quantity(Number(i.expected_quantity), i.base_unit)}</td>
                <td className="num">
                  {count.status === 'open' ? (
                    <input
                      className="input ltr" style={{ width: 90, minHeight: 34 }}
                      inputMode="decimal"
                      value={entries[i.item_id] ?? (i.counted_quantity ?? '')}
                      onChange={(e) => setEntries(
                        (s) => ({ ...s, [i.item_id]: e.target.value }),
                      )}
                    />
                  ) : (
                    i.counted_quantity != null
                      ? quantity(Number(i.counted_quantity), i.base_unit) : '—'
                  )}
                </td>
                <td className="num">
                  {i.variance_quantity != null
                    ? quantity(Number(i.variance_quantity), i.base_unit) : '—'}
                </td>
                <td className="num">
                  {i.variance_value != null ? (
                    <span className={Math.abs(Number(i.variance_percent ?? 0)) >= 3 ? 'badge red' : ''}>
                      {riyal(i.variance_value)}
                    </span>
                  ) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function WasteForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { push } = useToast();
  const [items, setItems] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [form, setForm] = useState({
    itemId: '', locationId: '', quantity: '', unit: 'g', reason: 'dropped', notes: '',
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api<{ items: any[] }>('/inventory/items'),
      api<{ locations: any[] }>('/inventory/locations'),
    ]).then(([i, l]) => {
      setItems(i.items);
      setLocations(l.locations);
      setForm((f) => ({ ...f, locationId: l.locations[0]?.id ?? '' }));
    }).catch(() => {});
  }, []);

  return (
    <Modal
      title="تسجيل هدر" onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={busy || !form.itemId || !form.locationId || !form.quantity}
          onClick={async () => {
            setBusy(true);
            try {
              const res = await api<any>('/waste', {
                method: 'POST',
                body: {
                  locationId: form.locationId, itemId: form.itemId,
                  quantity: Number(form.quantity), unit: form.unit,
                  reason: form.reason, notes: form.notes || null,
                },
              });
              push(
                res.status === 'pending_approval'
                  ? 'سُجل الهدر وبانتظار موافقة المدير (لم يُخصم بعد)'
                  : 'تم تسجيل الهدر وخصم الكمية',
                res.status === 'pending_approval' ? 'warn' : 'ok',
              );
              onSaved();
            } catch (err) { push((err as Error).message, 'error'); }
            finally { setBusy(false); }
          }}
        >
          {busy ? '...' : 'تسجيل'}
        </button>
      }
    >
      <div className="field">
        <label className="label">الصنف</label>
        <select
          className="select" value={form.itemId}
          onChange={(e) => {
            const item = items.find((i) => i.id === e.target.value);
            setForm((f) => ({ ...f, itemId: e.target.value, unit: item?.stock_unit ?? 'g' }));
          }}
        >
          <option value="">— اختر —</option>
          {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label className="label">الكمية</label>
          <input
            className="input ltr" inputMode="decimal" value={form.quantity}
            onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
          />
        </div>
        <div className="field" style={{ width: 110 }}>
          <label className="label">الوحدة</label>
          <select
            className="select" value={form.unit}
            onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
          >
            {['g', 'kg', 'ml', 'l', 'piece', 'box', 'carton', 'pack'].map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label className="label">الموقع</label>
        <select
          className="select" value={form.locationId}
          onChange={(e) => setForm((f) => ({ ...f, locationId: e.target.value }))}
        >
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>
      <div className="field">
        <label className="label">السبب</label>
        <select
          className="select" value={form.reason}
          onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
        >
          {WASTE_REASONS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div className="field">
        <label className="label">ملاحظات</label>
        <textarea
          className="textarea" value={form.notes}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
        />
      </div>
      <p className="small faint">
        الهدر الذي تتجاوز قيمته الحد المسموح يحتاج موافقة مدير قبل خصمه من المخزون.
      </p>
    </Modal>
  );
}
