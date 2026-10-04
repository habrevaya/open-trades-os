---
title: Invoicing and Payments
module: M13
domain: Money
phase: 1
status: partial
---

# Invoicing and Payments

> Module M13. Domain: Money. Ships in phase 1.

## What it does

Raises an invoice from a job, issues it, sends it, takes the money, and keeps a
record of where every dollar went that still reconciles six years later.

## The problem

Invoicing looks like the easy part and it is where most of this product's hard
rules live, because money has to agree with itself from four directions: what the
customer was charged, what arrived, what it was applied to, and what the ledger
says. Any two of those disagreeing is a dispute, an audit finding, or a
bookkeeper's afternoon.

## Key concepts

**Totals are computed server side and a client supplied total is ignored.** Not
distrust of our own web app: the same API serves a third party integration, an AI
agent and an offline mobile client, and exactly one of them should be allowed to
decide what something costs.

**A draft is edited, issued or thrown away.** Those are the three things that can
happen to one, and the pricing rules for editing a draft are the same code as
pricing a new invoice. Two copies of those rules would be two invoices that
disagree about the same lines.

**Every line says who priced it.** Our price book, a price somebody typed, or a
client's rate card, warranty schedule or manufacturer allowance, with how and
the working in a sentence. Recorded when the line is priced and never worked out
again, because "whose price is that" is the first question about a rejected
commercial invoice. The authorities themselves are M31's.

**The customer's share under coverage is taken off as the invoice is raised.**
An invoice to the job's own customer on a job a warranty or plan covers carries
only the customer's part of each covered line, with a sentence saying what the
coverage took. The rules are M32's.

**An invoice line names the job line it bills.** That is what makes "what is
still to invoice" a query. A line billed twice is the customer charged twice for
one capacitor; a warranty part billed at all is the complaint that ends the
relationship.

**Allocation is the part that decides whether a month end reconciles.** A payment
can span invoices and an invoice can take many payments. Left unspecified, money
is applied oldest balance first, which is what a bookkeeper does by hand and what
a customer expects.

**"Oldest" has to be a total order.** It was issue date alone, and a company
invoicing four jobs in one morning gives four invoices the same issue date:
Postgres then returns them in whatever order the heap holds, and a part payment
lands on an arbitrary one. The first tie break is the DUE date rather than the
issue date, because that is the order the aging report buckets by and the order
the customer is chased in, so it is the one a part payment should clear.

**Where money may be applied is asked the same way whoever is applying it.** This
customer's invoice (or the invoice's payer's), open, a positive amount, never more
than the balance, counting every line for the same invoice together. Recording a
payment with its allocations named used to check none of that: money could land on
another customer's invoice, on a void or draft one, or for more than was owed,
leaving a negative balance the receivables report counted as money the company
owed back.

**A refund is negative allocation rows, not an edit.** The allocations are the
history of where this money went, and that history now says it came back. Out of
held money first, because returning a credit nobody used reverses nothing that was
ever owed; beyond that it reopens what the payment paid, newest allocation first.
A void or written off invoice is refused rather than reopened, because the money it
received cannot go back onto a receivable that no longer exists.

**A card refund and a hand recorded refund post identically.** One shared
function, so the two cannot disagree about which invoices reopen or what the
posting says.

**A deposit is a liability from the moment it arrives.** It posts distinctly on
receipt, on application, on refund and on forfeiture, because those are four
different things happening to somebody else's money.

**A payment is recorded only from a verified webhook.** So is a refund. A card
refund Stripe reports reopens the invoices it paid and posts to the ledger exactly
as one recorded by hand does, dated when it was made, booked once per Stripe
refund id.

**A tip is the technicians' money, held, never the company's revenue.** A
customer paying from the portal can add one when the company has turned
tipping on, and so can one paying cash or a check to the technician on site. The card is charged the balance and the tip together; when the
money arrives the payment's amount is the balance, which goes on the invoice,
and its tip amount is credited to Tips payable (2250), a liability, by the
same `postPayment` that has always had a tip leg. Nothing of it touches
revenue, sales tax or commission. It is split evenly between the technicians
on the job's visits, written as shares beside the payment, and leaves the
books when payroll passes it on (M17), which debits Tips payable against
cash. When less arrives than was asked for, the invoice is paid first and the
tip takes what is left. This is what `ledger.ts` already said a tip is, and it
is now reachable.

