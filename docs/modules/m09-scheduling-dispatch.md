---
title: Scheduling and Dispatch
module: M09
domain: Operate
phase: 3
status: partial
---

# Scheduling and Dispatch

> Module M09. Domain: Operate. Ships in phase 3.

## What it does

Decides who is going where, today and next Tuesday. Four capacity models, not
one, because a company that dispatches service calls, a crew that paints a
house, a route that cleans forty pools and a yard that rents steel boxes are
four different shapes of day.

## The problem

Nearly every system in this space models the dispatched appointment and assumes
the rest are special cases of it. They are not. A pool company does not sell
appointments, it sells a stop on a Tuesday route, and its unit economics are
density: how many stops fit between the first and the last without running into
overtime. Run that business as a list of unrelated jobs and you have rebuilt the
system they were leaving.

## Key concepts

**Four capacity models, declared per job type and not per trade.** Technician
dispatch, crew production, route, and asset rental. A lawn company runs routes
and sells installs; an electrician dispatches service and runs crews on a rough
in. Stamping one model on a trade tells an owner their business is a category.

**The board is one query for a whole day across everybody.** A dispatcher is not
looking at a visit, they are looking for the gap and the thing that is late, and
both of those are properties of the day rather than of any row in it.

**Assignment replaces rather than adds.** The board's gesture is "these people,
on this job", and an add-only call makes removing somebody a second call that is
easy to forget.

**A day is reordered as a list, not as a sequence of moves.** A board reorders by
drag, which moves one card and renumbers everything after it. Sending the whole
order means the server never holds a half renumbered day, which is what produces
two stops numbered four and a technician driving the wrong way across a county.

**On my way is a row, not a flag.** A company that sends two has a problem worth
seeing, and the question worth asking later is how long before arrival it
actually went out. A boolean answers neither. It goes through the same consent
gate as every other message: a technician tapping it is not an exemption from a
STOP.

**Who to text, in order: the contact on the PROPERTY first.** On a rental the
customer is the landlord and the person who opens the door is the tenant, and
texting the landlord that somebody is fifteen minutes away helps nobody standing
outside a house. Then the customer's primary contact, then the number on the
customer record, which is what a one person household has.

**The ETA is omitted rather than guessed.** "About null minutes" has shipped in
this industry more than once.

**The text names who is coming and links to them coming.** "Ridgeline Air:
your technician, Ray, is about 15 minutes away. See where they are:" and the
job's link, `/j/{token}`. While Ray is on the way, that page shows his first
name, his photo if the office set one, an ETA, and a pin that moves as his
phone shares where he is, read every twenty seconds through
`GET /v1/portal/job/live`. Only positions taken for that visit after the text
went are shown, never the drive before it, and once he arrives the page shows
no location at all. The ETA is by road when the company has a routing
service, a straight line otherwise, or what Ray said when he set off, counted
down, and the page says which. The photo is on the page, not in the text: a
text with a picture is a different, costlier message, and not every phone
shows one.

**A route is materialised once per stop per date, not per route per date.** The
unit a customer notices being double booked is their own house. The idempotency
key is the one `services/recurring.ts` already uses, deliberately: two different
answers in this codebase to "has this already been created" means two
technicians on the day they disagree.

**Materialising produces ordinary jobs and visits.** The board already draws
them, the field app already syncs them, and dispatch can still reassign one when
somebody calls in sick. Nothing about technician dispatch changes.

**Density answers in three values, not two.** Null means the question cannot be
settled from what the company has declared, which is a different thing from a day
that fits, and a total with no declared drive time is reported as a floor rather
than as a figure, because treating the drive as zero tells somebody a fifteen
stop day fits.

**A crew names its lead.** The lead is who the office rings, and a crew with
people and no lead is called out rather than left looking complete.

**A production rate shows only with its unit.** "Eight hundred a day" is square
feet or linear feet or cubic yards, and the three are different jobs.

**At most one person is on call at any instant.** Enforced on the way in by
refusing an overlapping window, rather than resolved on the way out by a priority
rule. A read that picks a winner from two overlapping rows tells two technicians
two different things and neither of them knows it, which is the actual failure
mode of a whiteboard and a group text.

**Nobody on call is said in words.** A blank where a name should be reads as
fine.

