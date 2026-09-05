import pg from 'pg';
import { config } from './config.js';

const { Pool, types } = pg;

// NUMERIC arrives as a string by default to protect precision. Our quantity
// columns are NUMERIC(18,4), comfortably inside the double range, and every
// call site wants a number, so parse them once here rather than at each usage.
types.setTypeParser(1700, (v: string) => (v === null ? null : Number(v)));
// BIGINT (money in halalas, ledger ids) — safe as a JS number below 2^53.
types.setTypeParser(20, (v: string) => (v === null ? null : Number(v)));

/**
 * Two runtimes, one interface.
 *
 * On Node a long-lived Pool is right: connections are reused across requests
 * and the process outlives them. On Cloudflare Workers there is no process to
 * hold a pool — Hyperdrive maintains the real pool at the edge and the guidance
 * is to create a client per request. So on Workers a request-scoped client is
 * installed for the duration of the invocation and every helper below routes
 * through it.
 *
 * Keeping this behind `one`/`many`/`withTransaction` is what lets roughly nine
 * thousand lines of tested business logic run on both without modification.
 */
type RequestScope = { client: pg.PoolClient; release: () => Promise<void> };

let requestScope: RequestScope | null = null;
let lazyPool: pg.Pool | null = null;

function nodePool(): pg.Pool {
  if (!lazyPool) {
    lazyPool = new Pool({
      connectionString: config.database.url,
      max: config.database.poolMax,
      ssl: config.database.ssl ? { rejectUnauthorized: false } : undefined,
      application_name: 'mara-server',
    });
    lazyPool.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[db] idle client error', err);
    });
  }
  return lazyPool;
}

/**
 * Install a request-scoped connection (Workers). Returns a disposer that must
 * run in a `finally`, or the Hyperdrive connection is never returned to the
 * pool.
 *
 * Safe as module state because a Workers invocation handles exactly one request
 * at a time; there is no interleaving to race against.
 */
export function useRequestConnection(client: pg.PoolClient, release: () => Promise<void>): () => Promise<void> {
  requestScope = { client, release };
  return async () => {
    const scope = requestScope;
    requestScope = null;
    if (scope) await scope.release();
  };
}

/** The pool on Node; the request-scoped client on Workers. */
function runner(): Pick<pg.Pool, 'query'> {
  return requestScope ? (requestScope.client as unknown as Pick<pg.Pool, 'query'>) : nodePool();
}

/**
 * Kept as a getter so existing `pool.query(...)` call sites work unchanged on
 * both runtimes.
 */
export const pool = {
  query: (<T extends pg.QueryResultRow = any>(text: string, params?: unknown[]) =>
    runner().query<T>(text, params as unknown[])) as pg.Pool['query'],
  connect: (): Promise<pg.PoolClient> => (
    requestScope
      ? Promise.resolve(requestScope.client)
      : nodePool().connect()
  ),
} as unknown as pg.Pool;

export type Queryable = Pick<pg.PoolClient, 'query'>;

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params: readonly unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return runner().query<T>(text, params as unknown[]);
}

/** First row or null. */
export async function one<T extends pg.QueryResultRow = any>(
  text: string,
  params: readonly unknown[] = [],
  client?: Queryable,
): Promise<T | null> {
  const target = client ?? runner();
  const res = await target.query<T>(text, params as unknown[]);
  return res.rows[0] ?? null;
}

export async function many<T extends pg.QueryResultRow = any>(
  text: string,
  params: readonly unknown[] = [],
  client?: Queryable,
): Promise<T[]> {
  const target = client ?? runner();
  const res = await target.query<T>(text, params as unknown[]);
  return res.rows;
}

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 *
 * Every business operation that touches money, stock or the wallet runs through
 * here: an order and its stock consumption, a redemption and its ledger row,
 * a receipt and its inventory transactions are each all-or-nothing.
 */
/**
 * Isolation levels, as literals rather than interpolated text. The value is
 * already a closed union, but a fixed lookup means no caller can ever get a
 * string into a statement.
 */
const ISOLATION_SQL = {
  'read committed': 'BEGIN ISOLATION LEVEL READ COMMITTED',
  'repeatable read': 'BEGIN ISOLATION LEVEL REPEATABLE READ',
  serializable: 'BEGIN ISOLATION LEVEL SERIALIZABLE',
} as const;

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  isolation: 'read committed' | 'repeatable read' | 'serializable' = 'read committed',
): Promise<T> {
  // On Workers the request-scoped client is reused, so it must not be released
  // here — the request disposer owns its lifetime.
  const scoped = requestScope;
  const client = scoped ? scoped.client : await nodePool().connect();
  try {
    await client.query(ISOLATION_SQL[isolation]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    if (!scoped) client.release();
  }
}

/** Advisory lock helper — used to serialise per-entity critical sections. */
export async function withAdvisoryLock<T>(
  client: pg.PoolClient,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  return fn();
}

export async function closePool(): Promise<void> {
  if (lazyPool) { await lazyPool.end(); lazyPool = null; }
}
