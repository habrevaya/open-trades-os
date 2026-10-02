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

A whole-company export (`data:export`) is not built.

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
| owner | Everything here, including `data:import` |
| admin | Everything except `data:import`, which is deliberately left out, as `data:export` is |
| others | Ordinary creates, and dates up to a week back; never history |

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

Not yet accepted, and reported by the toolkit as gaps: an estimate's historical
status (sent, approved, converted) with its date, customer notes, partial
billing addresses, property coordinates, a price book item without a code, and
a person who never had a login.

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
