import type { PoolClient } from 'pg';
import { config } from '../../core/config.js';
import { many, one, pool } from '../../core/db.js';
import { generateNumericCode, hashSecret, verifySecret } from '../../core/crypto.js';
import { AUDIT, audit } from '../../core/audit.js';
import { badRequest, notFound, tooManyRequests, unprocessable } from '../../core/errors.js';
import { getMessageProvider } from './whatsapp.provider.js';

export type OtpPurpose =
  | 'customer_login' | 'order_verification' | 'customer_discount' | 'points_redemption';

const PURPOSE_LABELS: Record<OtpPurpose, string> = {
  customer_login: 'تسجيل الدخول',
  order_verification: 'تأكيد الطلب',
  customer_discount: 'خصم خاص',
  points_redemption: 'استخدام النقاط',
};

export interface IssueOtpInput {
  purpose: OtpPurpose;
  phone: string;
  customerId?: string | null;
  branchId?: string | null;
  orderId?: string | null;
  tableId?: string | null;
  /**
   * Binds the code to one specific operation. Two different discount attempts
   * produce two different refs, so a code minted for one can never satisfy the
   * other — this is what stops a staff member banking a code and reusing it.
   */
  operationRef?: string | null;
  payload?: Record<string, unknown>;
  requestedByUserId?: string | null;
  requestedByEmployeeId?: string | null;
  ip?: string | null;
}

export interface IssueOtpResult {
  otpRequestId: string;
  expiresAt: string;
  channel: 'whatsapp' | 'sms';
  delivered: boolean;
  /** Present only when a non-delivering provider is in use (development). */
  devCode?: string;
}

/**
 * Issue a one-time code over WhatsApp.
 *
 * Throttling is per phone number, not per staff member, because the person
 * being protected is the customer whose phone would otherwise be spammed.
 */
export async function issueOtp(input: IssueOtpInput): Promise<IssueOtpResult> {
  const recent = await one<{ cnt: number; last_at: Date | null }>(
    `SELECT count(*)::int AS cnt, max(created_at) AS last_at
       FROM otp_requests
      WHERE phone = $1 AND created_at > now() - interval '1 hour'`,
    [input.phone],
  );

  if ((recent?.cnt ?? 0) >= config.otp.maxPerPhonePerHour) {
    throw tooManyRequests('تم تجاوز عدد رموز التحقق المسموح بها لهذا الرقم، حاول لاحقاً');
  }
  if (recent?.last_at) {
    const sinceMs = Date.now() - new Date(recent.last_at).getTime();
    if (sinceMs < config.otp.resendCooldownSeconds * 1000) {
      const wait = Math.ceil((config.otp.resendCooldownSeconds * 1000 - sinceMs) / 1000);
      throw tooManyRequests(`انتظر ${wait} ثانية قبل طلب رمز جديد`);
    }
  }

  // Any earlier live code for the same customer and purpose is invalidated, so
  // only the most recent code can ever be used.
  if (input.customerId) {
    await pool.query(
      `UPDATE otp_requests SET invalidated_at = now()
        WHERE customer_id = $1 AND purpose = $2
          AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > now()`,
      [input.customerId, input.purpose],
    );
  }

  const code = generateNumericCode(config.otp.length);
  const codeHash = await hashSecret(code);

  const row = await one<{ id: string; expires_at: Date }>(
    `INSERT INTO otp_requests (
       customer_id, phone, purpose, code_hash, operation_ref, branch_id, order_id,
       table_id, requested_by_user_id, requested_by_employee_id, payload,
       channel, max_attempts, expires_at, ip
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'whatsapp',$12,
               now() + ($13 || ' seconds')::interval, $14)
     RETURNING id, expires_at`,
    [
      input.customerId ?? null, input.phone, input.purpose, codeHash,
      input.operationRef ?? null, input.branchId ?? null, input.orderId ?? null,
      input.tableId ?? null, input.requestedByUserId ?? null,
      input.requestedByEmployeeId ?? null, JSON.stringify(input.payload ?? {}),
      config.otp.maxAttempts, String(config.otp.ttlSeconds), input.ip ?? null,
    ],
  );
  if (!row) throw new Error('Failed to create OTP request');

  const provider = getMessageProvider();
  const delivery = await provider.sendOtp(input.phone, code, PURPOSE_LABELS[input.purpose]);

  await pool.query(
    `UPDATE otp_requests
        SET delivery_status = $2, delivery_ref = $3, delivery_error = $4
      WHERE id = $1`,
    [row.id, delivery.ok ? 'sent' : 'failed', delivery.reference ?? null, delivery.error ?? null],
  );

  await audit({
    action: AUDIT.OTP_ISSUED,
    branchId: input.branchId ?? null,
    actorUserId: input.requestedByUserId ?? null,
    actorEmployeeId: input.requestedByEmployeeId ?? null,
    actorKind: input.requestedByEmployeeId ? 'employee' : 'system',
    entityType: 'otp_request', entityId: row.id,
    // The code itself is never logged, only the fact that one was issued.
    metadata: {
      purpose: input.purpose, delivered: delivery.ok,
      operationRef: input.operationRef, orderId: input.orderId,
      error: delivery.error,
    },
    ip: input.ip,
  });

  if (!delivery.ok && config.isProd) {
    throw unprocessable(`تعذّر إرسال رمز التحقق: ${delivery.error ?? 'خطأ في المزود'}`);
  }

  return {
    otpRequestId: row.id,
    expiresAt: row.expires_at.toISOString(),
    channel: 'whatsapp',
    delivered: delivery.ok,
    devCode: provider.name === 'log' ? code : undefined,
  };
}

