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

A connected application can also add to how the company runs, as data and
never as code: the stages a kind of work moves through, a rule that changes
prices, a report type in the report builder. The company sees each one under
the application that added it and turns all of it off by turning the
application off.

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

**A plugin is data an application registers, never code.** Nothing an
application sends is run on this server. It registers one of three closed
shapes through the API with its own token, core (`core/plugins`) checks it and
refuses it in words when it does not fit, and the services that act on it read
it back: a job workflow, a pricing rule, a report type. Only an application may
register one, so Settings, Applications can always say which application added
what, and only with the permission a person would need to make the same change
by hand (`settings:write` for how jobs move, `pricebook:write` for prices,
`report:build` for reports). It may only register what it could read itself: a
rule on customers' tags needs `customer:read`, a checklist gate `visit:read`, a
report whatever its columns need. An application holds nothing its installer
did not, so that is the installer's authority, asked again at registration.

**Versioned like an automation, and off with its application.** Registering a
key again is the next version, every version is kept, and the same thing sent
twice changes nothing, so a retry needs no state. Every registration and
removal is in the audit log. Whether a plugin is in force is a join on the
application's status on every read, so turning the application off turns
everything it added off at the same moment.

**The company can stop one plugin without stopping the application.** Somebody
holding `integration:write` turns a pricing rule, a job workflow or a report type
off on its own, and back on, from "What apps changed" under Settings. It is a flag
the company owns, kept apart from the application's own removal: the application
removes a plugin and can register it again, the company turns one off and only the
company turns it back on, so a new version from the application never undoes a
decision made at the company. Off means what it means for an application that is
off, for that one thing: a rule prices nothing from the next estimate or invoice
priced, a workflow stops gating moves and stops showing its stages, a report type is
not offered. Nothing already priced or moved is changed. It is read at the one place
"in force" is decided, so every use of a plugin leaves it out at the same moment.

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

A confidential client rotates its own secret at `POST /api/oauth/client-secret`,
proving itself with the current secret (either way it may send one) and
optionally `overlap_seconds`, from 0 to 86400, an hour unless it says. The answer
carries the new `client_secret`, shown once and kept only as a hash, and
`previous_secret_expires_at`: until then the old secret works too, at every
endpoint, so the maker can roll the new one out to each of its servers. Nought
ends the old one at once, which is the answer when it leaked. Only the current
secret can rotate, never the one in its overlap, so a leaked old secret cannot be
used to keep a working one; a second rotation during an overlap retires the
oldest, so two at most ever work. Every company that has connected the client
gets `app.oauth_secret_rotated` in its audit log, naming the client and when the
old secret stops, and never the secret. A company's administrator cannot rotate
it: the secret lives on the client maker's server, not with any one company.
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
more. Introspection never ends the connected app. Revocation does when the client
adds `end_connection=true`: the app is turned off as well, with every token and
refresh token it holds, and Settings, Applications says the application
disconnected itself (`app.revoked` in the audit log); a retry finds it already off
and succeeds. Without it the app stays under Settings, Applications, with nothing
live, for the company to turn off. A registration no company has approved a week after
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

### Adding to how the company runs

An application acting with its own token registers these with
`POST /v1/plugins/job-workflows`, `POST /v1/plugins/pricing-rules` and
`POST /v1/plugins/report-types`, each under a key of its own; registering the
key again is the next version. `DELETE /v1/plugins/job-workflows/{key}`,
`DELETE /v1/plugins/pricing-rules/{key}` and `DELETE /v1/plugins/report-types/{key}`
remove one (kept as a record, never in force again until registered again), and
`GET /v1/plugins` lists what the application registered. A person signed in
calling any of them gets a 404, as on `GET /v1/apps/me`: there is no
application behind a session. As tools they are `otos_register_job_workflow`,
`otos_register_pricing_rule` and `otos_register_report_type`.

