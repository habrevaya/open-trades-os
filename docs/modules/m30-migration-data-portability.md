---
title: Migration and Data Portability
module: M30
domain: Platform
phase: 4
status: partial
---

# Migration and Data Portability

> Module M30. Domain: Platform. Ships in phase 4.

## What it does

A company moving here from Jobber, Housecall Pro or anything else brings its
history with it: customers, properties, the price book, jobs and their
visits, estimates, invoices, payments, refunds and the photographs attached
to all of it, on the dates they happened, with the numbers the customers know
them by and the tax they were actually charged.

The importer itself is not in this repository. It is the separate migration
toolkit (`open-trades-os-migration`), and it writes through the public API
with a connected app's token, never into the database. That is deliberate:
every rule the services enforce (the ledger postings, the job lifecycle, the
audit trail, row level security) applies to migrated records exactly as it
does to records typed in by hand, and the same toolkit works against any
deployment. What lives here is what the API has to accept for a load to be
faithful.

Going the other way is the second half, and it is now built. A whole company
export (`data:export`) hands back every row in every table that carries an
`organization_id`, driven off the database catalogue rather than off a list,
with a row count per table so the result is checkable and with every held back
column named.

**It leaves because it can.** That is the argument this project makes against
the incumbents, and the comparison pages make it in detail, naming the things
their export APIs leave behind. "It is your Postgres instance" was the previous
answer and it is only true for somebody self hosting; a company on a hosted
deployment, which the operator API exists to make possible, had no way out at
all.

## Key concepts

**History is recorded, not made.** Recording that an invoice was issued in
2023 is a different act from issuing one, and so is stating the tax another
system charged or keeping a source document's number. Every one of those is
also how books are cooked, so they need the `data:import` permission. Only
the owner preset holds it. An owner gives it to the migration's app token for
the length of the migration and takes it away after.

**Back-dated, never edited.** A historical invoice or payment posts to the
ledger on the day it happened. It is still an append: a new balanced pair on
an earlier day. The rules for a business date are in
`packages/core/src/history`:

- Nothing is dated in the future.
- Up to seven days back is ordinary late entry and needs nothing extra.
- Anything earlier is history and needs `data:import`.
- Nothing posts into a closed accounting period, whoever asks. Reopen it
  (`accounting:close`, with a reason) or record the correction today.

Visit completion is the exception: `completedOfflineAt` is accepted from any
caller that may complete a visit, because the field invariant says a write
recording work that happened is never refused.

**History is not announced.** A back-dated invoice, payment or job completion
emits no domain event, so no workflow sends "your invoice is ready" or "how
did we do" to a customer about work from three years ago. Creates without a
date (customers, jobs, visits) do emit their events: pause automations that
message customers on "created" events for the length of a migration.

**Provenance.** Every importable create takes `externalRef: { source, id }`:
the source system, in lower case, and its own id for the record. The pair is
unique per company and kind of record, a second create for it is a 409 naming
the id it already became, and every read returns it. `recurring_schedule` is
reserved; this product writes it itself.

**Totals are computed here.** Tax as charged and invoice-level adjustments are
inputs; totals are not. A caller's `expectedTotals` is a cross check that
refuses the invoice with a 422 when any total differs to the cent.

## Setup

1. As the owner, install a connected app for the migration with the
   permissions it needs (see below) and the `all` scope on customers, jobs,
   estimates and invoices, and issue it a token.
2. If any accounting period is closed, decide now whether history inside it is
   being loaded. It cannot be until the period is reopened.
3. Pause automations that message customers on created events.
4. Run the toolkit. When it is done, revoke the token, or at least remove
   `data:import` from the app.

## Using it

### Load a historical invoice as it was sent

`POST /v1/invoices` with `issuedOn`, `number`, `externalRef`, lines carrying
`taxRate` and, where the source rounded per line, `taxAmount` (accepted within
a cent of what the rate gives), an `adjustment` for anything the lines do not
account for, and `expectedTotals`. A line linked to the price book with
`priceAsGiven: true` keeps the price it was sold at.

### Load a payment, a deposit or a credit

`POST /v1/payments` with `receivedAt` and `externalRef`. Name the invoices in
`allocations`; send `allocations: []` for money applied to nothing, which is
held for the customer as a liability and reported as `unappliedAmount`. Apply
it later with `POST /v1/payments/{id}/apply`.

