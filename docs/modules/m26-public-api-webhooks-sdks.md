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

**The timestamp is inside the signed payload, not merely alongside it.** A signature
over the body alone is valid forever: anybody who captures one delivery can replay it
later and the receiver cannot tell, because everything they check still matches.

**A signing secret is stored in plaintext and an app token is not, and the asymmetry
is the point.** A token is presented to us, so a one way hash is enough to check it. A
signing secret goes the other way: we hold it and have to reproduce a signature with
it on every delivery, which a hash cannot do. So the secret is returned exactly once,
at registration, and the single function that shapes a row for output does not read
that column, so a list, a read or an update cannot leak it even by accident.

## Using it

### Call the API

Everything is under `/api/v1`, with the generated reference in
`packages/api/openapi.json`: 341 paths and 413 operations. A session or an app token
authenticates; the permissions each route needs are in the spec.

### Register a webhook

`POST /v1/webhooks/endpoints` registers one and returns the signing secret once.
`GET /v1/webhooks/endpoints` lists them without it,
`PATCH /v1/webhooks/endpoints/{id}` changes the subscription,
`DELETE /v1/webhooks/endpoints/{id}` removes it,
`GET /v1/webhooks/events` is the catalogue of what can be subscribed to, and
`GET /v1/webhooks/endpoints/{id}/position` says how far behind the log an endpoint is.

### Be an app

`GET /v1/apps/me` tells a connected application what it is and what it holds. It
takes no permission because the token is the identity.

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
| `GET /v1/apps/me` | nothing: the token is the identity |

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

There is no SDK in any language, despite the module's name: what exists is the
OpenAPI document a generator can be pointed at.

More seriously, a connected app cannot be installed. The service has install,
update, revoke, token issue and token revoke, all guarded and tested, and none of
them has a route or a screen, so the only app route is the one an app calls to
describe itself. An owner cannot approve an app, issue it a token, see which apps
hold one or revoke one. `docs/concepts/connected-apps.md` describes this as the way a
third party integrates and that path is currently unreachable, which makes it the
largest single gap in this module.
