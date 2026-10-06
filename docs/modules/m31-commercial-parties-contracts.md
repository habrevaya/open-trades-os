---
title: Commercial Parties, Contracts and Third-Party Billing
module: M31
domain: Money
phase: 5
status: partial
---

# Commercial Parties, Contracts and Third-Party Billing

> Module M31. Domain: Money. Ships in phase 5.

## The assumption this module removes

The product encoded one assumption so deeply it was invisible: ONE customer
who owns the property, approves the work, receives the invoice and pays it, at
a price from our own price book, with no intermediary.

That is true for residential service and false for roughly half the market.

| | Orders it | On site | Approves | Pays |
|---|---|---|---|---|
| Commercial FM | a facilities network | a store manager | the client, to a ceiling | a corporate AP portal |
| Property management | a manager | a tenant | the manager | the owner |
| Home warranty | a warranty company | the homeowner | the warranty company | the warranty company, less a call fee |
| Builder | a superintendent | the super | the GC | the builder, on draws |
| Restoration | the homeowner | the homeowner | an adjuster | the carrier, less the excess |

## What is built

**The cast.** A job carries the set of parties involved: who asked, who is
there, who approves, who is billed, who pays, who referred it. Residential is
the degenerate case, one customer holding every role, and a job with no
parties behaves exactly as it always did. That is the test a change like this
has to pass.

**The ceiling.** Not-to-exceed, coverage limit, approval limit and
authorisation number are one concept: a maximum we may not bill past without a
separate approval event.

**The mirror.** A work order created in a facilities network, a warranty
administrator's portal or a manufacturer's dealer system, mirrored here with
their id as the key, their status verbatim, and a push queue for what they have
not yet been told. The adapters that talk to those networks are NOT here; what
is here is everything that does not depend on them.

**The price.** A client's rate card, a warranty network's schedule or a
manufacturer's allowance prices the work that payer pays for, with our price
book as the fallback, and every invoice line says which priced it.

**The clocks.** Response times, the invoicing window and the claim deadline
come from the contract, run on every job under it, and raise a task before
they breach.

**The split.** One job billed to two payers, by coverage or by share, as two
invoices that add up to the work.

## Key concepts

**The invoice goes to whoever is being billed, not to whoever is on site.** An
invoice addressed to the tenant is a document the payer will not accept and
the tenant should never have seen. Invoicing refuses it and names the party
who should have received it.

**Nobody named is not the same as naming the customer.** A job with no bill-to
party is the residential case and invoices exactly as before. Treating the
absence as a decision would make the two indistinguishable, and only one of
them should refuse an invoice addressed elsewhere.

**A ceiling is not a permission system.** A residential job has nobody to
authorise it, and a job with no authorisation bills whatever it costs. An
authorisation stating no limit is the same answer: "approved, bill what it
costs" is a real thing a client says, and reading that null as zero would
refuse every one of them.

**The ceiling counts what earlier invoices used.** This is the case that is
usually got wrong: two invoices on one job, each fitting on its own, together
over the limit. The consumption is an increment rather than a write of a
computed total, so two raised at the same moment cannot both read three
hundred and both write six hundred.

**A supplement supersedes rather than adds.** Two live ceilings is two answers
to "how much may we bill". The supplement carries the old consumption forward:
resetting it would let a client who authorised five hundred, then another five
hundred after three hundred was billed, be invoiced thirteen hundred.

**Going over is recorded, not lost.** Some networks allow the overage and
chase it afterwards, so `exceeded` is a state rather than only a refusal. That
is what makes "how often do we go over, and with whom" a question with an
answer.

**The refusal has to be actionable.** Whoever is invoicing did not ask for the
authorisation and cannot see it. A refusal that does not name the ceiling,
what is already billed and what would fit is a refusal somebody works around
by turning the feature off, so it says all three and suggests the supplement.

## Using it

### Say who is involved

Set the cast on the job. Each party is a customer, a contact, or a name with
no record of its own, which is what "ABC Warranty, claim 44812" is. A role
with nothing in it is refused, because an empty row reads on the screen as
somebody being responsible.

### Record what they authorised

Authorise the job with an amount, who granted it and their reference. Leave
the amount off for "bill what it costs". A supplement is another
authorisation, which supersedes the first and keeps its consumption.

### Invoice it

Invoicing checks both: the right party, and the ceiling. It consumes the
ceiling once the invoice exists.

## Working somebody else's queue