### Load a refund paid by hand

`POST /v1/payments/{id}/refunds` with `amount`, `method`, `refundedAt` and a
`reason`. It comes out of held money first and then reopens the invoices the
payment paid.

### Load jobs and visits

`POST /v1/jobs` with `number` and `externalRef`, then
`POST /v1/jobs/{id}/visits` (idempotent on the Idempotency-Key) for each
visit, with `status: "cancelled"` for one that was called off and no window
for one that never had a time. Complete a job with
`PATCH /v1/jobs/{id}` `{ status: "completed", completedAt }`, or complete its
visits with `completedOfflineAt`.

### Map people and job types

`GET /v1/people` (matchable by `email`) gives the technician id a visit
names. `GET /v1/job-types` gives job type ids.

### Find what was loaded

Every list route for an importable record takes `externalSource` and
`externalId`: `/v1/customers`, `/v1/properties`, `/v1/pricebook/items`,
`/v1/jobs`, `/v1/estimates`, `/v1/invoices`, `/v1/payments`. Visits come back
with their `externalRef` on `GET /v1/jobs/{id}`.

### Attach photographs and documents

`POST /v1/attachments` with `entityType`, `entityId`, `fileName` and base64
`bytes`.

## Permissions

| Role | Access |
|---|---|
| owner | Everything here, including `data:import` and `data:export` |
| admin | Everything except `data:import` and `data:export`, both deliberately left out |
| others | Ordinary creates, and dates up to a week back; never history |

Both are owner only, and for the same reason read from two directions.
`data:import` is the power to make the books say anything happened.
`data:export` is the power to walk out with the customer list, which for a
trades company is most of what the business is worth.

A migration app token needs, at most: `customer:read`, `customer:write`,
`property:read`, `property:write`, `pricebook:read`, `pricebook:write`,
`job:read`, `job:write`, `job:complete`, `visit:read`, `visit:write`,
`estimate:read`, `estimate:write`,
`invoice:read`, `invoice:write`, `invoice:void`, `invoice:writeoff`,
`payment:read`, `payment:collect`, `payment:refund`, `user:read`,
`document:read`, `document:write` and `data:import`.

## API

The generated reference is `packages/api/openapi.json`. The calls above are
the whole of a load.

An estimate's outcome comes in on `POST /v1/estimates` as `outcome`: approved
on a day with the option that won (and who signed, when the source says),
declined on a day with the reason, or expired on a day. It needs
`data:import`, emits no event and records no signature, so loading history
starts no automation. An imported approval converts like any other.

Not yet accepted, and reported by the toolkit as gaps: the day an estimate was
sent or converted, customer notes, partial billing addresses, a price book item
without a code, and a person who never had a login. A property's coordinates
are not taken when it is created; they are set afterwards with
`POST /v1/properties/{id}/pin`, which the geocoder then never moves.

## Taking a copy

### The manifest

`GET /v1/export` lists every exportable table with a row count, the primary key
columns, and whatever is held back.

**Read off the catalogue, not off a list.** The same mechanism the row level
security sweep uses, and for the same reason: a hand maintained list is how a
product ends up with one table missing from its export and nobody finding out
for eighteen months. A table added tomorrow is exportable tomorrow and nobody
has to remember.

**The row counts are what make it checkable.** Somebody who pulls 14,812
customers and had 14,900 has a problem they can see. Without the count they
have a file and a hope.

### The pages

`GET /v1/export/{table}` returns up to a thousand rows, a cursor, and whether
there is more. Pass the cursor back as `after`. Stop on `more: false` rather
than on an empty page.

**Keyset pagination on the primary key, never an offset.** A company exports
while its office is still working, so rows arrive during the walk. An offset
shifts every remaining row by one and the export quietly loses one. The cursor
is the previous page's last key, compared as a row with typed parameters, so a
composite key works without the endpoint knowing which tables have one, and an
integer key would still sort correctly.

### What does not leave