**A job workflow** is for one job type: named stages in order, every one of the
nine job statuses in exactly one stage, and gates a job has to meet before it
leaves a stage, either an item of the job type's checklist ticked on one of its
visits not cancelled, or one of the company's job fields filled in. Moving a
job forward past a gate not met, whether from the job page or with
`PATCH /v1/jobs/{id}`, is refused in a sentence naming every gate left ("This
job cannot leave "Survey" yet: fill in "Permit number" on the job."), counting
the fields the same save fills in. A move that skips a stage is held to that
stage's gates too. Moving back, inside a stage or to cancelled is never held,
and neither is a move the product makes because something happened (a visit
booked, the last visit finished, an invoice issued, paid or voided). The job
page shows the stages, which one the job is at and each gate met or waiting,
`GET /v1/jobs/{id}/stages` says the same, and each card on the board at
`/schedule` names its job's stage. One workflow per job type: another
application's is refused while its application is on, and replaced once it is
off. A sandbox copies the workflows in force, each standing on its own there,
because a sandbox has no applications.

**A pricing rule** is one of four kinds: a percentage or an amount for customers
carrying a tag, for a job type, or for work booked in a time window (days and
hours, or outside the company's own hours, counted from the start of the job's
first visit window as the after hours rate is), or a minimum charge. A window's
`days` are the days it STARTS on, and a `to` earlier than its `from` runs past
midnight into the next day, so `{ days: [1, 2], from: "18:00", to: "06:00" }` is
one rule: Monday evening until Tuesday at six in the morning, and Tuesday evening
until Wednesday at six. Work at three on Tuesday morning is inside it because the
window that holds it started on Monday, a listed day; work at three on Monday
morning is not, unless Sunday is listed, and a Saturday night runs into Sunday
morning. "18:00" to "24:00" and to "00:00" are both the evening to midnight. The
times are the wall clock in the company's zone, so a night with a clock change in
it is still six in the evening to six in the morning on the clock. A window that
starts and ends at the same minute is refused, and so is one that starts at "24:00"
(start it at "00:00"). The sentence on Settings, Applications reads such a rule as
"50% added for work from 18:00 on Mon, Tue until 06:00 the next day". The rule is
core's `inWindow`, with unit tests, so the invoice, the estimate and the screens
cannot count differently. Rules are
applied when an estimate or an invoice is priced, after member pricing and
before tax, to the lines priced from the company's own price book, in an order
core decides and tests: every percentage taken from the price after member
pricing (so two give the same in either order), then amounts spread over the
lines by what each comes to, never below nothing, then the largest minimum that
applies. Money taken off goes into the line's discount, as a member's does;
money added raises the line's unit price. Each line a rule touched records the
rule, its application, its version and the amount, the estimate and invoice
pages show it on the line, and the invoice made from an estimate carries it
with the price.

**A report type** is a cut of one of the report builder's datasets (a key from
`GET /v1/report-datasets`): the columns it offers to group by, the numbers it
offers, and filters it always carries. It appears in the report builder and on
dashboards as a dataset of its own, keyed `app_` and its key, reading the same
records its base does with the same scope, and whoever runs it needs exactly
what its base, columns and filters need.

**On Settings, Applications** (`/settings/apps`), each application lists what it
added: what kind, its name, what it does in a sentence, its version, and
whether it is on, turned off by the company, removed by the application, or off
because the application is turned off. `GET /v1/apps` carries the same under
each application.

**On "What apps changed"** (`/settings/apps/added`), everything every application
added is listed under what it is (pricing rules, job stages, report types) with the
application it came from, what it does, its version and its state. Somebody with
`integration:write` sees a "Turn off" button on each row that is on, with a box for
why that nobody has to fill, and a "Turn on" button on each the company turned off;
the row then says who turned it off, when and why. Somebody with `integration:read`
and no more sees the list without the buttons. A plugin its application removed
cannot be turned on (only the application can register it again), and one that is off
because its application is off is shown as that, with no button. `GET /v1/app-plugins`
lists the same, `POST /v1/app-plugins/{id}/turn-off` (with an optional `reason`) and
`POST /v1/app-plugins/{id}/turn-on` switch one, and every switch is in the audit log
(`plugin.turned_off`, `plugin.turned_on`) with who and why. Switching one already in the
state asked for changes nothing and writes no line.

## Permissions

There is no permission specific to this module. A tool requires exactly what
its route requires, so the matrix is the API's matrix. Turning one plugin off or
on is `integration:write`, the permission that lets an application in and takes
it out, and seeing the list is `integration:read`; neither is something an
application can do to itself.

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
`/oauth/authorize`, `POST /api/oauth/token`, `POST /api/oauth/revoke`,
`POST /api/oauth/introspect` and `POST /api/oauth/client-secret`. Over HTTP a dry run is the
`x-otos-dry-run: true` header on a route the OpenAPI document marks
`x-dry-run`.

The underlying routes are the same ones in the OpenAPI document at
`packages/api/openapi.json`, generated from the contracts.

The plugin routes:

