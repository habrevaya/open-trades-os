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

An owner with a spreadsheet and no programmer has a screen for it:
`Settings > Bring in a spreadsheet` (`/settings/imports`). It is not a second
importer. Each row becomes the input of the same create the toolkit calls,
parsed by that route's own schema, so it is held to every rule below.

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
date (customers, jobs, visits) do emit their events: through the API, pause
automations that message customers on "created" events for the length of a
migration. A spreadsheet brought in on the screen does not need that: see
"Automations are held" below.

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

A visit on a job that is already over is recorded as it happened: the same
`POST /v1/jobs/{id}/visits` with its window, the technician who went in
`technicianIds`, `completedAt` and what they wrote in `technicianNotes`. It
needs `data:import` whatever its date, and the day goes through the history
rules, so it is never ahead of now. It goes only on a job that is completed,
invoiced or paid, and is refused on one still open. It is marked
`fromHistory`, and history is recorded, not acted on: it raises no event, tells
nobody it is on their day, leaves the job's status alone, is not checked
against time off or certificates (whoever went then went), and is left out of
every commission split and tip share, because the work was paid for in the
old system if it was paid for at all. No time goes on anybody's timesheet: pay
here comes from the clock, never from visits.

A job that ended before the move and needs no visits can be created as it
ended: `POST /v1/jobs` with `completedAt` or `cancelledAt` (one of them, and
no `visit`). The day is admitted by the history rules, and a job ended more
than a week back announces nothing: no "created" event and no "completed" or
"cancelled" one. Walking a lead to scheduled and then to completed would have
been a live status change on the way, and a workflow that texts a customer
when their job is scheduled would have texted every customer in the history.

### Load equipment

`POST /v1/equipment` with `propertyId`, `category` and `externalRef`. The
serial guard applies as it does to a unit typed in: a serial already on file
elsewhere is refused naming where.

### Map people and job types

`GET /v1/people` (matchable by `email`) gives the technician id a visit
names. `GET /v1/job-types` gives job type ids.

### Find what was loaded

Every list route for an importable record takes `externalSource` and
`externalId`: `/v1/customers`, `/v1/properties`, `/v1/pricebook/items`,
`/v1/jobs`, `/v1/estimates`, `/v1/invoices`, `/v1/payments`, and
`/v1/equipment`, which with either of them needs no address and finds the
units across every address, retired ones included. Visits come back with
their `externalRef` on `GET /v1/jobs/{id}`, units on every read of the
register, and a customer's notes on `GET /v1/customers/{id}/notes`.

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
`equipment:read`, `equipment:write`,
`payment:read`, `payment:collect`, `payment:refund`, `user:read`,
`document:read`, `document:write` and `data:import`.

## API

The generated reference is `packages/api/openapi.json`. The calls above are
the whole of a load.

An estimate's outcome comes in on `POST /v1/estimates` as `outcome`: approved
on a day with the option that won (and who signed, when the source says),
declined on a day with the reason, or expired on a day. It needs
`data:import`, emits no event and records no signature, so loading history
starts no automation. An imported approval converts like any other. The day it
was sent comes in beside its outcome as `sentOn`, also `data:import` and
announcing nothing; it is refused without an outcome, because an estimate
recorded as sent and still waiting is one a follow up would chase about an
answer the customer gave in the old system, and refused before the day it was
written or after the day it was decided.

Customer notes come in on `POST /v1/customers/{id}/notes` with `notedAt` (the
day the old system has, under the history rules) and `externalRef`: marked as
brought in, with no writer here, and never changed afterwards (M03).

Not yet accepted, and reported by the toolkit as gaps: the day an estimate was
converted, partial billing addresses, a price book item without a code, and a
person who never had a login. A property's coordinates
are not taken when it is created; they are set afterwards with
`POST /v1/properties/{id}/pin`, which the geocoder then never moves.

## Bringing in a spreadsheet

`Settings > Bring in a spreadsheet` (`/settings/imports`) is for an owner who
has files exported from wherever the company was before and nobody to drive
the toolkit. It takes nine kinds of file: customers with their addresses and
a person to contact, equipment, price book items, past jobs, past invoices
with their lines and what was paid on them, past payments, each split across
the invoices it paid, past estimates with how they ended and the day they
were sent, customer notes, and past visits on past jobs. CSV only: no workbook reader is part of
this product, and a workbook uploaded by mistake is refused with how to save
it as CSV. A file can be 5 MB and ten thousand rows; a larger one is refused
in words, to be split.

