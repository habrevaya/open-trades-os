---
title: Fleet, Tools and Company Assets
module: M22
domain: Company
phase: 7
status: partial
---

# Fleet, Tools and Company Assets

> Module M22. Domain: Company. Ships in phase 7.

## What it does

Two registers for two different questions.

`company_asset` answers "where is it, who has it, and what does keeping it
cost" for a truck, a chipper or a torque wrench. One register rather than
three, because they are the same question asked three times.

`rentable_asset` answers a different one: what fraction of the fleet is on a
customer site earning, and how long each unit has been there. That is the
whole economics of a trade whose scarce resource is a steel box rather than a
person, and it is why the two are separate tables rather than a `kind` column
on one. A chipper is checked out to a person; a container is hired to an
address, bills on two meters, and has a utilisation rate.

## Why the rental half is a register and not an inventory count

The dumpster rental trade pack shipped before this was built, which made the
gap unusually visible. Two hundred and seventy eight lines declaring six job
types whose capacity model is `asset_rental`, thirty eight price book items
built around container days and scale tickets, two checklists written for a
driver with a hook truck, and eight KPI definitions. And `rentable_asset` and
`rental` had no reader and no writer, so a roll off company could apply the
pack and record no containers.

A count of cans would not have closed it. The question is not how many, it is
which one, where, since when, and what it is owed.

## Key concepts

**A container day is any part of a calendar day.** Not elapsed hours over
twenty four, and the difference is not small. A can delivered at 4pm Monday
and collected at 9am Tuesday is on site seventeen hours, which is 0.7 of a day
by division and TWO container days by the trade's reckoning: it occupied a
space in the fleet on two separate days and the customer had it on two
separate days. Every operator counts it that way and so does every
competitor's invoice. Dividing by twenty four undercharges every short rental.

**In the company's timezone.** A calendar day is a local thing. A delivery at
7pm Central on 31 March is 1 April in UTC, and counting in UTC starts the
rental a day late for every evening drop. The report's SQL converts with
`at time zone` before casting to a date for exactly this reason; a bare
`::date` on a `timestamptz` uses the session's zone, which is not the
company's.

**The utilisation denominator includes the yard.** Available days include cans
sitting in the yard and exclude only cans tagged out of service. Excluding
yard cans is the usual mistake and it makes a bloated fleet look fully booked,
which is the one conclusion the metric exists to prevent: a shop with forty
cans and sixty per cent utilisation bought sixteen cans it did not need, and a
report counting only the cans that went out tells it utilisation is a hundred
per cent.

**Out of service is the only status that leaves the denominator.** That is why
tagging a unit out is its own operation with a required reason rather than a
field on an update, and why retiring a unit that is still on a site is
refused: it would remove a container from the fleet count while it is still
earning and push the rate above a hundred per cent with nothing explaining
why.

**Two billing meters, neither derived from the other.** One runs on elapsed
calendar days against an included period. The other runs on weight from the
scale ticket against an included tonnage. A can that sat three weeks holding
four hundred pounds owes days and no tons; one collected on day two holding
six tons owes tons and no days. A single "overage" figure cannot express
either case, and a customer disputing one of them is entitled to see which.

**A missing rate is a refusal, not a zero.** A rental eleven days past its
included week with no daily rate on it is eleven days of work already done
that nobody can invoice. Reporting nothing to charge would make the leak
invisible and the pack's `overage_capture` KPI, which exists to measure
exactly that, would read a hundred per cent.

**A swap is one placement, two rows.** `rental.asset_id` is a single column
and the can physically changed, so a swap cannot be an update. It closes one
rental and opens another at the same address, linked by
`previous_rental_id`. Without the link a four week construction hire with
three swaps reads as four unrelated week long rentals and the average duration
comes out at a quarter of the truth, which is why the pack's own KPI
definition says a swap counts inside the parent rental. The new period carries
the old terms forward: a swap mid hire does not renegotiate the rate.

**The scale ticket lives on the rental.** Not only as a reading on the visit.
It is the support behind the largest line on the invoice and the largest line
in the cost of goods, the pack keeps it for three years from the haul, and a
number living in a visit's readings blob cannot be totalled, reconciled
against the facility's account, or found when a customer questions a tonnage
charge.

## Setup

1. **Locations**, if a unit has a home yard. `settings:write`.
2. **The fleet.** `asset:write`. One row per unit, with the number painted on
   the side as its identifier. It is unique in the company and it is the only
   thing tying a scale ticket back to a unit.
