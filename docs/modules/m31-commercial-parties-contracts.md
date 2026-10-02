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

**No rate card.** A facilities network's schedule is the other half of "our
price book is not the price authority", and the tables for it still have no
reader.

## Permissions

The cast and the ceiling are decisions about the job, so both need
`job:write`. Reading either needs `job:read`.

A mirrored work order needs `contract:write` to receive, move or sync, and
`contract:read` to look at. It is the commercial arrangement rather than the
job: accepting an order from a facilities network is agreeing to their terms
for it, which is the same decision as signing the contract, and it is not the
same decision as scheduling the visit.

## Not built

Rate cards, which are the other half of "our price book is not the price
authority": a client contract, a warranty network schedule, a manufacturer
labour allowance. The tables exist and nothing reads them, so a commercial job
is still priced from our own book.

Obligations, which are SLA clocks, invoicing windows and claim deadlines as
one primitive. Invoice delivery beyond email: a portal, a cXML or EDI
submission, an FM network API. Service contracts and their site lists.
Splitting one invoice across two payers by share, which the party rows can
express and nothing computes.
