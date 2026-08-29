import pg from 'pg';
import { config } from './config.js';

const { Pool, types } = pg;

// NUMERIC arrives as a string by default to protect precision. Our quantity
// columns are NUMERIC(18,4), comfortably inside the double range, and every
// call site wants a number, so parse them once here rather than at each usage.
types.setTypeParser(1700, (v: string) => (v === null ? null : Number(v)));
// BIGINT (money in halalas, ledger ids) — safe as a JS number below 2^53.
types.setTypeParser(20, (v: string) => (v === null ? null : Number(v)));

export const pool = new Pool({
  connectionString: config.database.url,
  max: config.database.poolMax,
  ssl: config.database.ssl ? { rejectUnauthorized: false } : undefined,
  application_name: 'mara-server',
});

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[db] idle client error', err);
});

export type Queryable = Pick<pg.PoolClient, 'query'>;

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params: readonly unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as unknown[]);
}

/** First row or null. */
export async function one<T extends pg.QueryResultRow = any>(
  text: string,
  params: readonly unknown[] = [],
  client?: Queryable,
): Promise<T | null> {
  const runner = client ?? pool;
  const res = await runner.query<T>(text, params as unknown[]);
  return res.rows[0] ?? null;
}

export async function many<T extends pg.QueryResultRow = any>(
  text: string,
  params: readonly unknown[] = [],
  client?: Queryable,
): Promise<T[]> {
  const runner = client ?? pool;
  const res = await runner.query<T>(text, params as unknown[]);
  return res.rows;
}

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 *
 * Every business operation that touches money, stock or the wallet runs through
 * here: an order and its stock consumption, a redemption and its ledger row,
 * a receipt and its inventory transactions are each all-or-nothing.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  isolation: 'read committed' | 'repeatable read' | 'serializable' = 'read committed',
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
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
  await pool.end();
}
