# Operations

## Deployment shape

| Piece | Where it runs |
|---|---|
| API + PostgreSQL | Cloud, HTTPS behind a reverse proxy or WAF |
| Web PWA | Static hosting or the same origin as the API |
| Print agent | A small always-on machine inside each branch's LAN |
| MARA Buyer | The rep's Android phone |

Serving the web app from the same origin as the API is the simplest correct
setup: no CORS, and cookies and tokens never cross an origin boundary.

## First run

```bash
npm install
npm run build
npm run migrate -w @mara/server
npm run seed -w @mara/server
```

The seed is idempotent — running it again does not duplicate anything. It
prints the accounts it created. **Change those passwords before opening.**

Migrations run automatically on boot unless `AUTO_MIGRATE=false`. They are
forward-only, each runs once inside its own transaction, and a file that
changes after having been applied is a hard error rather than a silent
divergence.

## Environment

`.env.example` is the reference. The ones that must be right in production:

| Variable | Why it matters |
|---|---|
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `COOKIE_SECRET`, `MFA_SECRET_KEY` | At least 32 characters each; the server refuses to start otherwise |
| `REQUIRE_ADMIN_MFA` | Must stay `true` |
| `WHATSAPP_PROVIDER` | `meta_cloud`; the `log` provider refuses to run in production |
| `CORS_ORIGINS` | The exact origins, never a wildcard |
| `TRUST_PROXY` | `true` behind a proxy, or every client appears to share one IP and rate limiting collapses |

`COOKIE_SECRET` also signs table QR tokens: changing it invalidates every
printed QR sticker.

## Setting up a branch

1. Create the branch, its stock locations, staff and tables.
2. Print each table's QR from the table sheet (Floor → table → QR).
3. Add the printers with their IPs, one per department.
4. Create a print-agent token (Printers → وكيل طباعة جديد) and install the agent
   on the branch machine. **The token is shown once.**
5. Enter opening stock, then set a minimum level per item so low-stock alerts
   are meaningful.
6. Set the loyalty rule and the waste-approval threshold.

## Backups

The database is the system of record; everything else can be rebuilt.

```bash
pg_dump --format=custom --file=mara-$(date +%F).dump "$DATABASE_URL"
```

Take them daily, keep them off the database host, and **restore one on a
schedule** — an untested backup is a hope, not a backup. Uploaded invoice
images live under `UPLOAD_DIR` and need backing up alongside.

## What to watch

| Signal | Meaning |
|---|---|
| `GET /health` | Liveness plus database latency |
| Print queue depth | A queue that stops draining means paper has stopped |
| Print agent last-seen | An agent silent for two minutes is reported offline |
| Failed logins / PINs | Repeated failures raise a security notification |
| Inventory variance | Counts breaching the threshold alert automatically |

The notification centre is the operational inbox; the audit log is the record.

## Routine operations

**A printer is replaced.** Update its IP in Printers. Queued jobs retry against
the new address; nothing is lost.

**The print agent machine is rebuilt.** Create a new token, install the agent.
Jobs claimed by the dead agent return to the queue when their leases expire.

**An employee leaves.** Disable the account. Their sessions are revoked and
their history stays intact — never delete an employee who has taken money.

**A guest disputes a discount.** Search the audit log by order. The record shows
who applied it, which customer, the price before and after, and that the
customer's code was verified, with the time.

**Stock does not match.** Open a count. Expected quantity is the sum of the
period's movements broken out by receipts, transfers, recipe consumption and
waste, so the variance points at where it went rather than only that it is
missing.

## Scaling

The API is stateless and scales horizontally; sessions and the print queue live
in PostgreSQL. Websockets are per-instance, so with more than one instance
either use sticky sessions or add a shared pub/sub — the clients already poll
as a fallback, so a missed event degrades rather than breaks. The database is
the first thing that will need attention: the ledger tables grow fastest, and
`inventory_transactions` and `audit_logs` are the natural first candidates for
partitioning by month.