**The map is the board's day, drawn where it happens.** Every visit as a pin in
its technician's colour, numbered in the order they will drive it; a crew's
visits as squares in the crew's colour; unassigned work as an outline, so it
cannot be mistaken for anybody's; a late visit ringed in red; each technician's
and each crew's day as a line from where it starts, through the stops and
back; and, for somebody who dispatches, where each technician is now. A visit whose address is not on the map yet is listed beside it with
a link to place the pin, never dropped: a map missing three addresses shows a
lighter day than the one the technicians are going to have.

**The map is drawn by a small component, not a mapping library.** Raster tiles
from a URL the deployment configures (`MAP_TILE_URL`, OpenStreetMap's own
servers by default, with their attribution drawn on the map as their terms
require), placed by Web Mercator arithmetic that lives in core with its own
tests. Pins are buttons, so a keyboard and a screen reader can reach them.

**A day starts somewhere.** A technician's own start location when one is set
on the technicians screen, otherwise the company's first location, which is
said wherever it is used. Locations are geocoded like properties.

**The optimiser proposes; it never reorders.** For one technician's day it
proposes the order that keeps arrival windows first and drive time second,
starting and ending where the day does. A fixed appointment is a window that
opens and closes at the same minute. Work already under way or finished is not
moved, and the plan starts from it. Applying the proposal sends the whole day
to the same reorder a drag uses.

**A window that cannot be kept is said, not broken quietly.** The proposal
names it, says by how much, and says whether any order at all could have kept
it, because "nobody can get there by ten" and "this order gets there at ten
forty" are different calls to the customer.

**Drive time is by road when the company has a road network to ask, and
says which it used.** A company connects a routing service under Settings,
Integrations (capability `routing`): OSRM it runs itself on OpenStreetMap
roads, Mapbox's Matrix API, or OpenRouteService hosted or self hosted. Drive
times are asked as a matrix, kept in `travel_time` for as long as the provider
allows (thirty days for a company's own OSRM, a week for OpenRouteService, a
day for Mapbox), and asked outside any database transaction. Without one, or
when it does not answer, a straight line between two addresses, stretched by a
road factor, at an average speed the company sets. Every proposal says which
in a sentence (`driveSource` and `driveNote`), and a routing service that has
stopped answering is named on the integrations screen. Between two stops on
the same route that declares its own drive time, the operator's number beats
both. Nearest neighbour construction and 2-opt and or-opt improvement,
deterministic: the same day in gives the same order out.

**The whole day can be rebalanced, and a person applies it.** "Rebalance the
day" on the board proposes who takes what across every technician and every
crew at once: it places the unassigned pile and moves assigned work between
people, and between crews, keeping,
hardest first, who may do the work (skills and time off), arrival windows, the
overtime limit, lunch inside its window, then less overtime, then less
driving. It is shown as each day before and after, with the driving saved, and
nothing moves until somebody presses "Apply these changes", which goes through
the same assignment and reorder a drag uses, in one transaction, and is
refused when the board has changed since the proposal was made. A visit is
moved between people only when that keeps a promise or a limit, cuts
overtime, or saves at least five minutes of driving: two phones buzzing for
three minutes saved is not a trade. A run of up to three visits moves
together, so two calls on the far side of town are not each left where they
are because the other keeps the van there. The share of each person's window
held for members (M08) is kept as a drop keeps it: a visit for somebody no plan
lets into the hold goes onto a person, or a crew, only while that person's (or
each of the crew's people's) window has room outside the share kept for
members, counting every visit the plan puts there; one nobody can take without
it stays where it is, and one waiting in the pile is listed with the hold in
words ("Ray Ortiz's time in the 8am to 12pm window on 2026-12-02 is kept for
members, and Sid Stranger is not a member there that day."). Applying asks
the whole plan the same question before anything moves, against the day as
it was proposed, and refuses it whole in the same words, ending "Propose it
again.", when the payload or something since (a plan sold, a booking taken)
would put a stranger in a member's place.

**Several days can be rebalanced, and a visit moves to another day only
where its customer agreed.** "Rebalance several days" proposes the next two
to seven days together. Each day is rebalanced as above, and a visit may
also move to another day of the range, but only one whose customer agreed:
a range of days set on the visit ("any day the week of the fifth"), the
window of the agreement visit it delivers, or the days of the week set on
the customer as the days that suit them (and inside both when there are
both). Never onto today or off it, because a customer expecting somebody
this afternoon has not agreed to Thursday, and never onto a day the visit's
branch is closed: a weekday its own week keeps closed (the company's week,
for a branch that keeps none, M02) or a date on its holiday list, so a Houston
visit may go to Houston's Saturday while an Austin one may not. The same constraints hold on the new day (skills and time off at the
hours the visit would have on that day, so a person with the afternoon off still
takes a morning visit, the window at the same wall clock times, the overtime limit and
lunch), and a visit moves day only when that keeps a promise or a limit,
places work no day could take, cuts overtime, or saves at least fifteen
minutes of driving, a higher bar than moving it between two people because
the customer's plans change. The share of each arrival window held for
members (M08) is kept on the new day: a visit for somebody no plan lets into
it moves into a window only while that window has room outside the hold, as
online booking would have offered it, counting every visit the plan moves in,
and so is the share of each person's window, as in one day's rebalance: on the
new day a visit's time is new to everybody, whoever had it included. It is shown as each day before and after, and
a person applies it: each moved visit goes to its new day through the
assignment a drag uses, its technicians hear through the visit's notices,
and its customer is told by text or email through the same path an answer
to their own request to move uses, which also overtakes any request of
theirs still waiting.

