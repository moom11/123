# MARA Lounge Management System

نظام التشغيل المركزي لمارا لاونج — مطعم وكافيه ولاونج.

A cloud system that knows, at any moment: who the customer is, which table they
are on, what they ordered, which waiter is responsible, which printer each item
went to, whether the order was changed or reprinted, what discount was applied
and whether the customer confirmed it, how many points they hold and spent,
which recipes were consumed, what stock that implies, what was wasted, what the
count found, what is short, who asked to buy it, whether the branch manager
approved it, what quantity they approved, what the purchasing rep saw, what
they bought, from whom, at what price, whether the invoice was captured,
whether the goods arrived, who received them — and who did every one of those
things.

## Contents

| Package | What it is |
|---|---|
| `packages/shared` | Role and permission matrix, domain state machines, unit and money helpers shared by every client |
| `packages/server` | Fastify API over PostgreSQL — all business rules live here |
| `packages/web` | Arabic RTL PWA: POS, floor board, management, and the guest QR menu |
| `packages/buyer` | MARA Buyer — the purchasing rep's Android app (Capacitor) |
| `packages/print-agent` | Local ESC/POS agent that drives the branch's IP printers |

```
Frontend / Mobile app  →  Secure backend API  →  PostgreSQL
```

No client ever talks to the database. The iPad never talks to a printer.

## Quick start

With PostgreSQL 16 running and `npm install` done, one command does everything —
create the database, migrate, seed, build and start all three services:

```bash
./scripts/dev-up.sh              # POS on :4173, buyer app on :4174
./scripts/dev-up.sh --share      # ...and a free public HTTPS URL for the iPads
./scripts/dev-up.sh --reset      # start over from an empty database
```

`--share` opens a [Cloudflare quick tunnel](https://github.com/cloudflare/cloudflared/releases/latest)
and prints an address anyone on any device can open — no account, no card. It is
a temporary link for trying the system out, not a way to run a shift; see
[`docs/CLOUDFLARE.md`](docs/CLOUDFLARE.md) §0.

<details>
<summary>Doing it by hand</summary>

```bash
# 1. PostgreSQL 16
createdb mara

# 2. Configure
cp .env.example .env      # fill in the secrets; see the file's comments

# 3. Install, migrate, seed
npm install
npm run migrate -w @mara/server
npm run seed -w @mara/server      # prints the logins it created

# 4. Run
npm run dev:server -w @mara/server   # API on :4000
npm run dev -w @mara/web             # POS + guest menu on :5173
npm run dev -w @mara/buyer           # buyer app on :5174
```

</details>

The seed creates a working branch: 20 tables with QR tokens, four printers, a
menu whose recipes are the worked examples from the specification, opening
stock, suppliers, loyalty rules, and one demo customer with a special price.

## The rules the system enforces

These are not conventions; they are enforced in the backend and covered by
tests, so no client — however it is built — can route around them.

**Two doors, and only two.** Management signs in with email + password + MFA.
Operational staff sign in with an employee number and a PIN. An administrative
role cannot sign in with a PIN even if one is attached to the account.

**The frontend is never the authority.** Every endpoint checks permissions
server-side. Hiding a button changes nothing. A branch manager cannot raise
their own privileges, and no principal escapes its branch.

**Prices come from the database.** A waiter cannot type a price. A crafted
request body cannot set one.

**Customer discounts and points each require the customer's own consent.** Two
separate single-use WhatsApp codes, each bound to one customer and one
operation, neither able to authorise the other, neither reusable on a second
invoice. Each application records the customer, employee, invoice, table,
original and discounted price, the verification result, and the time.

**A guest's order reaches no printer until a waiter confirms it.** Orders from
the QR menu land in the waiter's inbox; the departments see nothing until a
human approves.

**Departments work from paper.** There are no kitchen, bar or shisha screens.
Items route to their department's printer, later additions print `ADD ITEM`
with only the new lines, cancellations print `VOID` with a reason, and every
reprint is stamped `REPRINT` and attributed.

**Nothing printable is lost.** Print jobs are a durable queue with leases,
retries and alerts — a failed ticket is retried, and once retries are spent the
till and the branch manager are told.

**Modifier choices move real stock.** Tea with sugar consumes sugar; tea
without it consumes none. Mint mix draws 2.5 g from each of two tins. Every
movement is a row in an append-only ledger, which is what makes the expected
stock in a count arithmetic rather than an estimate.

**The purchasing rep never sees an unapproved request** and can never buy
beyond the approved quantity. Both are enforced in SQL. Stock moves only when
the receiving department confirms it — never on the buyer's word.

**Financial and stock history is never deleted.** Orders, payments, purchases,
wallet movements and stock transactions carry status and reversal, not
deletion.

**Everything sensitive is audited.** One append-only row per action with the
actor, the entity, the value before and after, IP and user agent. There is no
write or delete path to the audit log anywhere in the API.

## Verification

```bash
npm test -w @mara/server                # 110 integration tests, real PostgreSQL
npm test -w @mara/print-agent           # ESC/POS renderer, no hardware needed
node packages/web/e2e-smoke.mjs         # 26 browser checks against a live API
node packages/buyer/e2e-smoke.mjs       # 17 browser checks incl. offline sync
```

The server tests run against an actual database, not mocks: they assert that
stock really moves, that a wrong OTP really leaves the wallet untouched, that a
replayed session token really revokes its family, and that an unapproved
purchase request really is absent from the buyer's queue.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the pieces fit together
- [`docs/SECURITY.md`](docs/SECURITY.md) — the security model and what it assumes
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — deployment, backups, day-to-day running
- [`docs/CLOUDFLARE.md`](docs/CLOUDFLARE.md) — running the whole system on Cloudflare Workers
- [`packages/print-agent/README.md`](packages/print-agent/README.md) — branch printing
- [`packages/buyer/README.md`](packages/buyer/README.md) — building the Android APK

## Multi-branch

Single-branch today, multi-branch by construction: every user, table, printer,
inventory item, order and purchase request carries a branch, document numbering
is per branch and per year (`ORD-2026-000001`), and branch containment is
checked on every request.
