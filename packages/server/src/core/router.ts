/**
 * A minimal Fastify-compatible router.
 *
 * The point of this file is what it lets us NOT change. Every route file, every
 * `requirePermission` guard and every handler in this codebase was written
 * against Fastify and is covered by integration tests. Rewriting 135 route
 * definitions for a different framework would put the authorisation logic —
 * the part that most needs to stay correct — through a hand translation.
 *
 * Instead this implements the narrow slice of Fastify those files actually use,
 * over Web-standard Request/Response, so the same route files run unchanged on
 * Cloudflare Workers.
 *
 * Deliberately NOT implemented, because nothing here uses it: hooks other than
 * onRequest, decorators, schema validation (we use zod in the handlers),
 * streaming replies, and the reply object's fluent API beyond status/send.
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ShimRequest {
  method: string;
  url: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
  ip: string;
  id: string;
  /** Populated by the auth hook, exactly as under Fastify. */
  principal?: unknown;
  customer?: unknown;
  /** Multipart, used only by the invoice upload route. */
  file: () => Promise<
    { filename: string; mimetype: string; toBuffer: () => Promise<Uint8Array> } | null
  >;
  /** The raw request, for anything the shim does not model. */
  raw: Request;
}

export interface ShimReply {
  status: (code: number) => ShimReply;
  send: (payload: unknown) => ShimReply;
  header: (name: string, value: string) => ShimReply;
  statusCode: number;
  payload: unknown;
  sent: boolean;
  headers: Record<string, string>;
}

export type PreHandler = (req: ShimRequest, reply: ShimReply) => Promise<void> | void;
export type Handler = (req: ShimRequest, reply: ShimReply) => Promise<unknown> | unknown;

export interface RouteOptions {
  preHandler?: PreHandler | PreHandler[];
  config?: { rateLimit?: { max: number; timeWindow: string } };
}

interface Route {
  method: HttpMethod;
  /** The path as written, e.g. '/orders/:id/items'. */
  pattern: string;
  segments: string[];
  handler: Handler;
  options: RouteOptions;
}

export type Plugin = (app: RouterApp) => Promise<void> | void;

export class RouterApp {
  private routes: Route[] = [];
  private onRequestHooks: PreHandler[] = [];
  private errorHandler?: (err: unknown, req: ShimRequest, reply: ShimReply) => unknown;
  private notFoundHandler?: (req: ShimRequest, reply: ShimReply) => unknown;

  constructor(private readonly prefix: string = '') {}

  private add(method: HttpMethod, path: string, a: RouteOptions | Handler, b?: Handler): void {
    const options = typeof a === 'function' ? {} : a;
    const handler = (typeof a === 'function' ? a : b)!;
    const pattern = `${this.prefix}${path}`;
    this.routes.push({
      method, pattern, segments: splitPath(pattern), handler, options,
    });
  }

  get(path: string, a: RouteOptions | Handler, b?: Handler): void { this.add('GET', path, a, b); }
  post(path: string, a: RouteOptions | Handler, b?: Handler): void { this.add('POST', path, a, b); }
  patch(path: string, a: RouteOptions | Handler, b?: Handler): void { this.add('PATCH', path, a, b); }
  put(path: string, a: RouteOptions | Handler, b?: Handler): void { this.add('PUT', path, a, b); }
  delete(path: string, a: RouteOptions | Handler, b?: Handler): void { this.add('DELETE', path, a, b); }

  addHook(name: 'onRequest', fn: PreHandler): void {
    if (name === 'onRequest') this.onRequestHooks.push(fn);
  }

  setErrorHandler(fn: (err: unknown, req: ShimRequest, reply: ShimReply) => unknown): void {
    this.errorHandler = fn;
  }

  setNotFoundHandler(fn: (req: ShimRequest, reply: ShimReply) => unknown): void {
    this.notFoundHandler = fn;
  }

  /**
   * Register a plugin, optionally under a prefix. Routes registered by the
   * plugin are collected into this app rather than an encapsulated child, which
   * is the behaviour these route files rely on.
   */
  async register(plugin: Plugin, opts: { prefix?: string } = {}): Promise<void> {
    const child = new RouterApp(`${this.prefix}${opts.prefix ?? ''}`);
    await plugin(child);
    this.routes.push(...child.routes);
    this.onRequestHooks.push(...child.onRequestHooks);
  }

