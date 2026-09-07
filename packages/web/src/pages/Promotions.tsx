import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { Empty, Modal, Spinner, Stat, useToast, ConfirmReason } from '../components/ui.js';
import { money } from '../lib/format.js';

/**
 * Campaigns.
 *
 * This screen exists so nobody has to type a price. The specification forbids
 * staff changing prices by hand, and that rule only holds if there is a
 * legitimate way to sell something cheaper — otherwise the pressure finds
 * another outlet, usually a manager's override used ten times a night.
 *
 * So the emphasis is on what a campaign COST, not on how many were created.
 * That is the number that decides whether it continues.
 */

const KIND_LABEL: Record<string, string> = {
  percent: 'نسبة مئوية',
  amount: 'مبلغ ثابت',
  item_price: 'سعر محدد',
  buy_x_get_y: 'اشترِ وخذ',
  combo: 'وجبة مركّبة',
};

const DAYS = [
  { value: 1, label: 'الاثنين' }, { value: 2, label: 'الثلاثاء' },
  { value: 3, label: 'الأربعاء' }, { value: 4, label: 'الخميس' },
  { value: 5, label: 'الجمعة' }, { value: 6, label: 'السبت' },
  { value: 7, label: 'الأحد' },
];

/** "16:30" ⇄ minutes past midnight, which is how the rule is stored. */
const toMinutes = (hhmm: string): number | null => {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const toClock = (minutes: number | null): string => {
  if (minutes === null || minutes === undefined) return '';
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

export function Promotions() {
  const { can } = useSession();
  const { push } = useToast();
  const [promotions, setPromotions] = useState<any[]>([]);
  const [report, setReport] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<any | null>(null);
  const [retiring, setRetiring] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, costs, menu] = await Promise.all([
        api<{ promotions: any[] }>('/promotions'),
        api<{ promotions: any[] }>('/reports/promotions'),
        api<{ categories: any[] }>('/menu/categories').catch(() => ({ categories: [] })),
      ]);
      setPromotions(list.promotions);
      setReport(costs.promotions);
      setCategories(menu.categories ?? []);
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setLoading(false); }
  }, [push]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <Spinner label="جارٍ تحميل العروض…" />;

  const active = promotions.filter((p) => p.is_active);
  const givenAway = report.reduce((sum, r) => sum + Number(r.given_away ?? 0), 0);
  const redemptions = report.reduce((sum, r) => sum + Number(r.redemptions ?? 0), 0);

  return (
    <>
      <div className="grid cols-4">
        <Stat label="عروض فعّالة" value={active.length} />
        <Stat label="مرات الاستخدام" value={redemptions} />
        {/* The headline number: what the campaigns actually gave away. */}
        <Stat label="إجمالي ما مُنح" value={money(givenAway)} />
        <Stat label="متوسط الخصم"
              value={redemptions > 0 ? money(Math.round(givenAway / redemptions)) : '—'} />
      </div>

      {can('promotions.manage') && (
        <div className="toolbar" style={{ marginTop: 16 }}>
          <button className="btn" onClick={() => setEditing({ kind: 'percent' })}>
            عرض جديد
          </button>
        </div>
      )}

      {promotions.length === 0 ? (
        <Empty icon="🏷️" text="لا عروض بعد" />
      ) : (
        <table className="data" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>العرض</th>
              <th>النوع</th>
              <th>القيمة</th>
              <th>متى</th>
              <th>استُخدم</th>
              <th>كلّف</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {promotions.map((p) => {
              const cost = report.find((r) => r.id === p.id);
              return (
                <tr key={p.id} className={p.is_active ? '' : 'muted'}>
                  <td>
                    {p.name_ar}
                    {p.code && <span className="pill mono"> {p.code}</span>}
                    {!p.is_active && <span className="pill"> موقوف</span>}
                    {p.is_stackable && <span className="pill"> تراكمي</span>}
                  </td>
                  <td>{KIND_LABEL[p.kind] ?? p.kind}</td>
                  <td className="num">
                    {p.kind === 'percent'
                      ? `${(Number(p.value) / 100).toFixed(p.value % 100 ? 2 : 0)}%`
                      : money(Number(p.value))}
                  </td>
                  <td className="small">{describeWindow(p)}</td>
                  <td className="num">
                    {cost?.redemptions ?? 0}
                    {p.usage_limit && <span className="muted"> / {p.usage_limit}</span>}
                  </td>
                  <td className="num">{money(Number(cost?.given_away ?? 0))}</td>
                  <td className="actions">
                    {can('promotions.manage') && (
                      <>
                        <button className="btn small ghost" onClick={() => setEditing(p)}>
                          تعديل
                        </button>
                        {p.is_active && (
                          <button className="btn small ghost" onClick={() => setRetiring(p)}>
                            إيقاف
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {editing && (
        <Modal
          title={editing.id ? `تعديل ${editing.name_ar}` : 'عرض جديد'}
          onClose={() => setEditing(null)}
        >
          <form onSubmit={save}>
            <label>
              الاسم
              <input name="nameAr" required maxLength={120}
                     defaultValue={editing.name_ar ?? ''}
                     placeholder="ساعة سعيدة على المشروبات الساخنة" />
              <small className="muted">
                يُطبع على الفاتورة كسبب الخصم، فاكتبه كما تريد العميل أن يقرأه.
              </small>
            </label>

            <label>
              النوع
              <select name="kind" defaultValue={editing.kind ?? 'percent'}>
                {Object.entries(KIND_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>

            <label>
              القيمة
              <input name="value" type="number" min={0} required
                     defaultValue={editing.value ?? ''} />
              <small className="muted">
                للنسبة: بنقاط أساس (1500 = 15%). لغيرها: بالهللات (1000 = 10 ريال).
              </small>
            </label>

            <div className="grid cols-2">
              <label>
                اشترِ
                <input name="buyQuantity" type="number" min={1}
                       defaultValue={editing.buy_quantity ?? ''} />
              </label>
              <label>
                خذ مجاناً
                <input name="getQuantity" type="number" min={1}
                       defaultValue={editing.get_quantity ?? ''} />
              </label>
            </div>

            <fieldset>
              <legend>الفترة اليومية</legend>
              <div className="grid cols-2">
                <label>
                  من
                  <input name="dailyStart" type="time"
                         defaultValue={toClock(editing.daily_start_minute)} />
                </label>
                <label>
                  إلى
                  <input name="dailyEnd" type="time"
                         defaultValue={toClock(editing.daily_end_minute)} />
                </label>
              </div>
              <small className="muted">
                بتوقيت الفرع. ويمكن أن تعبر منتصف الليل (22:00 إلى 02:00 وردية واحدة).
              </small>
            </fieldset>

            <fieldset>
              <legend>الأيام</legend>
              <div className="chips">
                {DAYS.map((d) => (
                  <label key={d.value} className="chip">
                    <input type="checkbox" name="daysOfWeek" value={d.value}
                           defaultChecked={(editing.days_of_week ?? []).includes(d.value)} />
                    {d.label}
                  </label>
                ))}
              </div>
              <small className="muted">لا شيء محدد = كل الأيام.</small>
            </fieldset>

            <fieldset>
              <legend>على أي تصنيفات</legend>
              <div className="chips">
                {categories.map((c) => (
                  <label key={c.id} className="chip">
                    <input type="checkbox" name="categoryIds" value={c.id}
                           defaultChecked={(editing.category_ids ?? []).includes(c.id)} />
                    {c.name_ar ?? c.name}
                  </label>
                ))}
              </div>
              <small className="muted">لا شيء محدد = كل المنيو.</small>
            </fieldset>

            <div className="grid cols-2">
              <label>
                أقل فاتورة (هللات)
                <input name="minBasket" type="number" min={0}
                       defaultValue={editing.min_basket ?? 0} />
              </label>
              <label>
                سقف الخصم (هللات)
                <input name="maxDiscount" type="number" min={0}
                       defaultValue={editing.max_discount ?? 0} />
              </label>
            </div>

            <div className="grid cols-2">
              <label>
                حد الاستخدام الكلي
                <input name="usageLimit" type="number" min={1}
                       defaultValue={editing.usage_limit ?? ''} />
              </label>
              <label>
                لكل عميل
                <input name="usagePerCustomer" type="number" min={1}
                       defaultValue={editing.usage_per_customer ?? ''} />
              </label>
            </div>

            <label className="check">
              <input type="checkbox" name="isStackable"
                     defaultChecked={editing.is_stackable ?? false} />
              يتراكم مع عروض أخرى
              <small className="muted">
                بلا هذا، هذا العرض وحده يُطبَّق. فعّله بحذر: عرضان بـ50% لا يعطيان
                100% (الثاني يرى ما تبقّى) لكنهما يعطيان 75%.
              </small>
            </label>

            <label className="check">
              <input type="checkbox" name="isActive"
                     defaultChecked={editing.is_active ?? true} />
              فعّال
            </label>

            <button className="btn" type="submit" disabled={busy}>
              {busy ? 'جارٍ الحفظ…' : 'احفظ'}
            </button>
          </form>
        </Modal>
      )}

      {retiring && (
        <ConfirmReason
          title={`إيقاف ${retiring.name_ar}`}
          message="العرض لا يُحذف — سجل استخدامه يبقى للتقارير. سيتوقف عن التطبيق فوراً."
          confirmLabel="أوقف العرض"
          onCancel={() => setRetiring(null)}
          onConfirm={async () => {
            try {
              await api(`/promotions/${retiring.id}/retire`, { method: 'POST' });
              push('أُوقف العرض', 'ok');
              setRetiring(null);
              await load();
            } catch (err) { push((err as Error).message, 'error'); }
          }}
        />
      )}
    </>
  );

  function describeWindow(p: any): string {
    const bits: string[] = [];
    if (p.daily_start_minute !== null && p.daily_start_minute !== undefined) {
      bits.push(`${toClock(p.daily_start_minute)}–${toClock(p.daily_end_minute)}`);
    }
    if ((p.days_of_week ?? []).length > 0) {
      bits.push(p.days_of_week
        .map((d: number) => DAYS.find((x) => x.value === d)?.label ?? d).join('، '));
    }
    if (p.ends_at) bits.push(`حتى ${new Date(p.ends_at).toLocaleDateString('ar-SA')}`);
    return bits.length > 0 ? bits.join(' · ') : 'دائماً';
  }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const num = (name: string): number | null => {
      const raw = form.get(name);
      return raw === null || raw === '' ? null : Number(raw);
    };

    setBusy(true);
    try {
      const body = {
        nameAr: String(form.get('nameAr')),
        kind: String(form.get('kind')),
        value: Number(form.get('value') ?? 0),
        buyQuantity: num('buyQuantity'),
        getQuantity: num('getQuantity'),
        dailyStartMinute: toMinutes(String(form.get('dailyStart') ?? '')),
        dailyEndMinute: toMinutes(String(form.get('dailyEnd') ?? '')),
        daysOfWeek: form.getAll('daysOfWeek').map(Number),
        categoryIds: form.getAll('categoryIds').map(String),
        minBasket: Number(form.get('minBasket') ?? 0),
        maxDiscount: Number(form.get('maxDiscount') ?? 0),
        usageLimit: num('usageLimit'),
        usagePerCustomer: num('usagePerCustomer'),
        isStackable: form.get('isStackable') === 'on',
        isActive: form.get('isActive') === 'on',
      };
      await api(editing.id ? `/promotions/${editing.id}` : '/promotions',
        { method: editing.id ? 'PUT' : 'POST', body });
      push('حُفظ العرض', 'ok');
      setEditing(null);
      await load();
    } catch (err) { push((err as Error).message, 'error'); }
    finally { setBusy(false); }
  }
}