In five segments the contractor is a vendor in somebody else's software: a
facilities network dispatches to them, a warranty administrator assigns a
claim, a manufacturer sends a dealer a warranty job, a marketplace sells a
lead. The order arrives in that portal, it is accepted or declined there, the
status is pushed back at every step, and the portal's view decides whether the
invoice is paid.

### Why this is not a few columns on `job`

**An order can be rejected, and a rejected order must never become a job.**
Half of what arrives on a facilities network is declined. Modelling it as a job
with a status would put work nobody is doing on the dispatch board and in the
margin report.

**The ids are theirs.** `(source_system, external_id)` is the natural key and
it is what an inbound sync is idempotent on. A job number is ours.

**The status we owe them is not the status of our work.** `pending_push` is a
queue, and a status changed and never pushed is a contractor whose scorecard
says they never responded. That queue has no home on a job row.

### The asymmetry

What we may do is deliberately narrower than what they may do.

`cancelled_by_client`, `reopened` and `closed` are refused from our side.
Neither of the first two is ours to declare: a contractor who could mark an
order cancelled by the client could make their own missed deadline look like
the client's change of mind, and the portal would disagree the moment anybody
looked.

Inbound, nothing is validated. Their portal has states we have never seen,
renames them between releases and skips ours. A status we cannot place is
recorded verbatim in `external_status` with our state left where it was,
because refusing an inbound update for being unfamiliar is the one failure this
table exists to prevent: an integration that stops the day the client renames
"Dispatched" to "Assigned" is a vendor whose statuses silently stop arriving.

### Two flags that differ per network

**`acceptance_is_irreversible`.** Some networks make acceptance final the
moment it is sent. A product that lets a dispatcher un-accept on one of those
has taught them a habit that costs a chargeback the first time it matters.

**`accepts_via_invoice_only`.** Some have no accept call at all: they take a
work order by receiving an invoice for it. An Accept button that posts nowhere
is worse than none, because it tells a dispatcher the job is theirs when the
client has not heard from us. `POST .../accept-via-invoice` is what accepting
means there, and it is a separate operation because the two are different acts:
one says we will do this, the other says we have done it and here is the bill.

A network with no profile in `core/external-work` gets the cautious default of
each: acceptance assumed final, because the cost of being wrong is asymmetric.
Assuming it can be undone when it cannot produces a chargeback; assuming it
cannot when it can produces one phone call.

### A conflict is not a merge

The external system is the system of record, and `POST .../remote` honours
that including when it contradicts us.

When we were still holding a change they have not seen, theirs replaces it and
ours is **written down**: the audit line carries both states and a sentence
saying what was lost. "We marked it complete on the 4th and their portal says it
was still open on the 11th" is a dispute somebody has to be able to reconstruct,
and it is the dispute that decides who pays for the trip.

The test is not whether the states differ. A portal confirming the `completed`
we pushed differs from nothing and loses nothing; reporting a conflict there
would make every normal sync look like a dispute. What decides it is
`pending_push`: if it is false, whatever we last said reached them and their
answer is the next word in the conversation. If it is true, they are answering
something older.

### The push queue

`GET /v1/external-work-pushes`, oldest first, because the oldest unsent status
is the one costing the most. A failed push leaves the order IN the queue: a
network that was down has to be told when it comes back, and an error that
quietly removed it would turn a retryable outage into a status the client never
hears.

### What is not built

**No adapter for any of these networks.** Not Corrigo, not ServiceChannel, not
a warranty administrator's API. Each is a vendor approval and a contract rather
than code, and one written against documentation without a sandbox looks
finished and has never run. Everything above is reachable through the API, so
an integration or a middleware can drive it today, and the day a sandbox exists
the adapter has somewhere to write to.

**No automatic job creation on accept.** Accepting takes a job id if the caller
has one. Deciding what job an order becomes needs the client's trade, site and
scope mapped to ours, and guessing it would put the wrong job type on the
board.

**No automatic pricing from the order.** A work order that arrives here
carries the client's own codes in its payload; mapping them to lines on the
job is not done, so the job's work is recorded the ordinary way and priced by
the client's card when it is billed (see Rate cards below).

## Rate cards: whose price governs

A rate card is a price authority that is not ours: a client contract, a
warranty network schedule, a manufacturer labour allowance, an insurance
price list. A card belongs to a contract, and a contract to a customer, so a
card applies to the work that customer pays for and to nothing else. On a
home warranty job the network's schedule prices the covered work and the
homeowner's part is priced by our book.

