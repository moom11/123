import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { Empty, Modal, Spinner, useToast } from '../components/ui.js';
import { riyal } from '../lib/format.js';

/**
 * Menu management.
 *
 * The one screen where prices are decided. Everywhere else in the system a
 * price is read, never typed: the POS takes it from here, and a cashier who
 * wants a different one has to go through the customer's own OTP. So this
 * screen is gated on menu.manage, and every save lands in the audit log.
 */

const DEPARTMENTS = [
  ['BAR', 'البار'],
  ['KITCHEN', 'المطبخ'],
  ['SHISHA', 'المعسل'],
  ['OTHER', 'أخرى'],
] as const;

const DEPT_LABEL: Record<string, string> = Object.fromEntries(DEPARTMENTS);

interface Product {
  id: string; category_id: string; name: string; price: number;
  production_department: string;
  is_available: boolean; show_in_menu: boolean; sort_order: number;
  description?: string | null; modifierIds?: string[];
}
interface Category { id: string; name: string; sort_order: number; show_in_menu: boolean; }
interface Modifier {
  id: string; name: string; selection: 'single' | 'multi'; is_required: boolean;
  min_select: number; max_select: number | null;
  options: Array<{ id: string; name: string; price_delta: number; is_default: boolean }>;
}

/** Riyals in the input, halalas on the wire — money is never a float here. */
const toHalalas = (riyals: string): number => Math.round(Number(riyals || 0) * 100);
const toRiyals = (halalas: number): string => (halalas / 100).toFixed(2);

