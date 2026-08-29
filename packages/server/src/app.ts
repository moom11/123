import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { config } from './core/config.js';
import { attachPrincipal, sendError } from './core/http.js';
import { AppError } from './core/errors.js';
import { addClient, removeClient, clientCount } from './core/realtime.js';
import { registerRoutes } from './routes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.isProd
      ? { level: process.env.LOG_LEVEL ?? 'info' }
      : { level: process.env.LOG_LEVEL ?? 'warn',
          transport: undefined },
    trustProxy: config.security.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  // --- Security headers -----------------------------------------------------
  // The API serves JSON, so a restrictive CSP costs nothing and closes off
  // content-sniffing and framing entirely.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  });

  await app.register(cors, {
    origin(origin, cb) {
      // Same-origin and native app requests arrive without an Origin header.
      if (!origin) return cb(null, true);
      cb(null, config.security.corsOrigins.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Label', 'X-Idempotency-Key'],
  });

  await app.register(cookie, { secret: config.security.cookieSecret });

  await app.register(rateLimit, {
    global: true,
    max: config.security.rateLimitMax,
    timeWindow: config.security.rateLimitWindowMs,
    // Rate limit per authenticated principal where possible, per IP otherwise,
    // so one busy till does not throttle the whole branch.
    keyGenerator: (req) => req.principal?.userId ?? req.customer?.customerId ?? req.ip,
    // statusCode is included so the error handler below recognises the
    // rejection as a 429 rather than falling through to a generic 500.
    errorResponseBuilder: () => ({
      statusCode: 429,
      code: 'FST_ERR_RATE_LIMIT',
      error: { code: 'too_many_requests', message: 'محاولات كثيرة، حاول بعد قليل' },
    }),
  });

  await app.register(multipart, {
    limits: { fileSize: config.uploads.maxBytes, files: 4 },
  });

  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });

  // --- Request pipeline -----------------------------------------------------
  app.addHook('onRequest', async (req) => {
    await attachPrincipal(req);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) req.log.error({ err }, 'app error');
      return sendError(reply, err);
    }
    if ((err as { validation?: unknown }).validation) {
      return reply.status(400).send({
        error: { code: 'bad_request', message: 'بيانات غير صالحة' },
      });
    }
    const asFastify = err as { statusCode?: number; code?: string };
    if (asFastify.statusCode === 429 || asFastify.code === 'FST_ERR_RATE_LIMIT') {
      return reply.status(429).send({
        error: { code: 'too_many_requests', message: 'محاولات كثيرة، حاول بعد قليل' },
      });
    }
    req.log.error({ err }, 'unhandled error');
    return sendError(reply, err);
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      error: { code: 'not_found', message: 'المسار غير موجود' },
    });
  });

  app.get('/health', async () => {
    const { pool } = await import('./core/db.js');
    const started = Date.now();
    await pool.query('SELECT 1');
    return {
      status: 'ok',
      database: 'ok',
      dbLatencyMs: Date.now() - started,
      realtimeClients: clientCount(),
      time: new Date().toISOString(),
    };
  });

  // --- Realtime -------------------------------------------------------------
  // Authenticated over the same access token; a socket inherits exactly the
  // permissions of the principal that opened it and nothing more.
  app.register(async (scope) => {
    scope.get('/ws', { websocket: true }, (socket, req) => {
      const principal = req.principal;
      if (!principal) {
        socket.send(JSON.stringify({ type: 'error', payload: { message: 'unauthorized' } }));
        socket.close(1008, 'unauthorized');
        return;
      }

      const client = {
        socket: socket as unknown as import('ws').WebSocket,
        userId: principal.userId,
        employeeId: principal.employeeId,
        branchId: principal.branchId,
        permissions: principal.permissions,
        channels: new Set<string>(),
      };
      addClient(client);
      socket.send(JSON.stringify({
        type: 'connected',
        payload: { branchId: principal.branchId, employeeId: principal.employeeId },
      }));

      socket.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg?.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
        } catch { /* ignore malformed frames */ }
      });
      socket.on('close', () => removeClient(client));
      socket.on('error', () => removeClient(client));
    });
  });

  await registerRoutes(app);
  return app;
}
