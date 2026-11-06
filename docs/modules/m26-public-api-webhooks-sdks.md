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
per endpoint, to thirty days and a thousand attempts, whichever cuts first, or to what
the company chose instead (between a day and a year, and between a hundred and ten
thousand attempts), so a receiver answering every retry with a megabyte of HTML
cannot grow it without bound.

**A replay is a second copy of history, not a rewind.** One delivery, one event, or
everything an endpoint subscribes to from a point in the log can be sent again. It is
queued and the worker sends it in order after the endpoint's live deliveries, signed
afresh (an old signature would fail the receiver's skew check, which is the point of
it) and carrying the same `x-otos-delivery` header as the original, so a receiver
deduplicating on it is never made to process an event twice; `x-otos-replay` names
the replay. The range is fixed when it is asked for, at most five thousand events,
and the endpoint's own position does not move. A replay that keeps failing backs off
and gives up on its own count, and never switches the live stream off. Asking again
for a replay that is still waiting returns it rather than queuing a second. A
replay still waiting can be stopped: nothing more of it is sent, what already went
stays sent, and the record keeps how far it got. The worker reads the replay again
before every event, so a stop that lands while one is under way takes effect at
the next event. The
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
own words and approves all of that list or part of it, through the same authority
check as an install by hand, or refuses it. Part of it, never more: a permission the
app did not ask for cannot be added. Only then can the app collect its credential,
once, with a claim secret that only it holds, and the token carries what was given
and nothing that was left out.

**A retry finds the first request.** An app may choose its own claim secret when it
asks, and a request sent again with the same secret is answered with the first one,
as it stands, rather than leaving a second waiting. The secret is the proof that
the retry is the same app; the same secret on a request asking for something else
is refused.

**Somebody is told.** When a request arrives, everybody in the company who could
approve it (holding `integration:write`) is emailed the app's name and the page to
decide on, through the company's own email provider. With no provider connected
nothing is sent and the request still waits on the Applications screen. A
notice on the bell, the phone and a text goes either way, as each of them chose
(M34).

**A request nobody answers is chased once.** The first telling is the one that
gets buried, and a request waits up to seven days. After a number of days the
company sets, the same people are told once more, through the same path: the
notice on the bell, the phone and a text as each of them chose, and the email when
the company sends email. The notice says "{App} is still waiting for an answer"
and how many days ago it asked, and names no more than the first did. The days are
on **Applications** under "Reminders for waiting requests", whole days from 1 to 6
(a request ends on the seventh), counted in the company's calendar days from the day
the app asked, and three until the company says otherwise; empty means no reminder.
`GET /v1/app-request-reminder` reads it (`settings:read`) and
`PATCH /v1/app-request-reminder` sets it (`integration:write`, the permission that
approves); both are on the audit log as `organization.app_request_reminder_set`
with what it was. A request is reminded at most once: `connected_app.reminded_at`
is set by an update that only lands on a request that has none, in the transaction
that tells them, and the reminder carries a notice key of its own, so a pass cut
short and run again, or two workers at once, remind once (`app.request_reminded` is
on the audit log). Only a request still waiting is reminded: one answered either
way, or ended, is not. Lowering the number reminds a request already past it on the
next pass, once. The worker asks the database which companies could have one due
(`app.app_request_reminder_organizations`, which skips a suspended company), at
most once a minute.

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

### Retry without doing it twice

A route that declares itself idempotent takes an `Idempotency-Key` header, and
the reference marks the header on exactly those routes, whoever may call them.
Repeat the same key and the request is not done twice: the first answer comes
back, or the state the first one set. The key is a header and never a body field,
because a client that rebuilds its body on a retry would rebuild a key inside it.

A session route gets the key on its context and the service keeps the first
answer against it. A route with no session (the portal's link and sign in routes,
the booking widget, the hosted forms, the website chat) gets it too
(`src/http/dispatch.ts` hands it to every route), and its service matches it only
with what that caller already holds: a form submission on that form, a chat
message on that chat, a sign in code for that address, a booking for that
customer. A key a stranger guesses never returns somebody else's answer. The rest
of the open idempotent routes set a state (unsubscribe, approve or decline an
estimate or a change order, close a chat, turn autopay on), so doing one twice
changes nothing; each route's description says which it is.

Three portal routes that touch a card are not idempotent and do not take the
key: Pay on an invoice link (`POST /v1/portal/invoice/pay`) and on a signed in
account (`POST /v1/portal/account/pay`) each start a fresh payment the customer
confirms in the browser, so a repeat leaves the earlier one unconfirmed and
nothing is charged twice; and paying with a saved card
(`POST /v1/portal/cards/{cardId}/pay`) charges on the spot, so a repeat before
the processor's webhook lands is a second charge. The SDK only repeats a route
that takes a key, so it never repeats these.

`idempotency-open-routes.integration.test.ts` posts a public form twice with one
key and declines an estimate twice from its link, through the dispatcher, and
checks the reference marks the header on every idempotent route and no other.

