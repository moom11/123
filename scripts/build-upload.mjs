#!/usr/bin/env node
/**
 * Build exactly the folder to drag into htdocs over FTP.
 *
 *   npm run build:upload
 *
 * Reads the API address from api-url.txt in the project root — one line, the
 * https address of the server the app should talk to. That file is the only
 * thing to edit; everything else is derived from it, so the address cannot end
 * up baked into one build and forgotten in another.
 *
 * Output: upload/  — upload its CONTENTS to htdocs, not the folder itself.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'upload');
const configFile = join(root, 'api-url.txt');
const isWindows = process.platform === 'win32';

if (!existsSync(configFile)) {
  writeFileSync(configFile,
    '# The address of your API server. One line, no quotes, https.\n'
    + '# Example:  https://mara-api.example.com\n'
    + '# Leave the example line below replaced with your real address.\n'
    + 'https://REPLACE-WITH-YOUR-API-ADDRESS\n', 'utf8');
  console.error(
    `\nCreated api-url.txt.\n\n`
    + 'Open it, put your API address on the last line, and run this again.\n',
  );
  process.exit(1);
}

const apiUrl = readFileSync(configFile, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .pop() ?? '';

if (!apiUrl || apiUrl.includes('REPLACE-WITH')) {
  console.error('\nOpen api-url.txt and put your API address on the last line.\n');
  process.exit(1);
}
if (!/^https?:\/\//.test(apiUrl)) {
  console.error(`\napi-url.txt must start with https:// — found: ${apiUrl}\n`);
  process.exit(1);
}
// The page is served over HTTPS, so its websocket must be WSS. A browser
// blocks ws:// from an https:// page as mixed content, and the live-updates
// badge sits on "offline" with no other symptom.
if (apiUrl.startsWith('http://')) {
  console.error(
    `\napi-url.txt is http://, and your site is served over https://.\n\n`
    + 'The browser will block every call to it as mixed content, and live\n'
    + 'updates will never connect. Use an https:// address.\n',
  );
  process.exit(1);
}

const npmCmd = isWindows ? 'npm.cmd' : 'npm';
console.log(`\nBuilding against ${apiUrl}\n`);

const build = spawnSync(npmCmd, ['--workspace', '@mara/web', 'run', 'build'], {
  cwd: root, stdio: 'inherit', shell: isWindows,
  env: { ...process.env, VITE_API_BASE: apiUrl },
});
if (build.status !== 0) process.exit(build.status ?? 1);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'packages/web/dist'), out, { recursive: true });

// Shared hosting needs this so a refresh on /pos or /catalog does not 404:
// every unknown path has to fall back to index.html for client-side routing.
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

console.log(`
Ready.

  Upload the CONTENTS of the upload folder to htdocs
  (index.html, assets/, .htaccess — not the folder itself).

  Use Binary transfer mode, or Arabic text will arrive corrupted.

  On the API server, allow this site:
    CORS_ORIGINS=https://mara.unaux.com
`);
