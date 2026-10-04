---
title: Developer and Agent Platform
module: M28
domain: Platform
phase: 7
status: partial
---

# Developer and Agent Platform

> Module M28. Domain: Platform. Partly built.

## What it does

Point an MCP client at your instance and it can do what you can do. Not a
curated set of AI features somebody chose for you: the product's own API,
offered as tools, with the same permissions your account carries. If you can
book a job on the screen, an agent connected as you can book a job. If you
cannot void an invoice, neither can it, and it will tell you which permission
to ask for.

There is nothing here that is not already in the API. That is the point. The
tools are generated from the same route definitions the web app and the HTTP
API are built from, so there is no version of this system where the tool an
agent calls and the endpoint a developer calls have drifted apart.

## Key concepts

**The tools are generated, never curated.** `packages/api/src/contracts` holds
every route in the product. The MCP server walks that registry and produces a
tool for each one. A hand-maintained tool list is a second description of the
product: it starts correct and ends as the reason an agent calls an endpoint
that was renamed six months ago.

**One gate, not two.** A tool call is turned into a `Request` and handed to the
same dispatcher an HTTP client reaches. Nothing in the MCP layer touches a
service or the database. A permission is therefore checked in exactly one
place, and an agent can reach nothing a person holding the same credential
could not. The alternative, a second call path into the handlers, means two
places a permission is checked, and the second one written is the one that
eventually forgets.

**Listing is narrower than enforcement, never wider.** You are shown the tools
your permissions allow. This is about attention rather than security: a model
handed ninety tools of which it may call thirty will spend its reasoning
discovering that by failing, in front of somebody waiting for an answer, and
will often report the refusal as though the underlying fact were unavailable
rather than the permission missing. The dispatcher checks again regardless, so
if the two ever disagreed you would get a refusal rather than a hole.

**An agent that retries must not pay twice.** An agent whose call times out
calls the tool again with the same arguments. So on a route that creates a
record or moves money, the idempotency key is a tool ARGUMENT named
`idempotencyKey`, and it is required. Send the same value on a retry and the
second call returns the first call's result. If the server minted a key per
invocation instead, every retry would be a distinct intent, which on a payment
route is a second charge whose only record is a customer's card statement.

**A refusal is a result, not a broken connection.** MCP distinguishes a
protocol error from a tool error, and clients treat them very differently. A
protocol error reaches the person as a failing server. A tool error goes back
to the model. "You do not hold `deposit:refund`" is something a model can act on:
it can tell you what to ask an administrator for. Sent as a transport failure
it becomes "the OpenTradesOS server is down", which is both wrong and
unactionable.