| Call | Needs |
|---|---|
| `GET /v1/plugins` | nothing: the application's token is the identity |
| `POST /v1/plugins/job-workflows` | `settings:write`, `job:read`, and `visit:read` for a checklist gate |
| `DELETE /v1/plugins/job-workflows/{key}` | `settings:write` |
| `POST /v1/plugins/pricing-rules` | `pricebook:write`, and `customer:read`, `job:read` or `visit:read` for what the rule asks about |
| `DELETE /v1/plugins/pricing-rules/{key}` | `pricebook:write` |
| `POST /v1/plugins/report-types` | `report:build`, and whatever its base, columns and filters need |
| `DELETE /v1/plugins/report-types/{key}` | `report:build` |
| `GET /v1/app-plugins` | `integration:read` |
| `POST /v1/app-plugins/{id}/turn-off` | `integration:write` |
| `POST /v1/app-plugins/{id}/turn-on` | `integration:write` |
| `GET /v1/jobs/{id}/stages` | `job:read` |
| `GET /v1/report-datasets` | `report:read` |

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

**Can an application change how jobs move or what things cost?** Yes, as data
it registers, never code: a job workflow, a pricing rule or a report type, each
checked by core, listed under the application on Settings, Applications and
turned off with it. See "Adding to how the company runs".

**Is there somewhere safe to try things?** Yes, a sandbox: a second company holding a
copy of this one's settings and none of its customers. `otos_create_sandbox` makes
one, `otos_get_sandbox_copy_plan` says what copying each setting back would do, and
`otos_copy_back_from_sandbox` copies the chosen ones, all or none, after a dry run if
asked. All three need `sandbox:manage`. M29 has what is copied and what is not.

## What is not built

Plugins are three closed shapes and nothing else. A pricing rule cannot be a
callback to the application's own server ("ask my app for a price
adjustment"): calling out from inside the transaction that prices an invoice
would hold the invoice on a stranger's server, and doing it properly needs the
call made before that transaction and a per application signing secret read
through the company's secret store, which is not built. Rules touch only lines
priced from the company's own price book, never a typed price, a contract's
rate card or history; they are not applied on a job somebody other than the
customer covers (the coverage decides the customer's part), on a job billed in
parts, or on an estimate or invoice a technician's phone priced, whose figure
the customer has already seen. Money a rule adds raises the line's unit price
(revenue) and money it takes off is a discount, the conservative reading until
an accountant says otherwise. A time window may run past midnight, but no
further than the next morning (it is a start time and an end time, not a length:
there is no "for thirty hours"), it is named by the day it starts on, and there
is no screen to write one: an application registers it with its own token, as it
registers every rule, and the company reads it back in a sentence under the
application. Only the largest minimum charge counts. Editing a draft invoice prices it again: a
line billing work recorded on the job is sent back as the price before the
rules and priced as typed, so a rule does not touch it a second time. A gate is
a checklist item or a job field, only one workflow can be in force per job
type, a stage is a name over the existing statuses and never a new status, and
nobody at the company can write stages, a rule or a report type on a screen: they
come from an application, and the company's control is to turn that application off
or one plugin of it. A plugin the company turned off stays registered, so a workflow
turned off still holds its job type and another application's workflow for it is
refused until its own application removes it; a report saved on a report type turned
off does not run until it is on again; and a sandbox does not copy a workflow that is
turned off. A report type is a cut of
one dataset, without joins of its own, cannot be cut from another application's
type, and cannot be sent to a customer by an automation. Pricing rules and
report types are not copied into a sandbox, and nothing an application
registered is offered for copying back.

An app token belongs to one company, so an agent connected to the real company reaches its
sandbox only through the sandbox routes, and an agent working inside a sandbox needs a
token issued there.

OAuth introspection answers a client about its own tokens only; there is no
resource server here other than this instance, so nothing else is authorised to
ask about somebody else's. A confidential client's secret does not expire on its
own; it is replaced only when the client rotates it, and a client that has lost
its current secret cannot rotate and registers again. A secret that leaked can be
used by whoever holds it to rotate before the maker does, which locks the maker
out until it registers again; the audit line in each company is how that is seen.
There is no registration access token (RFC 7592) and no way to change a
registration's name or addresses. Clients authenticate with a secret or not at
all; signed JWT assertions (`private_key_jwt`) and mutual TLS are not supported.
Ending the connection on revocation is this product's own `end_connection`
parameter, not part of RFC 7009, so a client written only to the RFC ends the
token and leaves the app for the company to turn off. The stdio
transports read their token once at start and check it on every message, so a
new token means restarting the client. A dry run is offered on seventeen bulk routes:
the bulk changes and the routes that change how the company is set up, and on no
route that sends a message or moves money.