**The columns are guessed, and the owner has the last word.** A plain matcher
in `packages/core/src/imports` reads each header for the words people put at
the top of a column (name, email, phone, street, city, zip, amount, date,
total, paid) and knows nothing about any other product's export. A single
word only matches a header that is exactly that word, so "Last service date"
is not taken for a surname. The owner corrects any guess, names where the
records came from, says whether dates are written month first or day first,
and can save the columns under a name. A later file with the same headers, in
any order, is matched by itself.

**Every row is read as it will land before anything is tried.** The screen
shows the first rows as they will be saved (amounts as numbers, dates as
dates) and every row that cannot go in, with the reason in words: half an
address, "about 200" in an amount column, a date that has not happened, a two
digit year, the same id twice in one file. An invoice with no date, a
payment with no date and a job marked finished with no day it finished are
refused rather than dated today, because dated today they would land in this
month's books.

**Check, then load, both a batch of a hundred at a time.** Checking runs each
row through the real create inside the dry run every bulk route offers (M28):
run, look, roll back, with a savepoint per row so the second refusal in a
batch is found as well as the first, and only the answers are kept. Loading
is offered once every row has an answer. A batch goes in through the same
creates in one transaction, whole or not at all; a row refused at load time
(somebody typed the same invoice number in since the check) is marked
refused with its reason and the rest of its batch is tried again without it.
The page drives one batch per request and shows the count, so a closed tab
stops between batches and pressing the button again carries on.

**What each row goes through.**

| File | Create |
|---|---|
| Customers | `POST /v1/customers` with the address as billing address and first property, then `POST /v1/customers/{id}/contacts` for a contact |
| Equipment | `POST /v1/equipment`, at the customer's address the row names by street, or their main one |
| Price book items | `POST /v1/pricebook/items` |
| Past jobs | `POST /v1/jobs` with `completedAt` or `cancelledAt`, or as a lead when the row says open |
| Past invoices | `POST /v1/invoices` with `issuedOn`, a line per row (its quantity at its price each, or one at its amount before tax) with the tax as charged on it and the total as `expectedTotals`, then `POST /v1/payments` dated the day it was paid and applied to that invoice |
| Past payments | `POST /v1/payments` dated the day it was paid, with an allocation per row to the invoice that row names, and whatever a row names no invoice for held for the customer |
| Past estimates | `POST /v1/estimates` with `issuedOn`, one option of one line at the amount before tax, taxed at the rate its tax was charged at or not at all, its `outcome` (approved on its one option, declined with the reason, expired) and `sentOn`; the total is checked against the file's to the cent afterwards |
| Customer notes | `POST /v1/customers/{id}/notes` with `notedAt` at midday of the day in the file on the company's clock (now, for a note written today), `forField` when the file says the technician should see it, and `externalRef` |
| Past visits | `POST /v1/jobs/{id}/visits` with the window at the day and times in the file on the company's clock, the one technician it names, `completedAt` at the time it finished and `technicianNotes`; an hour long when the file has no time it finished |

**A note comes in on its day.** Whose it is the way a job finds its customer
(by the customer's id from a customers file under the same "came from" name,
or an email exactly one customer has), the day it was written is needed (a
note with no day would sit at the top of the customer's notes as if it were
written today), and it lands among the customer's notes marked as brought in
from that source, with nobody here as its writer and never changed afterwards.
"For the technician" (yes or no) shows it on the customer's visits.

**A past visit goes on a past job, done, by somebody on the board.** It finds
its job by the job's id from a jobs file or the number it kept, and the job
has to be finished; one still open is refused, to bring in as finished or to
book from the board. It names its technician by the email they sign in with,
and only an active technician of the company matches: an email nobody on the
board signs in with is refused, rather than putting the visit on nobody or on
a guess, so add the person under Team first. The day and the time it started
are needed and the time it finished is not; times are read on the company's
clock, "14:30" or "2:30 PM", a time with no AM or PM is a 24 hour clock, and a
visit that ends before it starts, or runs past midnight, is refused. It is
recorded the way the API records history: done, starting nothing and telling
nobody, not refused for time off the technician recorded since, and never
counted toward their pay or a commission.

**An estimate comes in as it ended.** Approved, declined or expired, each with
the day it was decided, or open. An open one comes in as a draft, to send from
here, and one that says it was sent and is still open is refused with that
reason: recorded as sent, it would be chased by a follow up about an answer
the customer gave in the old system. Its tax is never the company's rate of
today; a file whose tax does not come out to the cent at the rate it implies is
refused in words.

A job, a unit or an invoice finds its customer by the customer's id from a
customers file brought in under the same "came from" name, or by an email
exactly one customer has. Never by name: a name is not unique, and a job on
the wrong customer's account is worse than a refused row. An invoice finds its
job by the job's id or by the number it kept. A number the source printed is
kept when it is a whole number; one like `INV-1042` is said in the invoice's
memo instead.