3. **The price book.** Applying the dumpster pack seeds the rental lines, the
   two overage meters (`OVR-DAY-SM`, `OVR-TON-CD` and the rest) and the trip
   fees. The rates on a hire are set per hire, not read from the price book,
   because a contract customer's rate is not the list price.

## Using it

### A delivery

`POST /v1/rentals` with the asset, the property and the terms. `deliveredAt`
comes from the caller rather than the clock, because a driver writing up a
day's drops at five in the evening would otherwise have every rental start at
five. Where a job id is given, the job's first unassigned stop is pointed at
the hire and marked as the delivery leg, which is what tells the board whether
the driver is dropping or collecting.

A hire with no job behind it is ordinary and is the standing container on a
commercial site. Nothing invents a visit for it.

### A swap

`POST /v1/rentals/{id}/swap` with the empty can the driver brought. Same
property always: a swap is defined by the address staying the same, and a can
taken from one site and dropped at another is a pickup and a delivery.

### A collection

`POST /v1/rentals/{id}/pickup` with the scale ticket. `backInService: false`
leaves the unit tagged out, which is the ordinary case rather than an edge one:
the pickup checklist's last line is to record the condition and tag it out if
it needs repair.

### What it owes

`GET /v1/rentals/{id}/overage` returns the two meters as separate lines. It is
a read and it does not raise an invoice; pricing a line is M13's job. It
refuses while the container is still on site, because an open hire's overage
changes every midnight and a number that does that on a screen beside an
invoice is one somebody will put on the invoice.

### Collections on the board

`POST /v1/rental-collections` puts every open hire due back by a day
(tomorrow when none is given) on the board as a collection. Due back is the
last calendar day the price covers, in the company's timezone, so a seven day
hire delivered on the first is due on the seventh. The stop goes on the day
it is due, or today when it is already late, inside the working day, marked
as the pickup leg of that hire so the driver arrives with an empty truck. A
hire that came with a job gets the stop as a visit on that job; one with no
job gets a job of its own at the address, of the company's `pickup` job type
when it has one. A hire already given a collection is left alone, so running
it twice books nothing twice, and one whose collection was cancelled on the
board is offered again. A standing hire with no included period is skipped
with the reason: it goes back when the customer says so. It needs
`asset:write` and `job:write`. On the containers screen it is one button with
a date.

### Charges found on a haul

`POST /v1/rentals/{id}/charges` records a contaminated load, a prohibited
item, an overweight or overfilled can against the haul it was found on,
priced from the pack's own fees (`FEE-CONTAM`, `FEE-PROH-TIRE` and the rest)
at today's price unless another is given, or priced by hand. A charge with no
price is refused rather than recorded at nothing. `GET /v1/rental-charges`
lists them and `POST /v1/rental-charges/{id}/remove` takes back one recorded in
error, refused once it is on an invoice.

### Invoicing a hire

`POST /v1/rentals/{id}/invoice` raises a draft invoice to the customer at the
address from a collected hire: the rental period when the hire is priced by the
day (days inside the included period at the day rate), each meter that went
over (extra days at the overage rate, tonnage over the included at the per ton
rate) and every charge found on the haul. Refused while the can is on site,
refused with the meter's own sentence when a meter went over with no rate,
and refused when the hire is already on an invoice that has not been voided,
so the same extra days cannot reach two invoices. A hire priced by a flat line
on its job has no period line here, so the period is not billed twice. It
needs `invoice:write`, and the draft is checked and issued on Invoices like
any other.

### A facility's scale tickets

`POST /v1/scale-tickets/preview` reads the file a landfill or transfer station
sends and matches each ticket to the haul that collected or swapped out that
can on the ticket's date or the day before. Net tons, net pounds, or gross and
tare in pounds are all read, and the common spellings of each header. A
ticket is skipped with the reason when no haul matches, when the haul already
carries another ticket, or when a weight typed on the haul disagrees with the
file: nothing typed is ever overwritten. `POST /v1/scale-tickets/apply` works
it out again inside the write and fills only empty fields. The screen is
`/fleet/containers/tickets`.

### The fleet report

`GET /v1/fleet-report` computes four of the pack's eight KPIs, with every
exclusion the pack names, because each exclusion is the way that metric is
usually got wrong.

The other four are absent rather than approximated:
`revenue_per_container_month` and `disposal_cost_pct` need invoiced revenue and
facility cost attributed per container, `hauls_per_truck_day` needs truck days
from the driver timeclock rather than the roster, and `turnaround_hours` needs
the moment a can was emptied at the facility, which nothing records. A KPI
computed from the nearest available number is one an owner makes a fleet
purchase on.

## Permissions