**A saved card is a reference, not a card.** A signed in customer saves one
through Stripe's own setup flow, and this server keeps Stripe's id for it, the
brand, the last four digits and the expiry, which recognise it and cannot
charge it. A charge with one is confirmed on the spot because the customer is
on the page pressing Pay, and is settled, like every card payment, only by the
signed webhook.

**A job already marked paid stays paid when a refund arrives.** Its lifecycle does
not go backwards, and the invoice is what now shows money owed.

## Setup

Stripe is connected at `/settings/integrations`, on the company's own account
with a restricted key, by the names of the secrets rather than by pasting secrets
into a form. The webhook address Settings shows has to be pasted into the Stripe
dashboard; that is not something this product can do on its screens, and the
screen says so.

## Using it

### Raise and issue

`POST /v1/invoices` from a job, `POST /v1/invoices/{id}/issue` to issue a draft,
`POST /v1/invoices/{invoiceId}/send` to send it. `/invoices/new` and
`/invoices/{id}` are the office screens, and `/invoices/{id}/edit` is a draft.

### Take money

`POST /v1/payments` records one, whatever its method.
`POST /v1/payments/intents` starts a card, which the office takes from the
invoice screen through Stripe's Payment Element, and the customer takes from
`/i/{token}`, the account link or their signed in account, with a tip when the
company takes them (`POST /v1/portal/invoice/pay` and
`POST /v1/portal/account/pay` carry it). A saved card pays through
`POST /v1/portal/cards/{cardId}/pay`. The invoice screen lists the tips that
came with its payments and who each is for, under **Tips**, and
`GET /v1/invoices/{id}/tips` is the same list. `POST /v1/payments/{id}/apply` puts held money onto invoices later.

### On site

The technician on a visit raises the invoice for its work on the phone or on
`/my-day` (`invoice:raise_on_site`, which the technician preset holds, and
which raises and issues one invoice for their own visit and nothing else),
from the option the customer signed for, copied as signed, or from the parts
and charges recorded, priced by the same rules as an invoice raised here.
The customer signs for it on the screen. A total that disagrees with what
the customer was shown is kept as a draft for the office rather than issued.
Cash and checks are taken against it with a tip on top when the company
takes tips, split between everybody on the job as a portal tip is; a card
through its link, and financing through the lender's application,
`POST /v1/visits/{id}/financing-link`, texted or handed over. M11 has the
whole of it.

### Give money back

`POST /v1/payments/{id}/refunds` records one paid by hand and
`POST /v1/payments/{paymentId}/refund` sends one to the processor.
`POST /v1/invoices/{id}/void` and
`POST /v1/invoices/{id}/write-off` are the other two ways an invoice stops being
owed, and they are different permissions because they are different admissions.

### Credit notes

When the bill asked for too much, the invoice is credited rather than voided or
written off. Open the invoice, choose **Credit this invoice**, and put how much
comes off each line. The tax comes back at the rate that line was charged, and
the credit comes off what is still owed. A credit that is not about one invoice
(goodwill after a bad visit, what is owed back at the end of a contract) is given
from the customer page with **Give a credit**, and sits on their account until it
is used on an invoice from the credit note's own page.

A credit note numbers in its own sequence. Issuing it reverses the revenue and the
sales tax and leaves the amount owed to the customer as a liability; using it on an
invoice settles that against the receivable. The invoice's paid amount never
changes, so a collections report never counts a credit as cash. A line can never
be credited for more than it charged, counting every earlier credit and draft, and
goodwill needs a note. `/invoices/credit-notes` lists every one, with what is still
unused.

