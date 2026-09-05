#!/usr/bin/env node
/**
 * Build exactly the folder to drag into htdocs over FTP.
 *
 *   npm run build:upload
 *
 * By default the app talks to /api on whatever host it is served from, so the
 * same upload works on http and https, on the real domain and on a preview,
 * with nothing baked in and nothing to reconfigure. That is the arrangement
 * where the API sits behind /api on the same site.
 *
 * Only when the API lives on a DIFFERENT host does it need an address, and
 * then api-url.txt supplies one. Absent or empty, relative wins.
 *
 * Output: upload/ — upload its CONTENTS to htdocs, not the folder itself.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'upload');
const configFile = join(root, 'api-url.txt');
const isWindows = process.platform === 'win32';

/** An address in api-url.txt, or '' meaning same-origin. */
function readConfiguredBase() {
  if (!existsSync(configFile)) return '';
  const value = readFileSync(configFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .pop() ?? '';
  if (!value || value.includes('REPLACE-WITH')) return '';

  if (!/^https?:\/\//.test(value)) {
    console.error(`\napi-url.txt must start with https:// — found: ${value}\n`);
    process.exit(1);
  }
  // The site is served over HTTPS, so a plain http API is blocked by the
  // browser as mixed content: every call fails and the live-updates badge sits
  // on "offline" with no other symptom.
  if (value.startsWith('http://')) {
    console.error(
      `\napi-url.txt is http://, which a browser blocks from an https:// page.\n\n`
      + 'Use https://, or delete api-url.txt to talk to /api on the same site.\n',
    );
    process.exit(1);
  }
  return value;
}

const apiBase = readConfiguredBase();

console.log(apiBase
  ? `\nBuilding against ${apiBase}\n`
  : '\nBuilding with relative /api — the app calls the host it is served from\n');

const npmCmd = isWindows ? 'npm.cmd' : 'npm';
const build = spawnSync(npmCmd, ['--workspace', '@mara/web', 'run', 'build'], {
  cwd: root,
  stdio: 'inherit',
  shell: isWindows,
  // Empty string, not undefined: Vite must see the variable as set-and-empty
  // so it inlines '' rather than leaving the expression to resolve at runtime.
  env: { ...process.env, VITE_API_BASE: apiBase },
});
if (build.status !== 0) process.exit(build.status ?? 1);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'packages/web/dist'), out, { recursive: true });

// Client-side routes exist only in the browser, so a refresh on /pos or
// /catalog must be answered with index.html rather than the host's 404.
writeFileSync(join(out, '.htaccess'), `DirectoryIndex index.html
AddDefaultCharset UTF-8

<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteRule ^index\\.html$ - [L]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule . /index.html [L]
</IfModule>
`, 'utf8');

/**
 * Prove the claim rather than trusting it: walk everything about to be
 * uploaded and fail on any hardcoded address. A build that quietly points at
 * localhost or at http:// is the exact failure this script exists to prevent,
 * and it is invisible until a browser refuses the call.
 */
function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const TEXT = /\.(js|css|html|json|webmanifest|htaccess)$/i;
const offenders = [];
for (const file of walk(out)) {
  if (!TEXT.test(file) && !file.endsWith('.htaccess')) continue;
  const text = readFileSync(file, 'utf8');

  for (const match of text.matchAll(/(?:https?|wss?):\/\/[^\s'"`)\\]+/g)) {
    const url = match[0];
    // An address the operator asked for is not a stray one.
    if (apiBase && url.startsWith(apiBase)) continue;

    // Only addresses the app would CALL matter. React and Workbox embed links
    // to their own documentation in error messages; those are text, never
    // fetched, and failing on them would make this check cry wolf.
    const wouldBeCalled =
      /\/api(\/|$|\?)/.test(url)                       // an API endpoint
      || /^wss?:\/\//.test(url)                          // a websocket
      || /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)\b/.test(url)  // a dev machine
      || /:\d{2,5}(\/|$)/.test(url);                     // an explicit port
    if (!wouldBeCalled) continue;

    offenders.push(`${relative(out, file)}: ${url}`);
  }
}

if (offenders.length > 0) {
  console.error('\nHardcoded addresses found in the build:\n');
  for (const o of offenders.slice(0, 20)) console.error(`  ${o}`);
  if (offenders.length > 20) console.error(`  … and ${offenders.length - 20} more`);
  console.error('\nRefusing to emit upload/ — these would be wrong on the live site.\n');
  rmSync(out, { recursive: true, force: true });
  process.exit(1);
}

const files = walk(out).length;
console.log(`
Ready — ${files} files in upload/, no hardcoded addresses.

  Upload the CONTENTS of upload/ to htdocs
  (index.html, assets/, .htaccess — not the folder itself).

  Use Binary transfer mode, or the Arabic arrives corrupted.
${apiBase ? `
  On the API server, allow this site:
    CORS_ORIGINS=https://mara.unaux.com
` : `
  The app calls /api on the same host, so there is no CORS to configure.
`}`);
