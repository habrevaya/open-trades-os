---
title: Memberships and Service Agreements
module: M08
domain: Sell
phase: 6
status: partial
---

# Memberships and Service Agreements

> Module M08. Domain: Sell. Ships in phase 6.

## What it does

Sells a customer recurring service: a price, a term, and a number of visits
the company owes them. The visits exist as rows from the moment the agreement
is sold, the billing runs on its own separate schedule, and the money sits as
a liability until a visit is actually delivered.

## Why it is the module worth getting right

Maintenance agreements are the single biggest lever on what a home services
company is worth. A shop with four hundred members on auto renew sells for a
different multiple than an identical shop doing the same revenue in one off
calls, because one has predictable revenue and a reason for the customer to
call them first, and the other has neither.

## Key concepts

**One concept, not two.** The industry says "membership" for residential and
"service agreement" for commercial, and at least one major platform models
them as two separate things, which means two of everything: two billing paths,
two visit generators, two renewal reports. They are the same object with
different marketing.

**The agreement generates its own visits.** A plan that includes two tune ups a
year and relies on somebody remembering to book them is a plan that quietly
does not get delivered, and the first anybody hears of it is at renewal when
the customer says they never saw us. So the visits are written down at the
moment of sale, and "who is owed a visit" is a query rather than an
investigation.

**Billing and delivery are separate schedules.** A customer can pay monthly and
be visited twice a year. Tying visit generation to billing is the obvious
shortcut and breaks the moment somebody prepays annually.

**Money billed is not money earned.** Twelve months collected up front is a
liability that unwinds as visits are delivered. Recognising it on receipt
shows a spectacular month followed by eleven months of servicing work with no
revenue attached to it. Billing an agreement credits deferred revenue, not
revenue; delivering a visit moves one slice across.

**The price is frozen at sale.** Raising a plan's price must not reprice four
hundred existing members, and retiring a plan must not orphan them.

**Amounts are allocated, never divided.** A term price split across twelve
instalments by dividing and rounding each one leaves cents unbilled, and those
cents sit in deferred revenue forever with nothing to release them. The same
argument applies to the recognition slices.

**Seasonal plans pin to months.** A heating tune up belongs in autumn
regardless of when the agreement was sold, so a plan can anchor its visits to
months rather than counting forward from the sale date.

## Setup

Define a plan: a name, a price, how often it bills, how long the term is, and
how many visits it includes. Seasonal plans add the months those visits belong
in. Member benefits, the reason anyone renews, sit on the plan: a discount
rate, priority dispatch, a waived diagnostic fee.

A plan is retired rather than deleted. Existing members keep their price and
their term.

## Using it

### Sell one

Pick a plan, a customer and a property. Everything the agreement owes is
written down in the same transaction: every included visit with the date it is
due and what it is worth, every billing instalment, and a deferred revenue
entry per visit.

### Deliver one

`/agreements` opens on the visits the company owes and has not booked. Booking
one makes a job worth nothing, because the customer has already been billed
for it under the agreement and putting the plan price on the job would bill
them twice. Marking it delivered is what moves its slice from liability to
revenue.

### Bill one

An instalment becomes an invoice whose posting credits deferred revenue rather
than revenue. A plain invoice here is the single most common way this module
is got wrong in the products contractors already use.

### Cancel one

The reason is required: a cancellation with none is indistinguishable from a
mistake, and the reason is the whole of a win-back campaign. Whatever has been
billed and not earned is released, either to revenue if the company keeps the
prepayment or back to the customer if it does not. Leaving it sitting in
deferred revenue forever, which is what doing nothing amounts to, is the one
answer that is wrong either way.

## Permissions

| Role | Access |
|---|---|
| owner, admin | Everything |
| office manager | Sell, book, deliver, cancel |
| accountant | Read, and the unearned balance |
| dispatcher, csr, technician | Not by default |

`membership:read` sees the book. `membership:write` sells and cancels.
Invoicing an instalment additionally needs `invoice:write`.

## API

`agreements.plans`, `createPlan`, `retirePlan`. `sell`, `list`, `get`,
`cancel`. `owed` is the report that keeps a book alive. `book` and `deliver`
are the delivery path, `bill` the billing one, and `unearned` is the balance
sheet number.

## Common questions

**Why is the job worth nothing?** Because the customer already paid for it
under the agreement. Anything extra the technician sells on that visit goes on
the job as normal.

**What happens on the last visit of a term?** The deferred balance reaches
zero, which is how you know the allocation was right. Renewal is not built
yet.

**Can a member pay annually and be visited monthly?** Yes. That is the whole
reason the two schedules are separate.

## Not built

Renewal, including the notice a plan says it owes before one. Auto renew is a
column nothing reads yet. Member pricing is not wired into the price book, so
the discount rate on a plan is recorded and not applied. Prorating a
cancellation to the day, rather than releasing whole undelivered slices, is a
decision nobody has made.