**Paying a credit back.** A credit the customer cannot use on another invoice
can be given back as money from the credit note's page, with **Pay it back**
(`POST /v1/credit-notes/{id}/payouts`, which needs `payment:refund`, because
sending money back is a different decision from raising the credit). Back to
their card goes through the card processor as a refund against one of their
earlier card payments (`GET /v1/credit-notes/{id}/refundable-payments` lists
them with what each still has to refund): the credit is set aside at once, so
it cannot also be used on an invoice, and it is posted only when the
processor's webhook says the refund moved, like any card refund; a refund the
processor declines keeps nothing, and one it reports failed puts the credit
back on the account. Cash, a cheque or another way is recorded as handed
over and posted on the day given. Either way the posting takes the credit out
of customer deposits against cash and touches no invoice: the card payment
records the money as refunded and as paid out, and still says it paid what it
paid, so the invoice stays paid and nothing is reopened. The customer's
statement shows it as the credit paid back. A credit note any of which has
been paid out cannot be voided.

A company syncing its books gets each credit note there too: the credit note itself,
each use of it on an invoice on the day it was used, each payout on the day it
was paid, and a void as an invoice reversing it on the day of the void. M14 says
how each lands in QuickBooks and Xero.

### Invoices and proposals as PDF

**Download PDF** on an invoice's page saves it as a PDF: the company with its
logo, the customer (and who pays, when somebody else does), the address, every line, the
totals, the payments made on it and the balance due. The customer gets the same
file from the invoice link in their email and from each invoice on their account
page, never a draft and never one billed to somebody else. An estimate's page and
its printable proposal offer the proposal as a PDF, every option with its lines
and total and the terms, and so does the customer's estimate link. Both are built
from the same reader as the customer's screens, so no cost or margin is on them.
The office's download follows the invoice and estimate lists' scope: a technician
who sees invoices on their own work gets those and a not found for the rest.

The invoice email attaches the customer's copy as a PDF beside the link to view
and pay it, because a bookkeeper files the file. Names print as they are spelled:
the PDFs carry their own font (Noto Sans, under the SIL Open Font License, bundled
with its licence), cut down to the letters each document uses, so Nguyễn, Dvořák,
Σωκράτης and Анна print as written rather than with their accents dropped.

### Statements

**Statement** on a customer's page shows what they owed at the start of a period,
every invoice, payment, refund and credit in it with a running balance, what they
owe at the end, and the open invoices aged by how late they are. It prints as a
document, and **Download PDF** beside the print button saves it as one for the
dates on screen. The customer sees the same statement from their account link, or
signed in, under **Your statement**, with the same download. It is read from the ledger, so it agrees with the receivables
report, and moving money already held onto an invoice is not a line because nothing
the customer owes changed. On commercial work an invoice appears on the statement of
whoever pays it, not the tenant's.

**Email statement**, on the same page, sends the customer a link to that
statement on their own account page, for the dates on screen, to the address on
file or one the office types (a commercial customer's accounts mailbox is rarely
the person who booked the work). The text of the email carries no amounts: the page
reads the books when the customer opens it, so a cheque that cleared since is
already on it. The statement as it stood that day is attached as a PDF, which says
on its face that it is a copy as of that date, because a bookkeeper files the file
and an accounts payable clerk will not follow a link to fetch one. The monthly run
attaches it the same way. An address that asked
not to be emailed, a customer with no address, or no email provider connected is
recorded as not sent, with the reason, under the button, and the link minted for
it is revoked rather than left alive.

**Text statement**, beside it (`POST /v1/customers/{id}/statement/text`), sends
the same link by text, with no amounts, to the customer's main contact's mobile,
the number on the customer, or one the office types. It goes through the consent
gate every text goes through (M18): a number that replied STOP, no number to text,
or no number registered to text from is recorded as not sent with the reason, and
its link revoked.

**Monthly statements** are a setting at `/invoices/statements`, off until
somebody turns it on: on a day from 1 to 28, at a time in the company's
timezone, every customer owing more than the amount set on open invoices
(counted by whoever pays them) is emailed a link to their statement for the
month before. Each customer is sent at most one per month, whatever the worker
does: the record of it is keyed on the customer and the month under a unique
index, and is written in the same transaction as the email. With **Text it to
customers whose main contact prefers texts** ticked, the run texts the link to a
customer whose main contact prefers texts and emails everybody else; a text that
cannot go is emailed instead, and the row says why. It is off unless somebody
ticks it, including on a run set up before texting existed, because a contact
says it prefers texts unless somebody changed it, and a company that chose
emailed statements did not choose to text its customers. The same page lists
every statement sent, by hand or by the run, with how and where it went, what was
owed then, and what became of it.

