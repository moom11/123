import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { one, pool } from '../src/core/db.js';
import { setMessageProvider, type MessageProvider } from '../src/modules/customers/whatsapp.provider.js';

/**
 * Captures every OTP the system sends, so tests can act as the customer
 * reading the code off their phone — without ever reaching WhatsApp.
 */
export class CapturingProvider implements MessageProvider {
  readonly name = 'capture';
  readonly sent: Array<{ phone: string; code: string; purpose: string }> = [];

  async sendOtp(phone: string, code: string, purposeLabel: string) {
    this.sent.push({ phone, code, purpose: purposeLabel });
    return { ok: true, reference: `capture-${this.sent.length}` };
  }

  lastCode(): string {
    const last = this.sent.at(-1);
    if (!last) throw new Error('no OTP was sent');
    return last.code;
  }

  clear(): void { this.sent.length = 0; }
}

export const otpCapture = new CapturingProvider();

let app: FastifyInstance | null = null;

export async function getApp(): Promise<FastifyInstance> {
  if (!app) {
    setMessageProvider(otpCapture);
    app = await buildApp();
    await app.ready();
  }
  return app;
}

export async function closeApp(): Promise<void> {
  sessionCache.clear();
  if (app) { await app.close(); app = null; }
  await pool.end().catch(() => {});
}

export interface Session { accessToken: string; refreshToken: string }

/**
 * Sessions are cached per principal. Login endpoints are deliberately
 * rate-limited (that limit has its own test), so a suite that logged in afresh
 * for every assertion would be testing the throttle rather than the feature.
 */
const sessionCache = new Map<string, Session>();

export function clearSessionCache(): void { sessionCache.clear(); }

export async function loginAdmin(email: string, password: string): Promise<Session> {
  const cached = sessionCache.get(`admin:${email}`);
  if (cached) return cached;

  const a = await getApp();
  const res = await a.inject({
    method: 'POST', url: '/api/auth/login', payload: { email, password },
  });
  const body = res.json();
  if (body.status !== 'ok') {
    throw new Error(`admin login did not complete: ${JSON.stringify(body).slice(0, 300)}`);
  }
  sessionCache.set(`admin:${email}`, body.tokens);
  return body.tokens;
}

export async function loginEmployee(code: string, pin: string): Promise<Session> {
  const cached = sessionCache.get(`emp:${code}`);
  if (cached) return cached;

  const a = await getApp();
  const branchId = await getBranchId();
  const res = await a.inject({
    method: 'POST', url: '/api/auth/employee/login',
    payload: { branchId, employeeCode: code, pin },
  });
  const body = res.json();
  if (!body.tokens) {
    throw new Error(`employee login failed: ${JSON.stringify(body).slice(0, 300)}`);
  }
  sessionCache.set(`emp:${code}`, body.tokens);
  return body.tokens;
}

export function auth(session: Session): Record<string, string> {
  return { authorization: `Bearer ${session.accessToken}` };
}

export async function getBranchId(): Promise<string> {
  const b = await one<{ id: string }>("SELECT id FROM branches WHERE code = 'MARA-01'");
  return b!.id;
}

export async function getProductId(name: string): Promise<string> {
  const p = await one<{ id: string }>('SELECT id FROM products WHERE name_ar = $1', [name]);
  if (!p) throw new Error(`product not found: ${name}`);
  return p.id;
}

export async function getTableId(number: string): Promise<string> {
  const t = await one<{ id: string }>(
    'SELECT id FROM restaurant_tables WHERE table_number = $1', [number],
  );
  return t!.id;
}

export async function getQrValue(tableNumber: string): Promise<string> {
  const { buildQrValue } = await import('../src/modules/tables/tables.service.js');
  const t = await one<{ qr_token: string }>(
    'SELECT qr_token FROM restaurant_tables WHERE table_number = $1', [tableNumber],
  );
  return buildQrValue(t!.qr_token);
}

export async function getModifierOption(name: string): Promise<string> {
  const o = await one<{ id: string }>(
    'SELECT id FROM modifier_options WHERE name_ar = $1', [name],
  );
  if (!o) throw new Error(`modifier option not found: ${name}`);
  return o.id;
}

export async function getItemId(sku: string): Promise<string> {
  const i = await one<{ id: string }>('SELECT id FROM inventory_items WHERE sku = $1', [sku]);
  if (!i) throw new Error(`inventory item not found: ${sku}`);
  return i.id;
}

export async function stockOf(sku: string, locationCode = 'BAR'): Promise<number> {
  const row = await one<{ quantity: number }>(
    `SELECT COALESCE(s.quantity, 0) AS quantity
       FROM inventory_items i
       JOIN inventory_locations l ON l.code = $2 AND l.branch_id = i.branch_id
       LEFT JOIN inventory_stock s ON s.item_id = i.id AND s.location_id = l.id
      WHERE i.sku = $1`,
    [sku, locationCode],
  );
  return Number(row?.quantity ?? 0);
}

export async function getCustomerId(phone = '+966551234567'): Promise<string> {
  const c = await one<{ id: string }>('SELECT id FROM customers WHERE phone = $1', [phone]);
  return c!.id;
}

export async function auditCount(action: string, entityId?: string): Promise<number> {
  const row = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE action = $1 AND ($2::text IS NULL OR entity_id = $2)`,
    [action, entityId ?? null],
  );
  return row?.n ?? 0;
}