**Several rows can be one invoice or one payment.** That is how accounting
programs export them: an invoice of three lines is three rows with one invoice
number, and a cheque that paid two invoices is two rows with one payment id.
In a past invoices or past payments file, the rows sharing an id are one
record: the first carries the rest, they are checked and loaded together as one
create, and every one of them takes the outcome. What they share (the invoice
date, whose it is, the invoice's Total, what was paid on it, the day a payment
was paid) only has to be on one row, and where more than one row fills it they
have to agree, or every row of the record is refused naming the two that
disagree. An invoice's Total is the whole invoice's, checked against its lines
added up; a line's Before tax and Tax are that line's, or Quantity at Price
each makes its amount. A payment's rows each name the invoice that share went
to, by the id an invoices file gave it under the same "came from" name or by the
number it kept, and a payment names its customer or takes the invoices'. The
same invoice twice in one payment is refused. Without an id column nothing is
grouped, and two rows the same are the same row twice. The counts on the screen
are rows, so a loaded invoice of three lines is three loaded.

**A second upload makes no copies.** Each record carries `externalRef`: the
"came from" name and the row's id column, or failing that the code or number
that already names one record, or failing both a hash of everything mapped
from the row. A row whose key is already here is skipped and the screen says
which record it already is. The key is per company: another company's
records are not visible to the lookup, so a file naming an id only another
company brought in is refused as not found.

**The refused rows come back as a file.** The original columns and cells,
with the row's place in the first file and the reason added at the end, to
fix and bring in again. A cell that starts like a formula (`=HYPERLINK(...)`)
was stored as the characters it holds and is written back as text, so a
spreadsheet shows it rather than running it.

The API is the screen's: `GET /v1/imports`, `POST /v1/imports`,
`GET /v1/imports/{id}`, `POST /v1/imports/{id}/mapping`,
`POST /v1/imports/{id}/check`, `POST /v1/imports/{id}/load`,
`GET /v1/imports/{id}/refused`, `GET /v1/import-mappings` and
`DELETE /v1/import-mappings/{id}`. All of them need `data:import`, and checking
or loading also needs each create's own permission. The screen sits in the
rail under Settings, shown under `settings:read` and opened under
`data:import`, like Take a copy.

**Automations are held.** "Do not start automations for what this file brings
in" is on the upload form and beside the columns, ticked unless the owner
unticks it, and changeable until the first row is loaded (`holdAutomations` on
`POST /v1/imports` and `POST /v1/imports/{id}/mapping`). A record a file brings
in still raises its events, `customer.created` and `job.created` among them,
exactly as one typed in does, because webhooks, reports and the run log read
them; each event carries the file it came from (`domain_event.import_run_id`),
and the workflow engine starts nothing for an event from a file with the switch
on: the run log shows it skipped as imported. Every event the file raised is
held, not only the created ones, because a job finished last week brings in
`job.completed` and a recent paid invoice `invoice.paid`, and a review request
on either is the same text to the same customers. A record typed in, or one
from a file with the switch off, starts them as before.

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

`user`, `credential`, `session`, `setup_token`, `demo_visit`, `organization`, `network` and `oauth_client`
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
clear and the secret key as the NAME it is kept under in the company's own secrets,
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
company's own secrets; a stored secret's sealed value never travels.

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

Nothing in this repository reads another product's export format. The
migration toolkit is separate and loads through `/api/v1` with a connected
app's token; the spreadsheet screen reads plain CSV whose columns the owner
matches. It reads no workbook files, only CSV, because no workbook reader is a
dependency. An invoice's lines carry a quantity, a price each, a description
and the tax charged on them, not a price book item, a discount or a cost; a
refund or a credit does not come in through it. An estimate comes in as one
option of one line at its amount, not the options and lines of the original.
A note comes in dated by its day, not its time, and a past visit carries one
technician, not a crew: a visit two people went on is two files' worth of
work, or the second is added from the visit afterwards. A past visit's parts,
photographs, signature and readings do not come in, only who went, when and
what they wrote. A technician who has left is not on the board and cannot be
matched, so their visits are refused until they are added back.
Photographs come in only through the toolkit. A file is matched to customers by
id or email and never by name, and a payment to its invoices by id or number.
Rows are grouped into one invoice or one payment only by an id column. A file
and its rows are kept after loading so the screen can show what happened, and
there is no button to forget one. Holding automations holds what the file's
own events would start, and nothing else: webhooks still receive those events,
each naming the file, and an automation on a clock or on a record waiting (an unpaid invoice
past due, M29) can still reach a record brought in, because it starts from the
record rather than from the file's event. Through the API, a create has no
switch: pause automations for the length of a migration.

An estimate's history carries its outcome and the day it was sent, but not the
day it was converted.

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
