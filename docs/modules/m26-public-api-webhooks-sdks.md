---
title: Public API, Webhooks and SDKs
module: M26
domain: Platform
phase: 1
status: partial
---

# Public API, Webhooks and SDKs

> Module M26. Domain: Platform. Ships in phase 1.

## What it does

Publishes every capability in the product as an HTTP API with a declared schema,
delivers signed webhooks when things happen, and lets a third party act against one
company's instance with that company in control of exactly what it may touch.

## The problem

BUILD.md's third ordering rule is that the API comes first, always, and the web app
consumes the same surface a third party gets. Every embed, agent and integration
depends on that being true from the start rather than retrofitted.

The second problem is subscriptions to events nothing emits. A workflow subscribed to
a dead event is a workflow that never runs, and the person who built it believes they
automated something. A webhook subscribed to a dead event is the same failure
happening in somebody else's system: they built a receiver, tested it by hand,
deployed it, and it will never be called. Nothing in this product logs a subscription
that matches nothing, because matching nothing is exactly what a quiet week looks
like, and no screen can tell the two apart.

## Key concepts

**Every route declares its method, path, input schema, output schema and required
permissions in one place.** OpenAPI is generated from that, and so is the MCP tool
list. A declared route with nothing behind it is a compile error rather than a 404
somebody finds in production, because a promise with no implementation is worse than
no promise when an SDK and a tool list are generated from it.

**Three handler shapes, matching the three ways a caller can be authorized.** A
session handler takes a service context and the service checks the permission. A
grant handler takes a database and the request and resolves the token itself. A public
handler takes a database and no caller identity exists at all. The shapes are kept
apart deliberately: a session handler and a grant handler have different first
arguments, so wiring one where the other belongs does not compile, and the common way
to turn an authenticated endpoint into an open one is exactly that mistake.

**An app is an actor, not a parallel authorization system.** It gets the same actor
type a person gets, and every permission check and scope filter applies to it
unchanged. Nothing downstream knows or cares that a request came from an app.

**You cannot grant what you do not hold.** Approving an app goes through the same
function that governs custom roles, because two implementations of "may you grant
this" disagree eventually and the disagreement is silent. An office manager
installing an app cannot give it the ledger.

**Revocation is immediate, and it is SQL rather than a check somebody remembers.**
Every revocation path is a condition in the query that resolves a token. An operator
who revokes at four in the afternoon means four in the afternoon.

**An unknown permission on an app install is refused rather than dropped.** Silently
ignoring it would install an app with less access than the operator approved and no
sign of it.

**A webhook subscription is validated against the event catalogue.** A name the
catalogue does not hold is refused, and so is a name the catalogue holds and nothing
emits, with the refusal saying which. A name this company's own log has already seen
is allowed through whatever the current build declares, because it is a real thing in
that company's history and refusing it would break integrations that work.

**Delivery is ordered per endpoint, and gives up.** Each endpoint has its own position
in the event log; a failure stops that endpoint at the failing event rather than
skipping it; retries back off; and an endpoint that has failed enough times in a row is
switched off with a line in the audit log rather than retried forever.

**Every attempt is kept, with what the receiver said, and kept bounded.** Each
delivery attempt records the event, the attempt number (replays included), when it
went, how long it took, the status the receiver answered, the first two thousand
characters of its body and any error. An attempt is delivered (a 2xx), refused (any
other answer) or unreachable (no answer at all). The history is pruned on every pass,
per endpoint, to thirty days and a thousand attempts, whichever cuts first, so a
receiver answering every retry with a megabyte of HTML cannot grow it without bound.

**A replay is a second copy of history, not a rewind.** One delivery, one event, or
everything an endpoint subscribes to from a point in the log can be sent again. It is
queued and the worker sends it in order after the endpoint's live deliveries, signed
afresh (an old signature would fail the receiver's skew check, which is the point of
it) and carrying the same `x-otos-delivery` header as the original, so a receiver
deduplicating on it is never made to process an event twice; `x-otos-replay` names
the replay. The range is fixed when it is asked for, at most five thousand events,
and the endpoint's own position does not move. A replay that keeps failing backs off
and gives up on its own count, and never switches the live stream off. Asking again
for a replay that is still waiting returns it rather than queuing a second. The
worker visits a company owing a replay or a retry even on a pass where it produced
no event.

**The timestamp is inside the signed payload, not merely alongside it.** A signature
over the body alone is valid forever: anybody who captures one delivery can replay it
later and the receiver cannot tell, because everything they check still matches.

**A signing secret is stored in plaintext and an app token is not, and the asymmetry
is the point.** A token is presented to us, so a one way hash is enough to check it. A
signing secret goes the other way: we hold it and have to reproduce a signature with
it on every delivery, which a hash cannot do. So a secret is returned exactly once,
when it is made (at registration or at a rotation), and the single function that
shapes a row for output reads neither secret column, so a list, a read or an update
cannot leak one even by accident.

