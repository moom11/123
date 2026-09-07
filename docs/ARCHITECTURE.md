# Architecture

## The path data takes

```
  Guest phone          iPad / POS          MARA Buyer (Android)
       │                    │                       │
       └────────────────────┴───────────────────────┘
                            │  HTTPS
                    ┌───────▼────────┐
                    │  Fastify API   │  ← every rule lives here
                    └───────┬────────┘
                            │
                    ┌───────▼────────┐
                    │  PostgreSQL    │
                    └────────────────┘
                            ▲
                            │ HTTPS, bearer token
                    ┌───────┴────────┐
                    │  Print agent   │  (inside the branch LAN)
                    └───────┬────────┘
                            │ TCP 9100
                     ESC/POS printers
```

No client opens a database connection. No client opens a printer socket.

## Why the backend holds everything

Four different clients touch this system — a POS on an iPad, a guest's browser,
an Android app, and a print agent — and they update on different schedules. A
rule implemented in a client is a rule that an out-of-date client can break, so
every rule that matters is implemented once, in the API, and covered by a test
that calls the API directly rather than driving a UI.

The clients still hold a permission set, but only to decide what to render. A
403 from the server is treated as a bug in the UI, never as the security
boundary.

## Modules

The server is organised by domain, each module owning its own routes, service
and rules:

| Module | Owns |
|---|---|
| `auth` | Both sign-in paths, MFA, session rotation, permission resolution |
| `admin` | Users, employees, roles, permission overrides, settings |
| `menu` | Categories, products, modifiers, prices, availability |
| `tables` | Tables, QR tokens, sessions, move/merge, guest service requests |
| `orders` | Ordering, waiter approval, additions, voids, discounts, payments |
| `customers` | Profiles, wallet, loyalty, special prices, OTP |
| `inventory` | Stock ledger, recipes, receiving, transfers, waste, counting |
| `purchasing` | Requests, approval, the buyer surface, suppliers, receiving |
| `printing` | Printer routing, the durable queue, the agent protocol |
| `reports` | Dashboards and reporting |
| `notifications` | The notification centre |
| `audit` | Read-only access to the audit trail |

## Data model decisions worth knowing

**Money is `BIGINT` halalas, never floating point.** The till, the wallet
ledger and the printed bill have to agree exactly, and binary floating point
cannot represent 0.10 SAR.

**Quantities are stored in a canonical base unit** (gram, millilitre, piece).
Purchases in cartons, recipes in grams and counts in kilograms all normalise on
the way in, so they are directly comparable without arithmetic at each call
site.

**Stock is an append-only ledger.** `inventory_stock` is a running total that is
only ever changed in the same transaction as a row in
`inventory_transactions`. That is what makes a stock count's "expected"
quantity the sum of the period's movements by construction, rather than a
figure someone has to trust.

**Order lines snapshot what they need.** The product name and production
department are copied onto the order line at the time of sale, so renaming a
product or moving it to another printer next month does not rewrite what
happened last night.

**The buyer's window is a database view.** `buyer_purchase_requests` contains
only approved-and-beyond requests and exposes the approved quantity rather than
the requested one. A bug in a caller cannot leak a draft request through it,
because the rows are not there.

## Concurrency

Anything that touches money or stock runs inside a transaction, and the row it
depends on is locked before it is read:

- The wallet row is locked before a redemption, so two tills redeeming the same
  customer's points serialise rather than both succeeding against a stale
  balance.
- The stock row is locked before a movement, so concurrent sales of the same
  drink cannot both write the same balance.
- Print jobs are claimed with `FOR UPDATE SKIP LOCKED`, so two agents in one
  branch can work the queue without ever being handed the same ticket.
- OTP consumption is guarded on `consumed_at IS NULL`, so two simultaneous
  submissions of the same correct code can only ever succeed once.

**Nested transactions are a hazard here.** A service that opens its own
transaction must accept a client when it is called from inside one — otherwise
it takes a second pooled connection and deadlocks against locks the caller
holds. `receiveGoods` takes an optional client for exactly this reason; it was
a real deadlock before it did.

## Realtime

One websocket per client, authenticated with the same access token and carrying
exactly the permissions of the principal that opened it. Events are filtered by
branch and by permission on the way out, so a socket cannot subscribe its way
into another branch's traffic. Delivery is best-effort: every screen that
listens also polls slowly, because a floor cannot be left blind by a dropped
connection.

## Idempotency

The POS and the guest app both send an idempotency key with an order, and the
POS sends one with a payment. The keys carry unique indexes, so a retry on a
flaky connection returns the original result instead of creating a second order
or charging twice. The buyer app does the same for purchases recorded offline.