### Deposits

`POST /v1/deposits` asks for one, `POST /v1/deposits/{id}/apply` puts it against
an invoice and needs `invoice:write` as well, and
`POST /v1/deposits/{id}/refund` returns or forfeits it.

### Customer financing

With a lender connected under "Customer financing" on `/settings/integrations`
(Wisetack is the one adapter), an open invoice shows "as low as" a monthly
figure for its balance, and so do the customer's invoice link at `/i/{token}`,
their estimate link and the printable proposal, per option. The figure is worked
out from the plans on the company's own Wisetack agreement, entered on the
connection as months and APR (such as `60@17.9`), as the lowest payment any plan
gives, exactly and rounded up to the cent; it is never shown without the
sentence saying it is subject to the lender's approval and that the customer's
terms may differ, and the company can hide the figure and keep the button. An
amount outside what the lender finances shows nothing.

The customer presses **Apply for financing** on their link and is taken to the
lender's own page, or the office opens the application from the **Financing**
panel on the invoice (or the estimate) and texts it, emails it or takes the link
to hand over. Pressing again for the same amount reuses the open application.
The application's status (link sent, applied, approved, declined, expired,
funded, cancelled), the amount approved and the offer the customer chose show
in the same panel. Nothing about the customer's credit is kept beyond the status
the lender returns.

