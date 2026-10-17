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

**The moment, or only the day, and the hire says which.** `deliveredAt` is the
moment the can was put down (and with neither field, now, recorded as it
happens); `deliveredOn` is only the day, kept at midday in the company's clock
so it bills the same container days, and the hire records that its hour is
nobody's (`deliveredTimeKnown` false). Every hire from before this was kept is
a day only, because nobody can now say which had a real time. The board takes a
time beside the day ("Time dropped"), and a delivery recorded as a day gets its
hour later with "Save drop time" on its row or from the driver's phone
(`PUT /v1/rentals/{id}/delivered-at`), on the day recorded and never another,
because the day is what the hire bills. A swap is the same: `at` is its
moment, `on` only its day, and the empty can it leaves is placed then.

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

### When the load was emptied

`tippedAt` on a pickup or a swap, or `PUT /v1/rentals/{id}/tipped-at` later
(null clears it), is the moment the full can was emptied at the facility: from
the driver's phone, or typed by the office when the ticket arrives ("Save time
emptied" on a collected hire's row, `asset:write`). It is neither the
collection, which includes the drive and the queue at the gate, nor the scale
ticket's weighbridge time, which a facility's file gives only to the day. A
haul still on the board may have one, because the driver tips the load before
the office records the collection. Refused in words: a time still to come, one
before the delivery, one on a day before the collection, and one after the can
was already on its next site; a delivery before the can's last tip is refused
the same way, so a turnaround can never run backwards. Both times are on the
audit log with where they came from.

### Repairs and customer holds, from when to when

The out of service tag is what a can is now. A repair is also a period
(`container_hold`): tagging a can out opens one (from `at`, or now, with the
reason), collecting it with "back in service" unticked opens one from the
collection, and putting it back in service closes it (`at`, or now). A can
already tagged out when this history began has a repair with no start, said
rather than guessed. A **customer hold** is the office keeping a can for
somebody who asked ("Hold for a customer" on the register row, with who asked
and why and since when, `POST /v1/rentable-assets/{id}/holds`): one still
running is refused for a can on a site, one that has already ended can be
recorded after the fact with its end, two on one can at once are refused, and
it ends with "End the hold" (`POST /v1/container-holds/{id}/end`) or when the
can is delivered. `GET /v1/container-holds` lists them, and "Repairs and holds"
on `/fleet/containers` shows the last thirty. All `asset:write` to change,
`asset:read` to look, and on the audit log.

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
board is offered again. A standing hire with no included period and no
agreed time is skipped with the reason: it goes back when the customer says
so. It needs `asset:write` and `job:write`. On the containers screen it is one
button with a date.

The worker runs the same booking on its own, on every pass, for each company
with a hire coming due, as many days ahead as the company says (the day
before, unless changed), so nobody has to remember the button. A company
turns it off, sets how far ahead, and says how many containers a truck
carries and how long the yard takes under "Collections and the truck" on
`/fleet/containers` (`GET /v1/rental-dispatch`, and
`PUT /v1/rental-dispatch` with `settings:write`). It is on unless turned off.

### A collection time agreed with the customer

`PUT /v1/rentals/{id}/collection-time` records the window the customer
agreed for the collection, or clears it, on each hire's row on
`/fleet/containers`. It beats the day the price runs out, early or late: a
customer who finished early has the can collected on the day they asked, and
one who asked for two more days is not collected on the seventh. The worker
and the button book the collection into that window on that day. A
collection already on the board and not under way moves with it: kept with
its driver when the day is the same, back on the board for the dispatcher
when the day changes, and the driver hears either through the visit's
notices. An agreed time that has passed is collected today in the working
day, and counted late from the agreed day.

### The driver's day, by what is on the truck

"Optimise route" on the board orders a driver's day with drops, collections
and swaps on it by what is on the truck: a drop needs an empty container on
board, a collection needs room, a swap needs an empty and leaves with a full
one, and the runs to the yard between are drive and time like any other
(M09). The proposal lists each run: after which stop, before which, what is
tipped and what is loaded. The leg comes from the hire's own record on the
stop, or from the pack's job type (delivery, final pickup, swap, dump and
return) before the hire exists.