**A rotation overlaps, because two people are involved.** The person who rotates a
secret and the person who updates the receiver rarely act in the same minute. For an
overlap the operator chooses (a day unless they say, up to a week) every delivery is
signed with both secrets, the signature header carrying two signatures separated by
a comma, newest first, and the receiver accepts a delivery when either matches the
secret it holds. With no overlap the old secret stops at once, which is the answer
when it leaked. A second rotation during an overlap retires the oldest, so at most
two ever sign.

**Asking grants nothing.** A third party can ask to be installed without holding any
credential, and what it asks for is written as a `pending` app that resolves no token
and can be issued none. Somebody at the company reads the request in the catalogue's
own words and approves exactly that list, through the same authority check as an
install by hand, or refuses it. Only then can the app collect its credential, once,
with a claim secret it was given when it asked and that only it holds.

**The SDK is generated, never written.** The contracts produce the OpenAPI document,
and the document produces the TypeScript client, in the same command; a test fails
when the client and the document disagree, so an operation cannot exist in one and
not the other.

## Using it

### Call the API

Everything is under `/api/v1`, with the generated reference in
`packages/api/openapi.json`, which counts its own paths and operations when it is
written, and the TypeScript SDK generated from it. A session or an app token
authenticates; the permissions each route needs are in the spec.

### The open routes

