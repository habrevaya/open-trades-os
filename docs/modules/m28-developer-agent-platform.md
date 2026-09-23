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

## Setup

1. Install a connected application (Settings, then Connected apps) and grant it
   the permissions it needs. You cannot grant a permission you do not hold
   yourself; the check is the same one that governs defining a role.
2. Issue a token. It is shown once and stored only as a hash, so a support
   engineer cannot read it back out of a table. `expires_at` is required: a
   partner holding a permanent credential is a permanent liability on both
   sides, and an expiry that has to be opted into is one nobody sets.
3. Point the client at `https://your-instance/api/mcp` with
   `Authorization: Bearer ots_...`.

A signed-in browser session works too, which is what makes the endpoint usable
from a client running on the same machine as the app.

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

The underlying routes are the same ones in the OpenAPI document at
`packages/api/openapi.json`, generated from the contracts.

## Common questions

**Can an agent do something I cannot?** No. Every call goes through the same
dispatcher, the same permission check and the same row level security your own
requests do.

**Why is a tool missing from my list?** You do not hold its permissions. Call
it anyway and the refusal will name what to ask for.

**Can I connect over stdio?** Not yet. HTTP only.

**Does it support OAuth?** Not yet. Bearer tokens from a connected application,
or a browser session.

**Can an agent add a custom field or edit a workflow rule?** Not yet. Those
routes exist in the product but the tools for them are part of the unfinished
half of this module.

## What is not built

Stdio transport. OAuth for remote clients. Tools for defining custom fields and
objects. Tools for editing workflow rules. A dry-run mode on bulk operations. A
sandbox tenant. The plugin APIs for custom job workflows, pricing rules and
report types.
