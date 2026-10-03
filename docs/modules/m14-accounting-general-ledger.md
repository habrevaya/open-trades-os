---
title: Accounting and General Ledger
module: M14
domain: Money
phase: 5
status: partial
---

# Accounting and General Ledger

> Module M14. Domain: Money. Ships in phase 5.

## What it does

Keeps a real double entry ledger behind every money movement in the product,
lets somebody read it, and pushes the documents into QuickBooks Online or Xero,
both directions.

## The problem

Most field service software holds money as a set of numbers on documents and
exports a CSV. That works until a number disagrees with another number, and then
nobody can say which one is right, because there is no account anything was
posted to.

The other problem is the sync. A sync that runs twice puts two invoices in
somebody's QuickBooks, and a sync that guesses where money lands produces a year
of misfiled revenue that an accountant finds in March.

## Key concepts

**Postings are append only, and the database enforces it.** A correction is a
reversing entry rather than an edit. `ledger_entry` has a trigger refusing
UPDATE, which is why a customer merge moves everything except the ledger.

**The balance is asserted twice, on purpose.** Once in TypeScript, where the
error names the imbalance and points at the code that built it, and once in
Postgres by a deferred constraint trigger, where it is a guarantee rather than a
convention. The first exists because a trigger firing at commit tells you a
transaction failed and not which of forty entries was wrong. The second exists
because the first can be bypassed by anything writing SQL directly, and the
ledger is the one table where that must not be possible.

**There is no bare journal entry surface, and that is a decision.** A posting is
a consequence of a guarded business action: invoicing, taking a payment, writing
one off. An operator who can post freely can make the books say anything with no
document behind it. `ledger:post` exists in the catalogue for the day a manual
journal is genuinely needed, and until then it is excused by name in the
permissions guard rather than quietly unenforced.

**The audit has to be reachable or double entry is pointless.** The postings were
written, append only and trigger enforced, and nothing could read them back: a
company could not see a trial balance, could not open a journal, and could not
answer "why does accounts receivable say that" without a database client.

**Reads are metered and writes are not.** Intuit charges for reads and refuses
the overage with a 429 instead of billing it, so the sync never asks the
accounting system what it already knows. "Have I pushed this" is answered
locally. The only reads on the outbound path are crash recovery, and the only
read on the inbound path is one change feed request. Running out of reads is
recorded on the run and the pass keeps going, because the outbound half does not
need reads at all.

**Idempotency is a unique index, not a check followed by an insert.** Two workers
both passing a check is not a rare race, it is what happens the first time a pass
takes longer than the tick.

**Nothing is guessed about where money lands.** An invoice line with no mapped
account is refused by name rather than defaulted into an income account that
looked plausible.

**A document is offered a bounded number of times.** Without a ceiling, a document
QuickBooks will never accept, a line naming a deleted item say, is retried on
every tick forever and the failure is invisible because each pass looks like the
last.

**A refund crosses the two systems differently depending on when it happened.**
One made before its payment reached the books is netted into it. One made after is
sent on its own date: to QuickBooks as an expense from the bank categorised to
Accounts Receivable, and to Xero as an invoice for the amount plus Spend Money
through the mapped customer deposits account, because Xero's receivable is a
system account nothing else may touch.

**A credit note becomes four kinds of document, each waiting for the one before.**
Issued, it goes as a QuickBooks CreditMemo or a Xero ACCRECCREDIT credit note, with
its own lines on the revenue account the ledger debited when it was issued and its
tax on the mapped tax account, exactly as an invoice's lines are mapped. Each time it
is used on an invoice, that application goes on its own date once both documents are
over there: in QuickBooks as a zero payment linking the invoice and the credit memo,
in Xero as an Allocation on the credit note. A void goes as an invoice for the same
lines dated the day of the void, settled against the credit note the same way, rather
than as either book's own void: QuickBooks' API offers no void for a credit memo, only
a delete, and Xero's void takes the credit out of the period it was issued in, which
may be closed. A credit note voided before it reached the books never goes. Each is
dated by its own act for the close (issue, application, void), offered a bounded
number of times, refused by name when an account is unmapped, and found again after a
lost response: by its number, or for a Xero allocation by reading the credit note and
matching the invoice, amount and date. A write off sent after a credit note was used
on the invoice credits only what was left owing.

