import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { Empty, Spinner, useToast } from '../components/ui.js';
import { quantity, riyal } from '../lib/format.js';

type Tab = 'sales' | 'products' | 'employees' | 'customers' | 'inventory' | 'purchasing';

const TABS: Array<[Tab, string, string]> = [
  ['sales', 'المبيعات', 'reports.sales'],
  ['products', 'المنتجات', 'reports.products'],
  ['employees', 'الموظفون', 'reports.employees'],
  ['customers', 'العملاء', 'reports.customers'],
  ['inventory', 'المخزون', 'reports.inventory'],
  ['purchasing', 'المشتريات', 'reports.purchasing'],
];

export function Reports() {
  const { can } = useSession();
  const { push } = useToast();
  const available = TABS.filter(([, , perm]) => can(perm));
  const [tab, setTab] = useState<Tab>(available[0]?.[0] ?? 'sales');
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  useEffect(() => {
    setLoading(true);
    const from = new Date(Date.now() - days * 86_400_000).toISOString();
    api<any>(`/reports/${tab}?from=${from}`)
      .then(setData)
      .catch((err) => push((err as Error).message, 'error'))
      .finally(() => setLoading(false));
  }, [tab, days, push]);

  if (available.length === 0) return <Empty icon="🔒" text="لا توجد تقارير متاحة لصلاحياتك" />;

  return (
    <>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <div className="category-bar">
          {available.map(([key, label]) => (
            <button
              key={key} className={`chip${tab === key ? ' active' : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <select
          className="select" style={{ maxWidth: 150 }}
          value={days} onChange={(e) => setDays(Number(e.target.value))}
        >
          <option value={1}>اليوم</option>
          <option value={7}>آخر 7 أيام</option>
          <option value={30}>آخر 30 يوماً</option>
          <option value={90}>آخر 90 يوماً</option>
        </select>
      </div>

      {loading ? <Spinner /> : !data ? null : (
        <>
          {tab === 'sales' && <SalesReport data={data} />}
          {tab === 'products' && <ProductReport data={data} />}
          {tab === 'employees' && <EmployeeReport rows={data.employees} />}
          {tab === 'customers' && <CustomerReport data={data} />}
          {tab === 'inventory' && <InventoryReport data={data} />}
          {tab === 'purchasing' && <PurchasingReport data={data} />}
        </>
      )}
    </>
  );
}

function Table({ head, rows }: { head: string[]; rows: Array<Array<React.ReactNode>> }) {
  if (rows.length === 0) return <Empty text="لا توجد بيانات في هذه الفترة" />;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} className={j > 0 ? 'num' : ''}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SalesReport({ data }: { data: any }) {
  const s = data.summary ?? {};
  return (
    <>
      <div className="grid cols-4">
        <div className="stat"><div className="label">إجمالي المبيعات</div>
          <div className="value">{riyal(s.gross)}</div></div>
        <div className="stat"><div className="label">عدد الفواتير</div>
          <div className="value">{s.orders}</div></div>
        <div className="stat"><div className="label">متوسط الفاتورة</div>
          <div className="value">{riyal(s.average_invoice)}</div></div>
        <div className="stat"><div className="label">الخصومات</div>
          <div className="value">{riyal(s.discounts)}</div></div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3 className="card-title">المبيعات بطريقة الدفع</h3>
        <Table
          head={['الطريقة', 'الإجمالي', 'العدد']}
          rows={data.byMethod.map((m: any) => [m.method, riyal(m.total), m.count])}
        />
      </div>

      <div className="card">
        <h3 className="card-title">المبيعات حسب الساعة</h3>
        <Table
          head={['الساعة', 'المبيعات', 'الفواتير']}
          rows={data.byHour.map((h: any) => [`${h.hour}:00`, riyal(h.sales), h.orders])}
        />
      </div>

      <div className="card">
        <h3 className="card-title">المبيعات اليومية</h3>
        <Table
          head={['اليوم', 'المبيعات', 'الفواتير']}
          rows={data.byDay.map((d: any) => [
            new Date(d.day).toLocaleDateString('ar-SA'), riyal(d.sales), d.orders,
          ])}
        />
      </div>
    </>
  );
}

function ProductReport({ data }: { data: any }) {
  return (
    <>
      <div className="card">
        <h3 className="card-title">الأكثر مبيعاً</h3>
        <Table
          head={['المنتج', 'التصنيف', 'الكمية', 'الإيراد']}
          rows={data.top.map((p: any) => [p.name, p.category, Math.round(p.quantity), riyal(p.revenue)])}
        />
      </div>
      <div className="card">
        <h3 className="card-title">الأقل مبيعاً</h3>
        <Table
          head={['المنتج', 'التصنيف', 'الكمية', 'الإيراد']}
          rows={data.slow.map((p: any) => [p.name, p.category, Math.round(p.quantity), riyal(p.revenue)])}
        />
      </div>
      <div className="card">
        <h3 className="card-title">المبيعات حسب التصنيف</h3>
        <Table
          head={['التصنيف', 'الكمية', 'الإيراد']}
          rows={data.byCategory.map((c: any) => [c.category, Math.round(c.quantity), riyal(c.revenue)])}
        />
      </div>
      <div className="card">
        <h3 className="card-title">الاستهلاك حسب الوصفات</h3>
        <p className="small muted">
          الكميات المستهلكة فعلياً من المخزون نتيجة ما تم بيعه، محسوبة من الوصفات
          والخيارات التي اختارها العملاء.
        </p>
        <Table
          head={['المادة', 'المستهلك', 'التكلفة']}
          rows={data.recipeUsage.map((u: any) => [
            u.item, quantity(Number(u.consumed), u.base_unit), riyal(u.cost),
          ])}
        />
      </div>
    </>
  );
}

function EmployeeReport({ rows }: { rows: any[] }) {
  return (
    <div className="card">
      <h3 className="card-title">أداء الموظفين</h3>
      <Table
        head={['الموظف', 'الرقم', 'الطلبات', 'المبيعات', 'متوسط الفاتورة',
               'الطاولات', 'الخصومات', 'الإلغاءات', 'إعادة الطباعة']}
        rows={rows.map((e: any) => [
          e.name, e.employee_code, e.orders, riyal(e.sales), riyal(e.average_ticket),
          e.tables_served, e.discounts_applied,
          e.voids > 3 ? <span className="badge amber">{e.voids}</span> : e.voids,
          e.reprints > 3 ? <span className="badge amber">{e.reprints}</span> : e.reprints,
        ])}
      />
    </div>
  );
}

function CustomerReport({ data }: { data: any }) {
  const r = data.returning ?? {};
  return (
    <>
      <div className="grid cols-4">
        <div className="stat"><div className="label">إجمالي العملاء</div>
          <div className="value">{r.total_customers}</div></div>
        <div className="stat"><div className="label">عملاء عائدون</div>
          <div className="value">{r.returning_customers}</div></div>
        <div className="stat"><div className="label">زيارة واحدة فقط</div>
          <div className="value">{r.one_time_customers}</div></div>
        <div className="stat"><div className="label">نقاط قائمة</div>
          <div className="value">{data.pointsOutstanding?.total_points ?? 0}</div></div>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h3 className="card-title">الأعلى إنفاقاً</h3>
        <Table
          head={['العميل', 'الزيارات', 'الطلبات', 'الإنفاق', 'متوسط الفاتورة', 'النقاط']}
          rows={data.topBySpend.map((c: any) => [
            c.name ?? c.customer_code, c.visit_count, c.order_count,
            riyal(c.total_spend), riyal(c.average_ticket), c.points,
          ])}
        />
      </div>
      <div className="card">
        <h3 className="card-title">عملاء لم يزوروا منذ 60 يوماً</h3>
        <Table
          head={['العميل', 'آخر زيارة', 'الإنفاق', 'الزيارات']}
          rows={data.inactive.map((c: any) => [
            c.name ?? c.customer_code,
            new Date(c.last_visit_at).toLocaleDateString('ar-SA'),
            riyal(c.total_spend), c.visit_count,
          ])}
        />
      </div>
    </>
  );
}

function InventoryReport({ data }: { data: any }) {
  return (
    <>
      <div className="grid cols-3">
        <div className="stat"><div className="label">قيمة المخزون</div>
          <div className="value">{riyal(data.totalStockValue)}</div></div>
        <div className={`stat${data.lowStock.length ? ' warn' : ''}`}>
          <div className="label">أصناف منخفضة</div>
          <div className="value">{data.lowStock.length}</div></div>
        <div className="stat"><div className="label">عمليات جرد</div>
          <div className="value">{data.variances.length}</div></div>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h3 className="card-title">الهدر حسب السبب</h3>
        <Table
          head={['السبب', 'عدد الحوادث', 'التكلفة']}
          rows={data.waste.map((w: any) => [w.reason, w.incidents, riyal(w.cost)])}
        />
      </div>
      <div className="card">
        <h3 className="card-title">فروقات الجرد</h3>
        <Table
          head={['الجرد', 'الموقع', 'الحالة', 'قيمة الفرق', 'النسبة']}
          rows={data.variances.map((v: any) => [
            v.count_number, v.location, v.status, riyal(v.total_variance_value),
            v.variance_percent != null
              ? (Math.abs(v.variance_percent) >= 3
                  ? <span className="badge red">{v.variance_percent}%</span>
                  : `${v.variance_percent}%`)
              : '—',
          ])}
        />
      </div>
      <div className="card">
        <h3 className="card-title">الاستهلاك حسب الوصفات</h3>
        <Table
          head={['المادة', 'المستهلك', 'التكلفة']}
          rows={data.usage.map((u: any) => [
            u.item, quantity(Number(u.consumed), u.base_unit), riyal(u.cost),
          ])}
        />
      </div>
    </>
  );
}

function PurchasingReport({ data }: { data: any }) {
  return (
    <>
      <div className="grid cols-3">
        <div className="stat"><div className="label">عدد المشتريات</div>
          <div className="value">{data.summary?.purchases ?? 0}</div></div>
        <div className="stat"><div className="label">إجمالي الإنفاق</div>
          <div className="value">{riyal(data.summary?.total_spend)}</div></div>
        <div className="stat"><div className="label">ضريبة القيمة المضافة</div>
          <div className="value">{riyal(data.summary?.vat)}</div></div>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h3 className="card-title">حسب المورد</h3>
        <Table
          head={['المورد', 'عدد المشتريات', 'الإنفاق']}
          rows={data.bySupplier.map((s: any) => [s.name, s.purchases, riyal(s.total_spend)])}
        />
      </div>
      <div className="card">
        <h3 className="card-title">حسب القسم</h3>
        <Table
          head={['القسم', 'الطلبات', 'الإنفاق']}
          rows={data.byDepartment.map((d: any) => [d.department, d.requests, riyal(d.spend)])}
        />
      </div>
      <div className="card">
        <h3 className="card-title">فروقات الكميات</h3>
        <p className="small muted">
          الحالات التي اختلف فيها المطلوب عن المعتمد، أو المشترى عن المستلم.
        </p>
        <Table
          head={['الطلب', 'الصنف', 'مطلوب', 'معتمد', 'مشترى', 'مستلم']}
          rows={data.quantityGaps.map((g: any) => [
            g.request_number, g.item,
            quantity(Number(g.requested_quantity ?? 0), g.base_unit),
            g.approved_quantity != null ? quantity(Number(g.approved_quantity), g.base_unit) : '—',
            g.purchased_quantity != null ? quantity(Number(g.purchased_quantity), g.base_unit) : '—',
            g.received_quantity != null ? quantity(Number(g.received_quantity), g.base_unit) : '—',
          ])}
        />
      </div>
    </>
  );
}
