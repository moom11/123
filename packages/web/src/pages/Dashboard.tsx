import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { Spinner, Stat, useToast } from '../components/ui.js';
import { riyal } from '../lib/format.js';

/** Branch manager dashboard, plus the owner's cross-branch view where allowed. */
export function Dashboard() {
  const { can } = useSession();
  const { push } = useToast();
  const [data, setData] = useState<any | null>(null);
  const [owner, setOwner] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const branch = await api<any>('/dashboard/branch');
        setData(branch);
        if (can('reports.all_branches')) {
          setOwner(await api<any>('/dashboard/owner'));
        }
      } catch (err) {
        push((err as Error).message, 'error');
      } finally {
        setLoading(false);
      }
    })();
  }, [can, push]);

  if (loading) return <Spinner label="جارٍ تحميل المؤشرات…" />;
  if (!data) return null;

  const { sales, operational, customers, lastVariance } = data;

  return (
    <>
      <h3 className="card-title">مؤشرات اليوم</h3>
      <div className="grid cols-4">
        <Stat label="مبيعات اليوم" value={riyal(sales.sales_today)} sub={`${sales.orders_today} فاتورة`} />
        <Stat label="متوسط الفاتورة" value={riyal(sales.average_invoice)} />
        <Stat label="نقدي" value={riyal(sales.cash)} />
        <Stat label="شبكة / بطاقات" value={riyal(sales.card)} />
      </div>

      <div className="grid cols-4" style={{ marginTop: 12 }}>
        <Stat
          label="طاولات مفتوحة"
          value={`${operational.open_tables} / ${operational.total_tables}`}
        />
        <Stat
          label="طلبات بانتظار الويتر" value={operational.pending_approvals}
          tone={operational.pending_approvals > 0 ? 'warn' : undefined}
        />
        <Stat
          label="طلبات خدمة مفتوحة" value={operational.open_service_requests}
          tone={operational.open_service_requests > 0 ? 'warn' : undefined}
        />
        <Stat
          label="فشل طباعة" value={operational.failed_print_jobs}
          tone={operational.failed_print_jobs > 0 ? 'alert' : undefined}
        />
      </div>

      <h3 className="card-title" style={{ marginTop: 18 }}>المخزون والمشتريات</h3>
      <div className="grid cols-4">
        <Stat
          label="أصناف تحت الحد الأدنى" value={operational.low_stock_items}
          tone={operational.low_stock_items > 0 ? 'warn' : undefined}
        />
        <Stat
          label="طلبات شراء بانتظار الاعتماد" value={operational.purchase_requests_pending}
          tone={operational.purchase_requests_pending > 0 ? 'warn' : undefined}
        />
        <Stat label="مشتريات اليوم" value={riyal(operational.purchases_today)} />
        <Stat
          label="هدر اليوم" value={riyal(operational.waste_today)}
          tone={operational.waste_today > 10000 ? 'warn' : undefined}
        />
      </div>

      <h3 className="card-title" style={{ marginTop: 18 }}>العملاء والمخاطر</h3>
      <div className="grid cols-4">
        <Stat label="عملاء اليوم" value={customers?.customers_today ?? 0} />
        <Stat label="عملاء جدد" value={customers?.new_customers_today ?? 0} />
        <Stat label="خصومات اليوم" value={riyal(sales.discounts_today)} />
        <Stat
          label="إلغاءات / إعادة طباعة"
          value={`${operational.voids_today} / ${operational.reprints_today}`}
          tone={operational.voids_today > 5 ? 'warn' : undefined}
        />
      </div>

      {lastVariance && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3 className="card-title">آخر جرد</h3>
          <div className="row">
            <span className="muted">{lastVariance.count_number}</span>
            <span className="spacer" />
            <span className={`badge ${Math.abs(lastVariance.variance_percent ?? 0) >= 3 ? 'red' : 'green'}`}>
              فرق {riyal(lastVariance.total_variance_value)}
              {lastVariance.variance_percent != null && ` (${lastVariance.variance_percent}%)`}
            </span>
          </div>
        </div>
      )}

      {owner && (
        <>
          <h3 className="card-title" style={{ marginTop: 20 }}>كل الفروع</h3>
          <div className="card">
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>الفرع</th><th>المبيعات</th><th>الفواتير</th>
                    <th>متوسط الفاتورة</th><th>الخصومات</th><th>العملاء</th>
                  </tr>
                </thead>
                <tbody>
                  {owner.branches.map((b: any) => (
                    <tr key={b.id}>
                      <td>{b.name}</td>
                      <td className="num">{riyal(b.sales)}</td>
                      <td className="num">{b.orders}</td>
                      <td className="num">{riyal(b.average_invoice)}</td>
                      <td className="num">{riyal(b.discounts)}</td>
                      <td className="num">{b.customers}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid cols-4" style={{ marginTop: 12 }}>
            <Stat label="هدر بانتظار الموافقة" value={owner.risks.waste_pending}
                  tone={owner.risks.waste_pending > 0 ? 'warn' : undefined} />
            <Stat label="جرد بفروقات عالية" value={owner.risks.high_variance_counts}
                  tone={owner.risks.high_variance_counts > 0 ? 'alert' : undefined} />
            <Stat label="خصومات يدوية" value={owner.risks.manual_discounts} />
            <Stat label="محاولات دخول فاشلة" value={owner.risks.failed_logins}
                  tone={owner.risks.failed_logins > 20 ? 'warn' : undefined} />
          </div>
        </>
      )}
    </>
  );
}
