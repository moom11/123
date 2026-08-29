import { execSync } from 'node:child_process';

/**
 * Rebuild the test database from scratch once per run, then seed it, so every
 * suite starts from the same known-good branch.
 */
export async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL
    ?? 'postgres://postgres@127.0.0.1:5432/mara_test';
  const admin = url.replace(/\/[^/]+$/, '/postgres');
  const dbName = url.split('/').pop()!;

  execSync(
    `psql "${admin}" -qtAX -c "DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)" ` +
    `-c "CREATE DATABASE ${dbName}"`,
    { stdio: 'inherit' },
  );

  execSync('npx tsx src/seed.ts', {
    stdio: 'pipe',
    env: {
      ...process.env,
      DATABASE_URL: url,
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters-long',
      JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters-long',
      COOKIE_SECRET: 'test-cookie-secret-at-least-32-characters-long!',
      MFA_SECRET_KEY: 'test-mfa-key-at-least-32-characters-long-here!!',
      WHATSAPP_PROVIDER: 'log',
    },
  });
}