**A change can be tried first.** The tools that change many records at once
(renaming or merging a customer tag, moving jobs between branches, setting tax on
many items, a price change, a supplier catalogue, loading a spreadsheet of a
company's own records) take `dryRun`, and so do the tools that change how the
company is set up: defining, changing and retiring a custom field or a kind of
record, writing, publishing and deleting a workflow, and copying settings back from
a sandbox. Sent as
true, the route runs exactly as it would, inside a transaction that is then
rolled back, and the answer is what it would have returned, the rows it would
have written per table, and the audit lines naming each record. It is the route
itself rather than a prediction of it, so the preview cannot drift from what the
real call does. Only routes that write nothing outside the database offer it: a
rollback cannot take back a text or a card charge, and asking any other route
for a dry run is refused rather than run for real.

## Setup

There are three ways to connect, and all three end at the same endpoint with
the same permission checks.

**A hosted assistant, with OAuth.** Point the client at
`https://your-instance/api/mcp` and nothing else. It is answered with a 401 whose
`WWW-Authenticate` header names `/.well-known/oauth-protected-resource`; from
there the client finds `/.well-known/oauth-authorization-server`, registers
itself at `/api/oauth/register`, and sends you to `/oauth/authorize`. That page
says who is asking and what it could do, every permission in plain words, and
you approve or refuse. Approving makes it a connected app under Settings,
Applications, which is also where you turn it off.

**A desktop client, with an app token.** Install a connected application under
Settings, Applications, grant it what it needs, and issue a token (shown once,
stored only as a hash, always with an expiry). Then give the client a command:

    OPENTRADESOS_URL=https://your-instance OPENTRADESOS_TOKEN=ots_... \
      node packages/sdk/bin/opentradesos-mcp.mjs

or, from a checkout, `npx ./packages/sdk` or `pnpm mcp:bridge` with the same two
variables. That is a stdio server with no dependencies that carries each message
to `/api/mcp` with the token; every protocol rule stays on the server.

**On the server itself, with an app token.** `pnpm --filter @opentradesos/api mcp`
with `OPENTRADESOS_TOKEN` and `DATABASE_URL` runs the same server over stdio
against the database directly, for a client on the machine the database is on.

A signed-in browser session works on the HTTP endpoint too, which is what makes
it usable from a client running on the same machine as the app.

### OAuth, in detail

Clients register themselves (RFC 7591), public by default: a client on somebody's
laptop has nowhere to keep a secret, so none is issued and PKCE with S256 stands in
for one, `plain` refused. A client that runs on its maker's own server can register
as confidential instead (`token_endpoint_auth_method` of `client_secret_basic` or
`client_secret_post`). It is handed a secret once, in the registration answer, and
only its hash is kept; from then on the token, revocation and introspection
endpoints refuse that client with a 401 unless it sends the secret, in the
`Authorization` header or in the form but not both. PKCE is required of it too,
because the secret proves which client is calling and PKCE proves the code was
asked for by the same one.
A code lives ten minutes, works once and is bound to the client, its redirect
address and the PKCE challenge. Presenting a code twice revokes everything the
first exchange produced. Access tokens are ordinary app tokens an hour long;
refresh tokens last thirty days unused and rotate on every use, and a refresh
token used twice revokes its whole family, because it means two parties hold it.

Scopes are permissions from the catalogue, or bundles of them with names a
person can read: `read` (everything you can see, nothing you can change),
`customers`, `jobs`, `dispatch`, `estimates`, `invoices`, `messages`, `tasks`
and `reports`. A client that names none asks for `read`. A bundle is cut down to
what the approver holds, and the consent page lists what was left out; an
unknown scope is refused rather than dropped. Every permission the page offers is
a ticked box, and the person can untick any of them: the app gets what is left,
and when that is less than was asked for the token answers with the permissions
themselves as its scope, so the client can see it got less. A permission the
page did not offer cannot be added by posting it, and nothing ticked is refused
(that is "Do not connect"). The assistant reaches the same records the approver
can, on every resource. Authorizing the same client again replaces its grant
rather than adding a second app.

A client can hand a token back at `/api/oauth/revoke` (RFC 7009): a refresh
token ends everything descended from the same approval, an access token ends
alone. The answer is the same 200 whether or not the token existed, and a token
another client holds is refused. `/api/oauth/introspect` (RFC 7662) tells a
client whether one of its own tokens is still live, with its scope and expiry;
anything else, another client's token included, is `active: false` and nothing
more. Neither ends the connected app, which stays under Settings, Applications
for the company to turn off. A registration no company has approved a week after
it was made is removed by the worker; one any company approved is kept.

## Using it

### Seeing what you can do

`tools/list` returns the tools your credential allows, each with its input
schema and a description that names the permissions it needs. An
unauthenticated list is empty rather than the full catalogue: otherwise anyone
who can reach the port could enumerate the product's surface, and which modules
a company runs, before presenting anything.

Tool names are the route name, lower-cased with underscores, prefixed `otos_`:
`otos_list_customers`, `otos_create_customer`, `otos_send_arrival_notice`. The
prefix is there because MCP names are flat and shared with every other server a
client has connected, and `list` and `create` from four servers at once is how
an agent books a job into somebody's calendar application.

### Calling one

Arguments match the route's input schema. Path parameters are ordinary
arguments and are lifted into the URL. A read carries its arguments in the
query string, a write in the body, because that is what the dispatcher parses.

Money is a decimal string, never a JSON number, everywhere in this API. A JSON
number is an IEEE 754 double and `0.1` does not survive a round trip. The tool
schemas say `string` for exactly this reason, and a test compares them against
the OpenAPI document to make sure both keep saying it.

### Retrying

If a call fails or times out, call it again with the same arguments. On a route
that takes `idempotencyKey`, sending the same value makes the second call a
no-op that returns the first call's result. Use a new value only when you mean
a genuinely new action.

## Permissions

There is no permission specific to this module. A tool requires exactly what
its route requires, so the matrix is the API's matrix.

| Role | Access |
|---|---|
| owner / admin | Every tool their permissions allow, which is most of them |
| manager / dispatcher / csr | The tools for their own work, filtered by role |
| technician | Reads and writes for their own day; no pricing, no refunds |
| accountant | Invoicing and ledger tools; no dispatch |

A connected application holds its own permission set, which cannot exceed the
set held by whoever approved it.

## API

The MCP endpoint is `POST /api/mcp`, speaking JSON-RPC. A `GET` answers 405
with an `Allow` header rather than 404, because this server has no
server-initiated event stream and a 404 would send somebody checking their URL.
A request with no usable credential answers 401 with the OAuth challenge, and
an expired or revoked token says `invalid_token` so the client refreshes.

OAuth lives beside it: `/.well-known/oauth-authorization-server`,
`/.well-known/oauth-protected-resource`, `POST /api/oauth/register`,
`/oauth/authorize`, `POST /api/oauth/token`, `POST /api/oauth/revoke` and
`POST /api/oauth/introspect`. Over HTTP a dry run is the
`x-otos-dry-run: true` header on a route the OpenAPI document marks
`x-dry-run`.

The underlying routes are the same ones in the OpenAPI document at
`packages/api/openapi.json`, generated from the contracts.

## Common questions

**Can an agent do something I cannot?** No. Every call goes through the same
dispatcher, the same permission check and the same row level security your own
requests do.

**Why is a tool missing from my list?** You do not hold its permissions. Call
it anyway and the refusal will name what to ask for.

**Can I connect over stdio?** Yes, two ways: the bridge in `packages/sdk` to a
hosted instance, or the server in `packages/api` beside the database. Both take
an app token.

**Does it support OAuth?** Yes, the authorization code flow with PKCE that the
MCP specification describes, for public clients and for confidential ones with a
secret, with revocation and introspection. See Setup.

**Can an agent see what a change would do first?** Yes, on the bulk tools and the
tools that change how the company is set up: send `dryRun: true`.

**Can an agent add a custom field or edit a workflow rule?** Yes, with the same
permissions as the screens. `otos_define_custom_field` and `otos_update_custom_field`
need `customfield:write`, as Settings, Custom fields does; `otos_define_custom_object`
defines a kind of record (a permit, an inspection) and its fields are then
`otos_define_custom_field` on `object:<key>`; `otos_get_workflow` reads a workflow's
trigger, conditions and steps with `workflow:read`, and `otos_create_workflow` and
`otos_publish_workflow` write and publish one with `workflow:write`, refused when it
names a step the person the agent acts for could not publish. Records of a company's
own kinds are `otos_list_custom_records` and `otos_create_custom_record`, under
`record:read` and `record:write`.

**Is there somewhere safe to try things?** Yes, a sandbox: a second company holding a
copy of this one's settings and none of its customers. `otos_create_sandbox` makes
one, `otos_get_sandbox_copy_plan` says what copying each setting back would do, and
`otos_copy_back_from_sandbox` copies the chosen ones, all or none, after a dry run if
asked. All three need `sandbox:manage`. M29 has what is copied and what is not.

## What is not built

The plugin APIs for custom job workflows, pricing rules and report types. An app
token belongs to one company, so an agent connected to the real company reaches its
sandbox only through the sandbox routes, and an agent working inside a sandbox needs a
token issued there.

OAuth introspection answers a client about its own tokens only; there is no
resource server here other than this instance, so nothing else is authorised to
ask about somebody else's. A confidential client's secret does not expire and
cannot be rotated: a client whose secret leaked registers again and is approved
again. Clients authenticate with a secret or not at all; signed JWT assertions
(`private_key_jwt`) and mutual TLS are not supported. A revoked token ends the
token, not the connection: the app stays active with nothing live until the
company turns it off or the client is approved again. The stdio
transports read their token once at start and check it on every message, so a
new token means restarting the client. A dry run is offered on seventeen bulk routes:
the bulk changes and the routes that change how the company is set up, and on no
route that sends a message or moves money.
