/**
 * API client.
 *
 * Holds the access token in memory and the refresh token in localStorage, and
 * transparently refreshes a single time on a 401 so a shift is never
 * interrupted by an expiring token mid-order.
 *
 * It deliberately knows nothing about permissions beyond rendering: the server
 * decides what is allowed, and a 403 here is a bug in the UI, not a bypass.
 */

const REFRESH_KEY = 'mara.refresh';
const BRANCH_KEY = 'mara.branch';

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string,
              readonly details?: unknown) {
    super(message);
  }
}

export function setTokens(tokens: { accessToken: string; refreshToken: string }): void {
  accessToken = tokens.accessToken;
  localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
}

export function clearTokens(): void {
  accessToken = null;
  localStorage.removeItem(REFRESH_KEY);
}

export function hasSession(): boolean {
  return Boolean(accessToken || localStorage.getItem(REFRESH_KEY));
}

export function rememberBranch(id: string): void { localStorage.setItem(BRANCH_KEY, id); }
export function rememberedBranch(): string | null { return localStorage.getItem(BRANCH_KEY); }

async function refresh(): Promise<boolean> {
  const token = localStorage.getItem(REFRESH_KEY);
  if (!token) return false;

  // Collapse concurrent refreshes: several in-flight requests must not each
  // burn a rotation, which would trip the replay detector.
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: token }),
        });
        if (!res.ok) { clearTokens(); return false; }
        const body = await res.json();
        setTokens(body.tokens);
        return true;
      } catch {
        return false;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function api<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
  const send = async (): Promise<Response> => fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(opts.idempotencyKey ? { 'X-Idempotency-Key': opts.idempotencyKey } : {}),
      // Which branch the user is looking at. Staff are pinned to their own
      // branch server-side and this is ignored for them; a multi-branch admin
      // has no home branch, so without it every screen would come back empty.
      ...(rememberedBranch() ? { 'X-Branch-Id': rememberedBranch()! } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  let res = await send();

  if (res.status === 401 && localStorage.getItem(REFRESH_KEY)) {
    if (await refresh()) res = await send();
  }

  if (!res.ok) {
    let code = 'error';
    let message = `طلب غير ناجح (${res.status})`;
    let details: unknown;
    try {
      const body = await res.json();
      code = body?.error?.code ?? code;
      message = body?.error?.message ?? message;
      details = body?.error?.details;
    } catch { /* non-JSON error body */ }
    throw new ApiError(res.status, code, message, details);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** Live updates. Reconnects with backoff so a flaky shop wifi self-heals. */
export function connectRealtime(
  onEvent: (event: { type: string; payload: any }) => void,
): () => void {
  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: number | undefined;

  const open = () => {
    if (closed || !accessToken) {
      timer = window.setTimeout(open, 2000);
      return;
    }
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${location.host}/ws`);

    socket.onopen = () => { attempt = 0; };
    socket.onmessage = (e) => {
      try { onEvent(JSON.parse(e.data)); } catch { /* ignore malformed frame */ }
    };
    socket.onclose = () => {
      if (closed) return;
      attempt += 1;
      timer = window.setTimeout(open, Math.min(1000 * 2 ** attempt, 15000));
    };
    socket.onerror = () => socket?.close();
  };

  open();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    socket?.close();
  };
}

/**
 * The websocket cannot carry an Authorization header, so the token is attached
 * where the server's onRequest hook can read it during the upgrade.
 */
export function realtimeUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${location.host}/ws`;
}

export function currentAccessToken(): string | null { return accessToken; }
