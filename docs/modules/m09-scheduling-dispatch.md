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
its technician's colour, numbered in the order they will drive it; unassigned
work as an outline, so it cannot be mistaken for anybody's; a late visit ringed
in red; each technician's day as a line from where it starts, through the stops
and back. A visit whose address is not on the map yet is listed beside it with
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

**Drive time is an estimate, and says so.** A straight line between two
addresses, stretched by a road factor, at an average speed the company sets,
except between two stops on the same route that declares its own drive time,
where the operator's number is used. Nearest neighbour construction and 2-opt
and or-opt improvement, deterministic: the same day in gives the same order
out.

**Who should take the unassigned work is a suggestion too.** Each unassigned
visit goes to the technician it adds the least driving to without breaking a
window, among those whose skills and time off allow it, and every technician
considered is listed with their figure or the reason they were ruled out.

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

### See the day on a map

`/schedule?view=map` is the map, and `/schedule?view=split` puts it beside the
board. `GET /v1/dispatch/map` is the same data. Click a pin to open the visit
and put it on somebody's day.

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

`/schedule/technicians` records each technician's skills, start location and
colour (`PATCH /v1/technicians/{id}`, which needs `user:write`), places the
company's locations on the map (`POST /v1/locations/{id}/pin`), and sets how
drive time is estimated (`PUT /v1/dispatch/travel`, which needs
`settings:write`). `GET /v1/technicians` lists them.

### Run a route business

`/schedule/routes` defines a route, its stops and their order, and shows whether
the day fits. `POST /v1/service-routes` creates one,
`POST /v1/service-routes/{id}/stops` adds a stop,
`POST /v1/service-routes/{id}/order` reorders,
`GET /v1/service-routes/{id}/density` answers whether it fits, and
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
on the board and is checked when a visit is booked, for work still to come only.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything |
| Office manager | Reads the board, dispatches, reschedules, overrides a skill refusal with a reason, runs routes and recurring work |
| Dispatcher | The board, the map, assignment, sequencing, crews and the rota. Cannot override a skill refusal unless given `visit:assign_unqualified`. No money |
| CSR | Books work. Cannot dispatch |
| Technician | Their own day. Requests their own time off |
| Crew lead | The crew's day |
| Accountant | Neither |

## API

The calendar can also be subscribed to: `POST /v1/calendar-feeds` issues a feed,
`GET /v1/calendar-feeds` lists them, and `POST /v1/calendar-feeds/{id}/rotate`
and `POST /v1/calendar-feeds/{id}/revoke` handle a leaked URL. All four are
`visit:read`, because a feed is a read of the schedule.

## Common questions

**Is there route optimisation?** Yes, as a proposal per technician that a
person accepts or ignores. It never reorders a day on its own. Route templates
at `/schedule/routes` are still ordered by a person and checked for density.

**Is there a map?** Yes, beside or instead of the board. It needs addresses on
the map: connect a geocoder under Settings, Integrations (M25) or place pins by
hand on each property's page.

**Why is the drive time different from my phone's?** Because it is a straight
line at an average speed, not a road network. Tune the speed and road factor on
the technicians screen, or declare a drive time on a route.

**Who may override a skill refusal?** The owner, an administrator and the
office manager preset hold `visit:assign_unqualified`. A dispatcher is given it
by name when the company wants the person at the board to make that call.

**Why can anybody request time off?** Because `timeclock:own` is the permission
for acting on your own behalf. Approving it is `timesheet:approve`, which is a
manager.

## What is not built

No drive time matrix from a road network: the optimiser estimates from the
straight line and the company's own declared route times, and a route
template's density check still uses only declared travel, which is why a
density total with no declared drive time reports a floor rather than a
figure. The optimiser orders one technician's day and suggests a technician for
each unassigned visit; it does not rebalance work between technicians, move a
visit to another day, or account for lunch, overtime or the end of the working
day beyond arrival windows. Crew visits are not on the map's lines, which follow
individual assignments. The map is raster tiles only, with no traffic and no
live technician positions. Crews, routes and the rota are not on the dispatch
board yet, so a route business plans at `/schedule/routes` and then watches the
day at `/schedule`.
