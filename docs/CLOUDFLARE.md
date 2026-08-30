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

## 6. Deploy the API

```bash
npm --workspace @mara/server run worker:check    # typechecks the Workers build
npm --workspace @mara/server run worker:deploy
```

The first deploy creates the `RealtimeHub` Durable Object class via the `v1`
migration in `wrangler.jsonc`.

## 7. Deploy the two PWAs

```bash
npm --workspace @mara/web run build
npx wrangler deploy --assets packages/web/dist --name mara-web
```

Point `VITE_API_BASE_URL` at the deployed Worker before building, and keep
`CORS_ORIGINS` in `wrangler.jsonc` in sync with the hostnames you serve the
PWAs from.

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

## 11. Things that behave differently on Workers

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