**A visit with several people on it moves with all of them.** It takes the
hours of every one of them, so both rebalances count it on each of their
days, not only the lead's, and neither ever hands it to somebody else or
takes one of them off it. The several day rebalance may move it to another
day the customer agreed to, but only one where every one of them is planned,
may take it at the hours it would have there (skills, and part of a day
off), and fits it into their own day: the window, their own hours and the
overtime limit, and lunch. The bar to move it is the same as for one
person's visit, measured over all of their days together. Applying it puts
the same people back on it, the lead still leading, after asking again
whether each of them is off for those hours; a payload that names only some
of them, or another lead, is refused in words. Work already under way, or
done, stays where it is.

**A move between days keeps online booking's ceiling.** When the work is
sold online, a visit moved to another day lands in one of the company's
arrival windows, and it counts against how many that window takes online,
the same count a customer moving their own visit meets (booking requests,
customers' asks to move, and times the office offered). A window already
at its limit is not moved into, and the apply reads the count again, so a
booking that came in after the proposal is refused in words rather than
overfilled.

**Crews are rebalanced like people, on one day and across days.** Every
active crew with work on the day or in the range, or with somebody on it the
person planning can see, is planned beside the technicians: its day starts where it is based, works
the company's hours and lunch, and its visits move between crews (and, in the several day
proposal, between days) by the same rules and the same bars. Crew work only
ever goes to a crew, checked for the crew's kit and its people at the
visit's hours on the day it would be on (the check a drop onto a crew's lane
makes), and one person's work only to a person. A
crew whose base is not on the map is left out with its work where it is,
and said so.

**The working day is declared, not assumed.** When the day ends, a break of so
many minutes that must start inside a window, and how much overtime a plan may
use, company wide on the technicians screen; a technician with their own hours
has those instead. The break goes in a wait outside a customer's window when
it fits there, at the first gap once its window opens otherwise, and is waited
for rather than skipped when the next job would run past its latest start.

**A locked visit stays put.** The office locks a visit to whoever has it when a
customer was promised a particular person first thing, which no window can
say. The rebalance never moves it to anybody else and keeps its order among
that person's locked visits; "Optimise route" keeps it at its place in the day
and orders the rest around it. Work under way is left where it is too, and
a visit with several people on it stays with all of them.
A visit has one place in the order however many people are on it, so a
shared visit takes its place from its lead's day, and the others' days are
numbered around it.

