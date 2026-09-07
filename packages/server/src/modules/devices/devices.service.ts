/**
 * The terminals on the floor.
 *
 * A till and a waiter's tablet are not the same machine with different logins.
 * The till closes bills and issues tax invoices; the tablet takes orders and
 * never touches money. Enforcing that by device — not only by who is logged in
 * — is what stops a waiter settling a bill on a tablet in a corner, and it is
 * also what ZATCA requires: a CSID is issued per EGS unit, and an EGS unit is
 * a device that issues invoices.
 *
 * A device authenticates with its own long-lived token, stored hashed. The
 * staff session says WHO; the device token says WHERE.
 */
import type { PoolClient } from 'pg';
import { many, one, pool } from '../../core/db.js';
import { generateToken, hashToken } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { AUDIT, audit } from '../../core/audit.js';
import type { Principal } from '../../core/principal.js';
import { assertBranchAccess } from '../../core/principal.js';

export type DeviceKind = 'cashier' | 'waiter' | 'kiosk' | 'display';

export interface Device {
  id: string;
  branchId: string;
  kind: DeviceKind;
  label: string;
  serialNumber: string;
}

/** Resolve a device from its token. Returns null rather than throwing. */
export async function resolveDevice(token: string): Promise<Device | null> {
  const row = await one<{
    id: string; branch_id: string; kind: DeviceKind; label: string; serial_number: string;
  }>(
    `SELECT id, branch_id, kind, label, serial_number FROM devices
      WHERE token_hash = $1 AND is_active AND deleted_at IS NULL`,
    [hashToken(token)],
  );
  if (!row) return null;
  return {
    id: row.id, branchId: row.branch_id, kind: row.kind,
    label: row.label, serialNumber: row.serial_number,
  };
}

/**
 * The guard the payment path uses.
 *
 * Deliberately strict: an invoice has to be attributable to the unit that
 * issued it, so a settlement from an unregistered terminal is refused rather
 * than attributed to a default. The message says what to do, because the
 * cashier reading it is mid-shift with a customer waiting.
 */
export function requireCashierDevice(device: Device | null, branchId: string): Device {
  if (!device) {
    throw forbidden(
      'هذا الجهاز غير مسجَّل. الفواتير تُقفل من جهاز الكاشير فقط — '
      + 'سجّل الجهاز من شاشة الأجهزة ثم أعد المحاولة.',
    );
  }
  if (device.kind !== 'cashier') {
    throw forbidden(
      `«${device.label}» جهاز ${LABEL[device.kind]} ولا يقفل الفواتير. `
      + 'أغلق الحساب من جهاز الكاشير.',
    );
  }
  if (device.branchId !== branchId) {
    throw forbidden('هذا الجهاز مسجَّل في فرع آخر.');
  }
  return device;
}

const LABEL: Record<DeviceKind, string> = {
  cashier: 'كاشير', waiter: 'نادل', kiosk: 'طلب ذاتي', display: 'عرض',
};

export async function listDevices(principal: Principal, branchId: string) {
  assertBranchAccess(principal, branchId);
  return many(
    `SELECT d.id, d.kind, d.label, d.serial_number, d.is_active, d.last_seen_at,
            host(d.last_ip) AS last_ip, d.registered_at,
            z.onboarding_step, z.is_production,
            z.certificate IS NOT NULL AS has_certificate
       FROM devices d
       LEFT JOIN zatca_credentials z ON z.device_id = d.id
      WHERE d.branch_id = $1 AND d.deleted_at IS NULL
      ORDER BY CASE d.kind WHEN 'cashier' THEN 0 WHEN 'waiter' THEN 1 ELSE 2 END,
               d.label`,
    [branchId],
  );
}

/**
 * Register a terminal. The token is returned EXACTLY ONCE — it is stored
 * hashed, so there is no way to show it again, and that is deliberate.
 */