Status changes arrive on a signed webhook at the address the settings screen
shows. The signature is checked, the application is read back from the lender,
and only the lender's own answer is applied, forward only, so a late, repeated or
forged delivery changes nothing. **Ask the lender** on the panel does the same
read by hand. When the loan is funded the payment is recorded through the same
path as any payment, method financing, applied to the invoice up to its balance
(anything more, or a loan on an estimate with no invoice yet, is held on the
customer's account to apply later), with the lender's fee as the payment's fee:
cash net of the fee, and the fee posted to processing fees (6100) as an expense.
It is recorded once, however many deliveries say so. A fee the lender did not
report is not guessed at: none is booked and the application says so.

`/invoices/financing` lists every application, and for whoever reads financial
reports: applications, the approval rate over the lender's decisions, funded
volume, fees and what is still waiting.

The Wisetack adapter has been tested against a fake of Wisetack's API in this
repository, not against a live account, and it needs a Wisetack merchant
account with API access. Run one application through Wisetack's sandbox before
customers see a link.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything |
| Office manager | Raises, issues, sends, voids, credits, takes payments and deposits |
| Dispatcher, CSR | Neither |
| Technician | Reads an invoice, takes a payment on site, and raises and issues the invoice for their own visit's work (`invoice:raise_on_site`). Does not write, edit or issue invoices otherwise |
| Accountant | Everything on this module, including refunds, credits and write offs |

Five separate permissions on one document, deliberately: `invoice:write`,
`invoice:send`, `invoice:void`, `invoice:writeoff` and `invoice:credit`. Voiding
says the invoice should never have existed; writing off says it existed and will
not be paid; crediting says it asked for too much. A company usually wants
different people doing those. The office manager and finance roles hold
`invoice:credit`.

## API

| Call | Needs |
|---|---|
| `GET /v1/invoices` | `invoice:read` |
| `POST /v1/invoices` | `invoice:write` |
| `POST /v1/invoices/{id}/issue` | `invoice:write` |
| `POST /v1/invoices/{invoiceId}/send` | `invoice:send` |
| `POST /v1/invoices/{id}/void` | `invoice:void` |
| `POST /v1/invoices/{id}/write-off` | `invoice:writeoff` |
| `GET /v1/customers/{id}/statement` | `invoice:read` |
| `POST /v1/customers/{id}/statement/email` | `invoice:send` |
| `POST /v1/customers/{id}/statement/text` | `invoice:send` |
| `GET /v1/statement-deliveries` | `invoice:read` |
| `GET /v1/statement-schedule` | `invoice:read` |
| `POST /v1/statement-schedule` | `invoice:send` |
| `GET /v1/credit-notes` | `invoice:read` |
| `POST /v1/credit-notes` | `invoice:credit` |
| `POST /v1/credit-notes/{id}/issue` | `invoice:credit` |
| `POST /v1/credit-notes/{id}/apply` | `invoice:credit` |
| `POST /v1/credit-notes/{id}/void` | `invoice:credit` |
| `POST /v1/credit-notes/{id}/payouts` | `payment:refund` |
| `GET /v1/credit-notes/{id}/refundable-payments` | `payment:read` |
| `GET /v1/payments` | `payment:read` |
| `POST /v1/payments` | `payment:collect` |
| `POST /v1/payments/{id}/apply` | `payment:collect` |
| `POST /v1/payments/{paymentId}/refund` | `payment:refund` |
| `GET /v1/invoices/{id}/tips` | `invoice:read` |
| `GET /v1/invoices/{invoiceId}/financing` | `invoice:read` |
| `GET /v1/financing/applications` | `payment:read` |
| `POST /v1/financing/applications` | `payment:collect` |
| `POST /v1/visits/{id}/financing-link` | `payment:collect`, and the technician on the visit or `invoice:send` |
| `POST /v1/financing/applications/{id}/refresh` | `payment:collect` |
| `GET /v1/financing/report` | `report.financial:read` |
| `GET /v1/deposits` | `deposit:read` |
| `POST /v1/deposits` | `deposit:collect` |
| `POST /v1/deposits/{id}/refund` | `deposit:refund` |

A payment list is paged on the received instant and then the id, because a
migration loads hundreds of payments dated the same day and a cursor on the
instant alone would skip or repeat them at a page boundary.

## Common questions

**Can I invoice part of a job?** Yes. An invoice names the job lines it bills,
and the rest stay billable.

**What happens with no processor connected?** The customer's invoice page shows
the balance and tells them to reply to arrange payment, because there is no other
way to pay from it.

**Why does a card payment only show paid after the webhook?** Because a payment
intent that was created is not money. The webhook is the only thing that says it
arrived.

**What is the difference between a credit note, a void and a write off?** A void
says the invoice should never have existed. A write off says it was right and the
money will not arrive, which is bad debt. A credit note says it asked for too much,
which is neither.

**Can a deposit be taken on a booking request?** No. There is no customer yet to
hold one for.

## What is not built

A credit is paid back to a card only through one of the customer's own earlier
card payments with enough left to refund, one payment per payout, and never to a
card they did not pay with. A card payout waits for the processor's webhook like
every card refund, so with no webhook configured it stays with the card
processor on the screen. A credit note that has been used or paid out cannot be
voided; the invoice it settled has to be dealt with on its own.
A statement is emailed as a link with a PDF attached, or texted as the link
alone: a text carries no file. The monthly run reads a customer's preference from
their main contact only, not from who the invoices name. It covers the calendar
month before and nothing else, and it emails nothing until an email provider is
connected. A tip is taken from the portal and, with cash or a check, on site; the office's own card
and cash screens record none, and refunding a payment refunds the invoice part and leaves its tip owed to the
technicians, because handing a tip back is a decision nobody here has made for the company. A refund made in
Stripe's own dashboard for the whole charge books only the invoice part, and the tip stays owed in the books
until somebody corrects it by hand. Saved cards are
Stripe's only. Tax rate determination is deliberately not
built: the rate is on the line it was charged on, and BUILD.md says why. Overdue
invoices are chased by the collections agent (M27): a reminder per step the
company sets, drafted on the company's model key and sent from
`/invoices/reminders` by a person or on its own when the company lets it. It
needs the company's own model key (M27); chasing without one is a workflow
somebody builds in M29. Financing has one lender adapter, Wisetack, tested against a fake rather
than a live account; a loan Wisetack refunds after funding is flagged on the
application and not reversed, so the refund is recorded on the payment by hand,
and the payment is dated when the funding was heard about rather than the
lender's settlement date. "As low as" uses the plans entered on the connection
and is not asked of the lender per customer.

The PDFs print the company's logo when it is a PNG or a JPEG (a PNG with
transparency or a palette included); an SVG or WebP logo is left off and the name
printed alone. The bundled font covers Latin with every extension, Vietnamese,
Greek and Cyrillic; a letter outside those (Chinese, Japanese, Korean, Arabic,
Hebrew, Thai and the scripts of India) prints as its base letter where it has one
and as "?" where it does not.