### What a card says

A card is mostly rules, and each line of work is priced by the most specific
one that applies, in this order:

1. **A listed price** for the exact item, matched on our item first and their
   code second (`PUT /v1/rate-cards/{rateCardId}/lines`). A line may say how
   many minutes the card allows, which is what a manufacturer labour
   allowance is.
2. **An hourly rate** for labour, by trade and time band
   (`PUT /v1/rate-cards/{rateCardId}/terms`). The trade is the job type the
   work is booked under, or every kind of work. The bands are standard, after
   hours, weekend and holiday, read from the client's own standard hours,
   days and holidays on the card rather than the office's, and from when the
   visit started rather than when the paperwork was written. A card with no
   rate for a band charges its next lower band, never a higher one. A minimum
   and a billing step ("one hour minimum, then quarter hours") apply.
3. **A markup on our cost** for materials, by cost band.
4. **A trip charge** per visit made, when the card has one.

Anything none of these prices falls back to our price book and is marked out
of scope, both on the billing preview and as a deadline on the invoice, so it
is agreed with the client before it goes out. With no card at all the price
book is simply the authority and nothing is flagged.

**Every invoice line records who priced it**: the authority, how (listed
price, hourly rate, markup, trip charge, price book, typed in, or a payer's
share of a split line) and the working in a sentence ("Standard hours rate:
90 min at 95.00 an hour"). It is written when the line is priced and never
worked out again, and it is on the invoice screen, the payer's page and the
export file. Cost is never taken from a card, so margin stays true on work we
did not price.

### The limit

A contract's not to exceed (its default, or a site's own) is checked when an
invoice is raised or a draft issued, counting what earlier invoices on the
job already billed to that payer. The contract says whether going over
**holds** the invoice, with the limit, what is billed and what would fit in
the refusal, or **warns**: it goes through and a deadline on the invoice says
it is over. A job's own authorisation, when the client gave one, governs
instead of the contract's limit.

### Screens

`Contracts` lists every contract. `/contracts/new` sets one up. Each
contract's page carries its terms and clocks, its fixed fee when it bills one
(below), its sites, every card with its price list and its rules, and what the
payer owes.

## Contract clocks

Response times, the invoicing window and the claim deadline are one
primitive, the obligation, computed from the contract. A contract states
`respond` (book a visit), `arrive` and `complete` in minutes from when the
work arrived, optionally per job priority, so an emergency can run on an hour
while everything else runs on four. It states how many days after finishing
an invoice is accepted, and a claim can be filed.

The job runs under the contract named on it (`PUT /v1/jobs/{id}/contract`),
or failing that the contract of whoever pays: the third party for covered
work, then the party billed, then the customer. Its clocks are reconciled
from what has happened rather than triggered from a dozen places: raised
once, satisfied by the fact that met them at the time it happened, moved when
the job's priority or contract changes, cancelled when the job is called off.
The worker reconciles every pass, and every write in this module does too.
`GET /v1/jobs/{id}/deadlines` and the job's page show each clock and how it
stands.

**About to breach becomes a task.** A quarter of the window before a clock
runs out (never less than fifteen minutes), a high priority task is raised in
the office queue, due when the clock is, and from there the company's own
escalation rules act on it like any late task. A clock met before then takes
its task out of the queue with it.

`Contracts > Deadlines` (`/contracts/deadlines`) is the queue of what is past
due, what is due within a day, and what is later. A clock already met since
the worker last went round is not shown, because the read checks the facts
itself rather than waiting for the record.

## Annual escalation

A contract that says rates rise by a percentage each year carries that rate in
its terms ("Rates rise each year by, per cent" on `/contracts/{id}`). The
contract's page then shows the next anniversary of its start date and, for every
card in force the day before it, each listed price, hourly rate and trip charge
now and after rising by the rate, to the cent, rounded half up once
(`GET /v1/contracts/{contractId}/escalation`; markups are fractions of our cost and
are kept). Nothing changes until a person presses **Apply year N prices**
(`POST /v1/contracts/{contractId}/escalation`, `pricebook:write`), which is refused
unless it names the anniversary and rate the page showed, so a rate changed in
between is a different rise somebody has to look at again.

Applying it writes a new version of each card, named for the year, in force from
the anniversary, and ends the old card the day before. A card is a price list and
is never edited in place: work done before the anniversary is priced by the old
card and every invoice already raised keeps its prices. It can be applied from
sixty days before the anniversary, so the prices are ready the morning they are
owed, and any time after, for one that was missed; anniversaries are applied one
at a time, oldest first, and the contract records the last one applied. It is
refused, in words, when the contract has no start date or ends first, when no
card is in force, or when a card is already loaded from the anniversary.