### Each truck its own kind

A hook lift that carries two small cans and a roll off truck that carries one
big one are different machines, so a truck has a kind of its own on
`/fleet/containers/trucks`: how many containers it carries at once (one to
four), which sizes in cubic yards it can lift (none listed means any), and
how long the yard takes it. `GET /v1/truck-kinds` lists them with the trucks
that have each, `POST /v1/truck-kinds` adds one, `PATCH /v1/truck-kinds/{id}`
changes one, `DELETE /v1/truck-kinds/{id}` takes one off the list (refused
while a truck has it, naming the trucks) and
`PUT /v1/assets/{assetId}/truck-kind` says what kind a vehicle is, or that it
has none. Only a vehicle that has not been retired can be a truck, and all of
it needs `asset:write` (`asset:read` to look).

A kind can also say how many of each size it carries at once, when that is
not one number: "How many of each size" on the same screen, written "2 of 10,
1 of 30" (`capacityBySize` on the API), is a hook lift that takes two 10 yard
cans or one 30 yard. Each can then takes its share of the truck (a 10 yard
half of it, a 30 yard all of it), and a load fits while the shares make the
whole truck or less, so two 10s fit and a 10 beside a 30 does not. A size
given its own figure is a size the kind lifts. A can of a size with no figure
of its own, or of no known size, counts against the containers carried. Words
that are not that shape are refused with how to write them. A kind with only
the one figure plans exactly as before.