export function Menu() {
  const { can } = useSession();
  const { push } = useToast();
  const [tab, setTab] = useState<'products' | 'categories' | 'modifiers'>('products');
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [modifiers, setModifiers] = useState<Modifier[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<Product> | null>(null);
  const [editingCategory, setEditingCategory] = useState<Partial<Category> | null>(null);
  const [editingModifier, setEditingModifier] = useState<Partial<Modifier> | null>(null);
  const [filter, setFilter] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');

  const manage = can('menu.manage');

  const load = useCallback(async () => {
    try {
      const [menu, cats, mods] = await Promise.all([
        api<any>('/menu'),
        api<{ categories: Category[] }>('/menu/categories'),
        api<{ modifiers: Modifier[] }>('/menu/modifiers'),
      ]);
      // getMenu returns categories and products as sibling arrays, joined by
      // category_id, rather than nesting one inside the other.
      setProducts(menu.products ?? []);
      setCategories(cats.categories);
      setModifiers(mods.modifiers);
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [push]);

  useEffect(() => { void load(); }, [load]);

  const byCategory = useMemo(() => {
    const map = new Map<string, Product[]>();
    for (const p of products) {
      if (!map.has(p.category_id)) map.set(p.category_id, []);
      map.get(p.category_id)!.push(p);
    }
    return map;
  }, [products]);

  const visibleCategories = categories.filter(
    (c) => !categoryFilter || c.id === categoryFilter,
  );

  const matches = (p: Product) =>
    !filter || p.name.toLowerCase().includes(filter.toLowerCase());

  const toggleAvailability = async (p: Product) => {
    try {
      await api(`/menu/products/${p.id}/availability`, {
        method: 'POST', body: { available: !p.is_available },
      });
      setProducts((list) => list.map(
        (x) => (x.id === p.id ? { ...x, is_available: !p.is_available } : x),
      ));
      push(p.is_available ? `${p.name} — أوقفت عن البيع` : `${p.name} — عادت للبيع`, 'ok');
    } catch (err) { push((err as Error).message, 'error'); }
  };

  if (loading) return <Spinner label="جارٍ تحميل المنيو…" />;

  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row wrap">
          <strong>🍽️ المنيو</strong>
          <span className="spacer" />
          {manage && tab === 'products' && (
            <button className="btn" onClick={() => setEditing({ price: 0 })}>+ صنف جديد</button>
          )}
          {manage && tab === 'categories' && (
            <button className="btn" onClick={() => setEditingCategory({})}>+ تصنيف جديد</button>
          )}
          {manage && tab === 'modifiers' && (
            <button
              className="btn"
              onClick={() => setEditingModifier({ selection: 'single', options: [] as any })}
            >
              + مجموعة خيارات
            </button>
          )}
        </div>
        <div className="small faint" style={{ marginTop: 6 }}>
          الأسعار تُحدَّد هنا فقط. الكاشير لا يستطيع تعديل سعر أثناء البيع، وكل تغيير هنا
          يُسجَّل في سجل العمليات باسم من غيّره.
        </div>
      </div>

      <div className="row wrap" style={{ marginBottom: 12, gap: 8 }}>
        {([
          ['products', `الأصناف (${products.length})`],
          ['categories', `التصنيفات (${categories.length})`],
          ['modifiers', `مجموعات الخيارات (${modifiers.length})`],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            className={`chip${tab === value ? ' active' : ''}`}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'products' && (
        <>
          <div className="row wrap" style={{ marginBottom: 12, gap: 8 }}>
            <input
              className="input" style={{ maxWidth: 260 }} value={filter}
              onChange={(e) => setFilter(e.target.value)} placeholder="ابحث عن صنف…"
            />
            <select
              className="select" style={{ maxWidth: 220 }} value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
            >
              <option value="">كل التصنيفات</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          {visibleCategories.map((category) => {
            const items = (byCategory.get(category.id) ?? []).filter(matches);
            if (items.length === 0 && filter) return null;
            return (
              <div className="card" key={category.id} style={{ marginBottom: 12 }}>
                <div className="row">
                  <strong>{category.name}</strong>
                  <span className="badge">{items.length}</span>
                  <span className="spacer" />
                  {!category.show_in_menu && (
                    <span className="badge" title="مخفي عن منيو العميل">مخفي عن العميل</span>
                  )}
                </div>

                {items.length === 0
                  ? <Empty icon="🍽️" text="لا أصناف في هذا التصنيف بعد" />
                  : (
                    <div className="table-wrap">
                      <table className="data">
                        <thead>
                          <tr>
                            <th>الصنف</th>
                            <th>القسم</th>
                            <th>السعر</th>
                            <th>الحالة</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((p) => (
                            <tr key={p.id}>
                              <td>
                                {p.name}
                                {!p.show_in_menu && (
                                  <span className="small faint"> · مخفي عن العميل</span>
                                )}
                              </td>
                              <td>{DEPT_LABEL[p.production_department] ?? p.production_department}</td>
                              <td className="num">{riyal(p.price)}</td>
                              <td>
                                <span className={`badge ${p.is_available ? 'green' : 'red'}`}>
                                  {p.is_available ? 'متاح' : 'موقوف'}
                                </span>
                              </td>
                              <td>
                                <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                                  {can('menu.availability.update') && (
                                    <button
                                      className="btn ghost sm"
                                      onClick={() => void toggleAvailability(p)}
                                    >
                                      {p.is_available ? 'أوقف' : 'أعِد'}
                                    </button>
                                  )}
                                  {manage && (
                                    <button
                                      className="btn sm"
                                      onClick={() => setEditing(p)}
                                    >
                                      تعديل
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
              </div>
            );
          })}
        </>
      )}

      {tab === 'categories' && (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>التصنيف</th><th>الأصناف</th><th>الترتيب</th>
                  <th>في منيو العميل</th><th />
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td className="num">{(byCategory.get(c.id) ?? []).length}</td>
                    <td className="num">{c.sort_order}</td>
                    <td>{c.show_in_menu ? 'نعم' : 'لا'}</td>
                    <td>
                      {manage && (
                        <button
                          className="btn sm"
                          onClick={() => setEditingCategory(c)}
                        >
                          تعديل
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'modifiers' && (
        <>
          {modifiers.length === 0 && (
            <Empty icon="⚙️" text="لا مجموعات خيارات بعد" />
          )}
          {modifiers.map((m) => (
            <div className="card" key={m.id} style={{ marginBottom: 12 }}>
              <div className="row wrap">
                <strong>{m.name}</strong>
                {m.is_required && <span className="badge red">إلزامي</span>}
                <span className="badge">
                  {m.selection === 'single' ? 'اختيار واحد' : 'اختيار متعدد'}
                </span>
                <span className="spacer" />
                {manage && (
                  <button className="btn sm" onClick={() => setEditingModifier(m)}>تعديل</button>
                )}
              </div>
              <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
                {m.options.map((o) => (
                  <span className="chip" key={o.id}>
                    {o.name}
                    {o.price_delta !== 0 && ` (${o.price_delta > 0 ? '+' : ''}${riyal(o.price_delta)})`}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {editing && (
        <ProductEditor
          product={editing}
          categories={categories}
          modifiers={modifiers}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
      {editingCategory && (
        <CategoryEditor
          category={editingCategory}
          onClose={() => setEditingCategory(null)}
          onSaved={() => { setEditingCategory(null); void load(); }}
        />
      )}
      {editingModifier && (
        <ModifierEditor
          modifier={editingModifier}
          onClose={() => setEditingModifier(null)}
          onSaved={() => { setEditingModifier(null); void load(); }}
        />
      )}
    </>
  );
}

function ProductEditor({
  product, categories, modifiers, onClose, onSaved,
}: {
  product: Partial<Product>;
  categories: Category[]; modifiers: Modifier[];
  onClose: () => void; onSaved: () => void;
}) {
  const { push } = useToast();
  const isNew = !product.id;
  const [name, setName] = useState(product.name ?? '');
  const [categoryId, setCategoryId] = useState(product.category_id ?? categories[0]?.id ?? '');
  const [department, setDepartment] = useState(product.production_department ?? 'BAR');
  const [price, setPrice] = useState(toRiyals(product.price ?? 0));
  const [description, setDescription] = useState(product.description ?? '');
  const [showInMenu, setShowInMenu] = useState(product.show_in_menu ?? true);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [retiring, setRetiring] = useState(false);

  // Which option groups this product already carries. Only meaningful for an
  // existing product; a new one starts with none.
  useEffect(() => {
    if (!product.id) return;
    api<any>(`/menu/products/${product.id}/options`)
      .then((res) => setSelected((res.modifiers ?? []).map((m: any) => m.id)))
      .catch(() => { /* the editor is still usable without them */ });
  }, [product.id]);

  const save = async () => {
    if (!name.trim()) { push('اكتب اسم الصنف', 'error'); return; }
    if (!categoryId) { push('اختر تصنيفاً', 'error'); return; }
    const halalas = toHalalas(price);
    if (!Number.isFinite(halalas) || halalas < 0) { push('السعر غير صحيح', 'error'); return; }

    setBusy(true);
    try {
      await api('/menu/products', {
        method: 'POST',
        body: {
          id: product.id ?? null,
          categoryId,
          nameAr: name.trim(),
          descriptionAr: description.trim() || null,
          price: halalas,
          productionDepartment: department,
          showInMenu,
          modifierIds: selected,
        },
      });
      push(isNew ? 'أُضيف الصنف' : 'حُفظ الصنف', 'ok');
      onSaved();
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const retire = async () => {
    setBusy(true);
    try {
      await api(`/menu/products/${product.id}/retire`, { method: 'POST' });
      push('أُخرج الصنف من المنيو', 'warn');
      onSaved();
    } catch (err) {
      push((err as Error).message, 'error');
    } finally {
      setBusy(false);
      setRetiring(false);
    }
  };

  return (
    <Modal
      title={isNew ? 'صنف جديد' : `تعديل — ${product.name}`}
      onClose={onClose}
      footer={(
        <div className="row" style={{ width: '100%' }}>
          {!isNew && !retiring && (
            <button className="btn ghost sm" disabled={busy} onClick={() => setRetiring(true)}>
              إخراج من المنيو
            </button>
          )}
          {retiring && (
            <>
              <span className="small">يبقى في التقارير والفواتير السابقة. متأكد؟</span>
              <button className="btn danger sm" disabled={busy} onClick={() => void retire()}>
                نعم، أخرجه
              </button>
              <button className="btn ghost sm" onClick={() => setRetiring(false)}>تراجع</button>
            </>
          )}
          <span className="spacer" />
          <button className="btn" disabled={busy} onClick={() => void save()}>
            {busy ? 'جارٍ الحفظ…' : 'حفظ'}
          </button>
        </div>
      )}
    >
      <div className="field">
        <label className="label">الاسم</label>
        <input
          className="input" value={name} onChange={(e) => setName(e.target.value)}
          placeholder="مثال: قهوة تركية"
        />
      </div>

      <div className="field">
        <label className="label">التصنيف</label>
        <select
          className="select" value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      <div className="field">
        <label className="label">القسم المُحضِّر</label>
        <div className="row wrap">
          {DEPARTMENTS.map(([value, label]) => (
            <button
              key={value}
              className={`chip${department === value ? ' active' : ''}`}
              onClick={() => setDepartment(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="small faint" style={{ marginTop: 4 }}>
          هذا يقرّر أي طابعة تستقبل التذكرة.
        </div>
      </div>

      <div className="field">
        <label className="label">السعر (ر.س)</label>
        <input
          className="input ltr" inputMode="decimal" value={price}
          onChange={(e) => setPrice(e.target.value)} placeholder="0.00"
        />
      </div>

      <div className="field">
        <label className="label">الوصف (اختياري)</label>
        <textarea
          className="input" rows={2} value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="يظهر للعميل في منيو الـ QR"
        />
      </div>

      {modifiers.length > 0 && (
        <div className="field">
          <label className="label">مجموعات الخيارات</label>
          <div className="row wrap" style={{ gap: 6 }}>
            {modifiers.map((m) => (
              <button
                key={m.id}
                className={`chip${selected.includes(m.id) ? ' active' : ''}`}
                onClick={() => setSelected(
                  (list) => (list.includes(m.id)
                    ? list.filter((x) => x !== m.id)
                    : [...list, m.id]),
                )}
              >
                {m.name}{m.is_required ? ' (إلزامي)' : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      <label className="row" style={{ gap: 8, marginTop: 12 }}>
        <input
          type="checkbox" checked={showInMenu}
          onChange={(e) => setShowInMenu(e.target.checked)}
        />
        <span>يظهر في منيو العميل (QR)</span>
      </label>
    </Modal>
  );
}

function CategoryEditor({
  category, onClose, onSaved,
}: { category: Partial<Category>; onClose: () => void; onSaved: () => void }) {
  const { push } = useToast();
  const isNew = !category.id;
  const [name, setName] = useState(category.name ?? '');
  const [sortOrder, setSortOrder] = useState(String(category.sort_order ?? 0));
  const [showInMenu, setShowInMenu] = useState(category.show_in_menu ?? true);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) { push('اكتب اسم التصنيف', 'error'); return; }
    setBusy(true);
    try {
      await api('/menu/categories', {
        method: 'POST',
        body: {
          id: category.id ?? null,
          nameAr: name.trim(),
          sortOrder: Number(sortOrder) || 0,
          showInMenu,
        },
      });
      push(isNew ? 'أُضيف التصنيف' : 'حُفظ التصنيف', 'ok');
      onSaved();
    } catch (err) {
      push((err as Error).message, 'error');
    } finally { setBusy(false); }
  };

  const retire = async () => {
    setBusy(true);
    try {
      await api(`/menu/categories/${category.id}/retire`, { method: 'POST' });
      push('حُذف التصنيف', 'warn');
      onSaved();
    } catch (err) {
      push((err as Error).message, 'error');
    } finally { setBusy(false); }
  };

  return (
    <Modal
      title={isNew ? 'تصنيف جديد' : `تعديل — ${category.name}`}
      onClose={onClose}
      footer={(
        <div className="row" style={{ width: '100%' }}>
          {!isNew && (
            <button className="btn ghost sm" disabled={busy} onClick={() => void retire()}>
              حذف
            </button>
          )}
          <span className="spacer" />
          <button className="btn" disabled={busy} onClick={() => void save()}>حفظ</button>
        </div>
      )}
    >
      <div className="field">
        <label className="label">الاسم</label>
        <input
          className="input" value={name} onChange={(e) => setName(e.target.value)}
          placeholder="مثال: مشروبات ساخنة"
        />
      </div>
      <div className="field">
        <label className="label">الترتيب في المنيو</label>
        <input
          className="input ltr" inputMode="numeric" value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value)}
        />
        <div className="small faint" style={{ marginTop: 4 }}>الأصغر يظهر أولاً.</div>
      </div>
      <label className="row" style={{ gap: 8 }}>
        <input
          type="checkbox" checked={showInMenu}
          onChange={(e) => setShowInMenu(e.target.checked)}
        />
        <span>يظهر في منيو العميل (QR)</span>
      </label>
    </Modal>
  );
}

interface DraftOption {
  id?: string | null; name: string; priceDelta: string; isDefault: boolean;
}

function ModifierEditor({
  modifier, onClose, onSaved,
}: { modifier: Partial<Modifier>; onClose: () => void; onSaved: () => void }) {
  const { push } = useToast();
  const isNew = !modifier.id;
  const [name, setName] = useState(modifier.name ?? '');
  const [selection, setSelection] = useState<'single' | 'multi'>(modifier.selection ?? 'single');
  const [isRequired, setIsRequired] = useState(modifier.is_required ?? false);
  const [options, setOptions] = useState<DraftOption[]>(
    (modifier.options ?? []).map((o) => ({
      id: o.id, name: o.name, priceDelta: toRiyals(o.price_delta), isDefault: o.is_default,
    })),
  );
  const [busy, setBusy] = useState(false);

  const setOption = (index: number, patch: Partial<DraftOption>) => {
    setOptions((list) => list.map((o, i) => (i === index ? { ...o, ...patch } : o)));
  };

  const save = async () => {
    if (!name.trim()) { push('اكتب اسم المجموعة', 'error'); return; }
    const clean = options.filter((o) => o.name.trim());
    if (clean.length === 0) { push('أضف خياراً واحداً على الأقل', 'error'); return; }

    setBusy(true);
    try {
      await api('/menu/modifiers', {
        method: 'POST',
        body: {
          id: modifier.id ?? null,
          nameAr: name.trim(),
          selection,
          isRequired,
          minSelect: isRequired ? 1 : 0,
          options: clean.map((o, index) => ({
            id: o.id ?? null,
            nameAr: o.name.trim(),
            priceDelta: toHalalas(o.priceDelta),
            isDefault: o.isDefault,
            sortOrder: index,
          })),
        },
      });
      push(isNew ? 'أُضيفت المجموعة' : 'حُفظت المجموعة', 'ok');
      onSaved();
    } catch (err) {
      push((err as Error).message, 'error');
    } finally { setBusy(false); }
  };

  return (
    <Modal
      wide
      title={isNew ? 'مجموعة خيارات جديدة' : `تعديل — ${modifier.name}`}
      onClose={onClose}
      footer={(
        <div className="row" style={{ width: '100%' }}>
          <span className="spacer" />
          <button className="btn" disabled={busy} onClick={() => void save()}>
            {busy ? 'جارٍ الحفظ…' : 'حفظ'}
          </button>
        </div>
      )}
    >
      <div className="field">
        <label className="label">اسم المجموعة</label>
        <input
          className="input" value={name} onChange={(e) => setName(e.target.value)}
          placeholder="مثال: اختيار السكر"
        />
      </div>

      <div className="field">
        <label className="label">نوع الاختيار</label>
        <div className="row wrap">
          <button
            className={`chip${selection === 'single' ? ' active' : ''}`}
            onClick={() => setSelection('single')}
          >
            اختيار واحد
          </button>
          <button
            className={`chip${selection === 'multi' ? ' active' : ''}`}
            onClick={() => setSelection('multi')}
          >
            اختيار متعدد
          </button>
        </div>
      </div>

      <label className="row" style={{ gap: 8, marginBottom: 12 }}>
        <input
          type="checkbox" checked={isRequired}
          onChange={(e) => setIsRequired(e.target.checked)}
        />
        <span>إلزامي — لا يُضاف الصنف للسلة قبل الاختيار</span>
      </label>

      <div className="field">
        <label className="label">الخيارات</label>
        {options.map((option, index) => (
          <div className="row" style={{ gap: 6, marginBottom: 6 }} key={option.id ?? index}>
            <input
              className="input" style={{ flex: 2 }} value={option.name}
              onChange={(e) => setOption(index, { name: e.target.value })}
              placeholder="اسم الخيار"
            />
            <input
              className="input ltr" style={{ flex: 1 }} inputMode="decimal"
              value={option.priceDelta}
              onChange={(e) => setOption(index, { priceDelta: e.target.value })}
              placeholder="0.00"
              title="فرق السعر بالريال — صفر إن لم يكن له تكلفة"
            />
            <button
              className="btn ghost sm"
              onClick={() => setOptions((list) => list.filter((_, i) => i !== index))}
              aria-label="حذف الخيار"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          className="btn ghost sm"
          onClick={() => setOptions(
            (list) => [...list, { name: '', priceDelta: '0.00', isDefault: false }],
          )}
        >
          + خيار
        </button>
        <div className="small faint" style={{ marginTop: 6 }}>
          فرق السعر يُضاف على سعر الصنف. خيار حُذف هنا يبقى في الفواتير القديمة.
        </div>
      </div>
    </Modal>
  );
}
