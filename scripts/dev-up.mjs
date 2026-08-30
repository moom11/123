#!/usr/bin/env node
/**
 * Bring the whole MARA system up, on Windows, macOS or Linux.
 *
 *   npm start                 start everything
 *   npm start -- --reset      drop the database and rebuild it first
 *   npm start -- --share      also open a free public HTTPS URL for the iPads
 *
 * scripts/dev-up.sh does the same thing and is a little faster to read, but it
 * needs a POSIX shell. This runs anywhere Node does, which is the only thing
 * the project already requires.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const logs = join(root, '.dev-logs');
const isWindows = process.platform === 'win32';

const args = process.argv.slice(2);
const unknown = args.filter((a) => !['--reset', '--share'].includes(a));
if (unknown.length > 0) {
  console.error(`unknown option: ${unknown.join(', ')}`);
  process.exit(1);
}
const reset = args.includes('--reset');
const share = args.includes('--share');

const PG = {
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgres',
  host: process.env.PGHOST ?? '127.0.0.1',
  port: process.env.PGPORT ?? '5432',
  db: process.env.MARA_DB ?? 'mara',
};
const url = (db) => `postgres://${PG.user}:${PG.password}@${PG.host}:${PG.port}/${db}`;
const PORT = process.env.PORT ?? '4000';

const env = {
  ...process.env,
  DATABASE_URL: url(PG.db),
  PGPASSWORD: PG.password,
  NODE_ENV: 'development',
  PORT,
  REQUIRE_ADMIN_MFA: 'false',
  WHATSAPP_PROVIDER: 'log',
  JWT_ACCESS_SECRET: 'dev-access-secret-at-least-32-characters-long!!',
  JWT_REFRESH_SECRET: 'dev-refresh-secret-at-least-32-characters-long!',
  COOKIE_SECRET: 'dev-cookie-secret-at-least-32-characters-long!!',
  MFA_SECRET_KEY: 'dev-mfa-key-at-least-32-characters-long-here!!!',
  CORS_ORIGINS: 'http://localhost:5173,http://localhost:5174,'
    + 'http://localhost:4173,http://localhost:4174',
};

const say = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** npm is npm.cmd on Windows, and .cmd files need a shell to launch. */
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, {
    cwd: root, env, stdio: opts.quiet ? 'pipe' : 'inherit', shell: isWindows,
  });
  if (res.error) throw res.error;
  if (res.status !== 0 && !opts.allowFailure) {
    if (opts.quiet) process.stderr.write(String(res.stderr ?? ''));
    throw new Error(`${cmd} ${cmdArgs.join(' ')} exited ${res.status}`);
  }
  return { status: res.status, stdout: String(res.stdout ?? '').trim() };
}

const children = [];
function background(cmd, cmdArgs, logFile, cwd = root) {
  const out = join(logs, logFile);
  writeFileSync(out, '');
  const child = spawn(cmd, cmdArgs, {
    cwd,
    env,
    shell: isWindows,
    // Each service leads its own process group. npm and vite each fork again,
    // so signalling only the child we spawned would leave the grandchildren —
    // the actual servers — holding the ports.
    detached: !isWindows,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => appendFileSync(out, d));
  child.stderr.on('data', (d) => appendFileSync(out, d));
  children.push(child);
  return child;
}

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null || !child.pid) continue;
    try {
      if (isWindows) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      } else {
        // Negative pid signals the whole group, which is why they are detached.
        process.kill(-child.pid, 'SIGTERM');
      }
    } catch { /* already gone */ }
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { stopAll(); process.exit(0); });
}
process.on('exit', stopAll);

/** Waits for something to accept a TCP connection, which is all "ready" means here. */
async function waitForPort(port, host, seconds) {
  for (let i = 0; i < seconds; i += 1) {
    const open = await new Promise((resolve) => {
      const probe = new Socket();
      probe.setTimeout(1000);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('timeout', () => { probe.destroy(); resolve(false); });
      probe.once('error', () => resolve(false));
      probe.connect(port, host);
    });
    if (open) return true;
    await sleep(1000);
  }
  return false;
}