export async function registerDevice(
  principal: Principal, branchId: string,
  input: { kind: DeviceKind; label: string; serialNumber: string },
): Promise<{ id: string; token: string; kind: DeviceKind; label: string }> {
  assertBranchAccess(principal, branchId);

  if (!/^[A-Za-z0-9._-]{2,40}$/.test(input.serialNumber)) {
    throw badRequest('الرقم التسلسلي: أحرف وأرقام و - . _ فقط، بين 2 و40 خانة.');
  }

  const token = generateToken(32);
  const row = await one<{ id: string }>(
    `INSERT INTO devices (branch_id, kind, label, serial_number, token_hash, registered_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [branchId, input.kind, input.label, input.serialNumber, hashToken(token),
     principal.userId],
  ).catch((err: { code?: string }) => {
    if (err.code === '23505') throw conflict('رقم تسلسلي مستخدم في هذا الفرع بالفعل');
    throw err;
  });

  await audit({
    action: AUDIT.DEVICE_REGISTERED, actorUserId: principal.userId,
    actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
    branchId, entityType: 'device', entityId: row!.id,
    newValue: { kind: input.kind, label: input.label, serialNumber: input.serialNumber },
  });

  return { id: row!.id, token, kind: input.kind, label: input.label };
}

/**
 * Retire a device. Never a hard delete: its invoices reference it, and the
 * chain has to stay readable for as long as the invoices do.
 */
export async function retireDevice(
  principal: Principal, deviceId: string, reason: string,
): Promise<void> {
  const device = await one<{ branch_id: string; kind: string; label: string }>(
    'SELECT branch_id, kind, label FROM devices WHERE id = $1 AND deleted_at IS NULL',
    [deviceId],
  );
  if (!device) throw notFound('الجهاز غير موجود');
  assertBranchAccess(principal, device.branch_id);

  // Retiring the only till leaves a branch unable to take money. That is a
  // mistake worth blocking rather than an intention worth honouring.
  if (device.kind === 'cashier') {
    const remaining = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM devices
        WHERE branch_id = $1 AND kind = 'cashier' AND is_active
          AND deleted_at IS NULL AND id <> $2`,
      [device.branch_id, deviceId],
    );
    if (Number(remaining!.n) === 0) {
      throw conflict(
        'هذا آخر جهاز كاشير في الفرع — سجّل بديلاً قبل إيقافه، وإلا تعذّر إغلاق أي فاتورة.',
      );
    }
  }

  await pool.query(
    `UPDATE devices SET is_active = FALSE, deleted_at = now() WHERE id = $1`, [deviceId],
  );
  await audit({
    action: AUDIT.DEVICE_RETIRED, actorUserId: principal.userId,
    actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
    branchId: device.branch_id, entityType: 'device', entityId: deviceId,
    oldValue: { label: device.label, kind: device.kind },
    newValue: { reason },
  });
}

/** Issue a fresh token, e.g. after a tablet is lost. Invalidates the old one. */
export async function rotateDeviceToken(
  principal: Principal, deviceId: string,
): Promise<{ token: string }> {
  const device = await one<{ branch_id: string; label: string }>(
    'SELECT branch_id, label FROM devices WHERE id = $1 AND deleted_at IS NULL', [deviceId],
  );
  if (!device) throw notFound('الجهاز غير موجود');
  assertBranchAccess(principal, device.branch_id);

  const token = generateToken(32);
  await pool.query('UPDATE devices SET token_hash = $2 WHERE id = $1',
    [deviceId, hashToken(token)]);

  await audit({
    action: AUDIT.DEVICE_TOKEN_ROTATED, actorUserId: principal.userId,
    actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
    branchId: device.branch_id, entityType: 'device', entityId: deviceId,
    newValue: { label: device.label },
  });
  return { token };
}

/** Liveness stamp, best-effort — never on the critical path of a sale. */
export function touchDevice(deviceId: string, ip: string | null): void {
  void pool.query(
    'UPDATE devices SET last_seen_at = now(), last_ip = $2::inet WHERE id = $1',
    [deviceId, ip],
  ).catch(() => { /* non-critical */ });
}

/** The cashier device of a branch, for jobs that have no request context. */
export async function primaryCashierDevice(
  branchId: string, client?: PoolClient,
): Promise<Device | null> {
  const row = await one<{
    id: string; branch_id: string; kind: DeviceKind; label: string; serial_number: string;
  }>(
    `SELECT id, branch_id, kind, label, serial_number FROM devices
      WHERE branch_id = $1 AND kind = 'cashier' AND is_active AND deleted_at IS NULL
      ORDER BY registered_at LIMIT 1`,
    [branchId], client,
  );
  if (!row) return null;
  return {
    id: row.id, branchId: row.branch_id, kind: row.kind,
    label: row.label, serialNumber: row.serial_number,
  };
}
