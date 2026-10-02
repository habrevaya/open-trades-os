---
title: Customer Portal and Online Booking
module: M05
domain: Customer
phase: 2
status: partial
---

# Customer Portal and Online Booking

> Module M05. Domain: Customer. Ships in phase 2.

## What it does

Lets a customer approve a quote, track a visit, pay an invoice, put down a
deposit and see their whole account, without creating an account. And lets a
stranger on the company's website book a real slot.

## The problem

Identity. A homeowner will not create an account to approve a quote, and a
platform that insists on one loses the approval. Every other design in this
space either sends a PDF and asks for a reply, or builds a login nobody uses.

The second problem is availability. A booking widget that offers times the
company cannot actually serve is worse than no widget: every overbooked slot
costs a reschedule call and the trust that came with it.

## Key concepts

**A grant is a capability, not a session.** A single purpose, scoped, expiring
token that says what its bearer may do and to which record. It cannot be
widened, it cannot be enumerated, and it does not survive the thing it was
issued for. Six scopes and no seventh: one estimate, one job, one invoice, one
deposit, one booking request, or the whole customer view.

**Only the hash is stored.** The plaintext exists exactly once, in the link
that was sent, so a grant leaked from a database backup is useless. The same
treatment sessions and credentials get, for the same reason.

**A use cap exists because the failure mode differs by scope.** An approval
link forwarded to a whole family is fine. A payment link forwarded to a whole
family is not.

**The subject comes from the grant, never from the request.** There is no id in
any portal input that a caller could change to reach another record. That is
structural rather than a matter of remembering, which matters because none of
these endpoints has an actor to check a permission against.

**Resolution runs through a security definer function.** The lookup has to
happen before the organization is known, so it cannot go through row level
security. The function takes a 256 bit hash the caller must already hold and
returns one row or none, so it cannot enumerate anything. Everything after
resolution runs inside the tenant boundary as a synthetic actor scoped to the
resolved company, so a bug in a handler cannot reach across tenants even if it
tries.

**A booking grant precedes its customer.** It is the one case where a grant has
no customer on it: somebody has asked for work and nobody has confirmed it yet.
They still want to see that something happened, and the gap before a human
looks at it is exactly when they want it most. Confirmation fills the customer
in.

**Offered availability is derived, never typed in.** What a company configures
is the shape of what it is willing to sell: which job types are bookable, in
which territories, how far ahead, how much notice, how many per window. The
engine intersects that with business hours, time off and what is already sold,
and re-checks the slot inside the transaction that writes the request.

**A resubmission inside a short window is the same submission.** Long enough to
cover a phone that lost signal mid-request and somebody who gave up and refilled
the form; short enough that the same household booking the same service for the
same window a season later is the second booking it actually is. Swallowing that
one would be worse than the duplicate, because nobody would find out the work
had been requested.

## Setup

`/booking` is where a company says what the public may book: the services, the
arrival windows it is willing to offer, and which days it is open. All three
need `booking:configure`. The public widget is served at `/book/{slug}`.

## Using it

### Hand a customer a link

`POST /v1/portal/grants` issues one, with `portal:grant`.
`POST /v1/portal/grants/{id}/revoke` withdraws it, with `portal:revoke`, which
is a separate permission because a technician may hand out a link and may not
take one back.

Sending an estimate issues the grant as part of sending, so the normal path is
`POST /v1/estimates/{id}/send` rather than minting one by hand.

### What the customer opens

| Link | What it is |
|---|---|
| `/e/{token}` | One estimate, to read, approve or decline |
| `/j/{token}` | One job: status, arrival window, who is coming |
| `/i/{token}` | One invoice, with a card if the company has connected Stripe |
| `/pay/{token}` | One deposit, asked for by an approved estimate |
| `/b/{token}` | One booking request, before anybody has confirmed it |
| `/c/{token}` | The whole account: visits, documents, agreements, history |

### Take a booking from the website

`GET /v1/public/services` and `GET /v1/public/availability` are read by a
stranger, so they resolve the company from its slug rather than from a session
and return nothing about anybody. `POST /v1/public/bookings` writes the request.
Those three and the portal reads are the only routes in the product with no
permission, and the only place where an explicit organization filter is the
mechanism rather than a backstop.

### Decide a request

`GET /v1/bookings` is the queue, at `/booking`.
`POST /v1/bookings/{id}/confirm` turns it into a job and needs both
`booking:decide` and `job:write`, because it is both decisions.
`POST /v1/bookings/{id}/decline` is the other half.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything, including what the public may book |
| Office manager | Decides requests, configures booking, issues and revokes links |
| Dispatcher, CSR | Reads and decides requests. Issues a link |
| Technician | Issues a link, so the customer approves on their own phone |
| Accountant | Neither |

A technician holds `portal:grant` and not `estimate:approve`, deliberately:
handing somebody a link to approve on their own phone is a different act from
approving on their behalf.

## API

| Call | Needs |
|---|---|
| `GET /v1/portal/session` | nothing: the token is the authority |
| `GET /v1/portal/estimate` | nothing |
| `POST /v1/portal/estimate/approve` | nothing |
| `POST /v1/portal/invoice/pay` | nothing |
| `POST /v1/portal/grants` | `portal:grant` |
| `POST /v1/portal/grants/{id}/revoke` | `portal:revoke` |
| `GET /v1/public/availability` | nothing |
| `POST /v1/public/bookings` | nothing |
| `GET /v1/bookings` | `booking:read` |
| `POST /v1/bookings/{id}/confirm` | `booking:decide`, `job:write` |
| `PUT /v1/booking/hours` | `booking:configure` |

## Common questions

**What happens when a link expires?** The page says so and offers nothing. A
new one has to be issued, which is the point: a link that outlives its purpose
is a standing credential.

**Can a customer pay without Stripe connected?** No. The invoice page shows the
balance and tells them to reply to arrange payment, because there is no other
way to pay from it and pretending otherwise wastes their time.

**Does a booking request hold a deposit?** No. There is no customer yet to hold
one for.

## What is not built

A customer cannot log in: every route into the portal is a link somebody sent
them. There is no account creation, no password and no saved payment method.
The portal blocks a trade pack declares are data with nothing reading them yet,
so the customer view is the same shape for every trade. Rescheduling from the
portal is not built: a customer who needs a different day replies.