**Where people are is shown to people who dispatch, and only while people
work.** With live location on (it is off until an owner turns it on), the
phone app shares a technician's position only while they are clocked in, on
the way to a visit or working one, never off the clock, and the server checks
every position against its own record of the clock and the visits and drops
any outside them. The map draws each technician's latest position today, with
how long ago it was taken, faded once it is half an hour old, for somebody
holding `visit:dispatch`: a CSR or a technician reads the board and not where
their colleagues are. Behind each pin is the path they took today, dotted
in their colour beside the planned day's solid line: every position kept
since the start of the company's day, a parked stretch drawn as one point,
thinned evenly to at most four hundred points. Positions are kept three
days unless the company says otherwise (one to thirty) and deleted by the
worker, which first keeps each person's finished day as its stops and the
miles between them for route density (M21) and nothing else; turning sharing
off deletes every position already kept, and those days with them. The store
is bounded: no two positions of one person are kept closer together than
half the company's interval (at least five seconds), so a day is at most
2,880 rows per person at the default minute. The privacy choices are set
out in M11.

**A visit called off says who asked, and when.** "Call off this visit" on
`/visits/{id}` (`POST /v1/visits/{id}/cancelled`, `visit:reschedule`) cancels a
visit nobody has started, or one somebody is on the way to, takes it off the
route, tells whoever was on it not to go, and closes any request of the
customer's still waiting on it. It asks who wanted it called off, the customer
or the company itself (weather, staffing), with no default, and when they asked
if that was earlier than now (never later, and never before the visit was
booked). Every other path that cancels a visit says the same: a job cancelled
with its visits (M10), a customer's request from their link approved by the
office (the customer, asked when they sent it, M05), and a visit brought in
from history (as the old system said, or not known). The company's notice
window, how many hours before a visit a customer must cancel (a day unless it
says otherwise, on Settings, "Late cancellations", or
`PATCH /v1/cancellation-notice`, `settings:write`), is frozen on the visit when
it is called off, so changing the policy does not change which past
cancellations were late. The visit's page says who asked, when, and whether it
came inside the window. Cleaning's cancellation rate reads these (M21), and a
guard test fails when a new path cancels a visit without saying who.

**A day the company called off says why.** When the answer to "who asked" is
"We called it off", the form goes on to ask why, from a fixed list (rain or
weather, crew short, equipment, or something else, which asks for a few words),
and shows a box for more words beside any of them. The customer is never asked:
choosing the customer shows no such box, and a reason sent with the customer on
the API is refused ("Only a day the company called off has a reason."), as the
database refuses one on a visit the customer cancelled. It is asked on the
visit's own form and on "Cancel this job" with its visits (M10), and accepted on
the two calls behind them, `reason` (`code`, `note`) on
`POST /v1/visits/{id}/cancelled` and `cancelReason` on `PATCH /v1/jobs/{id}`
with `cancelVisits` and `cancelledBy: "company"`; the job's one reason goes on
every visit it calls off. The visit's page says it ("We called it off, Oct 20,
9:00 AM. Rain or weather"), `GET /v1/visits/{id}` carries it as
`cancellation.reason` (`code`, `label`, `note`, `words`), and the cancellation
records the scorecard opens for the company's own days end with it ("#41 Rosa
Reyes, North, Wednesday, Rain or weather"), or "no reason given". It is kept on
the visit as `cancel_reason` and `cancel_reason_note`, and the audit entry has
it. An API caller that says the company did it and gives no reason is recorded
with no reason given, as one that does not say who is recorded as not known:
nothing guesses a reason from notes, and an integration that cancelled before
reasons existed keeps working. A visit brought in from history does not carry
one.

