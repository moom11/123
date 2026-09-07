/**
 * The detectors.
 *
 * Each one is a query plus a rule, kept side by side on purpose: a detector is
 * only reviewable if you can read what it counted and what it concluded in one
 * place. The query is data — it never decides anything — and `judge` is a pure
 * function of its rows and the branch's thresholds, so every rule here is
 * testable without a database, a clock, or a shift happening.
 *
 * What these look for is a SHAPE, not a size. The system already alerts on a
 * single large discount or a single large void, and those thresholds are the
 * first thing anyone stealing learns to stay under. Fifty discounts of twenty
 * riyals are invisible to a limit set at a hundred, and perfectly visible to a
 * count.
 *
 * Two rules hold everywhere below:
 *
 *   * A promotion is never a finding. A rule the owner wrote and the server
 *     applied is not a person's decision, and treating it as one would train
 *     managers to dismiss the whole screen.
 *   * A small sample is never a finding. A waiter who worked one shift and
 *     voided one item is not an outlier, and a detector that says so is worse
 *     than no detector.
 */

export type Severity = 'warning' | 'critical';
export type SubjectType =
  | 'employee' | 'user' | 'customer' | 'order' | 'invoice'
  | 'product' | 'department' | 'item' | 'branch';

export interface Finding {
  code: string;
  severity: Severity;
  subjectType: SubjectType;
  subjectId: string | null;
  subjectLabel: string;
  /** Identity of the claim: a day, an ISO week, or the row it is about. */
  periodKey: string;
  title: string;
  detail: string;
  metric: number;
  threshold: number;
  evidence: Record<string, unknown>;
}

export type Thresholds = Readonly<Record<string, number>>;

export interface Detector<Row = Record<string, unknown>> {
  code: string;
  /** Shown on the screen so a manager knows what the detector is for. */
  label: string;
  /** How far back the query reads, in days. */
  lookbackDays: number;
  /** $1 = branch id, $2 = window start, $3 = branch IANA timezone. */
  sql: string;
  judge(rows: Row[], t: Thresholds): Finding[];
}

/** Halalas → a readable amount. Findings are read by people, not machines. */
const sar = (halalas: number): string =>
  `${(halalas / 100).toLocaleString('ar-SA', { maximumFractionDigits: 2 })} ريال`;

const num = (v: unknown): number => Number(v ?? 0);

/**
 * Thresholds arrive from the settings table, where a branch may have changed
 * them or removed them. A missing one must not silently disable a detector,
 * so every read names its own fallback.
 */
const t = (thresholds: Thresholds, key: string, fallback: number): number => {
  const v = thresholds[key];
  return Number.isFinite(v) && (v as number) > 0 ? (v as number) : fallback;
};

// --- 1. Cooked food taken off the bill ---------------------------------------

interface VoidAfterPrintRow {
  employee_id: string | null; employee_name: string; day: string;
  voids: number; value: string; items: unknown;
}

export const voidAfterPrint: Detector<VoidAfterPrintRow> = {
  code: 'void_after_print',
  label: 'إلغاء أصناف بعد طباعتها',
  lookbackDays: 14,
  sql: `
    SELECT oi.voided_by_employee_id                       AS employee_id,
           COALESCE(e.full_name, 'غير معروف')             AS employee_name,
           to_char(oi.voided_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day,
           count(*)::int                                  AS voids,
           COALESCE(sum(oi.line_total), 0)::text          AS value,
           jsonb_agg(jsonb_build_object(
             'order', o.order_number, 'item', oi.product_name_ar,
             'amount', oi.line_total, 'at', oi.voided_at,
             'reason', COALESCE(oi.void_reason, '')) ORDER BY oi.voided_at) AS items
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN employees e ON e.id = oi.voided_by_employee_id
     WHERE o.branch_id = $1
       AND oi.voided_at >= $2
       -- The line was sent to a printer, so the kitchen or the bar made it.
       -- Voiding before that is an ordinary correction and is not counted.
       AND oi.printed_at IS NOT NULL
     GROUP BY 1, 2, 3`,

  judge(rows, thresholds) {
    const limit = t(thresholds, 'anomaly_void_after_print_count', 3);
    return rows.filter((r) => r.voids >= limit).map((r) => ({
      code: voidAfterPrint.code,
      severity: (r.voids >= limit * 2 ? 'critical' : 'warning') as Severity,
      subjectType: 'employee' as SubjectType,
      subjectId: r.employee_id,
      subjectLabel: r.employee_name,
      periodKey: r.day,
      title: `${r.employee_name}: ${r.voids} صنف أُلغي بعد تحضيره`,
      detail:
        `أُلغيت ${r.voids} أصناف بقيمة ${sar(num(r.value))} بعد إرسالها إلى المطبخ أو البار `
        + `في يوم ${r.day}، أي أن الصنف حُضّر ثم رُفع من الفاتورة. `
        + 'راجع الأسباب المكتوبة مع كل إلغاء.',
      metric: r.voids,
      threshold: limit,
      evidence: { day: r.day, value: num(r.value), items: r.items },
    }));
  },
};

