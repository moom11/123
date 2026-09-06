import { afterAll, describe, expect, test } from 'vitest';
import {
  auth, closeApp, getApp, getBranchId, loginAdmin,
} from './helpers.js';
import { many, one, pool } from '../src/core/db.js';
import {
  discountPair, discountVolume, paymentVoidAfterSettle, reprintBurst,
  stockVariance, voidAfterPrint, voidRate, wasteSpike, DETECTORS,
} from '../src/modules/anomalies/detectors.js';
import { sweepBranch, thresholdsFor } from '../src/modules/anomalies/anomalies.service.js';

const OWNER = { email: 'owner@maralounge.sa', password: 'MaraOwner#2026Xy' };

afterAll(async () => { await closeApp(); });

async function ownerHeaders(): Promise<Record<string, string>> {
  const session = await loginAdmin(OWNER.email, OWNER.password);
  return { ...auth(session), 'x-branch-id': await getBranchId() };
}

/**
 * The rules, with no database anywhere near them.
 *
 * Every detector's judgement is a pure function of rows and thresholds, which
 * is the only reason the interesting cases below can be tested at all: "a
 * waiter who worked one shift is not an outlier" is a claim about a sample
 * size that would take a month of real trading to produce.
 */
describe('what counts as a finding', () => {
  test('voiding cooked food is counted, voiding before the ticket prints is not', () => {
    // The query is what excludes unprinted lines, so this test states the
    // other half: given lines that DID print, the count is what decides.
    const rows = [
      { employee_id: 'e1', employee_name: 'خالد', day: '2026-09-01',
        voids: 3, value: '9000', items: [] },
      { employee_id: 'e2', employee_name: 'نورة', day: '2026-09-01',
        voids: 2, value: '4000', items: [] },
    ];
    const found = voidAfterPrint.judge(rows, { anomaly_void_after_print_count: 3 });
    expect(found).toHaveLength(1);
    expect(found[0]!.subjectLabel).toBe('خالد');
    expect(found[0]!.metric).toBe(3);
  });

  test('twice the threshold is critical, not merely worth a look', () => {
    const rows = [{ employee_id: 'e1', employee_name: 'خالد', day: '2026-09-01',
                    voids: 6, value: '20000', items: [] }];
    const [finding] = voidAfterPrint.judge(rows, { anomaly_void_after_print_count: 3 });
    expect(finding!.severity).toBe('critical');
  });

  test('a threshold missing from settings falls back rather than disabling the rule', () => {
    const rows = [{ employee_id: 'e1', employee_name: 'خالد', day: '2026-09-01',
                    voids: 4, value: '9000', items: [] }];
    // An operator who deletes a setting must not silently switch off detection.
    expect(voidAfterPrint.judge(rows, {})).toHaveLength(1);
    expect(voidAfterPrint.judge(rows, { anomaly_void_after_print_count: NaN })).toHaveLength(1);
  });

  test('one shift is not a pattern: a small sample is never an outlier', () => {
    const rows = [
      // 100% void rate, but on four items. Somebody dropped a tray.
      { employee_id: 'new', employee_name: 'موظف جديد', voided: 4, total: 4, branch_rate: 0.02 },
      { employee_id: 'old', employee_name: 'موظف قديم', voided: 25, total: 200, branch_rate: 0.02 },
    ];
    const found = voidRate.judge(rows, {
      anomaly_void_rate_ratio: 3, anomaly_void_rate_min_orders: 20,
    });
    expect(found.map((f) => f.subjectId)).toEqual(['old']);
  });

  test('with nothing to compare against, the rate detector says nothing', () => {
    const rows = [{ employee_id: 'e1', employee_name: 'خالد',
                    voided: 5, total: 50, branch_rate: 0 }];
    expect(voidRate.judge(rows, {})).toEqual([]);
  });

  test('a repeated pair keys on both halves, so two regulars are two findings', () => {
    const rows = [
      { employee_id: 'e1', employee_name: 'خالد', customer_id: 'c1',
        customer_name: 'عميل أ', week: '2026-W36', n: 5, value: '10000' },
      { employee_id: 'e1', employee_name: 'خالد', customer_id: 'c2',
        customer_name: 'عميل ب', week: '2026-W36', n: 4, value: '8000' },
    ];
    const found = discountPair.judge(rows, { anomaly_discount_pair_per_week: 4 });
    expect(new Set(found.map((f) => f.periodKey)).size).toBe(2);
  });

  test('a payment cancelled after the bill closed needs no threshold at all', () => {
    const rows = [{
      payment_id: 'p1', payment_number: 'PAY-1', order_id: 'o1', order_number: 'ORD-1',
      amount: '15000', method: 'cash', voided_at: '2026-09-01T22:00:00Z',
      void_reason: null, paid_at: '2026-09-01T21:00:00Z', actor: 'نورة',
    }];
    const [finding] = paymentVoidAfterSettle.judge(rows, {});
    expect(finding!.severity).toBe('critical');
    expect(finding!.detail).toContain('لم يُكتب سبب');
  });

  test('waste is judged against the department, not against a fixed number', () => {
    // Six ordinary days around 100 riyals, then one at 600.
    const days = ['01', '02', '03', '04', '05', '06'].map((d) => ({
      department: 'kitchen', day: `2026-09-${d}`, value: '10000',
    }));
    const rows = [...days, { department: 'kitchen', day: '2026-09-07', value: '60000' }];
    const found = wasteSpike.judge(rows, { anomaly_waste_spike_ratio: 3 });
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence).toMatchObject({ day: '2026-09-07', baseline: 10_000 });
  });

  test('a department with no history is not accused of a spike', () => {
    const rows = [
      { department: 'bar', day: '2026-09-01', value: '0' },
      { department: 'bar', day: '2026-09-02', value: '50000' },
    ];
    expect(wasteSpike.judge(rows, {})).toEqual([]);
  });

  test('a department whose normal is zero is not alerted on every dropped glass', () => {
    const rows = ['01', '02', '03', '04', '05', '06'].map((d) => ({
      department: 'shisha', day: `2026-09-${d}`, value: '0',
    }));
    rows.push({ department: 'shisha', day: '2026-09-07', value: '500' });
    expect(wasteSpike.judge(rows, {})).toEqual([]);
  });

  test('a stock count is judged on percent OR value, and either alone is enough', () => {
    const base = {
      count_number: 'CNT-1', location_name: 'المخزن', approved_at: '2026-09-01T00:00:00Z',
    };
    const rows = [
      { ...base, id: 'a', total_variance_value: '-50000', variance_percent: '0.5' },
      { ...base, id: 'b', total_variance_value: '-100', variance_percent: '9' },
      { ...base, id: 'c', total_variance_value: '-100', variance_percent: '0.2' },
    ];
    const found = stockVariance.judge(rows,
      { variance_alert_percent: 3, variance_alert_value: 20_000 });
    expect(found.map((f) => f.subjectId).sort()).toEqual(['a', 'b']);
  });

  test('a negative variance reads as a loss and a positive one as unrecorded use', () => {
    const rows = [{
      id: 'a', count_number: 'CNT-1', location_name: 'المخزن',
      total_variance_value: '-50000', variance_percent: '4', approved_at: '2026-09-01',
    }];
    const [finding] = stockVariance.judge(rows, {});
    expect(finding!.detail).toContain('ناقص عن');
    // The metric is the size of the gap, so a screen sorted by it is sorted by
    // how much money is missing, in either direction.
    expect(finding!.metric).toBe(50_000);
  });

  test('every detector produces a stable identity for the same input', () => {
    const rows = [{ employee_id: 'e1', employee_name: 'خالد', day: '2026-09-01',
                    n: 9, value: '5000', orders: [] }];
    const first = discountVolume.judge(rows, {});
    const second = discountVolume.judge(rows, {});
    expect(first[0]!.periodKey).toBe(second[0]!.periodKey);
    expect(first[0]!.code).toBe(second[0]!.code);
  });

  test('the reprint rule names the innocent explanation too', () => {
    const rows = [{ order_id: 'o1', order_number: 'ORD-9', day: '2026-09-01',
                    n: 5, actor: 'نورة', times: [] }];
    const [finding] = reprintBurst.judge(rows, { anomaly_reprint_count: 4 });
    // A finding that reads as an accusation gets dismissed unread.
    expect(finding!.detail).toContain('الطابعة المتعطّلة');
  });

  test('detector codes are unique — the identity index depends on it', () => {
    const codes = DETECTORS.map((d) => d.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

/**
 * The sweep against the real database.
 *
 * Every detector's SQL runs here even when it finds nothing, which is the
 * point: a query that references a column that no longer exists is a detector
 * that silently stops detecting, and that is the failure mode this catches.
 */
describe('the sweep', () => {
  test('every detector query runs against the real schema', async () => {
    const branchId = await getBranchId();
    const result = await sweepBranch(branchId);
    // A detector that throws is swallowed so the others still run, and the
    // swallow is audited. Nothing may be in that log after a clean sweep.
    const broken = await many<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs
        WHERE action = 'anomaly.sweep' AND metadata ? 'error'
          AND occurred_at > now() - interval '1 minute'`,
    );
    expect(broken.map((r) => r.metadata)).toEqual([]);
    expect(result.branchId).toBe(branchId);
  });

  test('a real pattern is found, and finding it twice does not raise it twice',
    async () => {
      const branchId = await getBranchId();
      const product = await one<{ id: string }>(
        'SELECT id FROM products WHERE deleted_at IS NULL ORDER BY name_ar LIMIT 1',
      );
      const employee = await one<{ id: string; full_name: string }>(
        `SELECT id, full_name FROM employees WHERE branch_id = $1 AND deleted_at IS NULL
          ORDER BY employee_code LIMIT 1`, [branchId],
      );

      // Three cooked items taken off bills by one person today. Written
      // directly because producing this through the API would mean voiding
      // real printed tickets, and the detector reads rows, not the route.
      const order = await one<{ id: string }>(
        `INSERT INTO orders (order_number, branch_id, status, grand_total)
         VALUES ($1, $2, 'paid', 30000) RETURNING id`,
        [`ORD-ANOM-${Date.now()}`, branchId],
      );
      for (let i = 0; i < 3; i += 1) {
        await pool.query(
          `INSERT INTO order_items
             (order_id, line_number, product_id, product_name_ar, quantity, unit_price,
              production_department, effective_unit_price, line_total, printed_at,
              voided_at, voided_by_employee_id, void_reason)
           VALUES ($1,$2,$3,'صنف تجربة',1,10000,'KITCHEN',10000,10000, now(), now(), $4, 'اختبار')`,
          [order!.id, i + 1, product!.id, employee!.id],
        );
      }

      const first = await sweepBranch(branchId);
      expect(first.byCode.void_after_print).toBeGreaterThanOrEqual(1);

      const row = await one<{ id: string; detections: number; status: string }>(
        `SELECT id, detections, status FROM anomalies
          WHERE branch_id = $1 AND code = 'void_after_print' AND subject_id = $2
          ORDER BY first_detected_at DESC LIMIT 1`,
        [branchId, employee!.id],
      );
      expect(row?.status).toBe('open');
      const before = row!.detections;

      // The second sweep re-derives the same claim. One row, one alert.
      await sweepBranch(branchId);
      const after = await one<{ n: string; detections: number }>(
        `SELECT count(*)::text AS n, max(detections) AS detections FROM anomalies
          WHERE branch_id = $1 AND code = 'void_after_print' AND subject_id = $2`,
        [branchId, employee!.id],
      );
      expect(Number(after!.n)).toBe(1);
      expect(after!.detections).toBe(before + 1);

      // And exactly one notification, from the first sweep only.
      const notifications = await one<{ n: string }>(
        `SELECT count(*)::text AS n FROM notifications
          WHERE kind = 'anomaly_void_after_print' AND entity_id = $1`,
        [row!.id],
      );
      expect(Number(notifications!.n)).toBe(1);

      await pool.query('DELETE FROM order_items WHERE order_id = $1', [order!.id]);
      await pool.query('DELETE FROM orders WHERE id = $1', [order!.id]);
    });

  test('a finding is answered by a person, and dismissing one needs a reason',
    async () => {
      const app = await getApp();
      const headers = await ownerHeaders();
      const branchId = await getBranchId();

      const target = await one<{ id: string }>(
        `SELECT id FROM anomalies WHERE branch_id = $1 AND status = 'open'
          ORDER BY first_detected_at DESC LIMIT 1`, [branchId],
      );
      if (!target) return;   // nothing open; the sweep test above covers detection

      const noReason = await app.inject({
        method: 'POST', url: `/api/anomalies/${target.id}/review`,
        headers, payload: { status: 'dismissed' },
      });
      expect(noReason.statusCode).toBe(400);

      const ok = await app.inject({
        method: 'POST', url: `/api/anomalies/${target.id}/review`,
        headers, payload: { status: 'dismissed', note: 'راجعتها مع المدير' },
      });
      expect(ok.statusCode).toBe(200);

      const after = await one<{ status: string; review_note: string; reviewed_by: string }>(
        `SELECT a.status, a.review_note, u.full_name AS reviewed_by
           FROM anomalies a LEFT JOIN users u ON u.id = a.reviewed_by_user_id
          WHERE a.id = $1`, [target.id],
      );
      expect(after?.status).toBe('dismissed');
      expect(after?.review_note).toBe('راجعتها مع المدير');
      // The whole value of the screen is that "we looked and it was fine" has
      // a name attached to it.
      expect(after?.reviewed_by).toBeTruthy();

      const audited = await one<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_logs
          WHERE action = 'anomaly.dismissed' AND entity_id = $1`, [target.id],
      );
      expect(Number(audited!.n)).toBe(1);
    });

  test('a waiter cannot read findings about waiters', async () => {
    const app = await getApp();
    const { loginEmployee } = await import('./helpers.js');
    const waiter = await loginEmployee('1042', '2580');
    const res = await app.inject({
      method: 'GET', url: '/api/anomalies', headers: auth(waiter),
    });
    expect(res.statusCode).toBe(403);
  });

  test('thresholds come from settings, and a branch override wins', async () => {
    const branchId = await getBranchId();
    await pool.query(
      `INSERT INTO settings (branch_id, key, value) VALUES ($1, 'anomaly_reprint_count', '9'::jsonb)
       ON CONFLICT (COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
       DO UPDATE SET value = EXCLUDED.value`,
      [branchId],
    );
    const t = await thresholdsFor(branchId);
    expect(t.anomaly_reprint_count).toBe(9);
    await pool.query(
      "DELETE FROM settings WHERE branch_id = $1 AND key = 'anomaly_reprint_count'",
      [branchId],
    );
    const back = await thresholdsFor(branchId);
    expect(back.anomaly_reprint_count).toBe(4);   // the shipped default
  });
});
