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

## What is not built

- **No screens.** The fleet and the hires are API only.
- **No scale ticket ingestion.** The ticket number, facility, material and
  tonnage are recorded; nothing reads a file the facility sends or a
  photograph of the ticket.
- **No routing on what is on the truck.** The pack's own note says the order
  of a driver's day is decided by what is on the truck and what has to come
  back on it. Dispatch does not know that yet.
- **No invoice lines raised from a hire.** `GET .../overage` says what the
  meters read; somebody still raises the invoice.
- **No contamination or prohibited item charge.** The pack prices them and
  nothing records an occurrence against a haul.
- **Four of the eight KPIs**, listed above with what each one needs.
- **No telematics.** Cost per hour and per mile on a company asset are only as
  good as what somebody enters.