// --- 2. One person voiding far more than the rest of the branch --------------

interface VoidRateRow {
  employee_id: string | null; employee_name: string;
  voided: number; total: number; branch_rate: string | number | null;
}

export const voidRate: Detector<VoidRateRow> = {
  code: 'void_rate',
  label: 'معدل إلغاء مرتفع مقارنة بالفرع',
  lookbackDays: 30,
  sql: `
    WITH per_employee AS (
      SELECT oi.added_by_employee_id AS employee_id,
             count(*) FILTER (WHERE oi.voided_at IS NOT NULL)::int AS voided,
             count(*)::int AS total
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
       WHERE o.branch_id = $1 AND oi.created_at >= $2
         AND oi.added_by_employee_id IS NOT NULL
       GROUP BY 1)
    SELECT p.employee_id,
           COALESCE(e.full_name, 'غير معروف') AS employee_name,
           p.voided, p.total,
           (SELECT sum(voided)::numeric / NULLIF(sum(total), 0) FROM per_employee) AS branch_rate
      FROM per_employee p
      LEFT JOIN employees e ON e.id = p.employee_id`,

  judge(rows, thresholds) {
    const ratio = t(thresholds, 'anomaly_void_rate_ratio', 3);
    const minOrders = t(thresholds, 'anomaly_void_rate_min_orders', 20);
    const branchRate = num(rows[0]?.branch_rate);
    // With nothing to compare against, everyone is an outlier. Say nothing.
    if (branchRate <= 0) return [];

    return rows
      .filter((r) => r.total >= minOrders && r.voided / r.total >= branchRate * ratio)
      .map((r) => {
        const rate = r.voided / r.total;
        return {
          code: voidRate.code,
          severity: 'warning' as Severity,
          subjectType: 'employee' as SubjectType,
          subjectId: r.employee_id,
          subjectLabel: r.employee_name,
          // One finding per employee per window, not per day: this is a claim
          // about a habit, and re-raising it daily would bury the screen.
          periodKey: 'rolling-30d',
          title: `${r.employee_name}: معدل إلغاء ${(rate * 100).toFixed(1)}%`,
          detail:
            `ألغى ${r.voided} من ${r.total} صنف خلال ٣٠ يوماً — `
            + `${(rate / branchRate).toFixed(1)} ضعف متوسط الفرع البالغ `
            + `${(branchRate * 100).toFixed(1)}%. `
            + 'قد يكون سببه تدريباً ناقصاً أو جهازاً بطيئاً، وقد لا يكون.',
          metric: Number((rate * 100).toFixed(2)),
          threshold: Number((branchRate * ratio * 100).toFixed(2)),
          evidence: {
            voided: r.voided, total: r.total,
            branchRatePercent: Number((branchRate * 100).toFixed(2)),
          },
        };
      });
  },
};

// --- 3. Discounts concentrated on one person ---------------------------------

interface DiscountDayRow {
  employee_id: string | null; employee_name: string; day: string;
  n: number; value: string; orders: unknown;
}

