# تشغيل النظام على Cloudflare Workers
# Running MARA on Cloudflare Workers

The API runs unchanged on two runtimes: Node (Fastify, `src/index.ts`) and the
Cloudflare Workers runtime (`src/worker.ts`). Only the infrastructure adapters
differ — router, database handle, realtime transport and attachment storage.
Every module under `src/modules/` is the same code on both, so the
authorization, OTP and transaction behaviour covered by the test suite is the
behaviour you get in production.

```
                         ┌──────────────── Cloudflare ─────────────────┐
  iPad / Android  ─────► │  Worker (mara-api)                          │
                         │    ├── Durable Object RealtimeHub  (/ws)    │
                         │    ├── Hyperdrive  ──────────────────────────┼──► PostgreSQL 16
                         │    ├── R2 ATTACHMENTS                       │      (external)
                         │    └── Cron Triggers                        │
                         └─────────────────────────────────────────────┘
  Print agent (on-site LAN) ──► polls the Worker ──► ESC/POS printers over TCP 9100
```

## 0. Just trying it out

You do not need any of this to try the system. Two commands, no account, no
card, and it is reachable from every device in the venue:

```bash
npm start -- --share
```

That brings the whole system up on your machine — on Windows, macOS or Linux —
and opens a free Cloudflare quick tunnel, printing an `https://….trycloudflare.com` address. Open it in
Safari on the iPad, Share → Add to Home Screen, and you are running the POS.
It needs [cloudflared](https://github.com/cloudflare/cloudflared/releases/latest)
(`brew install cloudflared` on macOS) and nothing else.

The tunnel points at the preview server, which already proxies `/api` and `/ws`
to the API, so one address serves the app, the API and the guest QR menu with
no CORS to configure.

**What this is not.** The address is temporary: it lives only as long as the
command runs, changes every time, and anyone holding the link reaches your
till. Use it to evaluate the system, not to run a shift, and never put real
customer data behind it. Everything below is the permanent setup.

**Free hosting for a longer trial.** Cloudflare's free Workers plan cannot run
this — see §1.1; Argon2id needs ~1.4 s of CPU against a 10 ms ceiling. A free
Postgres from Neon plus a small always-on Node host works, but any platform
that sleeps idle containers will make the first request of each shift slow, and
the print agent still has to run inside the venue either way.

## Where this cannot run

Free shared PHP hosting — ProFreeHost, InfinityFree, 000webhost, anything whose
control panel offers PHP and MySQL over cPanel and FTP — cannot run this
system, and no amount of configuration changes that. It is not a matter of
uploading the right archive.

| the system needs | shared PHP hosting gives |
| --- | --- |
| a long-lived **Node** process (`node dist/index.js`) | PHP executed per request |
| **PostgreSQL** | MySQL |
| an open **WebSocket** for live updates | long connections closed |
| **cron** for the background jobs | limited or absent |

The first row is the one with no way around it. The API is **13,500 lines of
TypeScript** across 139 routes; PHP hosting will not execute a line of it.
Making it run there is not configuration, it is rewriting the whole backend in
another language.

The database is the smaller obstacle, and worth stating accurately. Most of the
schema does have a MySQL 8 counterpart: `NUMERIC(18,4)` maps to `DECIMAL`,
`jsonb` to `JSON`, the PL/pgSQL numbering function to a stored procedure, and
InnoDB **does** support `SELECT … FOR UPDATE`, which is what the 35 row locks
guarding stock and wallet balances rely on. What does not carry over is the
partial unique index — `unique (lower(email)) where deleted_at is null` and
others like it, which is how soft-deleted rows stay out of uniqueness — and
that needs a different design, not a different keyword. Real work, but not the
blocker; the missing language runtime is.

What such a host is good for is static files. That does not help here: the
Worker that serves the API already serves the POS app from the same origin
(§7), so splitting them across two hosts adds CORS and a second domain while
still leaving the API homeless.

Use `--share` (§0) to try it, and §1 onward to host it.

## The order to do this in

Deployment mechanics are the easy half. The half that matters is that the seed
publishes the owner's password and every staff PIN **in this repository**, so
opening with any of them still in place is not a weak password — it is a
published one. `npm --workspace @mara/server run preflight` verifies the stored
hashes against those published values and refuses to pass while any still
match; `scripts/deploy-cloudflare.sh` will not deploy until it does.

| | what | who |
| --- | --- | --- |
| 1 | Cloudflare account on the **paid** Workers plan (§1.1), R2 enabled (§4) | you |
| 2 | A Postgres database at a provider, migrated and seeded (§2) | you |
| 3 | Hyperdrive, created `--caching-disabled` (§3) | one command |
| 4 | Four secrets generated and set (§5) | one command each |
| 5 | **Change the owner password and every staff PIN** | you, in the app |
| 6 | Real printer addresses, real tables, your menu | you, in the app |
| 7 | `npm run preflight -w @mara/server` until it says جاهز للافتتاح | one command |
| 8 | `./scripts/deploy-cloudflare.sh` | one command |
| 9 | Print agent on a machine inside the venue (§11) | you |
| 10 | Enrol MFA on first admin login, print the QR labels | you |

Generate each secret with something you did not choose yourself:

```bash
openssl rand -base64 48
```

Steps 5 and 6 are the ones with no shortcut, and the ones the preflight check
exists to stop you skipping.

## 1. Prerequisites — read these before you start

### 1.1 The Workers **Paid** plan is mandatory

This is not a preference. Password and PIN verification uses Argon2id, and the
CPU cost measured on the actual `workerd` runtime in this repository was:

| operation | measured CPU |
| --- | --- |
| `hashArgon2id` (64 MiB, t=3, p=1) | ~1437 ms |
| `verifyArgon2id` | ~1391 ms |

The free plan caps a request at **10 ms of CPU**, so every login would be
killed mid-verification. The paid plan allows up to 5 minutes; `wrangler.jsonc`
requests 10 s, which leaves generous headroom.

Do **not** "fix" this by lowering the Argon2 cost parameters. The memory cost is
what makes a stolen hash expensive to attack, and the stored PHC strings
(`$argon2id$v=19$m=65536,t=3,p=1$…`) carry their own parameters, so old hashes
keep verifying at their original cost regardless.

### 1.2 Cloudflare does not host PostgreSQL

Workers has D1 (SQLite), not Postgres. The schema depends on Postgres
specifically — `NUMERIC(18,4)` for stock quantities, `jsonb`, partial unique
indexes, `SELECT … FOR UPDATE` row locks (35 sites), and the
`next_document_number()` PL/pgSQL function. Provision the database with a
Postgres provider (Neon, Supabase, RDS, Cloud SQL) and reach it through
Hyperdrive.

### 1.3 Hyperdrive must have caching **disabled**

Hyperdrive caches read queries and does **not** invalidate that cache when the
application writes. This is a point of sale: a stale stock level, wallet
balance, or order status is a wrong answer, not a slightly old page. Create the
config with `--caching-disabled` (step 3) and keep the connection pooling
benefit without the cache.

### 1.4 R2 must be enabled on the account

Attachments (purchase invoices photographed by the buyer, waste evidence) go to
R2. Enable R2 once in the dashboard — Workers alone does not enable it.

## 2. Database

```bash
# Against your Postgres provider's connection string:
export DATABASE_URL='postgres://user:pass@host/mara?sslmode=require'

npm --workspace @mara/server run migrate   # applies migrations 001–008
npm --workspace @mara/server run seed      # branches, roles, menu, printers
```

Migrations are applied from your machine, not from the Worker: `AUTO_MIGRATE`
is `false` in `wrangler.jsonc` so that a cold start never races a schema change.

## 3. Hyperdrive

```bash
npx wrangler hyperdrive create mara-db \
  --connection-string="$DATABASE_URL" \
  --caching-disabled
```

Put the returned id into the `hyperdrive[0].id` field of
`packages/server/wrangler.jsonc`.

For `wrangler dev` against a local Postgres, set the local override instead of
editing the file:

```bash
export WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=\
'postgres://postgres:postgres@127.0.0.1:5432/mara'
```

## 4. R2

```bash
npx wrangler r2 bucket create mara-attachments
```

The binding name `ATTACHMENTS` in `wrangler.jsonc` must match; `src/worker.ts`
installs the R2-backed `AttachmentStore` at startup, replacing the filesystem
store used under Node.

## 5. Secrets

Never put these in `wrangler.jsonc` — that file is committed.

```bash
cd packages/server
npx wrangler secret put JWT_ACCESS_SECRET        # 32+ random bytes, base64
npx wrangler secret put JWT_REFRESH_SECRET       # different from the access one
npx wrangler secret put COOKIE_SECRET
npx wrangler secret put MFA_SECRET_KEY           # AES-256-GCM key for TOTP secrets
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put WHATSAPP_ACCESS_TOKEN
```

`MFA_SECRET_KEY` encrypts every stored TOTP secret. Losing it means every
administrator has to re-enrol MFA; rotating it requires re-encrypting the
`user_mfa` rows, so decide on it once.

## 6. Deploy

```bash
MARA_API_HOST=mara-api.<your-account>.workers.dev ./scripts/deploy-cloudflare.sh
```

That builds the POS app, deploys it together with the API as one Worker, then
builds and deploys the buyer app. To do it by hand instead:

```bash
npm --workspace @mara/web run build
cd packages/server && npx wrangler deploy       # API + POS app

VITE_API_BASE=https://<api-host> npm --workspace @mara/buyer run build
cd packages/buyer && npx wrangler deploy        # buyer app
```

The first deploy creates the `RealtimeHub` Durable Object class via the `v1`
migration in `wrangler.jsonc`.

## 7. One Worker, one origin

The POS app is served by the same Worker that serves the API
(`assets.directory` points at `packages/web/dist`). That is deliberate:

* **No CORS.** The app's `/api/...` calls are same-origin, exactly as in
  development.
* **One URL** to type on every iPad, and one certificate.
* **Static files never touch the database.** `run_worker_first` lists only
  `/api/*`, `/ws` and `/health`, so everything else is served from Cloudflare's
  edge cache without the Worker script running at all — no Hyperdrive
  connection is opened to serve a JavaScript bundle.
* `not_found_handling: "single-page-application"` makes client-side routes
  (`/tables`, `/pos`, and the guest `/menu/<qr>`) resolve to `index.html`.

The buyer app is a separate Worker because it is a separate application on
separate devices. It reaches the API by absolute URL, baked in at build time
with `VITE_API_BASE`; a value saved on the device overrides it, so a rep can be
pointed at another server without a rebuild.

### Custom domains

`wrangler deploy` gives you `<worker>.<account>.workers.dev`, which works
immediately. For your own domain, add the zone to Cloudflare and attach a route
in the dashboard (Workers & Pages → your Worker → Settings → Domains & Routes).
Certificates are issued automatically. Update `CORS_ORIGINS` and
`PUBLIC_MENU_BASE_URL` in `wrangler.jsonc` to match — `PUBLIC_MENU_BASE_URL` is
what goes into the printed table QR codes, so set it before printing labels.

## 8. Cron triggers

Three schedules are declared, handled by `src/jobs/scheduled.ts`:

| cron | job |
| --- | --- |
| `* * * * *` | reclaim print jobs stuck in `printing`, mark unreachable printers |
| `15 * * * *` | expire idle sessions and refresh-token families |
| `0 3 * * *` | purge consumed and expired one-time codes |

Under Node the same work runs from `src/jobs/index.ts` on `setInterval`.

## 9. Realtime

`/ws` is served by the `RealtimeHub` Durable Object, one instance per branch,
using the WebSocket Hibernation API so idle connections cost nothing.

**The Worker authenticates the connection before handing it to the Durable
Object.** The DO never sees an unauthenticated socket, and a client can only
subscribe to the branch its token grants — the same rule the HTTP endpoints
enforce through `assertBranchAccess`.

Service code calls `publish()` exactly as it does under Node; on Workers a
transport installed per request forwards the event to the DO through
`ctx.waitUntil`, so publishing never delays the response.

## 10. Verifying the deployment

`packages/server/worker-smoke.mjs` runs the security-critical flows against a
running Worker. It was used to validate this port on `workerd` and passes 23/23:

```bash
npx wrangler dev --port 8787          # in one shell
node packages/server/worker-smoke.mjs # in another
```

It covers employee PIN login, the refusal of PIN login for administrative
accounts, admin email+password login, permission sets, a waiter being refused
financial reports, static-vs-parameter route precedence, cross-branch refusal
(403), QR table resolution and tamper rejection, department printer routing,
server-side pricing, idempotent re-submission, OTP rejection, and recipe stock
consumption inside a transaction.

## 11. What runs where, and on which device

| | where it runs | how people reach it |
| --- | --- | --- |
| POS, floor, admin, reports | Cloudflare | Safari on the iPad → Share → **Add to Home Screen**. It then opens full-screen, and works through a brief wifi drop. |
| Guest QR menu | Cloudflare, same Worker | The customer's own phone camera. No app, no sign-in. |
| Buyer app | Cloudflare (or the APK) | The rep's Android phone. Add to Home Screen, or install the Capacitor build — same code either way. |
| Print agent | **inside the venue** | Nothing to reach. It polls the API and pushes to the printers. |

The print agent is the one piece that cannot live in the cloud, and this is not
a limitation to work around: the thermal printers speak raw ESC/POS over TCP
9100 on the venue's own LAN and have no public address. Run the agent on
anything that stays on — a mini PC, a Raspberry Pi — on the same network as the
printers:

```bash
MARA_API_URL=https://<api-host> \
MARA_AGENT_TOKEN=<the token the seed printed> \
node packages/print-agent/dist/index.js
```

It holds no inbound port and needs no port forwarding: it reaches out to the
API, takes the queued jobs, prints them, and reports back. If it stops, tickets
queue up rather than being lost, and the Printers screen shows the agent as
offline.

## 12. Things that behave differently on Workers

| | Node | Workers |
| --- | --- | --- |
| HTTP | Fastify | `core/router.ts` shim (verified route-for-route against Fastify's matcher for all 135 routes) |
| DB handle | `pg.Pool` | one `pg.Client` per request through Hyperdrive |
| Realtime | in-process `@fastify/websocket` | `RealtimeHub` Durable Object |
| Attachments | `uploads/` on disk | R2 |
| Background jobs | `setInterval` | Cron Triggers |
| Argon2 | pure JS (`core/argon2.ts`) | same code — runtime WASM compilation is forbidden on Workers, so there is no native or WASM path on either runtime |

### Module scope is not a place to do work

Workers refuses asynchronous I/O, timers and **random number generation** while
a module is being evaluated. `core/config.ts` therefore reads its secrets
lazily: the first access inside a request resolves them, rather than the module
body doing it at import time. Keep this in mind when adding configuration — a
`randomBytes()` or `fetch()` at the top level of any imported module takes the
whole Worker down at startup, on every request, with a message that points at
the module rather than at your change.

Note the last row: `WebAssembly.compile()` is blocked by the Workers embedder,
which is why Argon2id is implemented in plain TypeScript rather than pulled from
a WASM package. The implementation is verified in `tests/argon2.test.ts` against
hashes produced by the previous native implementation, so existing stored
passwords and PINs continue to verify.