**Crew work is not unassigned.** A visit sent to a crew is on the crew, not on
anybody's assignment list, and the board used to put it in the unassigned pile
where a dispatcher would give it to somebody else. A visit carries a crew or
people, never both: sending it to a crew takes it off whoever had it, and a
crew card dragged onto a person on the board hands it to that person, off
the crew's lane, with their skills and time off checked like any drop and
the crew's members told it is no longer theirs. The other way round, a
person's card, or one from the unassigned pile, dropped on a crew's lane goes
to the crew through the same check the crews screen makes (the crew's kit,
its people and their leave at the visit's hours), comes off whoever had it,
and a crew that cannot take it is refused in that check's own words where
the card was dropped. A visit for somebody who is not a member that would take
the share of one of the crew's people's window kept for members is refused the
way a drop onto that person is, naming the people and the crews whose people
all have room outside the hold, until the dispatcher presses "Send anyway"
(`intoMemberHold` on `POST /v1/visits/{id}/crew`), which the audit log records
for each person whose share it took (M08). Each crew with work today
has a lane of its own beside the people, with its lead, and its day is a line
on the map in its own colour from where it is based. The routes running today
are listed above the board with how many stops are done and who runs each,
and so is the rota: who is on call today, or "Nobody is on call today" in
words.

**Who should take the unassigned work is a suggestion too.** Each unassigned
visit goes to the technician it adds the least driving to without breaking a
window, among those whose skills and time off allow it (a person off for part of the day is
ruled out only of the visits whose hours meet theirs), and every technician
considered is listed with their figure or the reason they were ruled out.
Members whose plan promises priority dispatch are placed first, so the
cheapest gap on the day goes to them, and the suggestion names the plan;
the rebalance places them first in the unassigned pile too (M08). Booking a
job or adding a visit by hand into an arrival window held for members, for a
customer who is not a member there that day, is refused until the person
booking ticks "Book anyway", which the audit log records (M08). Dropping such
a customer's visit on the board onto a person whose own room in that window
is only the share of their window kept for members is refused the same way,
naming who could take it instead, until the dispatcher presses "Send anyway"
(`intoMemberHold` on `POST /v1/visits/{id}/assign`), which the audit log
records (M08). So is a drop onto a crew's lane, and both rebalances keep the
same share as they plan (above).

**A route's density uses drive times by road when it can.** The route's own
declared drive time between stops still comes first. Without one, and with
a routing service connected, the density check asks it for the drive
between the stops in their order and out from where the servicer's day
starts and back, counting only the legs it answered. Any leg it could not
answer, a stop not on the map, or the extra stop being asked about (which
has no address yet) leaves the total a floor, said so, and never filled in
with a straight line guess.

**A route's density can be asked for a date.** "Check a date" beside the fit
on `/schedule/routes` (`on` on `GET /v1/service-routes/{id}/density`) asks
about one day rather than the weekday's template. It counts only the stops
whose own cadence falls on that date, the rule making a day uses, and says
how many it left out; and it reads the hours kept that date by the branch of
whoever runs the route (the crew's, or the technician's), the company's week
where that branch keeps none, with its holiday list over it (M02). A date
that branch is shut, a holiday or a weekday its week keeps closed, has no
working day to fit into: the answer says why (`dayBasis: closed`,
`closedOn`) and gives no overtime verdict. A short day with no overtime
policy is measured against its own hours; with a policy, the policy still
says when overtime starts and the short day's hours are said beside it. A
date on another weekday than the route's is refused in words, as making a
day of it is. The weekday's template reads the same branch's week.

**A driver's day with containers on it is ordered by what is on the
truck.** "Optimise route" on a roll off driver's column knows that a drop
needs an empty container on the truck, a collection needs room on it, and a
swap needs an empty and leaves with a full one, and counts the runs to the
yard between (where the driver's day starts) as drive and time like any
other. How many containers a truck carries (of each size, when its kind says, with the load checked by size), which sizes it lifts and how long
the yard takes are those of the driver's own truck, the vehicle with a kind
checked out to them that day, or the company's figures on `/fleet/containers`
when they have none (M22). A full container is tipped at the company's default
disposal facility, or the one asked for with `facilityId`, when it is on the
map: yard to customer to facility to the next stop, counting the time at its
gate, and a run that would reach it after it has closed is named in words. The
proposal lists each run to the yard and each run to the facility: after which
stop, before which, and what is tipped and loaded there.

**Nobody is sent alone to work they are not qualified for.** The job type's
required skills are checked for an individual technician on a drop, on the
assignment API, on booking with a technician named, and in the suggestions,
with one sentence naming the person and the skill. See M24 for where the
answer comes from. An override needs `visit:assign_unqualified` and a reason,
and the audit log keeps the reason beside the refusal it overrode.

## Using it

### Run today

`/schedule` is the board. `GET /v1/dispatch/board` is the same data,
`POST /v1/visits/{id}/assign` and `POST /v1/visits/{id}/crew` put somebody on a
visit, `POST /v1/dispatch/route` sets the order, and
`POST /v1/visits/{id}/on-my-way` tells the customer.

A card whose job is on hold says why in words under the summary ("On hold 3 days.
Waiting on a part: condenser fan motor"), as `onHold` on the visit in
`GET /v1/dispatch/board`, so nobody rings a customer for work that is waiting on a
supplier (M10 keeps the hold itself, and nudges the office when one lasts too long).

### See the day on a map

`/schedule?view=map` is the map, and `/schedule?view=split` puts it beside the
board. `GET /v1/dispatch/map` is the same data. Click a pin to open the visit
and put it on somebody's day.

### See where people are

With live location on, `/schedule?view=map` shows each technician's latest
position today beside the day, read again every half minute, with how long
ago it was taken and the path they took today behind it. `GET
/v1/dispatch/positions` is the same, for `visit:dispatch`, each position
carrying its `trail`. `GET /v1/dispatch/location-sharing` reads the company's
setting (anybody who reads the schedule may, technicians included) and
`PUT /v1/dispatch/location-sharing` sets it (`settings:write`): on or off, how
many days positions are kept, and how often a phone takes one. Both are on
`/schedule/technicians`, with each person's own switch, set by the office with
`PATCH /v1/technicians/{id}` (`user:write`).

### Rebalance the day

"Rebalance the day" on the board opens `/schedule/rebalance`, the proposal for
the whole day: who would take what, each technician's day as it is and as it
would be, each crew's day beside them, the driving before and after, and what
could not be placed with why in a sentence. "Apply these changes" applies it,
putting crew work on its crew through `POST /v1/visits/{id}/crew`'s own check
and setting each changed crew day's order. `GET /v1/dispatch/rebalance`
is the proposal (`visit:read`) and `POST /v1/dispatch/rebalance/apply` applies
it with its `basis`, `moves`, `orders` and `crewOrders` (`visit:dispatch` and
`visit:reschedule`). The Lock button
on a card is `POST /v1/visits/{id}/lock` (`visit:dispatch`). The working day it
plans inside is `GET /v1/dispatch/workday` and `PUT /v1/dispatch/workday`
(`settings:write`), on `/schedule/technicians` with each person's own hours.

### Rebalance several days

"Rebalance several days" on the board opens `/schedule/rebalance/days`, the
proposal for two to seven days from a date: the visits that would move to
another day and why the customer agreed, who would take what on each day,
each day's visits, driving and overtime as it is and as it would be, and
each person's and each crew's day before and after. "Apply these changes"
applies it, putting crew work on its crew through `POST
/v1/visits/{id}/crew`'s own check and setting each changed crew day's
order. A visit with several people on it is listed with all their names,
and on each of their days as "with" the others; it is applied with
`technicianIds`, every one of them, lead first.
`GET /v1/dispatch/rebalance/days` is the proposal (`visit:read`) and
`POST /v1/dispatch/rebalance/days/apply` applies it with its `basis`
(`visit:dispatch` and `visit:reschedule`). What the customer agreed to is
set on the visit's page, `PUT /v1/visits/{id}/movable` (`visit:reschedule`),
and on the customer's page, `PUT /v1/customers/{id}/preferred-days`
(`customer:write`); an agreement visit's own window counts without being
set.

### Drive times by road

Connect OSRM, Mapbox or OpenRouteService under `/settings/integrations`, Drive
times by road. The optimiser, the suggestions, the rebalance and a customer's
ETA use it from then on, and say so.

### Put a technician's day in order

"Optimise route" on a technician's column previews the proposed order with the
drive time before and after and any window it cannot keep; "Use this order"
applies it. `GET /v1/dispatch/optimise` is the proposal and its `applyOrder`
goes to `POST /v1/dispatch/route`.

### Fill the unassigned pile

"Suggest who" above the unassigned pile proposes a technician for each visit.
`GET /v1/dispatch/suggestions` is the same, and accepting one is
`POST /v1/visits/{id}/assign`.

### Say what people do and where their day starts

`/schedule/technicians` records each technician's skills, start location,
colour, their own hours and whether their location is shared
(`PATCH /v1/technicians/{id}`, which needs `user:write`), the photo a customer
sees on their tracking link (`POST /v1/technicians/{id}/photo`), places the
company's locations on the map (`POST /v1/locations/{id}/pin`), and sets how
drive time is estimated (`PUT /v1/dispatch/travel`, which needs
`settings:write`). `GET /v1/technicians` lists them.

### Run a route business

`/schedule/routes` defines a route, its stops and their order, and shows whether
the day fits. `POST /v1/service-routes` creates one,
`POST /v1/service-routes/{id}/stops` adds a stop,
`POST /v1/service-routes/{id}/order` reorders,
`GET /v1/service-routes/{id}/density` answers whether it fits (by the
route's declared drive time, or by road when a routing service is connected,
and says which; for the weekday, or for a date with `on`), and
`POST /v1/service-routes/{id}/materialise` turns the template into real visits
for a date.

A route stop is recurring work sold to a customer at a price per stop, which is
what a recurring schedule is, so it uses the same permissions: `job:read` to look
and `job:write` to change. There is no route permission in the catalogue and
inventing one was not an option.

### Run crews

`/schedule/crews` names a crew, staffs it, gives it a lead, and shows who is on
call. `POST /v1/crews`, `PUT /v1/crews/{id}/members`,
`GET /v1/crews/for-job` and `GET /v1/crews/{id}/availability` are the API side.
`POST /v1/visits/{id}/crew` sends a visit to a crew (`visit:dispatch`), and
each member's phone hears about it (M11). On the board, a crew's card
dragged onto a person is `POST /v1/visits/{id}/assign`, which takes it off
the crew, and a person's card dropped on a crew's lane is `POST
/v1/visits/{id}/crew`, which takes it off the person.

A crew belongs to a branch and is based at a shop. `/schedule/crews` shows each
crew's branch, and somebody who sees the whole company moves one with
`PATCH /v1/crews/{id}`; somebody limited to a branch makes crews in their own
branch only and sees, staffs and sends only its crews, with only its people.
Routes are seen by whoever sees the technician or crew that runs them. Booking,
assigning, sending a crew or running a route writes the visit's shop: the
lead's start or membership shop, or the crew's base (`docs/modules/m01-core-tenancy-access.md`).

### Keep a rota

`POST /v1/on-call/rotations` schedules a shift, `GET /v1/on-call` answers who is
on right now, and `POST /v1/on-call/handover` passes the phone over mid shift.

### Recurring work

`POST /v1/recurring-schedules` defines it,
`GET /v1/recurring-schedules/{id}/preview` shows what it will produce,
`POST /v1/recurring-schedules/{id}/materialise` creates the jobs, and
`POST /v1/recurring-schedules/{id}/exceptions` skips one occurrence without
breaking the series. `/recurring` is the screen.

### Time off

`POST /v1/time-off` is a request, with `timeclock:own`, so anybody can ask.
`POST /v1/time-off/{id}/approve` needs `timesheet:approve`. Approved time off is
on the board and is checked when a visit is booked, for work still to come only. It is read by the hour
everywhere it is read: the board, booking, putting a crew on a visit, the map's
suggestions and the multi day rebalance (M17 says how).

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything |
| Office manager | Reads the board, dispatches, reschedules, overrides a skill refusal with a reason, runs routes and recurring work |
| Dispatcher | The board, the map with where people are, assignment, sequencing, the rebalance and locks, crews and the rota. Cannot override a skill refusal unless given `visit:assign_unqualified`. No money |
| CSR | Books work. Cannot dispatch, and does not see where people are |
| Technician | Their own day. Requests their own time off |
| Crew lead | The crew's day |
| Accountant | Neither |

## API

| Call | Needs |
|---|---|
| `POST /v1/visits/{id}/cancelled` | `visit:reschedule` |
| `GET /v1/cancellation-notice` | `settings:read` |
| `PATCH /v1/cancellation-notice` | `settings:write` |

The calendar can also be subscribed to: `POST /v1/calendar-feeds` issues a feed,
`GET /v1/calendar-feeds` lists them, and `POST /v1/calendar-feeds/{id}/rotate`
and `POST /v1/calendar-feeds/{id}/revoke` handle a leaked URL. All four are
`visit:read`, because a feed is a read of the schedule.

## Common questions

**Is there route optimisation?** Yes, as a proposal per technician, for the
whole day across everybody, and for several days with visits moved between
days where the customer agreed, that a person accepts or ignores. None
changes the day on its own. Route templates at `/schedule/routes` are still
ordered by a person and checked for density.

**Does it track technicians at home?** No. A phone shares only while its
person is clocked in or on a visit, the server drops anything else it is sent,
and the company and each person can turn it off, which deletes what was kept.

**Why did rebalancing several days not move a visit to a quieter day?**
Because its customer agreed to no other day: set the days it may happen on
on the visit, or the days of the week that suit the customer on their page.
Or the other day is today, or the company is closed then, or the move saves
less than fifteen minutes of driving and keeps no promise or limit, or the
window on that day has no room left outside the share held for members (the
window's, or the person's who would take it), or it has several people on it
and one of them cannot take that day.

**Why did the rebalance not move a visit to the nearer technician?** Because
it saves less than five minutes of driving, or it is locked, or that person may
not do it, or the time it would take is the share of their window kept for
members and the customer is not one, or it would make a visit late, run past
the overtime allowed, or push lunch past its window. The proposal says which for anything it could not
place.

**Is there a map?** Yes, beside or instead of the board. It needs addresses on
the map: connect a geocoder under Settings, Integrations (M25) or place pins by
hand on each property's page.

**Why is the drive time different from my phone's?** With no routing service
connected, it is a straight line at an average speed, not a road network:
connect one, or tune the speed and road factor on the technicians screen, or
declare a drive time on a route. A route template's density uses no straight
line at all: the declared time, the road, or a floor. With one, it is the road without traffic,
where a phone's map app counts the traffic now.

**Who may override a skill refusal?** The owner, an administrator and the
office manager preset hold `visit:assign_unqualified`. A dispatcher is given it
by name when the company wants the person at the board to make that call.

**Why can anybody request time off?** Because `timeclock:own` is the permission
for acting on your own behalf. Approving it is `timesheet:approve`, which is a
manager.

## What is not built

A visit is not called off from the phone: a team turned away at the door rings
the office, which records it with the time they were turned away, as the
customer's. Why the company called a day off is coded from now on, and a
company cancellation from before that, from an API caller that gave none, or
brought in from history, stays "no reason given": the API does not insist on a
reason, so an integration written before it keeps working, and only the screens
ask every time. A visit cancelled before who asked was recorded,
or by an API caller that did not say, stays not known; nothing guesses it from
notes. No live traffic: drive times by road are the roads as the provider knows them,
and a routing answer is kept for the provider's whole cache period. A route's
fit for a date counts the route's stops as the template has them that date: it
does not read the visits already made from it (a stop moved, added or removed
on the board that day is not in the figure), nor the servicer's own leave or
hours that day. Making a day of a route on a date its branch is closed is not
refused; its fit for that date says the day is closed. A route
template's density by road counts the drive out from where the day starts
and back, while a declared drive time counts only the hops between stops;
the note beside each figure says which. Rebalancing several days moves a
visit only to a day inside the range shown (seven days at most), keeps its
wall clock window rather than choosing another, and does not offer the
customer a choice of day: they are told the day it moved to and reply if it
does not suit. The online ceiling is checked only for work sold online and
only for a time inside one of the company's arrival windows that day; work
not sold online, or a window the company does not offer online, has no
ceiling to keep. A visit with several people on it moves only between days,
never between people, and is left where it is (and not counted) when one of
its people is not planned that day: another branch's person, or somebody
whose day starts off the map or carries containers. Each of its people is
held to its window on their own day; the plan does not make them arrive
together. The rebalance plans lunch and overtime from company settings and
each person's own hours, not from the overtime policy's thresholds. A crew
is planned on the company's working day (crews have no hours of their own).
A technician whose day has no start
on the map is left out of it, with their work where it is, and so is a
driver whose day has containers on it, which "Optimise route" orders by
what is on the truck instead. The truck's load in the morning of a day
already under way is worked out from the stops done so far, not recorded.
A crew has a lane on the board only on a day it has work, so its first
visit of a day is sent from the crews screen or the API; a card dropped on a
crew's lane keeps its place in the order, and the crew's day is reordered by
the rebalance, not by where the card was dropped. Live positions come only from the phone app; `/my-day`
in a browser shares none. The path on the map is today's only, from the
positions the phone sent, so a stretch with no signal is drawn as a
straight line between the positions either side of it. The map is raster
tiles only.
