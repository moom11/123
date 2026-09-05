# Security model

## Identity

**Administrative roles** (owner, super admin, executive, branch manager,
accountant) sign in with email + password + MFA. MFA is mandatory in
production: a first sign-in without it enrols one rather than letting the
account through. Passwords are Argon2id (64 MiB, 3 passes) and must be at least
12 characters with mixed case, a digit, a symbol, and no common word.

**Operational roles** sign in with an employee number and a PIN on a shared
shop-floor device. PINs are Argon2id too, are never stored or logged in any
other form, and reject repeated (1111) and sequential (1234) values.

**An administrative role cannot sign in with a PIN.** This is checked
explicitly and tested with the worst case: an admin account that has been given
an employee record and a valid PIN is still refused.

## Sessions

Access tokens are short-lived (15 minutes). Refresh tokens rotate on every use
and are stored only as a SHA-256 lookup hash. Presenting a token that has
already been rotated is treated as theft: the entire session family is revoked
and the event is audited and alerted.

That revocation deliberately runs outside the transaction that detected it —
performing it inside would be rolled back by the rejection that follows,
leaving the stolen family alive. This was a real bug, caught by a test that
asserted the successor token stops working too.

Administrative sessions also expire on idleness, not just on age. Changing a
password can force every other device to sign out, active sessions are listable,
and an administrator can force-close another user's sessions. A role change
revokes that user's sessions immediately, because their permissions just
changed.

## Authorisation

Every endpoint declares the permission it needs, next to the route, so it
cannot be forgotten. Effective permissions are role grants plus per-user
grants minus per-user denials, computed per request — a permission change takes
effect on the very next call rather than whenever a cache expires.

Constraints that are enforced, not merely intended:

- Only Owner and Super Admin may create administrative accounts, assign roles,
  or grant permission overrides.
- Nobody may change their own role or grant themselves a permission, including
  an owner.
- A branch manager cannot promote anyone into an administrative role.
- Every branch-scoped query passes through a containment check; a principal
  cannot read or write another branch's data by supplying its id.

## Customer protection

**Discounts and points each require the customer's own one-time code**, sent to
their WhatsApp. The two flows never share a code: a discount code carries the
purpose `customer_discount`, a redemption carries `points_redemption`, and each
is additionally bound to one operation reference. A code obtained for one
cannot authorise the other, and neither can be replayed on a second invoice.

Codes are stored only as Argon2id hashes, are single-use, expire in five
minutes, cap attempts, and are throttled per phone number — the person being
protected from a flood of messages is the customer, not the staff member.

The code itself is never written to the audit log. What is recorded is that a
code was issued and later verified, with the customer, employee, invoice,
table, original and discounted price, and the time.

**Phone numbers are masked** for staff without `customers.read.full_phone`, and
customer search by phone is exact-suffix rather than fuzzy, so staff cannot
enumerate the customer base by typing a few digits.

**Verifying a phone number is not marketing consent.** They are separate
records with their own timestamps and channel, and the guest can decline
marketing while still placing an order.

## Table QR codes

The QR encodes an opaque high-entropy token plus a truncated HMAC, never the
table number. There is nothing in the URL to edit, and a guessed token fails
the signature check before any database work happens, so response timing does
not disclose which tokens exist. A table's token can be rotated, which
invalidates every sticker already printed for it.

## Transport and headers

HTTPS throughout, HSTS in production, a restrictive CSP (the API serves JSON,
so `default-src 'none'` costs nothing), no framing, CORS limited to configured
origins, and rate limiting keyed per principal where one is known and per IP
otherwise, so one busy till does not throttle a whole branch.

The websocket is the one place a token may travel in a query parameter, because
a browser cannot set headers on a handshake. It is accepted **only** for the
`/ws` upgrade — on any other path a token in the URL would leak into access
logs, proxy logs and `Referer` headers.

## Secrets

Every secret comes from the environment. In production a missing or short
secret is a startup failure rather than a warning. TOTP secrets are encrypted
at rest with AES-256-GCM (they must be recoverable, unlike passwords).
Print-agent tokens are stored as hashes and shown exactly once. No secret is
ever sent to a browser.

The development WhatsApp provider, which writes codes to the log, refuses to
run in production.

## Audit

One append-only row per sensitive action: the actor (user, employee, customer,
system or print agent), the action, the entity, the value before and after, IP,
user agent and time. The audit write joins the caller's transaction, so there
is never a logged action that did not happen, nor an action with no log.

There is no update or delete path to `audit_logs` anywhere in the API, and the
absence is asserted by a test.

## What this model assumes

- **The database is trusted.** There is no field-level encryption; protecting
  the database is an infrastructure responsibility (network isolation,
  encryption at rest, restricted credentials, tested backups).
- **The print agent's network is trusted.** ESC/POS over TCP 9100 has no
  authentication — that is the protocol, not a choice. Printers belong on an
  isolated VLAN.
- **A staff device in the wrong hands is a risk PINs only bound.** Short
  sessions, lockouts and a complete audit trail limit the damage; they do not
  prevent it.
- **WhatsApp delivery is outside our control.** If Meta's API is down, discounts
  and points redemption cannot be authorised. That is the correct failure: the
  alternative is applying them without the customer's consent.