export const discountVolume: Detector<DiscountDayRow> = {
  code: 'discount_volume',
  label: 'كثرة الخصومات من موظف واحد',
  lookbackDays: 14,
  sql: `
    SELECT d.applied_by_employee_id                        AS employee_id,
           COALESCE(e.full_name, 'غير معروف')              AS employee_name,
           to_char(d.created_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day,
           count(*)::int                                   AS n,
           COALESCE(sum(d.discount_amount), 0)::text       AS value,
           jsonb_agg(jsonb_build_object(
             'order', o.order_number, 'amount', d.discount_amount,
             'kind', d.kind, 'at', d.created_at) ORDER BY d.created_at) AS orders
      FROM discounts d
      JOIN orders o ON o.id = d.order_id
      LEFT JOIN employees e ON e.id = d.applied_by_employee_id
     WHERE d.branch_id = $1 AND d.created_at >= $2
       AND d.applied_by_employee_id IS NOT NULL
       AND d.reversed_at IS NULL
       -- A promotion is a rule the owner wrote, applied by the server. It is
       -- not this person's decision and must not be counted against them.
       AND d.promotion_id IS NULL
     GROUP BY 1, 2, 3`,

  judge(rows, thresholds) {
    const limit = t(thresholds, 'anomaly_discount_count_per_day', 8);
    return rows.filter((r) => r.n >= limit).map((r) => ({
      code: discountVolume.code,
      severity: 'warning' as Severity,
      subjectType: 'employee' as SubjectType,
      subjectId: r.employee_id,
      subjectLabel: r.employee_name,
      periodKey: r.day,
      title: `${r.employee_name}: ${r.n} خصماً في يوم واحد`,
      detail:
        `طبّق ${r.n} خصماً بقيمة ${sar(num(r.value))} في يوم ${r.day}. `
        + 'الخصومات التي طبّقها عرض مسجّل غير محسوبة هنا — هذه قرارات فردية.',
      metric: r.n,
      threshold: limit,
      evidence: { day: r.day, value: num(r.value), orders: r.orders },
    }));
  },
};

// --- 4. The same two people meeting over a discount --------------------------

interface DiscountPairRow {
  employee_id: string | null; employee_name: string;
  customer_id: string | null; customer_name: string;
  week: string; n: number; value: string;
}

export const discountPair: Detector<DiscountPairRow> = {
  code: 'discount_pair',
  label: 'تكرار الخصم من الموظف نفسه للعميل نفسه',
  lookbackDays: 28,
  sql: `
    SELECT d.applied_by_employee_id                   AS employee_id,
           COALESCE(e.full_name, 'غير معروف')         AS employee_name,
           d.customer_id,
           COALESCE(c.full_name, 'عميل')              AS customer_name,
           to_char(d.created_at AT TIME ZONE $3, 'IYYY-"W"IW') AS week,
           count(*)::int                              AS n,
           COALESCE(sum(d.discount_amount), 0)::text  AS value
      FROM discounts d
      LEFT JOIN employees e ON e.id = d.applied_by_employee_id
      LEFT JOIN customers c ON c.id = d.customer_id
     WHERE d.branch_id = $1 AND d.created_at >= $2
       AND d.applied_by_employee_id IS NOT NULL
       AND d.customer_id IS NOT NULL
       AND d.reversed_at IS NULL
       AND d.promotion_id IS NULL
     GROUP BY 1, 2, 3, 4, 5`,

  judge(rows, thresholds) {
    const limit = t(thresholds, 'anomaly_discount_pair_per_week', 4);
    return rows.filter((r) => r.n >= limit).map((r) => ({
      code: discountPair.code,
      severity: 'warning' as Severity,
      subjectType: 'employee' as SubjectType,
      subjectId: r.employee_id,
      subjectLabel: r.employee_name,
      // The pair is the subject, so both halves belong in the key — otherwise
      // one employee's two regulars collapse into a single finding.
      periodKey: `${r.week}:${r.customer_id}`,
      title: `${r.employee_name} خصم لـ${r.customer_name} ${r.n} مرات`,
      detail:
        `${r.n} خصومات بقيمة ${sar(num(r.value))} من ${r.employee_name} `
        + `للعميل ${r.customer_name} في أسبوع واحد (${r.week}). `
        + 'قد يكون عميلاً دائماً، وقد يكون معرفة شخصية.',
      metric: r.n,
      threshold: limit,
      evidence: {
        week: r.week, value: num(r.value),
        customerId: r.customer_id, customerName: r.customer_name,
      },
    }));
  },
};

// --- 5. Money leaving a settled bill -----------------------------------------

interface PaymentVoidRow {
  payment_id: string; payment_number: string; order_id: string; order_number: string;
  amount: string; method: string; voided_at: string; void_reason: string | null;
  paid_at: string; actor: string;
}