| Table | Column | Why |
|---|---|---|
| `lead_source_connector` | `webhook_token` | A live secret, not a hash. Whoever holds it can post leads in as the partner. |
| `app_token` | `token_hash` | The hash of a live token. Reissue it. |
| `portal_grant` | `token_hash` | Customer links are capabilities and cannot be reconstructed. |
| `calendar_feed` | `token_hash` | Reissue it; the technician's phone needs a new URL anyway. |
| `unsubscribe_link` | `token_hash` | The address and whether it was used are exported; the link is not. |
| `device` | `push_token` | A live push credential, reissued by the app on first run. |
| `device` | `session_token_hash` | The hash of the phone app's live sign in. Phones sign in again. |
| `webhook_endpoint` | `secret_ref`, `previous_secret_ref` | The signing secrets themselves. Give the receiver a new one from the new system. |
| `connected_app` | `claim_hash` | The hash of the secret an app collects its credential with. |
| `oauth_code` | `code_hash` | A one time code that lived ten minutes. |
| `oauth_refresh_token` | `token_hash` | A connected assistant connects again. |

An export carrying live tokens is a breach in a file. An export that silently
drops them is a claim of completeness that is false. So each one is named, with
the reason, in the manifest and on every page.

What is NOT redacted, deliberately: `integration_connection.credential_ref` is
the NAME of a secret in the deployment's own store, by design, and a company
moving away needs it to know which secrets to go and find. A webhook's signing
secret is not a name: the delivery code has to sign with it, so the column holds
the secret itself, and it stays out of the file. `storage_key` on a file is the pointer to the bytes, without which
an export cannot be matched to the attachments.

### What is outside the tenant

`user`, `credential`, `session`, `setup_token`, `organization`, `network` and `oauth_client`
carry no `organization_id`, so row level security does not scope them and this
export cannot reach them.

The one worth stating plainly is `credential`. Password hashes are unreachable
from here, which is why no part of this export has to be trusted not to include
them. The people who work here are exported through `membership`, with their
name and address.

### One file, from the screen

`Settings > Take a copy` shows the manifest first and then downloads the whole
thing as one newline delimited JSON file. The first line is the manifest and
every line after it is `{"table": ..., "row": {...}}`.

**Not CSV, and not a zip of one file per table.** A CSV per table loses the type
of every column and cannot represent a `jsonb` field at all, which is where the
custom fields live. A zip has to be finished before its first byte can be sent,
so a company with real history gets a request that times out rather than a file
that starts arriving. NDJSON streams, and `grep` pulls one table out of it with
nothing installed.

**A finished file ends with `{"complete": true, "rows": n, "expected": m}` and
nothing else does.** That terminator is how a truncated download is detectable
from the file alone, and `rows` is a count of what the writer actually emitted
rather than the manifest's total restated, so the two differing tells you
somebody was working while it ran.

There is no line saying WHY a failed export stopped, and the first version had
one. A test showed it never arrives: enqueueing a chunk and then erroring a
`ReadableStream` discards the queued chunk, by specification. So the broken
transfer and the missing terminator are the signal, and the reason goes to the
server log. Closing the stream cleanly instead would have delivered the reason
and handed back a 200 with a successful-looking download, which is the one
outcome worth avoiding.

The screen is `data:export`, like the API. It is shown in the rail under
Settings, which only needs `settings:read`, and that is the single place in this
product where a navigation item is visible to somebody the page itself will
refuse. The alternative was a top level item most roles cannot open.

### The audit trail

Every page writes an audit line with the table, the row count and whether it
was a resumption. "When did somebody take a copy of our entire customer list,
and how much of it" is the question an export has to be able to answer, and it
is the single most sensitive read in this product. Per page rather than per
export, because an export is a sequence of calls and there is no moment it
finishes.

## Common questions

**Why can my bookkeeper not date a payment to last year?** Because that is
`data:import`, and back-dating cash is the first thing an auditor looks for.
A week back is allowed for anybody who may take a payment.

**Why was an invoice refused with "the books are closed through"?** Its issue
date is inside a closed period. Reopen the period with a reason, or do not
load it.

**I ran the migration twice. Did it duplicate everything?** Not anything it
sent an `externalRef` for: the second create is a 409 naming the record that
already exists.

## What is not built

Nothing in this repository imports from Jobber, Housecall Pro or ServiceTitan.
The importer is the separate migration toolkit, which loads through `/api/v1`
with a connected app's token, and what is here is the half that has to be right:
an API that takes history faithfully and refuses what it should.

An estimate's history carries its outcome but not the day it was sent or
converted. The export writes one newline delimited
JSON stream and nothing else: no per table CSV, no archive, and no object storage
path, so a company exporting a large instance streams it to their own disk.
Nothing imports an export back, which is the obvious symmetry and is not built.
