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
contract's page carries its terms and clocks, its sites, every card with its
price list and its rules, and what the payer owes.

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

**The tax follows the line to whoever pays it.** The sales tax rate on the
job's taxable lines is typed on the billing preview (`taxRate` on both calls,
as a fraction: 0.0825), because nothing in this product decides a rate for
anybody (M13). Each payer's invoice is then taxed on that payer's part of each
taxable line at the line's rate, and a payer whose customer record says tax
exempt is taxed on nothing. The tax is worked out once on the whole job,
rounded once, and shared between the payers and then between their lines by
largest remainder (`core/splits.taxAcross`): two payers each owing half a cent
are not each charged a cent, so the invoices' tax adds up to exactly what one
invoice for the whole job would charge, and every line's tax is still within a
cent of its own rate. That is checked again after the invoices are written,
like the total, and the ledger posts each payer's tax as collected from them.
A limit is checked against what the invoice will carry, tax included.

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

## Permissions

The cast and the ceiling are decisions about the job, so both need
`job:write`. Reading either needs `job:read`. So does naming the job's
contract, and reading its deadlines.

A card's prices and rules are the price book's business: `pricebook:write`
to set, `pricebook:read` to see. A contract's terms and clocks need
`contract:write`. Previewing how a job would be billed needs `invoice:read`,
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

**No annual escalation.** A contract's escalation rate is stored and nothing
applies it to the card; next year's rates are loaded as next year's card.

**Tax rates on a split.** The rate is one figure for the job's taxable lines,
typed by whoever bills it, so a job whose taxable lines owe different rates
cannot be billed in parts at each one. Nothing looks up a jurisdiction's
rate, and a payer is exempt for everything or nothing, as the customer record
says.

**Member pricing on a job billed in parts.** The plan discount is applied to
an invoice raised the ordinary way, and not when a job is billed by payer:
there, every line is priced once by the payer's authority before it is cut.

**Labour beyond an allowance.** A manufacturer's allowance pays the card's
listed price for the repair; the minutes it allows are shown, and time worked
beyond them is not charged to anybody automatically.

**Service contracts on a schedule.** A contract billed monthly whether or not
anybody visited is not built.
