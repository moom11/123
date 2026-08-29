import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '..', '..', 'migrations');

/**
 * Forward-only migration runner. Each file runs once, inside its own
 * transaction, recorded in schema_migrations. A file that has already run is
 * skipped; a file that changes after having run is a hard error, because
 * silently diverging schemas between branches is worse than a failed deploy.
 */
export async function runMigrations(log: (msg: string) => void = console.log): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Map<string, string>();
  const { rows } = await pool.query<{ filename: string; checksum: string }>(
    'SELECT filename, checksum FROM schema_migrations',
  );
  for (const r of rows) applied.set(r.filename, r.checksum);

  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = await sha256(sql);
    const previous = applied.get(file);

    if (previous) {
      if (previous !== checksum) {
        throw new Error(
          `Migration ${file} has changed after being applied. ` +
          'Add a new migration instead of editing an applied one.',
        );
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
        [file, checksum],
      );
      await client.query('COMMIT');
      log(`  applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
}

async function sha256(text: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex');
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('migrate.ts');
if (invokedDirectly) {
  runMigrations()
    .then(() => { console.log('migrations up to date'); return closePool(); })
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
