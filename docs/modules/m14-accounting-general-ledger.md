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

**A manual journal is allowed, under rules that answer why there was none.** A
posting is usually a consequence of a guarded business action: invoicing,
taking a payment, writing one off. An operator who can post freely can make the
books say anything, so for a long time there was no journal entry surface at
all, and an accountant's rent, depreciation, accruals and payroll never reached
this ledger: every report here disagreed with the books by exactly their work.
Now a journal entry exists under its own permission, `ledger:post`, and it is
balanced or refused line by line with the imbalance named, never dated in the
future or into a closed period, never posted to an account the product keeps in
step with documents (the receivable, customer deposits, tips and commission
owed, deferred revenue: correct those through the credit note, refund or
deposit instead), reversed by a reversing entry that points at what it takes
back and never edited, reversed once, and audited.

**A journal line says what it is about, and that is the company's own.** Rent
for one shop, a subcontractor's bill for one job and a cost that is one
customer's are the commonest reasons an accountant books a journal, so each line
can carry a branch, a job and a customer. Each is checked to be this company's
before anything is written, and the refusal names the line: a foreign key
accepts another company's job, because a foreign key is not row level security.
A branch that has been retired, and a job or customer that has been removed, are
refused too, since nothing new is booked against what the company has put away.
A line that names a job and no branch takes the job's branch, as every posting
does, and a line that names a branch keeps it, because rent for two shops is one
bill. A reversal puts the same branch, job and customer on the line that takes
one back, so the two net to nothing where they were. The branch and the
customer go to the books where each book has a place for them (below); the job
stays here, because neither book has a place on a journal line that means a
job.

**Every posting the product writes from a branch's job or invoice carries that
branch.** `ledger_entry.business_unit_id` existed from the first migration and
nothing wrote it, which is why the trial balance had no branch filter: filling it
on invoices alone would have given a branch its revenue and none of its payments,
write offs or deposits, a number that is plausible and wrong. So it is carried
through every path, once, at the door every posting goes through (`writePosting`,
with the rules in `services/ledger-branch.ts`). A branch is a job's: an invoice
is in its job's branch, and only an invoice with no job falls back to the branch
written on it. One branch per posting, taken from the document it is about, so
everything it writes lands in the same branch: voids, write offs, credit notes
and their applications and payouts, deposits with their application, refund and
forfeiture, retainage and commission follow the invoice or job they belong to; a
payment, a refund of one and a credit applied follow the invoices the payment
was applied to, and only when they are all in one branch. A guard test lists
every kind of posting core can write and fails on one that has neither a way to
its branch nor a stated reason it has none.

**What has no branch says so.** Nothing old is migrated: `ledger_entry` refuses
an UPDATE, and a branch guessed into a ledger is a guess for good, so every
posting made before this carries none. So do the postings that belong to the
company (payroll, the release of deferred revenue, breakage), a payment spread
over invoices in two branches (splitting it would be a number nobody recorded),
and the other side of a journal line that named a branch and no more. A report
narrowed to a branch holds what can be traced to it, and every ledger report
says how many entries in its window carry no branch, what their debits add up
to, and the first day any entry carries one. A branch's totals need not balance
by themselves, because a journal can give each of its lines a branch of its own;
only the whole company's do, and only that is asserted. A posting stays in the
branch its job was in when it was made: moving a job later does not move what
was posted.

**The books can be read by branch, once a person says what each branch is
there.** QuickBooks calls it a class and Xero an option of a tracking category,
and `PUT /v1/accounting/branch-mappings` maps one of the company's branches to
one, chosen from the list the books hold (`GET /v1/accounting/branch-options`,
a read made when a person asks and never on a sync pass). Nothing is matched by
name. From the next pass, a document goes with the class or tracking option of
the branch its posting carries: an invoice on every line and its tax lines, a
credit note and the invoice that reverses a voided one, the credit memo for a
void or write off (the invoice's branch), a refund on its expense line (and in
Xero on both its invoice and its Spend Money), and credit paid back on its
QuickBooks cheque. A journal sends each line's own branch, so rent for two shops
goes as two classes, and on QuickBooks each line's customer as the line's
`Entity`, the customer pushed first like any document's; a Xero manual journal
line takes no contact, so none is sent and no customer is pushed for it.
Payments and credit note applications go without one, because a QuickBooks
payment and a Xero batch payment or allocation have no class or tracking
field; QuickBooks reports a payment under the classes of the invoices it pays.
Mapping is optional: a branch nobody mapped, and a posting that carries no
branch or two, send nothing extra, exactly as before, and hold nothing back.
QuickBooks gets the class on each line, so its class tracking has to be set to
one class per row (see Setup).