## Billing a job in parts

`GET /v1/jobs/{id}/billing` prices every unbilled line on the job, plus a
card's trip charge per visit made, by the authority of whoever pays for that
line, and says who pays what. `POST /v1/jobs/{id}/billing` writes exactly
that, one invoice per payer, in one transaction. Three shapes are read from
the job rather than chosen:

- **One payer**: whoever the job is billed to.
- **By coverage**: a third party covers part of the work (a home warranty, a
  manufacturer, a carrier), named under Pays on the job. They pay the covered
  work less the deductible; the customer pays the deductible and whatever is
  not covered. The split comes from `quote`'s own arithmetic.
- **By shares**: payers named with a share (a fraction or an amount) pay
  their shares, and whoever is billed pays the rest.

Coverage nobody is invoiced for (a plan, our own warranty) is absorbed and
shown on the customer's invoice at nothing.

**The invoices add up to the work, to the cent.** Every line is priced once
and cut between payers by arithmetic on those prices, so a line two payers
share appears on both invoices, each with its part and a sentence saying
where the rest went. The total is checked again after the invoices are
written, and a mismatch keeps nothing. Each invoice is posted to the ledger
on its own payer's receivable by the same path as any invoice. The job's
authorisation applies to the payer it belongs to, and each payer's contract
limit to theirs.

**The tax follows the line to whoever pays it.** Each taxable line carries its
own rate: the one the company's rates (M13) give the job's address and customer
today, or one of the company's rates chosen for that line on the billing preview
(`lineRates` on both calls, `line:<job line id>=<rate id>` or `=none`), so a job
whose parts owe two districts' rates is billed in parts at each. A figure typed
for the whole job (`taxRate`, as a fraction: 0.0825) still charges every taxable
line at it. The preview shows each line's rate and offers the company's rates
beside it. Each payer's invoice is then taxed on that payer's part of each
taxable line at the line's rate, and a payer exempt on a certificate whose last
day has not passed is taxed on nothing; the job customer's own exemption does
not untax a warranty company's part. Each invoice line records which of the
company's rates it charged, and the ledger posts each payer's tax one entry per
rate. The tax is worked out once on the whole job,
rounded once, and shared between the payers and then between their lines by
largest remainder (`core/splits.taxAcross`): two payers each owing half a cent
are not each charged a cent, so the invoices' tax adds up to exactly what one
invoice for the whole job would charge, and every line's tax is still within a
cent of its own rate. That is checked again after the invoices are written,
like the total, and the ledger posts each payer's tax as collected from them.
A limit is checked against what the invoice will carry, tax included.

**A member pays their own part at the member's price (M08).** When the job's
own customer holds a running plan with a discount, the plan's discount comes
off the customer's own part of each line priced at our price, by the same
rule and arithmetic as an ordinary invoice: per line, rounded to the cent, with
what the plan leaves out left out and a waived fee waived. A third party's
part is priced by its own authority and never takes it, and neither does the
customer's share of a line a third party's schedule priced, such as the
deductible on covered work, because that figure is the third party's terms. A
property manager or landlord billed for the job is not the member. It is
taken before the tax is shared, so each payer is taxed on what they actually
pay. The preview shows it on the customer's part as "Member discount" with
the plan named (`memberDiscount` on the payer and the plan, `member` naming
the agreement), the invoice line carries it as its member discount naming
the agreement, and the check after the invoices are written counts it: the
invoices, the member discount and anything absorbed come to the priced work.

**Labour beyond a manufacturer's allowance is offered, never added.** An
allowance pays a card's listed price for a repair and allows a number of
minutes for it, however long it took. When the plan bills an allowance and
the minutes on site on the job's visits (punched `on_site` on its visits) come
to more than every allowance on the job allows, billed already or now, the
preview says so in minutes: "150 min on site, 90 min allowed, so 60 min nobody
is charged for". Time already on a labour line, billed, waiting or excused, is
taken off first, because somebody has already decided about it. Under the
priced work on the job's billing preview the office picks whose part it goes
on (any payer the plan names, the customer by default) and an hourly rate, and
presses **Add it to their part** (`beyondPayer` and `beyondRate` on both
calls). It is then a line of its own, "Labour beyond the allowance", on that
payer's part alone, priced at their card's hourly rate when they have one and
at the office's rate otherwise, with the minutes on the line; it does not move
what the allowance or a share pays, and the invoices still add up to the work.
Left alone, nothing is added. Once the allowance is billed it is not offered
again.