export const paymentVoidAfterSettle: Detector<PaymentVoidRow> = {
  code: 'payment_void_after_settle',
  label: 'إلغاء دفعة بعد إقفال الفاتورة',
  lookbackDays: 30,
  sql: `
    SELECT p.id AS payment_id, p.payment_number, o.id AS order_id, o.order_number,
           p.amount::text, p.method, p.voided_at, p.void_reason, o.paid_at,
           COALESCE(e.full_name, u.full_name, 'غير معروف') AS actor
      FROM payments p
      JOIN orders o ON o.id = p.order_id
      LEFT JOIN employees e ON e.id = p.taken_by_employee_id
      LEFT JOIN users u ON u.id = p.taken_by_user_id
     WHERE o.branch_id = $1
       AND p.voided_at >= $2
       AND o.paid_at IS NOT NULL
       AND p.voided_at > o.paid_at`,

  judge(rows) {
    // No threshold. A payment cancelled after the customer has gone is a
    // single-occurrence event by nature, and one is already one too many.
    return rows.map((r) => ({
      code: paymentVoidAfterSettle.code,
      severity: 'critical' as Severity,
      subjectType: 'order' as SubjectType,
      subjectId: r.order_id,
      subjectLabel: r.order_number,
      periodKey: r.payment_id,
      title: `دفعة ${sar(num(r.amount))} أُلغيت بعد إقفال ${r.order_number}`,
      detail:
        `أُقفلت الفاتورة ثم أُلغيت الدفعة رقم ${r.payment_number} `
        + `(${sar(num(r.amount))} — ${r.method}) بواسطة ${r.actor}. `
        + `السبب المكتوب: ${r.void_reason || 'لم يُكتب سبب'}.`,
      metric: num(r.amount),
      threshold: 0,
      evidence: {
        paymentNumber: r.payment_number, amount: num(r.amount), method: r.method,
        paidAt: r.paid_at, voidedAt: r.voided_at, actor: r.actor,
        reason: r.void_reason,
      },
    }));
  },
};

// --- 6. A department throwing away much more than it usually does ------------

interface WasteDayRow {
  department: string; day: string; value: string;
}

export const wasteSpike: Detector<WasteDayRow> = {
  code: 'waste_spike',
  label: 'قفزة في الهدر مقارنة بمعتاد القسم',
  lookbackDays: 21,
  sql: `
    SELECT COALESCE(w.department, 'غير محدد')                AS department,
           to_char(w.occurred_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day,
           COALESCE(sum(w.estimated_cost), 0)::text          AS value
      FROM waste_records w
     WHERE w.branch_id = $1 AND w.occurred_at >= $2
       AND w.status <> 'rejected'
     GROUP BY 1, 2`,

  judge(rows, thresholds) {
    const ratio = t(thresholds, 'anomaly_waste_spike_ratio', 3);
    const byDepartment = new Map<string, WasteDayRow[]>();
    for (const row of rows) {
      const list = byDepartment.get(row.department) ?? [];
      list.push(row);
      byDepartment.set(row.department, list);
    }

    const findings: Finding[] = [];
    for (const [department, days] of byDepartment) {
      // A department needs a normal before it can depart from one. Five other
      // days is the smallest sample where a median means anything at all.
      if (days.length < 6) continue;

      for (const day of days) {
        const others = days.filter((d) => d.day !== day.day).map((d) => num(d.value));
        const baseline = median(others);
        // Every quiet day is infinitely above a baseline of zero. A department
        // that normally wastes nothing needs a different conversation, not an
        // alert every time a tomato is dropped.
        if (baseline <= 0) continue;
        const value = num(day.value);
        if (value < baseline * ratio) continue;

        findings.push({
          code: wasteSpike.code,
          severity: (value >= baseline * ratio * 2 ? 'critical' : 'warning') as Severity,
          subjectType: 'department' as SubjectType,
          subjectId: null,
          subjectLabel: department,
          periodKey: `${day.day}:${department}`,
          title: `هدر ${department} في ${day.day}: ${sar(value)}`,
          detail:
            `قيمة الهدر ${sar(value)} مقابل معتاد القسم ${sar(baseline)} — `
            + `${(value / baseline).toFixed(1)} ضعفاً. `
            + 'راجع سجلات الهدر لهذا اليوم قبل اعتمادها.',
          metric: value,
          threshold: Math.round(baseline * ratio),
          evidence: {
            day: day.day, department, value,
            baseline: Math.round(baseline), sampleDays: days.length - 1,
          },
        });
      }
    }
    return findings;
  },
};

