# The operator API

For whoever runs a deployment with more than one company in it. A hosted
service is the obvious case, and not the only one: a firm that keeps the books
for six contractors, or a franchisor running the software for its
franchisees, has the same five needs. Create a company, read its status, count
what it has used, suspend it, resume it.

It is off unless you turn it on, and a deployment with one company in it has
no reason to.

## Turning it on

| Variable | What it is |
|---|---|
| `OPERATOR_TOKEN` | The bearer token. At least 32 characters, or the API stays off and the server logs why |
| `PUBLIC_URL` | Where this deployment is reached from outside. The owner's first-password link is built from it. `AUTH_URL` is used if it is not set |

```
OPERATOR_TOKEN=$(openssl rand -base64 48)
```

A token shorter than 32 characters disables the API rather than guarding it
with something guessable, so `OPERATOR_TOKEN=changeme` gets you no operator
API, not one anybody can reach. With no token, every path below
`/api/v1/operator` answers the same 404 an unknown route does, so a
deployment that never turned it on does not reveal that it exists.

## What it accepts, and what it does not

`Authorization: Bearer <OPERATOR_TOKEN>`, and nothing else. It is a separate
credential from a person's session and from a connected app's `ots_` token,
and the API never falls back to either: a request carrying a session cookie
and no operator token is refused, whoever is signed in. The comparison is
constant time over SHA-256 digests, so a wrong token of the right length and
one of the wrong length take the same time to refuse.

The token is checked before the path is, so a caller without it cannot map
which routes exist by watching for 404s and 405s.

These routes are not in the published contracts, so they are not in the
OpenAPI document, the generated SDK or the MCP tool list. A company's own AI
agent should not be offered "suspend organization", even as a call it would
be refused.

## The routes

All under `/api/v1/operator`. Errors have the shape every other route uses:
`{ "error": "...", "status": 422, "issues": [...] }`.

### Create a company

```
POST /api/v1/operator/organizations
```

```json
{
  "name": "Smith Plumbing",
  "timezone": "America/Denver",
  "tradePack": "plumbing",
  "externalRef": "cus_8f2k1",
  "owner": { "email": "sam@smithplumbing.com", "name": "Sam Smith" }
}
```

`201`, the first time:

```json
{
  "organizationId": "…",
  "ownerUserId": "…",
  "ownerSetupUrl": "https://ots.example.com/welcome?token=…",
  "created": true
}
```

**Idempotent on `externalRef`.** Ask again with the same reference and the
answer is `200` with the same two ids and `created: false`, however many times
and however close together: two retries racing each other are settled by a
unique index, and the loser reads the winner's ids. The body of a repeat is
not compared. A different name under the same reference is answered with the
company that already exists, because the alternative is creating a second one.

**The owner gets a link, never a password.** `ownerSetupUrl` opens a page
where they choose one and are signed in. The link is single use, expires in
seven days, and only the SHA-256 of it is stored. A repeat call issues a fresh
link and retires the previous one, since a caller asking again is usually a
caller that lost the first response.

If the address already belongs to somebody with a password, they are made the
owner of the new company and `ownerSetupUrl` is the sign in page. No link this
API issues can set the password of an account that already has one. That is
enforced in the SQL that spends the link, because the alternative is that
anybody able to issue a link for an address can take over the account behind
it.

`timezone` must be a zone this server can format, and `tradePack` must be one
that ships (`hvac`, `plumbing`, `electrical` and the rest in
`packages/trade-packs`). Either one wrong is a `422` before anything is
written. The pack is applied by the same call the setup wizard makes, inside
the same transaction as the company, so a company never exists with job types
and no price book.

The company and its owner's membership are written by the same function the
signup form uses (`packages/api/src/services/organizations.ts`), so a company
an operator created and one somebody created for themselves are the same kind
of company.

### Read a company's status

```
GET /api/v1/operator/organizations/{id}
```

```json
{ "organizationId": "…", "name": "Smith Plumbing", "status": "active", "createdAt": "…" }
```

`status` is `active` or `suspended`. An id that is not a company, or not a
uuid at all, is a `404`.

### Count what a company has used

```
GET /api/v1/operator/organizations/{id}/usage?since=2026-09-01T00:00:00Z
```

```json
{
  "organizationId": "…",
  "since": "2026-09-01T00:00:00.000Z",
  "activeUsers": 4,
  "technicians": 3,
  "jobsCreated": 112,
  "invoicesCreated": 97,
  "messagesSent": 431,
  "storageBytes": 18874368
}
```