The truck a driver has on a day is the vehicle with a kind that is checked out
to them that day, which is the same custody record that already says who has
the van (half open, so on the day a truck is handed back it is the next
driver's). A driver holding two such vehicles is planned on the one they were
handed most recently. "Optimise route" plans that day on the truck's own
figures, and the company's one figure under "Collections and the truck" is the
default for a driver with no truck of a kind, not a ceiling. The proposal says
which it used (`GET /v1/dispatch/optimise` answers `source`, the truck's label
and kind, and `capacityBySize`), and checks the load by size as the day goes:
the empties loaded at the yard are the sizes of the drops that follow, a drop
needs an empty of its own size on board (an empty of no known size will do),
a collection needs room for its size beside what is already on the truck, and
a can tipped at the facility is an empty of its own size, so a 30 yard tipped
there is not dropped as a 10 yard. A stop about a container of a size the truck does not lift is
named on the proposal and ordered as plain driving, rather than driven as if
the truck could take it: it needs another truck. A can with no number in its
size, or a drop booked before a can is chosen, is never refused for its size.
A kind's figures change the next proposal only; a day already ordered is not
reordered behind anybody's back.

### Disposal facilities

A full can is tipped at a landfill or a transfer station, and on
`/fleet/containers/facilities` the company records each one: its name, its
address (put on the map by the worker like a property's, or pinned by hand and
then never moved), the days and hours it takes loads (a day left empty is a day
it is closed; none at all means the hours are not recorded, which is never a
reason to refuse a trip), what it charges (by the ton or by the load, with a
minimum when it has one) and the minutes a tip takes there. `GET
/v1/disposal-facilities` lists them, `POST /v1/disposal-facilities` records one,
`PATCH /v1/disposal-facilities/{id}` changes one, `DELETE
/v1/disposal-facilities/{id}` stops using one (closed, never deleted: every haul
that went there keeps naming it), `PUT /v1/disposal-facilities/{id}/pin` and
`DELETE /v1/disposal-facilities/{id}/pin` place and take off a pin, and `GET
/v1/disposal-facilities/{id}/open` says whether it takes loads at a time, and in
words why not. They need `asset:write` (`asset:read` to look). The first one a
company records is its default, and a company has one default at a time.

**Which facility a haul goes to.** "Optimise route" does not send every can to
the default. For each run it picks the nearest facility **by road** (the same
drive times the rest of the plan uses, from wherever the truck is at that point
of the day) that is open when the truck gets there, among every active facility
the company has on the map, or only the `facilityId` asked for. One shut that
day is skipped: by its hours (a day left out of its week) or by a holiday it
keeps. So is one the truck would reach after it has closed. A gate that opens a
little later counts from when it opens, so it wins only when waiting for it still
gets the can tipped sooner than driving to another; one that opens hours later
does not. Ties go to the company's default and then to a fixed order, so the same day
always plans the same way. When none is open the nearest is named anyway and the
run is refused in words, exactly as a single facility is. The answer says which
facility each run goes to and why (`facilityRuns[].facilityName`, `driveMinutes`
and `why`: "Round Rock Landfill is the nearest one open when the truck gets
there, 25 min by road. Austin Transfer is closed for Thanksgiving."), lists
every facility the day knew of with whether it is on the map and why it is shut
(`facilities[].closedToday`), and still names one facility in `facility` (the one
asked for, else the company's default). The preview on the board prints the
reason under each run and a line for each facility shut that day. A facility not
on the map cannot be measured and is left out, and the answer says so; if none
is on the map the day is planned with the yard tipping. The default facility is
now a tie breaker and the one named, not the only one used.

**Holidays.** Each facility keeps a list of days it is closed whatever its week
says (`holidays` on the facility, `PATCH /v1/disposal-facilities/{id}`, and "Days
it is closed" on `/fleet/containers/facilities`): a date, a name ("Thanksgiving")
and whether it repeats every year on that month and day. A listed day beats the
hours, even for a facility whose hours nobody recorded, and `GET
/v1/disposal-facilities/{id}/open` and the run refusal both say the holiday by
name. A date that is not a date, the same day twice (a yearly one covers its
month and day in every year), or more than sixty are refused in words. No
calendar of public holidays is assumed: each facility's list is the company's
own.

The time at the gate is counted, a truck early for it waits, and a run that would
arrive after it has closed, or on a day it keeps no hours, is refused in words on
the proposal (`Austin Transfer is closed at 5:40 PM on Tuesday: it is open 7:00 AM
to 4:30 PM that day`). The search counts a closed gate as a broken promise, so it
drives further to avoid one where any order could. A full can is tipped at the
facility and not at the yard, the empty it leaves with goes straight to the next
drop, and the yard is still where empties are loaded and where a truck leaves
one for room.

A pickup or a swap names the facility the load went to with `facilityId` (the
screen offers the company's facilities beside the ticket); its name becomes the
haul's facility, and a closed facility is refused. A scale ticket file's
facility is matched to a recorded one only when the name is the same, case
ignored, and left as words otherwise.

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
refused with the meter's own sentence when a meter went over with no rate, and
refused when the hire is already on an invoice that has not been voided, so the
same extra days cannot reach two invoices. A hire priced by a flat line on its
job has no period line here, so the period is not billed twice. It needs
`invoice:write`, and the draft is checked and issued on Invoices like any other.
`GET /v1/rentals/{id}/invoice-preview` answers what the invoice would say, and
what raising it would refuse, without writing anything.

**A swap chain, one haul at a time or as one invoice.** The company chooses per
rental, with `PUT /v1/rentals/{id}/billing-terms` (`asset:write`) or when the
can is delivered, and the choice is carried through every swap like the rates.
One invoice per haul is the default: each can's row is invoiced from its own
call, as above. Billed as a chain, one call (from any can in the chain) raises
one invoice for the whole hire with the lines of every can on it in order, a
group per can (its period, its meters, its charges), so a four week hire with
three swaps is one invoice and not four. It waits for the last can to be
collected, for the reason a single haul does, and bills the cans not already on
a standing invoice. Changing the choice applies to every can in the chain not
already on one, and is refused once all of them are.

**Passing the facility's disposal fee on.** When the hire's terms say the
disposal fee is the customer's (`disposalPassThrough`), the fee is OFFERED when
the invoice is raised and never added without a person saying so. The fee is
what was recorded on the haul (what the facility billed) or, when none was, the
ticket's weight at the haul's facility's rate, and the offer says which; it is at
cost, with no markup. Raising the invoice is refused until the call says
`disposalFee: "pass_on"` (the fee goes on as a line for each can) or
`"leave_off"`; when the terms pass it on but no figure can be worked out, the
refusal says what is missing and `leave_off` is the only way forward. The hire
keeps whether it was passed on, the amount that was offered, who decided and
when (`disposalFeePassedOn`, `disposalFeeAmount`). A voided invoice raised again
asks again. `pass_on` for a hire whose terms do not pass it on is refused, and
the terms cannot be set while a hire bills disposal by the ton over the included
tonnage, which would charge the customer for the same load twice. The line is
taxed as the hire's other lines are, a judgement the product owner has not made:
the invoice is a draft, and the office changes that line before issuing it if its
state taxes disposal differently.

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

A fifth, `hauls_per_truck_day`, is on the trade scorecard (`Reports > Trade
scorecard`) and not in this report, because the datum it was missing now exists:
who is a driver. A driver is a person with a vehicle that has a kind of truck
checked out to them that day, the custody record that already says who has the
van, and a truck day is such a person's day on the timeclock rather than the
roster. The hauls are the completed deliveries, pickups, swaps, dump and returns
and relocations that a driver on a truck day did; a visit where the truck
arrived and the haul did not happen (the customer was not there, the way was
blocked) is counted beside the number as a dry run, not as a haul.

Two more are on the scorecard too, `revenue_per_container_month` and
`disposal_cost_pct`, because each haul's revenue is now recorded: a hire's own
invoice names the haul (the rental row) on every line it writes, chain or not,
and the office names the haul a job's own line bills (M10), so a hire sold at a
flat price on its job is a can's revenue too. The facility's fee recorded on the
haul is the cost. M21 says what each counts and leaves out.

The last, `turnaround_hours`, is on the scorecard too, because both ends are
now recorded to the minute and both exclusions as history: the tip and the
drop above, and the repairs and customer holds as periods. Each placement of a
can counts the hours from the tip of its previous hire; a placement recorded
only as a day, or a haul whose tip nobody recorded, is counted beside the figure
and never given an hour, and a can out for repair or held for a customer at any
moment between the two is left out, whole. M21 says what it counts and leaves
out. A KPI computed from the nearest available number (the collection instead
of the tip, midday instead of the drop) is one an owner makes a fleet purchase
on, which is why none of them is used.

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
- `PUT /v1/rentals/{id}/delivered-at` and `PUT /v1/rentals/{id}/tipped-at` for
  the drop and the tip, `POST /v1/rentable-assets/{id}/holds` and
  `GET /v1/container-holds` for the holds.
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

## Fresh water by truck

The trash bin trade's fresh water per stop is a truck's fresh water over its
stops, per truck, because one truck drifting upward is a nozzle or a burner
going. Nothing recorded water: a meter reading is a counter a machine wears out
by, and the per stop "water used" reading on a service report is a guess at one
bin. So a company vehicle's day has its fresh water (`truck_water_day`): the
gallons the tank gauge or the fill meter says it used that day in the company's
calendar, one figure per truck per day.

- **The driver reads it on the phone** at the end of the day, for a truck
  checked out to them that day (`truck.water`, M11).
- **The office types or corrects it** on "Fresh water by truck", linked from
  the top of `Fleet` (`/fleet/water`): each truck's last two weeks, a day per row with the stops
  completed that day by whoever had it, the gallons and the gallons a stop, and
  a form to record a reading; "Take off" removes one read on the wrong truck.
  `GET /v1/truck-water` lists the days (`asset:read`), `PUT
  /v1/assets/{assetId}/water/{day}` records one and `DELETE
  /v1/assets/{assetId}/water/{day}` takes one off (`asset:write`, as a meter
  reading is). Every change is on the audit log.
- **Between two readings of one day the later one stands**, by when it was
  read, so a correction lands and a phone that synced late with an older
  reading does not undo it.
- **Refused**: anything but a vehicle, a truck retired by that day, a day still
  to come, a figure that is not a number of gallons, and more than five
  thousand gallons, which no truck uses in a day.
- **A truck's stops** are not recorded here, because they are known: the visits
  completed that day by whoever had it checked out (custody, half open, so on
  a handover day it is the next driver's), sent to them by name or with a crew
  they are on. A day with stops and no reading is shown as not read.

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

**A day with a time, or a day on its own.** A delivery and a swap take a time
beside the day ("Time dropped", "Time swapped"), read in the company's clock.
With no time the day is sent as a day and kept at midday in the company's clock,
never at midnight: a date as `T00:00:00Z` lands on the previous evening anywhere
west of Greenwich and starts the hire a day early, which is exactly the off by
one a container day is defined to avoid. The hire's row says the time it was
put down, or "no time" for a day only, with "Save drop time" beside it; a
collected hire with no tip time has "Save time emptied", and the ticket column
says when the load was emptied. A collection's own date is still a day kept at
midday UTC, because nothing reads its hour.

**Holds on the register.** A can held for a customer says so on its row with
since when, beside "End the hold"; a can out for repair says since when beside
its chip. "Tag out" and "Back in service" take an optional time for a repair
recorded after the fact. "Repairs and holds" under the register lists the last
thirty periods.

The hire list carries the site's street and city rather than a property id, which
this release added. The asset list already answered "where is it" that way with a
comment saying why; a hire list that did not would make every caller do the join,
this product's own board first.

## What is not built

- **Collections are booked on a clock, not by a route planner.** The worker
  books each collection on its day, at the agreed time or in the working
  day, unassigned; who drives it is the dispatcher's, and the day is ordered
  by "Optimise route". A collection the customer moves after it is under way
  is the office's to rearrange by hand.
- **Scale tickets come from a file.** A photograph of a ticket is not read.
- **A truck's load is shares of one deck.** How many of each size a kind
  carries is one figure per size, and a mixed load fits by shares: a truck
  that can carry a 10 beside a 20 but not beside a 30, in a way shares do not
  describe, is not said. A swap is assumed to bring back a can of the size it
  left. The choice of facility looks only at drive time and opening hours: a
  queue at one gate, a facility that does not take a material (green waste, tyres,
  concrete) or one that charges less per ton does not move a haul, and the fee
  does not enter the choice. A haul is not given a facility the day before, so a
  can tipped somewhere other than the plan said is recorded as the driver says
  on the haul. Holidays are the lists the company types, one facility at a
  time. The load in the morning is not recorded; for a day already under way it is
  worked out from the stops done. The rebalance across people leaves a driver's
  day with containers on it alone (M09).
- **A disposal fee is passed on at cost.** There is no markup on the facility's
  fee, and no standing rule that adds it without being asked: it is offered
  every time. A fee worked out from the ticket's weight is an estimate until the
  facility's invoice is recorded on the haul, and the offer says so. A chain
  billed as one invoice cannot be raised until its last can is collected: the
  cans already collected are invoiced by changing the hire to one invoice per
  haul.
- **Turnaround's times are only as good as what is recorded.** A delivery
  recorded as a day, every hire from before the time was kept among them, is
  counted beside the figure until somebody says when the can was put down, on
  its row or from the phone; nothing reads a visit's completion as the drop. A
  can collected empty and never tipped has no tip, so the next placement is
  counted beside as not known; there is no way to say "came back empty". The
  phone times a stop's haul only once the office has recorded the hire on it
  (a drop off booked before the can was chosen shows nothing to time), and a
  time typed on the phone is the phone's own clock. A customer hold names the
  customer only through the API: the board asks who asked and why in words.
  A hold or a repair running at any moment between a tip and the next drop
  leaves the whole turnaround out, not the hours it ran: the conservative
  reading of "EXCLUDES cans held", which the product owner has not ruled on.
- **No telematics.** Cost per hour and per mile on a company asset are only as
  good as what somebody enters, and so is a truck's water: a reading is what
  the driver read off the gauge, and a flow meter is not connected.
