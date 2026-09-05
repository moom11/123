import { dequeue, enqueue, getAll, getMeta, markAttempt, newClientRef, putAll, queued, setMeta } from './offline.js';

/**
 * API client for the buyer app.
 *
 * The base URL is configurable because the Android build talks to the real
 * host rather than a dev proxy.
 */
const REFRESH_KEY = 'mara.buyer.refresh';
const BASE_KEY = 'mara.buyer.base';

let accessToken: string | null = null;

/**
 * Where the API lives. A build can bake in the deployed URL with
 * VITE_API_BASE, which is what the hosted and Android builds do; anything
 * saved on the device wins over it, so a rep can be pointed at a different
 * server without a rebuild. Empty means same-origin, as in local development.
 */
const BUILT_IN_BASE = (import.meta.env?.VITE_API_BASE ?? '').replace(/\/$/, '');

export function apiBase(): string {
  return localStorage.getItem(BASE_KEY) ?? BUILT_IN_BASE;
}
export function setApiBase(url: string): void {
  localStorage.setItem(BASE_KEY, url.replace(/\/$/, ''));
}

export function setTokens(t: { accessToken: string; refreshToken: string }): void {
  accessToken = t.accessToken;
  localStorage.setItem(REFRESH_KEY, t.refreshToken);
}
export function clearTokens(): void {
  accessToken = null;
  localStorage.removeItem(REFRESH_KEY);
}
export function hasSession(): boolean {
  return Boolean(accessToken || localStorage.getItem(REFRESH_KEY));
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  const token = localStorage.getItem(REFRESH_KEY);
  if (!token) return false;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: token }),
        });
        if (!res.ok) { clearTokens(); return false; }
        setTokens((await res.json()).tokens);
        return true;
      } catch { return false; }
      finally { refreshing = null; }
    })();
  }
  return refreshing;
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const send = () => fetch(`${apiBase()}/api${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  let res = await send();
  if (res.status === 401 && localStorage.getItem(REFRESH_KEY)) {
    if (await refresh()) res = await send();
  }
  if (!res.ok) {
    let code = 'error';
    let message = `طلب غير ناجح (${res.status})`;
    try {
      const body = await res.json();
      code = body?.error?.code ?? code;
      message = body?.error?.message ?? message;
    } catch { /* non-JSON */ }
    throw new ApiError(res.status, code, message);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export function online(): boolean { return navigator.onLine; }

/**
 * Pull the approved work list and cache it.
 *
 * Only ever reads /buyer/requests, which the server backs with a view
 * containing nothing but approved-and-beyond requests, exposing the approved
 * quantity rather than the requested one.
 */
export async function syncDown(): Promise<{ requests: any[]; fromCache: boolean }> {
  if (!online()) {
    return { requests: await getAll('requests'), fromCache: true };
  }
  try {
    const res = await api<{ requests: any[] }>('/buyer/requests');
    await putAll('requests', res.requests);
    await setMeta('lastSync', new Date().toISOString());
    return { requests: res.requests, fromCache: false };
  } catch {
    return { requests: await getAll('requests'), fromCache: true };
  }
}

export async function lastSync(): Promise<string | null> {
  return getMeta<string>('lastSync');
}

export interface ActResult {
  /** The server accepted it. */
  sent: boolean;
  /** Held locally because there is no connection; it will replay on reconnect. */
  queued: boolean;
  /** The server refused it outright — the rep must change something. */
  rejected: boolean;
  error?: string;
  clientRef: string;
}

/**
 * Queue an action, sending it straight away when there is a connection.
 *
 * The three outcomes are kept distinct on purpose: "saved, will send later" and
 * "the server said no" must never look the same to the rep, or a refused
 * purchase would appear to have been recorded.
 */
export async function act(
  kind: 'status' | 'purchase' | 'change_request',
  requestId: string,
  body: any,
): Promise<ActResult> {
  const clientRef = newClientRef();
  // The reference travels with a purchase so the server can recognise a replay
  // of the same purchase and return the original instead of recording it twice.
  const payload = kind === 'purchase' ? { ...body, clientRef } : body;

  await enqueue({ clientRef, kind, requestId, body: payload });
  if (!online()) {
    return { sent: false, queued: true, rejected: false, clientRef };
  }

  const result = await flush();
  // flush() drops permanently-refused actions from the queue, so an action that
  // is gone without having been sent was refused.
  const stillQueued = (await queued()).some((a) => a.clientRef === clientRef);
  if (result.sent > 0 && !stillQueued && result.errors.length === 0) {
    return { sent: true, queued: false, rejected: false, clientRef };
  }
  if (stillQueued) {
    return {
      sent: false, queued: true, rejected: false, clientRef,
      error: result.errors[0],
    };
  }
  return {
    sent: false, queued: false, rejected: true, clientRef,
    error: result.errors[0] ?? 'رُفضت العملية',
  };
}

const ENDPOINTS: Record<QueuedKind, (requestId: string) => string> = {
  status: (id) => `/buyer/requests/${id}/status`,
  purchase: (id) => `/buyer/requests/${id}/purchase`,
  change_request: (id) => `/buyer/requests/${id}/request-change`,
};
type QueuedKind = 'status' | 'purchase' | 'change_request';

/**
 * Replay queued actions in order.
 *
 * A rejection the server considers final (a 4xx that is not a conflict) is
 * dropped rather than retried forever — for example an attempt to buy beyond
 * the approved quantity, which the rep must resolve through Request Change.
 */
export async function flush(): Promise<{ sent: number; failed: number; errors: string[] }> {
  if (!online()) return { sent: 0, failed: 0, errors: [] };

  const actions = await queued();
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const action of actions) {
    try {
      await api(ENDPOINTS[action.kind as QueuedKind](action.requestId), {
        method: 'POST', body: action.body,
      });
      await dequeue(action.clientRef);
      sent += 1;
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      const permanent = apiError
        && apiError.status >= 400 && apiError.status < 500
        && apiError.status !== 409 && apiError.status !== 429;

      if (permanent) {
        // The server has made a decision; keeping this queued would replay a
        // refusal forever. Surface it and drop it.
        await dequeue(action.clientRef);
        errors.push(apiError.message);
        failed += 1;
      } else {
        await markAttempt(action, (err as Error).message);
        failed += 1;
        errors.push((err as Error).message);
        // Preserve ordering: stop at the first transient failure.
        break;
      }
    }
  }

  return { sent, failed, errors };
}

export async function pendingCount(): Promise<number> {
  return (await queued()).length;
}
