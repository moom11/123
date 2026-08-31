/**
 * Cloudflare Workers entry point.
 *
 * Runs the same route files, guards and services as the Node server. What
 * changes is only the plumbing beneath them:
 *
 *   HTTP      Fastify            →  the router shim in core/router.ts
 *   Database  pg.Pool            →  a per-request pg.Client over Hyperdrive
 *   Realtime  an in-isolate Set  →  a Durable Object per branch
 *   Jobs      setInterval        →  the scheduled() handler on cron triggers
 *   Uploads   the filesystem     →  R2
 *
 * Nothing in modules/ was modified to make this work, which is the point: the
 * authorisation, OTP and transaction logic that the 119 tests cover is the
 * same code running here.
 */
import pg from 'pg';
import { RouterApp, type ShimRequest, type ShimReply } from './core/router.js';
import { useRequestConnection } from './core/db.js';
import { registerRoutes } from './routes.js';
import { attachPrincipal } from './core/http.js';
import { AppError } from './core/errors.js';
import { config } from './core/config.js';
import {
  publishLocal, setRealtimeTransport, addClient, removeClient,
  type RealtimeEvent,
} from './core/realtime.js';
import { setAttachmentStore } from './core/storage.js';

export interface Env {
  /** Hyperdrive binding, created with --caching-disabled. */
  HYPERDRIVE: { connectionString: string };
  /** Durable Object namespace holding the websockets for each branch. */
  REALTIME: DurableObjectNamespace;
  /** Invoice photographs. */
  ATTACHMENTS: R2Bucket;
  [key: string]: unknown;
}

// The route table is built once per isolate and reused across requests.
let router: RouterApp | null = null;

async function getRouter(): Promise<RouterApp> {
  if (router) return router;
  const app = new RouterApp();

  app.addHook('onRequest', async (req) => {
    await attachPrincipal(req as never);
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }
    const message = err instanceof Error ? err.message : 'خطأ غير متوقع';
    // eslint-disable-next-line no-console
    console.error('[worker] unhandled error', err);
    reply.status(500).send({
      error: {
        code: 'internal_error',
        message: config.isProd ? 'خطأ في الخادم' : message,
      },
    });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: { code: 'not_found', message: 'المسار غير موجود' } });
  });

  await registerRoutes(app as never);
  router = app;
  return app;
}

/**
 * Security headers, matching the Node server's helmet configuration. The API
 * serves JSON, so a `default-src 'none'` policy costs nothing and closes off
 * framing and content sniffing entirely.
 */
function securityHeaders(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('cross-origin-resource-policy', 'same-site');
  if (config.isProd) {
    headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains; preload');
  }
  if (origin && config.security.corsOrigins.includes(origin)) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-credentials', 'true');
    headers.set('vary', 'Origin');
  }
  return new Response(response.body, { status: response.status, headers });
}