### Read an answer as it is written

A route that answers with something a model writes can send it as it is
written. `POST /v1/ai/field-assistant` does, and so does the open route
`POST /v1/public/chat/messages` that the website chat sends through, where the
last event is the chat's transcript. Sent with
`Accept: text/event-stream`, it answers as Server-Sent Events instead of one
JSON body. Without that header it answers JSON exactly as before, so nothing
written against it changes. The OpenAPI document marks such a route
`x-streams` and lists `text/event-stream` beside its JSON answer.

The events come in this order. `writing` carries `{ "text": ... }`, the answer
so far: whole sentences, each held to the same price check the whole answer is,
sent whole each time it grows. `answer` carries exactly the JSON the route
answers without a stream, after every check, and takes the place of what was
shown; it can say the answer cannot be shown. `problem` carries
`{ "error", "status" }` for a refusal that came after the first event. A comment
line keeps a quiet stream open every fifteen seconds.

It is the same route with the same session, the same permissions and the same
limits (for the chat, the same counts per address and per chat), because the same
service runs. A refusal before the first event (signed
out, not allowed, the assistant off, the day's runs used up) is the ordinary
status and JSON body, since nothing has been sent yet. A retry with the same
idempotency key answers from the record as one `answer` event. A caller that
drops the connection does not stop the answer: it is written and kept, and the
retry reads it.

**Event ids and resuming.** Every `writing` event carries an `id`: how many
characters long the answer so far is (`id: 23`), and `answer` carries the id
`answer`. A request sending `Last-Event-ID` is not sent a `writing` event it
already has (one no longer than the id), and goes on from there. A resume with the
same idempotency key while the first answer is still being written joins it rather
than asking the model again: the key's record is marked in progress (`in_flight`)
before the model is asked, the answer so far is written onto it (for the chat, onto
the chat) as each sentence is finished, and the second request is sent the
sentences after its id as they are written, then the same whole answer, read from
the record. The model is asked once and paid once. A first request that failed
leaves its mark failed, so a retry asks again; a mark nobody has written to for two
minutes is a request that died and is taken over by the next one, which asks again;
a request that waits three minutes on another's answer is told it is still being
answered, in words. The chat's mark is the same one that makes a double tap one
message: a resume of the chat's message joins its reply, and the visitor's words and
the reply are each kept once. `Last-Event-ID` is allowed from any origin on the open
routes, beside `idempotency-key`.

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
`GET /v1/webhooks/endpoints/{id}/replays` says how far each replay has got, and
`POST /v1/webhooks/endpoints/{id}/replays/{replayId}/cancel` stops one still waiting.
Settings > Webhooks (`/settings/webhooks`) registers endpoints, switches them on and
off, and shows the history with a filter by what happened and a send again button on
every attempt, and a **Stop it** button on every replay still waiting.

How long the history is kept is the company's choice: "How long we keep what was
sent" on the same page, or `GET /v1/webhooks/history` (`integration:read`) and
`PUT /v1/webhooks/history` (`integration:write`) with `keepDays` (1 to 365) and
`keepPerEndpoint` (100 to 10000). Thirty days and a thousand attempts, as before,
for a company that chose nothing. Whichever cuts first wins; the next delivery pass
trims to it, and keeping less never brings back what was removed. Every change is
audited (`organization.webhook_history_kept`).

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
optionally an https `redirectUri`, a `state` and its own `claimSecret` (32 to 200
random letters, digits, `-` or `_`). The answer carries `decisionUrl`, the page to
send somebody at the company to, and `claimSecret`, shown once when the server made
it. Sent again with the same `claimSecret`, the answer is the first request with
`repeated: true` and its status now; the same secret asking for something else is
refused. The people who can approve are emailed the page when the company has an
email provider connected.

The page is `/settings/apps/requests/{id}`, and the Applications screen lists every
request waiting. It shows each permission in plain words, marks the ones that expose
money and the ones the person looking does not hold, and offers **Approve** and
**Refuse** (with a reason the app is told). Approve has a box for every permission
asked for, ticked when the person holds it; unticking one leaves it out, and one
they do not hold cannot be ticked, because nobody can give what they do not hold.
Once approved, the page marks what was left out. A request's list cannot be edited
before it is answered. After the decision
the person is offered a link back to the app's `redirectUri` with `request`, `status`
and `state` added.

The app then calls `POST /v1/public/app-requests/{id}/claim` with its claim secret:
`pending` until somebody decides, `refused` or `expired` for no, and `approved` with
the token, once, beside `permissions` (what the token may do) and `withheld` (what
was asked for and left out). A second collection answers `claimed` and hands nothing over. A
request nobody answers expires after seven days, a company holds at most twenty
waiting, and both routes are counted per network address. The operator side is on
the API too: `GET /v1/apps/{id}/request` (with `leftOut` once approved),
`POST /v1/apps/{id}/approve` (with `permissions` for part of the list) and
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

`events(operation, input, options)` reads an answer as it is written, for the two
operations that stream (`askFieldAssistant`, `sayInChat`; the generated
`StreamingOperationId` names them, and any other is refused). It is an async
iterator: each `writing` event, then the `answer`, after which it ends; a `problem`
is thrown as the same `OpenTradesOSError` a refusal is. A dropped connection, a
stream that ends before its answer, a 429 or a 5xx is asked again after a pause
(half a second, doubling, capped at ten seconds, or the server's `Retry-After` or
`retry`), with the same idempotency key and `Last-Event-ID` set to the last id the
server sent, up to `maxReconnects` (5) times in a row. The server's ids say how much
of the answer it had, so a resume while the answer is still being written joins it
and is sent only the sentences after the id; its behaviour did not otherwise change. It asks again only for an
operation that takes an idempotency key. Both that stream take one, and for the
website chat's message the same key is one message and one answer, so a resume
joins the reply rather than sending the visitor's words again; a drop on an
operation without a key is thrown. An abort `signal` stops it at
once, mid stream or mid pause, and closes the connection, as leaving the loop early
does. `lastEventId` with your own `idempotencyKey` resumes a stream another process
was reading. A server that answers JSON instead is read as one `answer`. The parser
follows the event stream format itself (any line ending, comments, several data
lines, ids that outlast their event), and is tested against a fake server writing
with the API's own `eventText`.

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
| `GET /v1/webhooks/history` | `integration:read` |
| `PUT /v1/webhooks/history` | `integration:write` |
| `GET /v1/webhooks/endpoints/{id}/deliveries` | `integration:read` |
| `GET /v1/webhooks/deliveries` | `integration:read` |
| `POST /v1/webhooks/endpoints/{id}/replays` | `integration:write` |
| `GET /v1/webhooks/endpoints/{id}/replays` | `integration:read` |
| `POST /v1/webhooks/endpoints/{id}/replays/{replayId}/cancel` | `integration:write` |
| `POST /v1/webhooks/endpoints/{id}/secret` | `integration:write` |
| `GET /v1/apps/me` | nothing: the token is the identity |
| `POST /v1/public/app-requests` | nothing: counted per address, at most twenty waiting per company |
| `POST /v1/public/app-requests/{id}/claim` | nothing: the claim secret is the proof |
| `GET /v1/apps/{id}/request` | `settings:read` |
| `GET /v1/app-request-reminder` | `settings:read` |
| `PATCH /v1/app-request-reminder` | `integration:write` |
| `POST /v1/apps/{id}/approve` | `integration:write`, and holding everything it is given |
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

Only the field assistant and the website chat's messages answer as they are
written; every other route answers whole. Joining reads the record about
every half second, so a joined stream can be a sentence behind the first, and a
first answer given as JSON (not a stream) writes no sentences onto the record, so a
stream joining it waits for the whole answer. A resume that reaches a different
server while the first is still answering joins it the same way, through the
database, not the first server's memory. A sentence is sent only once it is
finished, so a long first sentence arrives late, and on a model connection that does
not stream (see M27) the stream holds only the `answer` event.

Paying from the portal is not repeatable with a key (above). Paying with a saved
card twice before the processor's webhook arrives charges the card twice, whatever
key the two requests carry: the processor is asked with each attempt's own id.
Making a repeat return the first charge means the payment record keeping one
attempt per key, which is a change to how every card payment is recorded, and it
is not made here.

The SDK is TypeScript only, and it is not published to a package registry: it is
used from this repository, and its package is marked private until the licensing
exception in `docs/project/licensing-and-hosting.md` is settled. There is no client
in any other language; the OpenAPI document is what a generator for one is pointed
at.

An approval can leave permissions out but cannot narrow the record reach the app
asked for: a reach wider than the approver's own blocks the approval, and the app
has to ask again for less. A retry finds the first request only when the app chose
its own claim secret; one the server made is shown once and cannot be handed out
again, so a retry without one leaves a second request waiting. The notice of a
request is an email, only to people who can approve and only when an email provider
is connected, and a notice (M34) on the bell, the phone app or a text as each of those
people chose, whether or not email is connected. Each approver is told twice at
most, once when it asks and once as a reminder, and a request nobody answers still ends on
its own date; the reminder is one number for the whole company, is not sent
at all by a company that left it empty, and never repeats.

Delivery history is kept for as long as the company chose, between a day and a
year and between a hundred and ten thousand attempts per endpoint, thirty days and
a thousand unless it chose otherwise; one setting covers every endpoint, an older
answer is gone, and keeping more only keeps what was still there. A replay cannot reach further back than the
event log does, and covers only the events the endpoint subscribes to now. A stopped
replay cannot be started again where it stopped: asking again queues a new one. A receiver that compares the whole signature header against
one value refuses deliveries for the length of a rotation's overlap.
