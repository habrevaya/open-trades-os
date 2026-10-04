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
| owner | Everything here, including `data:import` and `data:export`: taking a copy, Backups, and restoring one |
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
them. The people who work here are in the manifest's `people`, each with their
name and address, beside their `membership` rows; the company's own row is its
`company`.

### Every table at one moment

A copy read page by page in separate transactions is not one company: a
customer and their first job booked while the export was between the
`customer` table and the `job` table left a job in the file pointing at a
customer who was not, and the copy could not be loaded back. A download and a
scheduled copy now read every table inside one `repeatable read` transaction,
so a copy is always one the database could have held, and the manifest's
counts are exactly what follows them. The API's pages stay one transaction
each, because a program walking them is a sequence of calls.

### What the manifest carries besides the tables

Each table's columns, in order, with Postgres's name for the type and the table
a foreign key points at. The company's own row (name, address, timezone,
currency, settings), which is outside the tenant like every company's row and
which a restore needs to bring the business back as itself. The people: every
membership's name and address, read through the same function the team screen
uses, never anything about how they sign in. And the number of stored files and
their bytes.

### Values that survive the trip

A timestamp is ISO 8601 in UTC with every digit Postgres holds (a JavaScript
date keeps milliseconds and Postgres keeps microseconds); a `date` is
`2026-10-04`, not midnight in the server's zone; bytes are `\x` and hex rather
than an array of numbers; jsonb, booleans and integers are themselves; anything
else is Postgres's own text for it. That is what lets a restore load each value
back through Postgres's own input functions and get the same value.

### Files beside the rows

A stored file's bytes are held apart from `stored_file`'s rows, named in the
manifest under `apart`: a page of a thousand photographs inside one JSON answer
was gigabytes. Through the API each file is fetched by its id from
`GET /v1/export-files/{id}`, base64 with the `sha256` it was stored under, the one
place this product hands bytes back inside JSON.

### Two files, from the screen

`Settings > Take a copy` shows the manifest and offers two downloads of the same
moment.

**Spreadsheets** is a zip: `tables/` with one CSV per table (every table, with
its header even when empty), `files/` with every photograph and document under
its storage key, `manifest.json`, a `README.md` written from the manifest that
says what every column holds, and `complete.json` last. The CSVs are Postgres's
own COPY format, so each loads with `\copy table from 'table.csv' with (format
csv, header)`: an empty cell is NULL, `""` is an empty string, every other value
is quoted, and the file is UTF-8 with a byte order mark so a spreadsheet shows
accented names correctly.

**One data file** is newline delimited JSON: the manifest, one line per row
tagged with its table, one line per file with its bytes in base64, and last
`{"complete": true, "rows": n, "expected": m, "files": f, "expectedFiles": g}`.
It keeps every type and nested value exactly and is the better input to a
program.

The earlier version of this page said a zip "has to be finished before its first
byte can be sent". That is true of how most libraries write one and not of the
format: each entry can carry its sizes after its data, and the directory goes at
the end by design. The archive is written that way, compressed a table at a time
as rows arrive, ZIP64 where a company passes four gigabytes or sixty five
thousand files, with Node's own zlib and no library.

**How a cut short download shows.** A finished data file ends with its
terminator and nothing else does; a finished zip has its directory and
`complete.json`, and a zip without a directory will not open. A failure mid
file cannot be a status code, because the headers went out with the first byte
and said 200, so the stream errors: curl exits non zero, a browser marks the
download failed. There is no line saying why: enqueueing a chunk and then
erroring a `ReadableStream` discards the chunk, by specification, so the reason
goes to the server log. The stream also waits for its reader, so a slow
connection slows the copy rather than piling the company up in the server's
memory.

The screen is `data:export`, like the API. It is shown in the rail under
Settings, which only needs `settings:read`, and that is one of two places in
this product where a navigation item is visible to somebody the page itself
will refuse; `Settings > Backups` is the other, for the same reason. The
alternative was a top level item most roles cannot open.

### The audit trail

Every API page writes an audit line with the table, the row count and whether it
was a resumption, and every file fetched writes one too. "When did somebody take
a copy of our entire customer list, and how much of it" is the question an export
has to be able to answer, and it is the single most sensitive read in this
product. A download and a scheduled copy write `data.export.started` before the
first row is read and `data.export.finished`, or `data.export.stopped` with how
many rows of each table were read, after the last, each in a transaction of its
own, so a download that broke halfway is on the record too.

## Copies on a clock

`Settings > Backups` writes the spreadsheets zip to an S3 compatible bucket the
owner controls (Amazon S3, R2, B2, Wasabi, a MinIO on their own server) every
night or every week at an hour on the company's own clock, and keeps the newest
N. The bucket is named the way every connection is: the access key id in the
clear and the secret key as the NAME it is kept under in the deployment's store,
never the key; a value that looks like a key is refused. Saving checks the bucket
by writing a small object, reading it back and deleting it, and the screen says
what the bucket answered until a check passes.