**A document deleted in the books after it was sent is noticed, flagged here,
and handed to a person.** The read of changes that each pass already makes
covers journals and refunds too: QuickBooks' change data capture request now
names `JournalEntry` and `Purchase` beside the four it read, at no extra read,
and Xero's modified since read now also walks `ManualJournals` and
`BankTransactions` (two more calls a pass against its limits). A credit note's
use on an invoice is a Payment in QuickBooks, already read; in Xero it is an
allocation inside the credit note, so when a credit note read lists its
allocations, a use sent from here that is no longer among them (matched by
Xero's allocation id, or by invoice and amount where Xero gave none) is taken as
removed, and a read that lists none concludes nothing. On the pass that notices
it, the link is marked deleted with the time, a high priority task goes to the
`books` queue saying what was deleted and the two ways out, and the record here
says so: the journal on `/books`, the use of the credit on the credit note's
page, and the refund on the customer's payments, with a button to send it again
for somebody holding `accounting:sync`. Any other document deleted over there
(an invoice, a payment, a credit note) gets the same task and stays on the
problems list. Nothing is re-sent or reversed by itself; sending it again is
the retry, which clears the flag, and taking it out here is the record's own
reversal.

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

**A credit note becomes five kinds of document, each waiting for the one before.**
Issued, it goes as a QuickBooks CreditMemo or a Xero ACCRECCREDIT credit note, with
its own lines on the revenue account the ledger debited when it was issued and its
tax on the mapped tax account, exactly as an invoice's lines are mapped. Each time it
is used on an invoice, that application goes on its own date once both documents are
over there: in QuickBooks as a zero payment linking the invoice and the credit memo,
in Xero as an Allocation on the credit note. A void goes as an invoice for the same
lines dated the day of the void, settled against the credit note the same way, rather
than as either book's own void: QuickBooks' API offers no void for a credit memo, only
a delete, and Xero's void takes the credit out of the period it was issued in, which
may be closed. Credit paid back to the customer as money goes, once the credit note
is over there and on the day the money went, in Xero as a payment against the credit
note out of the mapped cash account, and in QuickBooks as a cheque from that account
to the customer's receivable, which is the first half of Intuit's own steps for
refunding a credit (see What is not built for the second). A card payout goes only
once the card processor has said the refund moved, because only then is it posted
here. A credit note voided before it reached the books never goes. Each is
dated by its own act for the close (issue, application, payout, void), offered a bounded
number of times, refused by name when an account is unmapped, and found again after a
lost response: by its number, or for a Xero allocation by reading the credit note and
matching the invoice, amount and date. A write off sent after a credit note was used
on the invoice credits only what was left owing.

**Sales tax goes over as the document charged it, one line per rate.** The tax on an
invoice or a credit note is sent as its own line against the mapped sales tax
account (2200), never through QuickBooks' automated sales tax or a Xero tax rate,
because their engines would work the tax out again from their own tables and the
books would disagree with the document the customer holds. A document that charged
two of the company's rates (M13) is sent as one line per rate on that account,
"Sales tax, Travis County 8.25%", read from the ledger's one entry per rate, so the
books show what each rate collected; one rate is one "Sales tax" line, as before.
No mapping of a rate to a QuickBooks tax agency or a Xero tax rate is asked for,
because nothing sent uses one.

## Setup

QuickBooks Online or Xero is connected at `/settings/integrations`.
`GET /v1/accounting/accounts` reads the chart of accounts from over there, and
`PUT /v1/accounting/mappings` says which of this product's categories lands in
which account. Nothing syncs until the mappings it needs exist, because a default
is worse than a refusal.

`/settings/accounting` is the screen for both, under Settings beside
Integrations, and needs `accounting:sync` like the routes (the accountant, who
holds it and not `settings:read`, reaches it from a link on `/books`). It lists
every account the product posts to, with its own name ("4000 Revenue from
work"), where it goes in the books now, and a Needed mark on each one postings
already use that has no mapping. The chart is read from the books only when
somebody presses "Read the accounts from QuickBooks Online to change these":
QuickBooks meters reads, so an ordinary visit reads nothing, and the mapping
stores the name that was chosen so the page can show it without a read. The
accounts and the books' products and services are then offered in one list per
account, grouped as income, expenses, assets, liabilities and equity, with the
current choice selected and an account switched off over there left out. One
save maps every account that was changed, through `PUT /v1/accounting/mappings`'s
own service, audited per account, and goes back to the plain page, so saving
reads nothing again. A refusal names the account it stopped at.

In QuickBooks, turn off **Automatically apply credits** (Account and settings,
Advanced). With it on, QuickBooks applies a new credit memo to the customer's
oldest open invoice by itself, which may not be the invoice it was used on here,
and the application sent afterwards is then refused with QuickBooks' own reason
and shows on the problems list.

To send branches, map each one with `PUT /v1/accounting/branch-mappings`
(`businessUnitId`, the class or option's `externalId` and `externalName`, and
for Xero the tracking category's `groupId` and `groupName`), choosing from
`GET /v1/accounting/branch-options`. On `/settings/accounting` the same is a
list of the company's branches (and a retired one while it is still mapped)
with what each goes as; "Read the classes" reads the list from the books, only
then, and one save maps every branch changed. "Stop sending" beside a mapped
branch is `DELETE /v1/accounting/branch-mappings/{businessUnitId}`. A Xero
option is shown with its category, "Region: North". In QuickBooks, turn on **Track classes**
and set it to **One to each row in transaction** (Account and settings,
Advanced): the class is sent on each line, and with one class per transaction
QuickBooks ignores it.

## Using it

### Read the books

`GET /v1/ledger/trial-balance` is every account with its two sides and its
balance, grouped in SQL because this is the one report that reads the whole
ledger and a company closing its fifth year has a lot of it.
`GET /v1/ledger/journal` is the entries. Both need `ledger:read`, and both take
`businessUnitId`: a branch, or `none` for the entries that carry no branch.

`/books/trial-balance` is the first one on a screen: two days in the company's
calendar (both included), and a Branch choice of the whole company, one branch
or No branch. Under the table it says how many entries in those days carry no
branch and what they add up to, and from which day entries carry one. The
whole company's report says so loudly when its debits and credits differ; a
branch's does not, and says why.

### Run the sync

`POST /v1/accounting/sync` runs a pass, `GET /v1/accounting/status` says where it
stands, `GET /v1/accounting/runs` is the history, and
`GET /v1/accounting/problems` is the documents it could not place, with
`POST /v1/accounting/problems/{id}/retry` to offer one again. All of them need
`accounting:sync`. Each problem says whether it was refused (`failed`) or
deleted in the books (`deleted`).

Each pass writes down every document it sent, every one it found already in
the books (a pass before it sent it and lost the answer) and every one it
refused, with the reason: the books' own words for a refusal over there, or
this product's for one made before sending (an account not mapped, a book that
cannot take a journal). `GET /v1/accounting/runs` counts them per pass (`sent`,
`found`, `refused`) beside the reads and writes, and
`GET /v1/accounting/runs/{id}` lists them, refusals first, up to 500. A
document already in the books and passed over is not written down, because
that is every document on every pass after the first; nor is one that has
stopped being offered, which is on the problems list instead. The list is
written in the same transaction that records the outcome on the document's
link, so the two cannot disagree.

On `/settings/accounting`, **Sync now** runs a pass (the same call as
`POST /v1/accounting/sync`; pressing it twice cannot send anything twice) and
opens what it did. Below it are the last twenty passes: when each started,
what it did in words ("Sent 3, refused 1", or "Nothing new to send"), how it
ended (finished, still running, stopped with an error and the error, or sent
but out of reads for now), and "See the documents" for one that touched any,
which lists each document in words with a link to its own page where it has
one, Sent, Already there, or Refused with the reason. A pass that cannot even
start (the books' credential gone from the secret store) says so under the
button.

The problems are on `/settings/accounting` too: each document in words with a
link to its own page where it has one (an invoice, a void or write off of one,
a credit note, a customer, a journal), what happened (refused and tried again
on each sync, stopped after five tries, or deleted in the books) with the
books' own reason, when it was last tried, and "Send it again", which is the
retry: the attempts start again under the same claim, so it cannot reach the
books twice. A document already waiting for the next sync is not offered the
button.

### Post a journal entry

`/books` lists every journal entry with its lines, posts a new one (a date, what
it is for, and up to eight lines of an account with a debit or a credit, and for
each line a branch from the list, a job by the number it is printed with and a
customer by their exact name) and reverses one. A job number or a customer name
that matches nothing, or two customers, is refused against its line rather than
guessed at. A line on a job counts in that job's margin (M15).
`POST /v1/ledger/journal-entries` posts one, taking each line's
`businessUnitId`, `jobId` and `customerId`,
`POST /v1/ledger/journal-entries/{id}/reverse` reverses it (today, or another open
day not before the original), and `GET /v1/ledger/journal-entries` lists them.
On the next sync each one goes to the books as a QuickBooks JournalEntry
numbered `OTJ` and the journal's number, or a posted Xero manual journal whose
narration starts with that key, once every account on it is mapped; an unmapped
account stops it and names the code on the problems list. A reversal is a
journal of its own and goes the same way. An accounting adapter that cannot
take a journal records each one as a problem saying so.

### Close a month

`POST /v1/accounting/periods/close` closes a period and
`POST /v1/accounting/periods/reopen` opens it again, with a reason, which is
required and kept. Both need `accounting:close`, which is a different
permission from running the sync; `GET /v1/accounting/periods` lists every
close, reopened ones included, and needs `accounting:sync`. Nothing posts into
a closed period, including a back dated document from a migration, and the
refusal names the period. A close is refused on or before the day already
closed through, and for a day that has not come yet in the company's calendar
(today is the latest). A period that was reopened can be closed again: the
reopened close stays on the record and the new one is a row of its own.

`/books/periods` (Books, Closing the books) is the screen. It says how far the
books are closed, closes them through a day (suggesting the end of last
month), with a note, and lists every close with when it was made, its note,
and whether it is still in force or was reopened, when and why. Each close in
force has a Reopen button that asks why. Reading it needs `accounting:sync`
and closing or reopening `accounting:close`, as the routes do; a person
without the second sees the list and a sentence saying which permission
closing needs. It is on Books rather than under the accounting settings
because a close holds the ledger whether or not any books are connected;
`/settings/accounting` links to it.

## Permissions

| Role | Access |
|---|---|
| Owner | Everything |
| Administrator | Everything except the ledger and closing a period, which are granted explicitly |
| Office manager | Neither the ledger nor the sync |
| Accountant | Reads the ledger, posts and reverses journal entries, runs the sync, closes the period |

`ledger:read` is on the sensitive list. The administrator preset deliberately
excludes it along with `ledger:post` and `accounting:close`: running the system is
not the same job as keeping the books, and a company that wants one person doing
both grants it rather than inheriting it.

## API

| Call | Needs |
|---|---|
| `GET /v1/ledger/trial-balance` | `ledger:read` |
| `GET /v1/ledger/journal` | `ledger:read` |
| `GET /v1/ledger/journal-entries` | `ledger:read` |
| `POST /v1/ledger/journal-entries` | `ledger:post` |
| `POST /v1/ledger/journal-entries/{id}/reverse` | `ledger:post` |
| `GET /v1/accounting/accounts` | `accounting:sync` |
| `PUT /v1/accounting/mappings` | `accounting:sync` |
| `GET /v1/accounting/branch-options` | `accounting:sync` |
| `GET /v1/accounting/branch-mappings` | `accounting:sync` |
| `PUT /v1/accounting/branch-mappings` | `accounting:sync` |
| `DELETE /v1/accounting/branch-mappings/{businessUnitId}` | `accounting:sync` |
| `POST /v1/accounting/sync` | `accounting:sync` |
| `GET /v1/accounting/runs` | `accounting:sync` |
| `GET /v1/accounting/runs/{id}` | `accounting:sync` |
| `GET /v1/accounting/problems` | `accounting:sync` |
| `POST /v1/accounting/problems/{id}/retry` | `accounting:sync` |
| `GET /v1/accounting/periods` | `accounting:sync` |
| `POST /v1/accounting/periods/close` | `accounting:close` |
| `POST /v1/accounting/periods/reopen` | `accounting:close` |

## Common questions

**Is the seeded demo company's ledger real?** Yes. Its invoices and payments are
raised and paid through the billing service, so the postings behind them are real
and seeded jobs show the revenue their invoices posted. That is why the seed lives
in the API package.

**Can the trial balance be filtered by branch?** Yes, for what has a branch.
It could not be while nothing wrote the column: a filter matched nothing, and
filling it on the invoice path alone would have produced a branch's revenue with
none of its payments. Every posting made since carries the branch of the job or
invoice it came from, so the filtered report has the branch's invoices, payments,
write offs, credits, deposits and the cost posted on its jobs. Postings before
that have no branch and are in no branch's report, and the report says how many.
Choose No branch to read them.

**Why does a branch's trial balance not balance?** It need not. A journal can
give one line a branch and another none (rent for two shops on one bill), so a
branch can hold one side of an entry. The whole company's always balances.

**A job moved to another branch: what happens to its postings?** They stay where
they were posted, because the ledger cannot be updated. New postings on the job
go to its new branch.

**What happens if the sync is interrupted?** The claim a pass takes is what makes
overlap safe, and the next tick recovers. A pass that never finishes holds nothing
open.

## What is not built

A journal entry cannot be edited, only reversed. Sending branches, customers on
journal lines and the deletion watch are tested against fakes of QuickBooks'
and Xero's APIs (their documented request and response shapes), not against a
live company in either. A line's job is not sent, because neither book has a
place for it on a journal line. Payments and credit note applications carry no
class or tracking option, because neither book's payment or allocation takes
one. The account and branch mappings, running a pass, what each pass sent and
refused and the problems list are on `/settings/accounting`, and closing and
reopening a period on `/books/periods`. The screens have been driven against a
fake of QuickBooks' query, token, customer and change feed endpoints only,
never Xero's. A pass's history lists up to 500 of its documents, refusals
first, and keeps every pass for as long as the connection: nothing trims it.
A close cannot be made through a day that has not come, which the API refused
for nobody before; a company that wants a month shut before its last day has
to wait for the day. The deletion watch reads Xero's allocations only
when its credit note read lists them, does not watch the settlement a void
makes in Xero, and in Xero watches a refund through its Spend Money and not the
invoice that puts it back on the receivable; a credit paid back in Xero is not
watched. A branch's books hold what can be traced to a job or invoice: payroll,
breakage and the release of deferred revenue have no branch, nothing posted
before branches were carried has one, and the branch on a posting is the one
its job had when it was posted. A credit note used on an invoice raised to a
different customer it pays for goes to QuickBooks under the credit note's
customer and is refused there, because a QuickBooks payment cannot link two
customers' documents. Credit paid back reaches QuickBooks as the cheque to the
customer's receivable and not the receive payment that would link it to the
credit memo, which QuickBooks' API is not documented to take: the customer's
balance over there is right, and the credit memo shows as unapplied until a
bookkeeper links the two by hand. Retainage held on an application for payment
is booked here to retainage receivable against revenue (M12) and not sent: the
books there carry the application's invoice as billed, net of retainage, and
revenue there is gross only once a bookkeeper posts the retainage by journal.
The accounting settings do not ask for account 1210 to be mapped, because
nothing sent lands on it. Sales tax arrives in the books as lines on the
liability account, so QuickBooks' sales tax centre and Xero's sales tax report
do not show it by agency or jurisdiction; tax by rate for filing is read here
(`/books/sales-tax`). There is no reconciliation screen against a bank feed,
and no fixed asset or depreciation handling: a company that needs those does
them in the accounting system, which is where they belong.