Billing is refused while the preview lists a problem, with the problem as the
reason: covered work with nobody named to pay it, a payer with no customer
record, shares that do not add up, a limit that holds.

## Delivering invoices to a payer

A commercial payer rarely wants an email per invoice.

- **A link per payer** (`POST /v1/payers/{customerId}/portal-link`) opens a
  page of everything addressed to them or naming them as payer: open
  invoices first, then what they paid this year, each with its lines and who
  priced them, and a CSV download. It is recorded against each open invoice
  as a link handed over.
- **A file** (`POST /v1/payers/{customerId}/invoice-export`) of their open
  invoices, CSV (one row per line) or XML (this product's own plain shape),
  in the format their contract names. Each invoice in it is recorded as
  delivered, so it leaves the undelivered list.

## A contract billed on a schedule

A commercial maintenance contract often bills a fixed fee every month, three
months or year whether or not anybody visited: "1,200.00 a month for planned
maintenance at both sites". On the contract's page, under **Billed on a
schedule**, the office sets the fee, how often, the billing day (1 to 28, so
every month has one), the first day billed for, what the invoice line says,
whether a part month is charged by the day, and whether sales tax is added
(`PUT /v1/contracts/{contractId}/billing`, `contract:write`, because how a
contract bills is one of its terms).

**Each period is billed on its first day, in advance.** On the billing day, in
the company's calendar, the worker raises an invoice for the period that starts
that day: to the contract's customer, due after that customer's payment terms,
with the contract's PO number, and the period in words on the line ("1 Mar 2027
to 31 Mar 2027"). The line records the contract as its price authority and "the
contract's fee for a period" as how it was priced. It goes through the same path
as every invoice, so it is numbered, taxed at the company's rate for the customer
when the fee is taxed, and posted the way an invoice is: revenue on the day it is
raised, with the receivable. Nothing is deferred. A quarterly or yearly fee is
billed every third or twelfth month, counted from the first billing day on or
after the first day billed.

**A part period at either end.** A contract that starts or ends between two
billing days has a part period: from the first day to the day before the next
billing day, and from the last billing day to the last day. It is charged by
the day, as the fee's share of the whole period it is part of, rounded once to
the cent, only when the contract says so. Otherwise it is charged as a whole
period, which is what a fixed fee that says nothing about part months means.
The form starts the billing day on the contract's own first day when it can,
so there is no part month to begin with.

**Once per period.** Each period is a row (`contract_billing_period`), claimed
by inserting it under a unique index on the contract and the period's first
day, in the same transaction as its invoice. The worker on every pass, a second
worker, a restart and **Raise what is owed now** on the page
(`POST /v1/contracts/{contractId}/billing/raise`, `invoice:write`) all meet the
same index, and only one of them writes an invoice. A schedule set up with a
first day months back is caught up twelve periods at a time.

**Paused and ended.** **Pause billing**
(`POST /v1/contracts/{contractId}/billing/pause`) stops it: nothing is billed,
and when it is started again (`POST /v1/contracts/{contractId}/billing/resume`)
each period whose billing day fell in the pause is written down as skipped, so
the customer is not sent the paused months the morning it resumes. **End
billing** (`POST /v1/contracts/{contractId}/billing/end`) names the last day
billed for: periods up to it are still billed, one cut short by it as a part
period, and none after. The contract's own end date does the same, and a
contract switched off bills nothing. Changing how often or on which day it
bills, once anything is billed, starts the new pattern the day after the last
period billed, and the first day cannot be moved to before then, so no day is
billed twice. Saving an ended schedule starts it again.

The page lists every period with its invoice, or "Skipped while paused", and the
next period with what it will be billed. `GET /v1/contracts/{contractId}/billing`
is the same, under `contract:read`.

## Permissions

The cast and the ceiling are decisions about the job, so both need
`job:write`. Reading either needs `job:read`. So does naming the job's
contract, and reading its deadlines.

A card's prices and rules are the price book's business: `pricebook:write`
to set, `pricebook:read` to see. A contract's terms and clocks need
`contract:write`, and so do its fixed fee, pausing it and ending it; seeing
them needs `contract:read`. Raising what a fixed fee owes now needs
`invoice:write`, because it raises invoices; the worker raises them as the
system with only that. Previewing how a job would be billed needs `invoice:read`,
and billing it `invoice:write`. Exporting a payer's invoices needs
`invoice:send`, and a payer link `portal:grant`. The deadline queue needs
`task:read`, like the task queue it feeds.

A mirrored work order needs `contract:write` to receive, move or sync, and
`contract:read` to look at. It is the commercial arrangement rather than the
job: accepting an order from a facilities network is agreeing to their terms
for it, which is the same decision as signing the contract, and it is not the
same decision as scheduling the visit.

### The screen

`Contracts > Work from other systems`. `contract:read` to look and `contract:write`
to move, which is the service's own split.

**Two statuses on every row, never reconciled into one.** Their word is kept
verbatim beside ours, because it is the only thing that survives them renaming a
status, and the row says which system is the record.

**The buttons come from `weMayMoveTo`.** The service works it out from the state
and the network's own flags, so the screen does not know the transition table and
cannot offer a move the module would refuse. Two consequences are visible: on a
network where acceptance is final there is no Accept after the fact, and nowhere
on the screen is there a button for "the client cancelled it" or "they sent it
back", because neither is ours to declare. A test checks that second one against
core in both directions rather than against the markup.

**The job field appears only on Accept.** A declined order must never carry a job:
half of what arrives on a facilities network is declined, and a job on a declined
order is work nobody is doing sitting on the board and in the margin report.

**The push queue is a count with a consequence, not a tidiness list.** A status
changed and never pushed is a contractor whose scorecard says they never
responded, and the scorecard decides the next dispatch. A failed push keeps the
order in the queue and shows the error; only recording the push clears it.

**Each network's caveat is where the decision is made.** A contractor needs to know
that a warranty administrator's acceptance is final BEFORE they accept. A network
with no profile written for it is listed too, with its order count, because the
profile list is notes rather than a gate: a regional warranty administrator nobody
has heard of is as real as Corrigo, and it gets the cautious defaults.

An order is posted through the API rather than created on the screen, because that
is how one arrives. The browser test does the same, which is also the honest shape
of the test: there is no adapter for any network, so the API is the only way in.

## What is not built

**No EDI, cXML or network submission.** The file export is for a person to
upload to the payer's system. Nothing here connects to an EDI network, an
Ariba or Coupa punchout, or a facilities network's invoice API, and the
`cxml`, `edi` and `fm_network_api` delivery channels stay unused rather than
being claimed by a file somebody downloaded. The XML is this product's own
shape, not any standard's.

**Escalation is one rate, applied by a person.** Nothing applies it on its own on
the anniversary or raises a task when one is due; the contract's page shows it
from sixty days ahead. A contract whose rises differ by year, or by trade, loads
next year's card by hand. A rate typed with more than four decimal places of a
percentage is rounded when it is saved.

**Tax rates on a split.** Each line is billed at its own rate, but the rates
are the company's own: nothing looks up a jurisdiction's rate, and a line taxed
at a different district's rate is chosen for it on the preview by a person. A
payer is exempt for everything or nothing, as the customer record says, and
nothing taxes one payer's part of a line at a different rate from another's.

**Member pricing on the deductible.** The plan discount comes off the
customer's own part of a job billed by payer at our price, and never off their
share of a line a third party's schedule priced, so a member's deductible is
never discounted. Whether a plan should reduce a deductible is the warranty
company's terms and the company's decision, and nobody has made it.

**Labour beyond an allowance is offered once, from punches.** It is worked out
only from time punched on site on the job's visits: a job whose technician did
not clock on the visit has nothing to compare, and nothing is offered. Travel to
the job is not counted against the allowance. It is offered while the allowance
is being billed; billed without it, it is not offered again, and adding it later
is an ordinary invoice. Nothing claims it back from the manufacturer: an
allowance is the manufacturer's figure, and asking them for more is their
supplement process, not a line here.

**A fixed fee is billed in advance, and never credited back by itself.** Each
period is billed on its first day. A contract that bills in arrears, at the end
of the month for the month just gone, is not offered. An invoice already raised
for a period that a pause or an end cuts short is left as it is: crediting the
rest is a decision made on the invoice with a credit note, and nobody has
decided that the schedule should make it for the office. A paused period is
skipped, never billed late. The fee is one amount: it does not rise with the
contract's annual escalation, which applies to the rate cards, so a fee that
rises is changed on the schedule by a person. The invoice is raised and not sent;
it goes out the way any invoice does.
