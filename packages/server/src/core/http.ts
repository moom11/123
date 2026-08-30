import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodTypeAny, type output as ZodOutput } from 'zod';
import { AppError, badRequest, unauthorized } from './errors.js';
import { config } from './config.js';
import { verifyJwt } from './crypto.js';
import { loadPrincipal } from '../modules/auth/auth.service.js';
import { one, pool } from './db.js';
import type { RequestMeta } from '../modules/auth/auth.service.js';

export function meta(req: FastifyRequest): RequestMeta {
  return {
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
    requestId: req.id,
    deviceLabel: (req.headers['x-device-label'] as string) ?? null,
  };
}

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): ZodOutput<S> {
  try {
    return schema.parse(data) as ZodOutput<S>;
  } catch (err) {
    if (err instanceof ZodError) {
      throw badRequest('بيانات غير صالحة', err.issues.map((i) => ({
        path: i.path.join('.'), message: i.message,
      })));
    }
    throw err;
  }
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;

  // A browser cannot set headers on a WebSocket handshake, so the token may
  // arrive as a query parameter — accepted ONLY for the /ws upgrade, never for
  // ordinary requests, where a token in the URL would leak into access logs,
  // proxy logs and Referer headers.
  if (req.url?.startsWith('/ws')) {
    const token = (req.query as { access_token?: string } | undefined)?.access_token;
    if (typeof token === 'string' && token.length > 0) return token;
  }
  return null;
}

/**
 * Populates req.principal when a valid staff access token is present. It never
 * rejects on its own — routes declare their own requirements, so a public route
 * can still benefit from knowing who the caller is.
 */
export async function attachPrincipal(req: FastifyRequest): Promise<void> {
  const token = bearer(req);
  if (!token) return;

  let payload: { sub: string; sid?: string; kind?: string; stage?: string; cid?: string };
  try {
    payload = verifyJwt(token, config.auth.accessSecret);
  } catch {
    return;
  }

  // A half-authenticated MFA token must never act as a session.
  if (payload.stage) return;

  if (payload.cid && payload.sid) {
    const session = await one<{ id: string; customer_id: string; phone: string }>(
      `SELECT cs.id, cs.customer_id, c.phone
         FROM customer_sessions cs JOIN customers c ON c.id = cs.customer_id
        WHERE cs.id = $1 AND cs.revoked_at IS NULL AND cs.expires_at > now()`,
      [payload.sid],
    );
    if (session) {
      req.customer = {
        kind: 'customer', customerId: session.customer_id,
        sessionId: session.id, phone: session.phone,
      };
    }
    return;
  }

  if (!payload.sid) return;
  const principal = await loadPrincipal(payload.sid);
  if (!principal) return;

  // Which branch is this request about? Multi-branch admins have no home
  // branch, so they say so per request. Naming a branch is not permission to
  // use it — resolveBranch still runs it past assertBranchAccess.
  const header = req.headers['x-branch-id'];
  const requested = Array.isArray(header) ? header[0] : header;
  principal.requestedBranchId = UUID_RE.test(requested ?? '') ? requested! : null;

  req.principal = principal;

  // Cheap liveness stamp so idle-timeout has something to measure against.
  void pool.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [payload.sid])
    .catch(() => { /* non-critical */ });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route guard: a valid staff session is required. */
export async function requireAuth(req: FastifyRequest): Promise<void> {
  if (!req.principal) throw unauthorized('يجب تسجيل الدخول');
}

/** Route guard: a verified customer session is required. */
export async function requireCustomerAuth(req: FastifyRequest): Promise<void> {
  if (!req.customer) throw unauthorized('يجب التحقق من رقم الجوال');
}

/**
 * Route guard factory. Attach with `preHandler: requirePermission('pos.use')`
 * so authorisation is declared next to the route and cannot be forgotten.
 */
export function requirePermission(...permissions: string[]) {
  return async function guard(req: FastifyRequest): Promise<void> {
    if (!req.principal) throw unauthorized('يجب تسجيل الدخول');
    const ok = permissions.some((p) => req.principal!.permissions.has(p));
    if (!ok) {
      throw new AppError(403, 'forbidden',
        `تحتاج إحدى الصلاحيات: ${permissions.join('، ')}`);
    }
  };
}

export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AppError) {
    return reply.status(err.statusCode).send({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }
  const message = err instanceof Error ? err.message : 'خطأ غير متوقع';
  return reply.status(500).send({
    error: { code: 'internal_error', message: config.isProd ? 'خطأ في الخادم' : message },
  });
}