The worker writes the copy straight into a multipart upload, a part at a time,
so the company is never in memory or on the server's disk. Every attempt is a
row: where it went, its size and row count, why it failed in the bucket's own
words, and when it was deleted to keep newer ones. Only copies this company
wrote are ever deleted, from its own record of them, never from a listing of
the bucket. A failed copy is tried again within the hour and put in the
office's queue as a task the first time.

`GET /v1/backups/destination`, `PUT /v1/backups/destination` and
`DELETE /v1/backups/destination` read, set and remove where copies go;
`GET /v1/backups` lists every attempt and `POST /v1/backups` queues a copy now.
All `data:export`.

## Putting a copy back

`/setup/restore` loads either file into a new, empty company, uploaded from a
computer or read from a bucket; `POST /v1/restores` does the second through the
API, and `POST /v1/restores/available` lists the copies in a bucket. Each needs
`data:import`, because a restore writes years of history into the books. A
company signing up is sent to setup, which links to it.

**Only into an empty company.** A company with any record (beyond its audit
trail, the person restoring and the starter automations every new company is
given) is refused with what it holds. A merge would decide, record by record,
which of two versions of the truth to keep, and each of those decisions would be
somebody's invoice.

**All or nothing, and a check that is the restore.** One transaction. A check
does everything a restore does, including the ledger's balance check, which is
asked for before the end rather than at commit, and then rolls back, so the
counts and refusals it reports are what would happen. A check and a refusal
leave their report in `restore_run`, written after the rollback;
`GET /v1/restores` lists them.

**In load order, off the catalogue.** Tables load after the tables they point at,
worked out from the foreign keys in `pg_constraint` rather than from a list; a
table pointing at itself (a customer referred by another) loads that column
empty and fills it in once every row is there. Rows go in through
`jsonb_populate_recordset`, so each value is read by Postgres's own input
function from the text or JSON the export wrote. A column the copy does not hold
takes its default, so a copy from an older version loads into a newer one; a
copy holding a table or a column with values this version does not have is
refused as coming from a newer version. A trigger that changes a row as it is
inserted (a job's branch filled from whoever is signed in) has the copy's values
put back.

**Ids kept when they can be.** On another deployment every id is kept, which is
what lets a connected app's mapping, a link in an email or a migration's record
of what it loaded keep working after a move. When the company the copy came from
is still on this deployment it holds every one of those ids, so every record gets
a new one, and every reference is rewritten BY VALUE: any uuid anywhere in a row,
in a uuid column, a storage key or a jsonb blob, that is the id of something in
the copy is replaced. A list of the columns that hold ids would be the hand
maintained list this export refuses to have, and the first one it missed would
point the restored company at the original.

**The people.** Each person in the copy comes back by address: a new account
with no password, sent a first-password link from Settings, Team; the person
restoring, who keeps their own membership and stays owner; or an existing
account that works for a company the person restoring runs, which is the case
of restoring beside the original. An address that already has an account with
anybody else is refused, for the reason an invitation refuses it: a file is not
allowed to add somebody's existing account to a company. A reference to a person
not in the copy is cleared.

**What was held back comes back as something to set up.** Every redacted column
with rows is on the report with its reason. One the database requires is filled
with a fresh random value that matches nothing, so the record comes back and the
old link or token stays dead. Rows pointing at something outside the company (a
franchise group) are not restored and the report says how many. The names of
the secrets the company's connections read are listed, to put in the new
deployment's store.

**Nothing sends until somebody has looked.** Every connected service is set to
need checking and every webhook is switched off, unless the person restoring
says otherwise. Otherwise a company restored beside its original would text the
same customers through the same carrier account the moment the worker noticed a
queued message.

**Files** are checked against their checksum and put wherever this deployment
keeps files, so a copy taken from a Postgres deployment restores into a bucket
deployment and the other way round.


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
converted.

The zip of spreadsheets is a download from the screen and a scheduled copy; the
API has no route that streams it, because the API answers in JSON, so a program
walks the pages and fetches each file. A restore runs while its request waits:
a company too large to upload through a browser, or to restore inside a proxy's
time limit, is put in a bucket and restored from there. A restore cannot merge
into a company with records, cannot add somebody's existing account from
another company, and does not bring back anything a copy never carries: live
tokens and signing secrets, a franchise group's grants, sign ins. Scheduled
copies need the long running worker; a serverless tick starts one and may cut it
off. Only S3 compatible buckets are taken, not Google Cloud Storage's or Azure's
own protocols.
