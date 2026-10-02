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

## Using it

### Run today

`/schedule` is the board. `GET /v1/dispatch/board` is the same data,
`POST /v1/visits/{id}/assign` and `POST /v1/visits/{id}/crew` put somebody on a
visit, `POST /v1/dispatch/route` sets the order, and
`POST /v1/visits/{id}/on-my-way` tells the customer.

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
| Office manager | Reads the board, dispatches, reschedules, runs routes and recurring work |
| Dispatcher | The board, assignment, sequencing, crews and the rota. No money |
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

**Is there route optimisation?** No. The order is set by a person and the
density check tells them whether what they set will fit. A solver is not built.

**Is there a map?** No. The board is a list by technician and by time.

**Why can anybody request time off?** Because `timeclock:own` is the permission
for acting on your own behalf. Approving it is `timesheet:approve`, which is a
manager.

## What is not built

No dispatch map, no route optimiser, and no drive time matrix: travel is what the
company declared, which is why a density total with no declared drive time
reports a floor rather than a figure. Crews, routes and the rota are not on the
dispatch board yet, so a route business plans at `/schedule/routes` and then
watches the day at `/schedule`. Skills gate crew assignment and are not checked
for an individual technician.
