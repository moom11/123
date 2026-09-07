import { many, one, pool } from '../../core/db.js';
import { AUDIT, audit } from '../../core/audit.js';
import { notFound } from '../../core/errors.js';
import type { Principal } from '../../core/principal.js';

export async function listSuppliers(branchId: string, includeInactive = false) {
  return many(
    `SELECT s.id, s.name, s.phone, s.email, s.vat_number, s.contact_person,
            s.is_active, s.notes,
            (SELECT max(p.purchased_at) FROM purchases p WHERE p.supplier_id = s.id) AS last_purchase_at,
            (SELECT count(*)::int FROM purchases p WHERE p.supplier_id = s.id) AS purchase_count
       FROM suppliers s
      WHERE (s.branch_id = $1 OR s.branch_id IS NULL) AND s.deleted_at IS NULL
        AND ($2::boolean OR s.is_active)
      ORDER BY s.name`,
    [branchId, includeInactive],
  );
}

export async function upsertSupplier(
  principal: Principal,
  input: {
    id?: string | null; branchId: string; name: string; phone?: string | null;
    email?: string | null; vatNumber?: string | null; contactPerson?: string | null;
    address?: string | null; notes?: string | null; isActive?: boolean;
  },
): Promise<{ id: string }> {
  if (input.id) {
    const before = await one<any>('SELECT * FROM suppliers WHERE id = $1', [input.id]);
    if (!before) throw notFound('المورد غير موجود');
    await pool.query(
      `UPDATE suppliers SET name = $2, phone = $3, email = $4, vat_number = $5,
              contact_person = $6, address = $7, notes = $8, is_active = $9
        WHERE id = $1`,
      [
        input.id, input.name, input.phone ?? null, input.email ?? null,
        input.vatNumber ?? null, input.contactPerson ?? null, input.address ?? null,
        input.notes ?? null, input.isActive ?? true,
      ],
    );
    await audit({
      action: AUDIT.SUPPLIER_UPDATED, actorUserId: principal.userId,
      actorLabel: principal.displayName, branchId: input.branchId,
      entityType: 'supplier', entityId: input.id,
      oldValue: { name: before.name, phone: before.phone, isActive: before.is_active },
      newValue: { name: input.name, phone: input.phone, isActive: input.isActive },
    });
    return { id: input.id };
  }

  const created = await one<{ id: string }>(
    `INSERT INTO suppliers (branch_id, name, phone, email, vat_number,
       contact_person, address, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      input.branchId, input.name, input.phone ?? null, input.email ?? null,
      input.vatNumber ?? null, input.contactPerson ?? null, input.address ?? null,
      input.notes ?? null, principal.userId,
    ],
  );
  await audit({
    action: AUDIT.SUPPLIER_CREATED, actorUserId: principal.userId,
    actorLabel: principal.displayName, branchId: input.branchId,
    entityType: 'supplier', entityId: created!.id,
    newValue: { name: input.name },
  });
  return { id: created!.id };
}

/**
 * Price history for an item. Surfaces last / average / lowest so the buyer can
 * decide — the system deliberately never picks a supplier automatically.
 */
export async function itemPriceHistory(itemId: string, days = 180) {
  const history = await many(
    `SELECT sp.id, sp.unit_price, sp.entered_price, sp.entered_unit, sp.effective_at,
            sp.source, s.id AS supplier_id, s.name AS supplier_name,
            p.purchase_number, p.invoice_number
       FROM supplier_prices sp
       JOIN suppliers s ON s.id = sp.supplier_id
       LEFT JOIN purchases p ON p.id = sp.purchase_id
      WHERE sp.item_id = $1 AND sp.effective_at > now() - ($2 || ' days')::interval
      ORDER BY sp.effective_at DESC LIMIT 100`,
    [itemId, String(days)],
  );

  const summary = await one(
    `SELECT
       (SELECT unit_price FROM supplier_prices WHERE item_id = $1
         ORDER BY effective_at DESC LIMIT 1) AS last_price,
       AVG(unit_price) AS average_price,
       MIN(unit_price) AS lowest_price,
       MAX(unit_price) AS highest_price,
       count(*)::int AS sample_size
     FROM supplier_prices
     WHERE item_id = $1 AND effective_at > now() - ($2 || ' days')::interval`,
    [itemId, String(days)],
  );

  const bySupplier = await many(
    `SELECT s.id, s.name,
            AVG(sp.unit_price) AS average_price,
            MIN(sp.unit_price) AS lowest_price,
            max(sp.effective_at) AS last_seen,
            count(*)::int AS purchases
       FROM supplier_prices sp JOIN suppliers s ON s.id = sp.supplier_id
      WHERE sp.item_id = $1 AND sp.effective_at > now() - ($2 || ' days')::interval
      GROUP BY s.id ORDER BY average_price`,
    [itemId, String(days)],
  );

  return { history, summary, bySupplier };
}