async function waitForHealth(seconds) {
  for (let i = 0; i < seconds; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  return false;
}

function psql(target, sqlArgs) {
  return run('psql', [url(target), '-qtAX', ...sqlArgs], { quiet: true });
}

async function main() {
  mkdirSync(logs, { recursive: true });

  // --- database -------------------------------------------------------------
  if (run('psql', ['--version'], { quiet: true, allowFailure: true }).status !== 0) {
    console.error(
      '\npsql was not found on PATH.\n'
      + '  Windows  install PostgreSQL 16, then add its bin folder to PATH\n'
      + '           (usually C:\\Program Files\\PostgreSQL\\16\\bin)\n'
      + '  macOS    brew install postgresql@16 && brew services start postgresql@16\n'
      + '  Linux    sudo apt install postgresql-16\n',
    );
    process.exit(1);
  }

  if (!(await waitForPort(Number(PG.port), PG.host, 3))) {
    console.error(
      `\nPostgreSQL is not accepting connections on ${PG.host}:${PG.port}.\n`
      + 'Start the PostgreSQL service and run this again.\n'
      + (isWindows ? '  Windows  services.msc -> postgresql-x64-16 -> Start\n' : ''),
    );
    process.exit(1);
  }

  if (reset) {
    say(`Dropping and recreating ${PG.db}`);
    psql('postgres', ['-c', `DROP DATABASE IF EXISTS ${PG.db} WITH (FORCE)`,
                      '-c', `CREATE DATABASE ${PG.db}`]);
  } else if (psql(PG.db, ['-c', 'select 1']).status !== 0) {
    say(`Creating ${PG.db}`);
    psql('postgres', ['-c', `CREATE DATABASE ${PG.db}`]);
  }

  say('Applying migrations');
  run(npmCmd, ['--workspace', '@mara/server', 'run', 'migrate']);

  const branches = psql(PG.db, ['-c', 'select count(*) from branches']);
  if (branches.stdout === '0') {
    say('Seeding');
    run(npmCmd, ['--workspace', '@mara/server', 'run', 'seed']);
  } else {
    console.log('already seeded — pass --reset to start over');
  }

  // --- build ----------------------------------------------------------------
  say('Building');
  for (const pkg of ['@mara/shared', '@mara/server', '@mara/print-agent']) {
    run(npmCmd, ['--workspace', pkg, 'run', 'build'], { quiet: true });
  }
  if (!existsSync(join(root, 'packages/web/dist/index.html'))) {
    run(npmCmd, ['--workspace', '@mara/web', 'run', 'build'], { quiet: true });
  }
  if (!existsSync(join(root, 'packages/buyer/dist/index.html'))) {
    run(npmCmd, ['--workspace', '@mara/buyer', 'run', 'build'], { quiet: true });
  }

  // --- run ------------------------------------------------------------------
  say('Starting services');
  background(process.execPath, [join(root, 'packages/server/dist/index.js')], 'api.log');
  background(npmCmd, ['exec', '--', 'vite', 'preview', '--port', '4173',
                      '--host', '127.0.0.1', '--strictPort'],
             'web.log', join(root, 'packages/web'));
  background(npmCmd, ['exec', '--', 'vite', 'preview', '--port', '4174',
                      '--host', '127.0.0.1', '--strictPort'],
             'buyer.log', join(root, 'packages/buyer'));

  if (!(await waitForHealth(60))) {
    console.error(`\nThe API did not come up; see ${join(logs, 'api.log')}`);
    try { console.error(readFileSync(join(logs, 'api.log'), 'utf8').slice(-2000)); } catch {}
    process.exit(1);
  }
  await waitForPort(4173, '127.0.0.1', 30);

  // --- optional public URL --------------------------------------------------
  let publicUrl = '';
  if (share) {
    if (run('cloudflared', ['--version'], { quiet: true, allowFailure: true }).status !== 0) {
      console.error(
        '\n--share needs cloudflared.\n'
        + '  Windows  winget install --id Cloudflare.cloudflared\n'
        + '  macOS    brew install cloudflared\n'
        + '  Linux    https://github.com/cloudflare/cloudflared/releases/latest\n'
        + '\nEverything below still works on this machine.\n',
      );
    } else {
      say('Opening a public URL');
      // Tunnelling the preview server, not the API: it already proxies /api and
      // /ws through, so one URL serves the whole thing with no CORS to set up.
      background('cloudflared',
                 ['tunnel', '--url', 'http://127.0.0.1:4173', '--no-autoupdate'],
                 'tunnel.log');
      for (let i = 0; i < 40 && !publicUrl; i += 1) {
        await sleep(1000);
        try {
          const found = readFileSync(join(logs, 'tunnel.log'), 'utf8')
            .match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
          if (found) [publicUrl] = found;
        } catch { /* not written yet */ }
      }
      if (!publicUrl) {
        console.error(`The tunnel did not come up; see ${join(logs, 'tunnel.log')}`);
        console.error('Everything below still works on this machine.');
      }
    }
  }

  console.log(`
  MARA is up.

    POS / admin      http://localhost:4173
    Buyer app        http://localhost:4174
    API              http://localhost:${PORT}
    Health           http://localhost:${PORT}/health

  Sign in
    Owner            owner@maralounge.sa / MaraOwner#2026Xy
    Branch manager   manager@maralounge.sa / MaraManager#2026Xy
    Waiter           1042 / 2580          Cashier   2001 / 4826
    Purchasing rep   4001 / 3648          Bar       3001 / 7192

  The customer QR menu opens without signing in; the table 12 link is printed
  by the seed above.

  Logs are in .dev-logs/. Ctrl-C stops everything.
`);

  if (publicUrl) {
    console.log(`  Reachable from any device, over HTTPS:

    ${publicUrl}

  Open it in Safari on the iPad, then Share -> Add to Home Screen.

  This is a temporary address for trying the system out. It lasts only as long
  as this command runs, it changes every time, and anyone holding the link can
  reach your till — so do not put real customer data behind it, and stop it
  with Ctrl-C when you are done. docs/CLOUDFLARE.md covers the permanent setup.
`);
  }

  // Hold the process open so the services keep running until Ctrl-C.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  stopAll();
  process.exit(1);
});