| Role | `asset:read` | `asset:write` |
|---|---|---|
| owner | yes | yes |
| admin | yes | yes |
| office_manager | yes | no |
| dispatcher | yes | no |
| csr | no | no |
| technician | yes | no |
| crew_lead | yes | no |
| accountant | no | no |
| readonly | yes | no |

Read is wide and write is narrow, and that is the right shape here. "Where is
every can" is a question a dispatcher answers twenty times a day and a
technician needs the answer to from a truck. Writing is narrow because moving a
container in the software without moving it on a truck is how a fleet view
stops being trusted, and a wrong `on_site` leaves a can earning nothing while
the report says it is out.

`asset:checkout` is a third permission, held by the technician and the crew
lead, and it governs custody of a company asset rather than a hire. A container
is not checked out to a person.

## API

The generated reference is `packages/api/openapi.json`. The calls that cover
most real use:

- `POST /v1/rentable-assets` once per unit.
- `POST /v1/rentals`, then `/swap` or `/pickup`.
- `GET /v1/rentals?open=true` for what is out and where.
- `GET /v1/fleet-report`.

## Common questions

**Why is my utilisation lower than I expected?**
Because the cans in the yard are in the denominator. That is deliberate and it
is the point of the metric: a report that counted only the cans that went out
would say a hundred per cent on a fleet that is three quarters idle.

**A can has been out for ninety days. Why is it not in the average duration?**
Average duration counts only hires that ENDED in the window. Including an open
one at "ninety so far" while excluding its eventual real duration would move
the same average in both directions at different times, for no reason anybody
could explain.

**Why does the overage call refuse while the can is on site?**
Because the figure changes every midnight. Collect it first.

**A rental went past its period and the overage call refuses. Why?**
There is no daily rate on the rental. That is the refusal doing its job: those
days are work already done that nobody can invoice, and reporting nothing to
charge would hide it. Set the rate on the rental.

**Can I delete a container I entered by mistake?**
Retire it (`DELETE /v1/rentable-assets/{id}`). It is soft, so every hire that
unit ever ran still resolves to its number, which is the difference between an
answerable tonnage query and an unanswerable one. Refused while it is on a
site.

## The container screen

`Fleet > Containers`. A child of Fleet rather than a filter on it, because the
two registers answer two different questions: a chipper is checked out to a
person, a container is hired to an address, bills on two meters and has a
utilisation rate.

**The four figures are at the top, above the board.** This is the one trade whose
daily question is a ratio rather than a list: a roll off company with sixty cans
at forty per cent utilisation is losing money on twenty steel boxes, and nothing
on a list of hires says so. Each figure carries what it is made of ("412 rented
days of 600 available"), for the same reason the trade scorecard does. A null
reads "Nothing to measure", never zero, because an empty fleet is not nought per
cent utilised.

Three details on the board that are the screen rather than decoration:

- **The days column is headed "Days so far".** On an open hire the figure is
  counted to today and moves at midnight. A column headed "Days" with a number
  that moves is the one somebody copies onto an invoice.
- **A hire past its included period is marked.** Unbilled days are the leak this
  trade is known for, and today an operator finds them by reading two columns and
  doing the subtraction.
- **A swap says it is one.** Without the link a four week hire with three swaps
  reads as four unrelated week long rentals.

A collected hire with no scale ticket is called out rather than left blank,
because the ticket is the support behind the largest line on the invoice and the
largest line in the cost of goods.

**Dates posted at midday UTC, not midnight.** A date box gives a calendar day and
the service wants an instant. Sent as `T00:00:00Z` it lands on the previous
evening anywhere west of Greenwich and starts the hire a day early, which is
exactly the off-by-one a container day is defined to avoid.

The hire list carries the site's street and city rather than a property id, which
this release added. The asset list already answered "where is it" that way with a
comment saying why; a hire list that did not would make every caller do the join,
this product's own board first.

## What is not built

- **Collections are put on the board when somebody asks.** The button and the
  API book every hire due by a day; nothing runs them on a clock, and a
  collection's window is the working day rather than a time agreed with the
  customer.
- **Scale tickets come from a file.** A photograph of a ticket is not read.
- **No routing on what is on the truck.** The pack's own note says the order
  of a driver's day is decided by what is on the truck and what has to come
  back on it. Dispatch does not know that yet.
- **A hire is invoiced one haul at a time.** A swap chain is several hauls and
  each is invoiced from its own row; the facility's disposal fee on a haul is
  its cost, and is not passed through.
- **Four of the eight KPIs**, listed above with what each one needs.
- **No telematics.** Cost per hour and per mile on a company asset are only as
  good as what somebody enters.