export interface VerifyOtpInput {
  otpRequestId: string;
  code: string;
  purpose: OtpPurpose;
  /** Must match what the code was minted for. */
  operationRef?: string | null;
  customerId?: string | null;
  consumedByUserId?: string | null;
  consumedByEmployeeId?: string | null;
}

export interface VerifiedOtp {
  id: string;
  customerId: string | null;
  purpose: OtpPurpose;
  payload: Record<string, unknown>;
}

/**
 * Verify and atomically consume a code.
 *
 * The consuming UPDATE is guarded on `consumed_at IS NULL`, so even two
 * simultaneous requests carrying the same correct code can only ever succeed
 * once — the second finds zero rows and is rejected.
 *
 * When `client` is supplied, consumption joins the caller's transaction: if
 * applying the discount then fails, the code is released rather than burned.
 */
export async function verifyOtp(
  input: VerifyOtpInput,
  client?: PoolClient,
): Promise<VerifiedOtp> {
  const runner = client ?? pool;

  const { rows } = await runner.query<{
    id: string; customer_id: string | null; purpose: OtpPurpose; code_hash: string;
    operation_ref: string | null; attempt_count: number; max_attempts: number;
    expires_at: Date; consumed_at: Date | null; invalidated_at: Date | null;
    payload: Record<string, unknown>; branch_id: string | null;
  }>(
    'SELECT * FROM otp_requests WHERE id = $1 FOR UPDATE',
    [input.otpRequestId],
  );
  const otp = rows[0];
  if (!otp) throw notFound('طلب التحقق غير موجود');

  const reject = async (reason: string, message: string): Promise<never> => {
    await runner.query(
      'UPDATE otp_requests SET attempt_count = attempt_count + 1 WHERE id = $1',
      [otp.id],
    );
    await audit({
      action: AUDIT.OTP_FAILED, branchId: otp.branch_id,
      actorUserId: input.consumedByUserId ?? null,
      actorEmployeeId: input.consumedByEmployeeId ?? null,
      actorKind: input.consumedByEmployeeId ? 'employee' : 'system',
      entityType: 'otp_request', entityId: otp.id,
      metadata: { reason, purpose: otp.purpose },
    }, runner);
    throw badRequest(message);
  };

  if (otp.consumed_at) return reject('already_used', 'تم استخدام هذا الرمز مسبقاً');
  if (otp.invalidated_at) return reject('invalidated', 'تم إلغاء هذا الرمز، اطلب رمزاً جديداً');
  if (otp.expires_at <= new Date()) return reject('expired', 'انتهت صلاحية الرمز، اطلب رمزاً جديداً');
  if (otp.attempt_count >= otp.max_attempts) {
    return reject('too_many_attempts', 'تم تجاوز عدد المحاولات، اطلب رمزاً جديداً');
  }
  // A code minted for a discount can never authorise a points redemption.
  if (otp.purpose !== input.purpose) return reject('purpose_mismatch', 'رمز غير صالح لهذه العملية');
  if (input.operationRef && otp.operation_ref !== input.operationRef) {
    return reject('operation_mismatch', 'رمز غير صالح لهذه العملية');
  }
  if (input.customerId && otp.customer_id && otp.customer_id !== input.customerId) {
    return reject('customer_mismatch', 'الرمز يخص عميلاً آخر');
  }

  if (!(await verifySecret(otp.code_hash, input.code.trim()))) {
    return reject('bad_code', 'رمز التحقق غير صحيح');
  }

  const consumed = await runner.query(
    `UPDATE otp_requests
        SET consumed_at = now(), consumed_by_user_id = $2, consumed_by_employee_id = $3
      WHERE id = $1 AND consumed_at IS NULL`,
    [otp.id, input.consumedByUserId ?? null, input.consumedByEmployeeId ?? null],
  );
  // Lost a race with a concurrent verification of the same code.
  if (consumed.rowCount === 0) return reject('already_used', 'تم استخدام هذا الرمز مسبقاً');

  await audit({
    action: AUDIT.OTP_VERIFIED, branchId: otp.branch_id,
    actorUserId: input.consumedByUserId ?? null,
    actorEmployeeId: input.consumedByEmployeeId ?? null,
    actorKind: input.consumedByEmployeeId ? 'employee' : 'system',
    entityType: 'otp_request', entityId: otp.id,
    metadata: { purpose: otp.purpose, operationRef: otp.operation_ref },
  }, runner);

  return {
    id: otp.id,
    customerId: otp.customer_id,
    purpose: otp.purpose,
    payload: otp.payload ?? {},
  };
}

/** Housekeeping: expired codes are useless and are cleared periodically. */
export async function purgeExpiredOtps(olderThanDays = 30): Promise<number> {
  const res = await pool.query(
    `DELETE FROM otp_requests
      WHERE created_at < now() - ($1 || ' days')::interval`,
    [String(olderThanDays)],
  );
  return res.rowCount ?? 0;
}

export async function listCustomerOtpHistory(customerId: string, limit = 20) {
  return many(
    `SELECT id, purpose, delivery_status, expires_at, consumed_at, created_at
       FROM otp_requests WHERE customer_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [customerId, limit],
  );
}