`since` defaults to thirty days ago. What each number means, because a number
that looks like "since" and is not is how a bill comes out wrong:

| Field | Counts |
|---|---|
| `activeUsers` | People who held a live session at any point since `since`. Not sign-ins: a session lasts thirty days, and somebody who signed in five weeks ago and works in it daily is active |
| `technicians` | **A headcount, not a flow.** Active technicians on the books right now |
| `jobsCreated` | Jobs created since `since` |
| `invoicesCreated` | Invoices created since `since`, voided ones included |
| `messagesSent` | Texts and emails handed to a carrier or mail provider since `since`. Queued and never sent is not sent |
| `storageBytes` | **Also not a flow.** Bytes this product holds in the database right now: uploads and brand assets. Anything a deployment keeps in its own object storage is that store's to count |

### Suspend and resume

```
POST /api/v1/operator/organizations/{id}/suspend   { "reason": "card declined" }
POST /api/v1/operator/organizations/{id}/resume
```

Both answer with the status object above.

**Suspension refuses access and changes nothing else.** No row is deleted and
nothing is revoked. While a company is suspended:

| What | What happens |
|---|---|
| A person's session | `403` with `"code": "organization_suspended"` from the API. In the app, a page that says the account is suspended, rather than the login page, which would let them in and refuse them again |
| A connected app's token | The same `403` |
| The MCP endpoint | An empty tool list, and a tool call answered with the same message |
| Public booking and web forms | Refused. A booking accepted for a company nobody can sign in to is a customer waiting for a call that never comes |
| Portal links (estimates, tracking) | Refused as "no longer valid", without spending a use. The company's customers are not told why |
| The worker | Does not see the company at all: no events drained, no schedules fired, no waiting runs resumed |
| Inbound webhooks (carrier, email, payments, lead sources) | **Still accepted.** A customer's reply, a bounce and a card payment that already happened are facts, and dropping them would lose data the company will want when it comes back |

The refusals live in the SQL that resolves a session, an app token and a
portal link, and in what the worker's discovery functions return, so a caller
cannot forget to make the check. A tenant cannot lift its own suspension: the
three columns involved are refused by a trigger to every role but the
operator.

Resuming puts every session, token and link back exactly as it was. Nobody
has to sign in again and no partner has to re-issue a token.

**One consequence to know about.** Events a suspended company produces (an
inbound text, mostly, since nobody can sign in to make any others) wait
unread rather than being skipped. When the company is resumed the worker
drains them, and any automation they trigger runs then, late. Suspensions are
usually short and the backlog is usually a handful of events, but a
deployment that suspends for months should know that the backlog is there.

Suspending a company that is already suspended keeps the original time and
records the new reason.

## The audit trail

Every call writes a line to the company's own audit log, reads included,
naming `operator` as the actor: `operator.organization.created`,
`operator.organization.create_replayed`, `operator.organization.read`,
`operator.usage.read`, `operator.organization.suspended`,
`operator.organization.resumed`. "When did the people who host us last look at
our usage, and when did they suspend us" is a question a company is entitled
to answer from its own records.

## The database role

The operator needs to do two things the request path must not: find a company
by the operator's reference, and find out whether an address already has an
account. Both are cross tenant reads, and row level security is forced on
every table, so neither can be done by selecting.

They get the shape the worker's discovery got (see
[the worker](worker.md#the-database-role)). The migrations create a
`platform_operator` role, a member of `authenticated` so every policy applies
to it exactly as it applies to a person. The two lookups, the usage count of
signed in people and the issuing of a first-password link go through
SECURITY DEFINER functions that return ids, counts and booleans, executable by
`platform_operator` and not by `authenticated`. Everything else an operator
call does happens inside the one company it named, with the tenant context
set to it.

Each call drops to the role with `set local role` inside its own transaction.
For that to work the account the web app connects as must be a member of
`platform_operator`. The migrations grant it to whichever account runs them,
which is usually the same one. If your web app connects as a different
account:

```sql
grant platform_operator to your_web_role;
```

Nothing here sets session state, takes a session level lock or listens, so it
is safe behind a transaction pooler such as Supabase's.

## What it is not

It is not an administrator who can read a company's data. No route returns a
customer, a job or an invoice. An operator who needs to see inside a company
asks to be made a member of it, and the company's own audit log shows that
they were.

It is not billing. It counts; deciding what a count costs is the job of
whatever calls it.