A few routes take no session at all, because a stranger's browser calls them:
the booking widget's three, the portal's link routes (M05), the unsubscribe
page (M19), and since the website snippet and hosted forms (M19) these:
`POST /v1/public/touches`, `GET /v1/public/dni`,
`GET /v1/public/hosted-forms/{key}` and `POST /v1/public/forms/{formSlug}`.
Each resolves the company from a public key (its slug, or a form's own key),
returns nothing about anybody, and the website and form routes count their
callers per key and per address and answer 429 with `Retry-After` past a
ceiling. Two more are for a third party with no credential yet: an app asking to
be installed and coming back for its credential (below), both counted per address.
The open routes, and only they, answer a browser's preflight and mark
their answers readable from any origin, which is safe because they read no
cookie and hold no session for another page to borrow.

### Register a webhook

`POST /v1/webhooks/endpoints` registers one and returns the signing secret once.
`GET /v1/webhooks/endpoints` lists them without it,
`PATCH /v1/webhooks/endpoints/{id}` changes the subscription,
`DELETE /v1/webhooks/endpoints/{id}` removes it,
`GET /v1/webhooks/events` is the catalogue of what can be subscribed to, and
`GET /v1/webhooks/endpoints/{id}/position` says how far behind the log an endpoint is.

### See what was sent, and send it again

`GET /v1/webhooks/endpoints/{id}/deliveries` is one endpoint's attempts, newest
first, filtered by `status` (delivered, refused, unreachable) or by `eventId`.
`GET /v1/webhooks/deliveries?eventId=` is every attempt to deliver one event, to every
endpoint. `POST /v1/webhooks/endpoints/{id}/replays` sends one `deliveryId`, one
`eventId`, or everything from `fromSequence` (to `throughSequence`) again, and
`GET /v1/webhooks/endpoints/{id}/replays` says how far each replay has got.
Settings > Webhooks (`/settings/webhooks`) registers endpoints, switches them on and
off, and shows the history with a filter by what happened and a send again button on
every attempt.

### Rotate a signing secret

`POST /v1/webhooks/endpoints/{id}/secret` makes a new secret and returns it once, with
`overlapHours` (0 to 168, 24 unless you say) for how long the old one also signs.
Settings > Webhooks has the same as **Make a new secret** under each endpoint, and the
endpoint list says until when the old secret still signs. A receiver must treat
`x-otos-signature` as a comma separated list and accept the delivery when any one
matches; outside an overlap it holds exactly one, as it always has.

### Be an app

`GET /v1/apps/me` tells a connected application what it is and what it holds. It
takes no permission because the token is the identity.

### Ask to be installed

An app with no credential posts what it wants to `POST /v1/public/app-requests`,
naming the company by its public slug: its name, who makes it, a description in its
own words, the permissions it needs and the record scope on each resource, and
optionally an https `redirectUri` and a `state`. The answer carries `decisionUrl`,
the page to send somebody at the company to, and `claimSecret`, shown once.

The page is `/settings/apps/requests/{id}`, and the Applications screen lists every
request waiting. It shows each permission in plain words, marks the ones that expose
money and the ones the person looking does not hold, and offers **Approve** and
**Refuse** (with a reason the app is told). Nobody can approve what they do not hold
themselves, and a request cannot be edited before it is answered. After the decision
the person is offered a link back to the app's `redirectUri` with `request`, `status`
and `state` added.

The app then calls `POST /v1/public/app-requests/{id}/claim` with its claim secret:
`pending` until somebody decides, `refused` or `expired` for no, and `approved` with
the token, once. A second collection answers `claimed` and hands nothing over. A
request nobody answers expires after seven days, a company holds at most twenty
waiting, and both routes are counted per network address. The operator side is on
the API too: `GET /v1/apps/{id}/request`, `POST /v1/apps/{id}/approve` and
`POST /v1/apps/{id}/refuse`.

### Use the TypeScript SDK

`packages/sdk` is a typed client for every operation, generated from
`packages/api/openapi.json` by `pnpm --filter @opentradesos/api run openapi`. It
authenticates with an app token, puts an idempotency key on every write that takes
one (made per call and reused on its own retries), retries a dropped connection, a
429 or a 5xx only where that is safe, pages a list with `paginate`, dry runs a bulk
change with `dryRun`, and raises the server's own refusal with its field issues.
`verifyWebhook` checks a delivery's signature and timestamp with Web Crypto, and
accepts either secret during a rotation. Its README says how.

### Talk to it as an agent

`/api/mcp` offers every signed in, non internal route as a tool, filtered by what the
caller holds. M28 is that module.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Registers webhooks, installs and revokes apps |
| Everybody else | Nothing: `integration:read` is not on the other presets |

There is no API key permission, and the catalogue explains the decision at length: a
token belongs to a connected app with its own permission list, its own audit
attribution and its own revocation, so "who may call us" is answerable without
anybody holding a string equivalent to a password that belongs to nobody in
particular.

## API

| Call | Needs |
|---|---|
| `GET /v1/webhooks/endpoints` | `integration:read` |
| `POST /v1/webhooks/endpoints` | `integration:write` |
| `PATCH /v1/webhooks/endpoints/{id}` | `integration:write` |
| `DELETE /v1/webhooks/endpoints/{id}` | `integration:write` |
| `GET /v1/webhooks/events` | `integration:read` |
| `GET /v1/webhooks/endpoints/{id}/position` | `integration:read` |
| `GET /v1/webhooks/endpoints/{id}/deliveries` | `integration:read` |
| `GET /v1/webhooks/deliveries` | `integration:read` |
| `POST /v1/webhooks/endpoints/{id}/replays` | `integration:write` |
| `GET /v1/webhooks/endpoints/{id}/replays` | `integration:read` |
| `POST /v1/webhooks/endpoints/{id}/secret` | `integration:write` |
| `GET /v1/apps/me` | nothing: the token is the identity |
| `POST /v1/public/app-requests` | nothing: counted per address, at most twenty waiting per company |
| `POST /v1/public/app-requests/{id}/claim` | nothing: the claim secret is the proof |
| `GET /v1/apps/{id}/request` | `settings:read` |
| `POST /v1/apps/{id}/approve` | `integration:write`, and holding everything it asks for |
| `POST /v1/apps/{id}/refuse` | `integration:write` |
| `POST /v1/public/touches` | nothing: counted per company, address and visitor |
| `GET /v1/public/dni` | nothing: counted per company and address |

## Common questions

**Is the API versioned?** The path carries `v1`. A breaking change gets a new path
rather than a flag.

**How does a caller page a long list?** Keyset cursors on a stable sort, never an
offset, so a company writing while somebody pages does not lose a row. Where the
obvious sort key is not unique the cursor carries a tie break, because a migration
loads hundreds of rows dated the same day.

**Can an integration be idempotent?** Yes. Every create takes an `externalRef` and
every list can look one up, which is what makes a migration and a two way sync safe
to retry.

## What is not built

The SDK is TypeScript only, and it is not published to a package registry: it is
used from this repository, and its package is marked private until the licensing
exception in `docs/project/licensing-and-hosting.md` is settled. There is no client
in any other language; the OpenAPI document is what a generator for one is pointed
at.

An approval is all or nothing: the person deciding cannot approve part of what an app
asked for, and an app asking for something they do not hold has to ask again for
less, or be approved by somebody who holds it. A request's claim secret cannot be
handed out again, so a retried request leaves a second request waiting rather than
returning the first. A request does not notify anybody by email or text; the app
sends the person to the page, and the Applications screen lists what is waiting.

Delivery history is kept for thirty days and a thousand attempts per endpoint and
not longer; an older answer is gone. A replay cannot reach further back than the
event log does, covers only the events the endpoint subscribes to now, and cannot be
cancelled once queued. A receiver that compares the whole signature header against
one value refuses deliveries for the length of a rotation's overlap.