## Setup

QuickBooks Online or Xero is connected at `/settings/integrations`.
`GET /v1/accounting/accounts` reads the chart of accounts from over there, and
`PUT /v1/accounting/mappings` says which of this product's categories lands in
which account. Nothing syncs until the mappings it needs exist, because a default
is worse than a refusal.

In QuickBooks, turn off **Automatically apply credits** (Account and settings,
Advanced). With it on, QuickBooks applies a new credit memo to the customer's
oldest open invoice by itself, which may not be the invoice it was used on here,
and the application sent afterwards is then refused with QuickBooks' own reason
and shows on the problems list.

## Using it

### Read the books

`GET /v1/ledger/trial-balance` is every account with its two sides and its
balance, grouped in SQL because this is the one report that reads the whole
ledger and a company closing its fifth year has a lot of it.
`GET /v1/ledger/journal` is the entries. Both need `ledger:read`.

### Run the sync

`POST /v1/accounting/sync` runs a pass, `GET /v1/accounting/status` says where it
stands, `GET /v1/accounting/runs` is the history, and
`GET /v1/accounting/problems` is the documents it could not place, with
`POST /v1/accounting/problems/{id}/retry` to offer one again. All of them need
`accounting:sync`.

### Close a month

`POST /v1/accounting/periods/close` closes a period and
`POST /v1/accounting/periods/reopen` opens it again. Both need
`accounting:close`, which is a different permission from running the sync.
Nothing posts into a closed period, including a back dated document from a
migration, and the refusal names the period.

## Permissions

| Role | Access |
|---|---|
| Owner | Everything |
| Administrator | Everything except the ledger and closing a period, which are granted explicitly |
| Office manager | Neither the ledger nor the sync |
| Accountant | Reads the ledger, runs the sync, closes the period |

`ledger:read` is on the sensitive list. The administrator preset deliberately
excludes it along with `ledger:post` and `accounting:close`: running the system is
not the same job as keeping the books, and a company that wants one person doing
both grants it rather than inheriting it.

## API

| Call | Needs |
|---|---|
| `GET /v1/ledger/trial-balance` | `ledger:read` |
| `GET /v1/ledger/journal` | `ledger:read` |
| `GET /v1/accounting/accounts` | `accounting:sync` |
| `PUT /v1/accounting/mappings` | `accounting:sync` |
| `POST /v1/accounting/sync` | `accounting:sync` |
| `GET /v1/accounting/problems` | `accounting:sync` |
| `GET /v1/accounting/periods` | `accounting:sync` |
| `POST /v1/accounting/periods/close` | `accounting:close` |

## Common questions

**Is the seeded demo company's ledger real?** Yes. Its invoices and payments are
raised and paid through the billing service, so the postings behind them are real
and seeded jobs show the revenue their invoices posted. That is why the seed lives
in the API package.

**Can the trial balance be filtered by branch?** No, and the omission is
deliberate rather than forgotten. The column exists and nothing writes it, so a
filter matched nothing on every ledger. Filling it on the invoice path alone would
produce a filtered trial balance holding a branch's revenue and none of its
payments, write offs or deposits: plausible, wrong, and nobody checking it against
a bank statement would find the cause.

**What happens if the sync is interrupted?** The claim a pass takes is what makes
overlap safe, and the next tick recovers. A pass that never finishes holds nothing
open.

## What is not built

No manual journal entry, as above. No branch dimension on a posting. A refund sent
to the accounting system is not watched for deletion over there, and neither is a
credit note application. A credit note used on an invoice raised to a different
customer it pays for goes to QuickBooks under the credit note's customer and is
refused there, because a QuickBooks payment cannot link two customers' documents. There is no
reconciliation screen against a bank feed, and no fixed asset or depreciation
handling: a company that needs those does them in the accounting system, which is
where they belong.