/** Median of a sample. Chosen over a mean because one bad day must not become the normal. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

// --- 7. The same receipt printed again and again ------------------------------

interface ReprintRow {
  order_id: string; order_number: string; day: string; n: number;
  actor: string; times: unknown;
}

export const reprintBurst: Detector<ReprintRow> = {
  code: 'reprint_burst',
  label: 'إعادة طباعة الفاتورة نفسها مراراً',
  lookbackDays: 14,
  sql: `
    SELECT o.id AS order_id, o.order_number,
           to_char(pj.created_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day,
           count(*)::int AS n,
           COALESCE(max(e.full_name), max(u.full_name), 'غير معروف') AS actor,
           jsonb_agg(jsonb_build_object(
             'at', pj.created_at, 'reason', COALESCE(pj.reprint_reason, ''))
             ORDER BY pj.created_at) AS times
      FROM print_jobs pj
      JOIN orders o ON o.id = pj.order_id
      LEFT JOIN employees e ON e.id = pj.requested_by_employee_id
      LEFT JOIN users u ON u.id = pj.requested_by_user_id
     WHERE pj.branch_id = $1 AND pj.created_at >= $2
       AND pj.is_reprint
     GROUP BY 1, 2, 3`,

  judge(rows, thresholds) {
    const limit = t(thresholds, 'anomaly_reprint_count', 4);
    return rows.filter((r) => r.n >= limit).map((r) => ({
      code: reprintBurst.code,
      severity: 'warning' as Severity,
      subjectType: 'order' as SubjectType,
      subjectId: r.order_id,
      subjectLabel: r.order_number,
      periodKey: `${r.day}:${r.order_id}`,
      title: `${r.order_number}: أُعيدت طباعتها ${r.n} مرات`,
      detail:
        `أُعيدت طباعة الفاتورة ${r.n} مرات في يوم ${r.day} بواسطة ${r.actor}. `
        + 'الطابعة المتعطّلة سبب معتاد؛ وتسليم نسخة لكل عميل بدل التحصيل سبب آخر.',
      metric: r.n,
      threshold: limit,
      evidence: { day: r.day, actor: r.actor, times: r.times },
    }));
  },
};

// --- 8. A stock count that did not add up ------------------------------------

interface StockVarianceRow {
  id: string; count_number: string; location_name: string;
  total_variance_value: string; variance_percent: string; approved_at: string;
}

export const stockVariance: Detector<StockVarianceRow> = {
  code: 'stock_variance',
  label: 'فرق جرد يتجاوز الحد',
  lookbackDays: 30,
  sql: `
    SELECT sc.id, sc.count_number,
           COALESCE(l.name_ar, 'مخزن') AS location_name,
           COALESCE(sc.total_variance_value, 0)::text AS total_variance_value,
           COALESCE(sc.variance_percent, 0)::text     AS variance_percent,
           sc.approved_at
      FROM stock_counts sc
      LEFT JOIN inventory_locations l ON l.id = sc.location_id
     WHERE sc.branch_id = $1 AND sc.status = 'approved' AND sc.approved_at >= $2`,

  judge(rows, thresholds) {
    // These two already existed in settings and nothing read them. A threshold
    // an operator can set and no code consults is worse than no threshold.
    const percentLimit = t(thresholds, 'variance_alert_percent', 3);
    const valueLimit = t(thresholds, 'variance_alert_value', 20_000);

    return rows
      .filter((r) => Math.abs(num(r.variance_percent)) >= percentLimit
                  || Math.abs(num(r.total_variance_value)) >= valueLimit)
      .map((r) => {
        const value = num(r.total_variance_value);
        const percent = num(r.variance_percent);
        return {
          code: stockVariance.code,
          severity: (Math.abs(value) >= valueLimit * 3 ? 'critical' : 'warning') as Severity,
          subjectType: 'item' as SubjectType,
          subjectId: r.id,
          subjectLabel: r.count_number,
          periodKey: r.id,
          title: `جرد ${r.count_number}: فرق ${sar(Math.abs(value))}`,
          detail:
            `${r.location_name} — فرق ${percent.toFixed(2)}% بقيمة ${sar(Math.abs(value))} `
            + `${value < 0 ? 'ناقص عن' : 'زائد عن'} المتوقع. `
            + 'الفرق الناقص خسارة؛ والفرق الزائد يعني أن الاستهلاك لا يُسجَّل كما يجب.',
          metric: Math.abs(value),
          threshold: valueLimit,
          evidence: {
            countNumber: r.count_number, location: r.location_name,
            variancePercent: percent, varianceValue: value, approvedAt: r.approved_at,
          },
        };
      });
  },
};

/** Every detector the sweep runs, in the order a manager should read them. */
export const DETECTORS: readonly Detector<never>[] = [
  paymentVoidAfterSettle, voidAfterPrint, stockVariance, discountPair,
  discountVolume, wasteSpike, voidRate, reprintBurst,
] as unknown as readonly Detector<never>[];