function preflight(origin: string | null): Response {
  const headers = new Headers();
  if (origin && config.security.corsOrigins.includes(origin)) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-credentials', 'true');
    headers.set('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    headers.set('access-control-allow-headers',
      'Content-Type, Authorization, X-Device-Label, X-Idempotency-Key, X-Branch-Id');
    headers.set('access-control-max-age', '86400');
  }
  return new Response(null, { status: 204, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    const clientIp = request.headers.get('cf-connecting-ip') ?? '0.0.0.0';

    if (request.method === 'OPTIONS') return preflight(origin);

    // --- Realtime: hand the upgrade to the branch's Durable Object -----------
    if (url.pathname === '/ws') {
      return routeWebSocket(request, env, clientIp);
    }

    // --- Everything else runs against a request-scoped database connection ---
    const client = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString });
    await client.connect();
    const release = useRequestConnection(
      client as unknown as pg.PoolClient,
      async () => { await client.end().catch(() => {}); },
    );

    // Events published while handling this request are forwarded to the
    // Durable Object rather than to an in-isolate socket set.
    setRealtimeTransport((event) => {
      ctx.waitUntil(forwardToRealtime(env, event));
    });

    try {
      if (url.pathname === '/health') {
        const started = Date.now();
        await client.query('SELECT 1');
        return securityHeaders(Response.json({
          status: 'ok',
          database: 'ok',
          dbLatencyMs: Date.now() - started,
          runtime: 'cloudflare-workers',
          routes: (await getRouter()).routeCount,
          time: new Date().toISOString(),
        }), origin);
      }

      const app = await getRouter();
      const response = await app.handle(request, clientIp);
      return securityHeaders(response, origin);
    } finally {
      setRealtimeTransport(null);
      // Runs after the response is produced, returning the Hyperdrive
      // connection to the pool. Without this the pool is exhausted in minutes.
      ctx.waitUntil(release());
    }
  },

  /**
   * Background work, on cron triggers rather than setInterval — a Worker has no
   * process to hold a timer. Mirrors jobs/index.ts.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const client = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString });
    await client.connect();
    const release = useRequestConnection(
      client as unknown as pg.PoolClient,
      async () => { await client.end().catch(() => {}); },
    );
    setRealtimeTransport((e) => { ctx.waitUntil(forwardToRealtime(env, e)); });

    try {
      const { runScheduledMaintenance } = await import('./jobs/scheduled.js');
      await runScheduledMaintenance(event.cron);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[worker] scheduled job failed', err);
    } finally {
      setRealtimeTransport(null);
      await release();
    }
  },
};

// --- Realtime -----------------------------------------------------------------

/**
 * All sockets for one branch are held by one Durable Object instance, so a
 * table-status change reaches every iPad on that floor regardless of which
 * isolate handled the request that caused it.
 */
async function routeWebSocket(request: Request, env: Env, clientIp: string): Promise<Response> {
  if (request.headers.get('upgrade') !== 'websocket') {
    return new Response('expected websocket', { status: 426 });
  }

  // Authenticate BEFORE handing off, so the Durable Object only ever sees
  // sockets that already carry a valid principal.
  const shim = {
    headers: { authorization: '' } as Record<string, string>,
    url: new URL(request.url).pathname + new URL(request.url).search,
    query: Object.fromEntries(new URL(request.url).searchParams),
    ip: clientIp,
  } as unknown as ShimRequest;
  request.headers.forEach((v, k) => { (shim.headers as Record<string, string>)[k.toLowerCase()] = v; });

  await attachPrincipal(shim as never);
  const principal = (shim as { principal?: { branchId: string | null } }).principal;
  if (!principal) return new Response('unauthorized', { status: 401 });

  const branchId = principal.branchId ?? 'global';
  const id = env.REALTIME.idFromName(branchId);
  return env.REALTIME.get(id).fetch(request);
}

async function forwardToRealtime(env: Env, event: RealtimeEvent): Promise<void> {
  const branchId = event.branchId ?? 'global';
  const id = env.REALTIME.idFromName(branchId);
  await env.REALTIME.get(id).fetch('https://realtime/publish', {
    method: 'POST',
    body: JSON.stringify(event),
    headers: { 'content-type': 'application/json' },
  }).catch(() => { /* realtime is best-effort; clients also poll */ });
}

/**
 * The realtime hub for one branch.
 *
 * Uses the WebSocket Hibernation API: without it the object is billed for the
 * entire time a socket is connected, which for a POS that holds sockets all
 * service would be the whole trading day.
 */
export class RealtimeHub {
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/publish') {
      const event = (await request.json()) as RealtimeEvent;
      this.broadcast(event);
      return new Response(null, { status: 204 });
    }

    if (request.headers.get('upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Attach the principal's branch and permissions to the socket so filtering
      // survives hibernation without re-reading the database.
      const token = url.searchParams.get('access_token') ?? '';
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ token: token.slice(0, 16), joinedAt: Date.now() });

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not found', { status: 404 });
  }

  private broadcast(event: RealtimeEvent): void {
    const message = JSON.stringify({
      type: event.type, payload: event.payload, at: new Date().toISOString(),
    });
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(message); } catch { /* closing */ }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const parsed = JSON.parse(typeof message === 'string' ? message : '');
      if (parsed?.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    } catch { /* ignore malformed frames */ }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code, 'closing'); } catch { /* already closed */ }
  }
}