  /**
   * Resolve a path to the MOST SPECIFIC matching route, the way Fastify's radix
   * tree does: a static segment always beats a parameter at the same position,
   * so `/orders/pending-approval` wins over `/orders/:id` even though `:id` is
   * registered first.
   *
   * This compares candidates at lookup time rather than pre-sorting the table.
   * Sorting looked cheaper but cannot work: "static beats parameter at the
   * first differing segment" is not a total order over the whole route set
   * (two unrelated routes compare equal while each differs from a third), and
   * feeding a non-transitive comparator to Array.sort gives an arbitrary
   * order. Choosing among only the routes that actually matched sidesteps that
   * entirely — all candidates have the same segment count, so the comparison is
   * well defined.
   */
  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    const parts = splitPath(pathname);
    let best: { route: Route; params: Record<string, string> } | null = null;

    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;

      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < parts.length; i += 1) {
        const segment = route.segments[i];
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(parts[i]);
        } else if (segment !== parts[i]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      if (best === null || isMoreSpecific(route.segments, best.route.segments)) {
        best = { route, params };
      }
    }
    return best;
  }

  /** Route counts, used by the parity test and by the health endpoint. */
  get routeCount(): number { return this.routes.length; }
  listRoutes(): Array<{ method: string; pattern: string }> {
    return this.routes.map((r) => ({ method: r.method, pattern: r.pattern }));
  }

  async handle(request: Request, clientIp: string): Promise<Response> {
    const url = new URL(request.url);
    const reply = createReply();
    const req = await buildRequest(request, url, clientIp);

    try {
      for (const hook of this.onRequestHooks) {
        await hook(req, reply);
        if (reply.sent) return toResponse(reply);
      }

      const found = this.match(request.method, url.pathname);
      if (!found) {
        if (this.notFoundHandler) {
          await this.notFoundHandler(req, reply);
          return toResponse(reply);
        }
        return json({ error: { code: 'not_found', message: 'المسار غير موجود' } }, 404);
      }

      req.params = found.params;

      const pre = found.route.options.preHandler;
      const preHandlers = Array.isArray(pre) ? pre : pre ? [pre] : [];
      for (const guard of preHandlers) {
        await guard(req, reply);
        if (reply.sent) return toResponse(reply);
      }

      const result = await found.route.handler(req, reply);
      if (reply.sent) return toResponse(reply);
      // Fastify serialises a returned value as the JSON body.
      return json(result ?? null, reply.statusCode || 200, reply.headers);
    } catch (err) {
      if (this.errorHandler) {
        const handled = await this.errorHandler(err, req, reply);
        if (reply.sent) return toResponse(reply);
        return json(handled ?? null, reply.statusCode || 500);
      }
      throw err;
    }
  }
}

/**
 * True when `a` is more specific than `b` — the first position where one has a
 * static segment and the other a parameter decides it. Only called on routes
 * that matched the same path, so both have the same length.
 */
function isMoreSpecific(a: string[], b: string[]): boolean {
  for (let i = 0; i < a.length; i += 1) {
    const aParam = a[i].startsWith(':');
    const bParam = b[i].startsWith(':');
    if (aParam !== bParam) return bParam;
  }
  return false;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

function createReply(): ShimReply {
  const reply: ShimReply = {
    statusCode: 200,
    payload: null,
    sent: false,
    headers: {},
    status(code) { reply.statusCode = code; return reply; },
    header(name, value) { reply.headers[name] = value; return reply; },
    send(payload) { reply.payload = payload; reply.sent = true; return reply; },
  };
  return reply;
}

function toResponse(reply: ShimReply): Response {
  return json(reply.payload, reply.statusCode, reply.headers);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

async function buildRequest(
  request: Request, url: URL, clientIp: string,
): Promise<ShimRequest> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => { query[key] = value; });

  // Parse a JSON body once, tolerantly: a malformed body becomes undefined and
  // the handler's zod schema produces the same 400 it would under Fastify.
  let body: unknown;
  const contentType = headers['content-type'] ?? '';
  const hasBody = !['GET', 'HEAD'].includes(request.method);
  if (hasBody && contentType.includes('application/json')) {
    body = await request.clone().json().catch(() => undefined);
  }

  return {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    params: {},
    query,
    body,
    headers,
    ip: clientIp,
    id: crypto.randomUUID(),
    raw: request,
    async file() {
      if (!contentType.includes('multipart/form-data')) return null;
      const form = await request.clone().formData();
      for (const value of form.values()) {
        if (value instanceof File) {
          return {
            filename: value.name,
            mimetype: value.type || 'application/octet-stream',
            toBuffer: async () => new Uint8Array(await value.arrayBuffer()),
          };
        }
      }
      return null;
    },
  };
}
