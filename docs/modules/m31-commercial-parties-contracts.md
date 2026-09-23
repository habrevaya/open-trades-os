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

## Permissions

The cast and the ceiling are decisions about the job, so both need
`job:write`. Reading either needs `job:read`.

## Not built

Rate cards, which are the other half of "our price book is not the price
authority": a client contract, a warranty network schedule, a manufacturer
labour allowance. The tables exist and nothing reads them, so a commercial job
is still priced from our own book.

External work orders, where the job is created in a facilities network and we
mirror it, and the external system is the system of record.

Obligations, which are SLA clocks, invoicing windows and claim deadlines as
one primitive. Invoice delivery beyond email: a portal, a cXML or EDI
submission, an FM network API. Service contracts and their site lists.
Splitting one invoice across two payers by share, which the party rows can
express and nothing computes.
