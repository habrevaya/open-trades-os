---
title: Payroll, Time and Commissions
module: M17
domain: Money
phase: 5
status: partial
---

# Payroll, Time and Commissions

> Module M17. Domain: Money. Ships in phase 5.

## What it does

Records time, prices it, classifies a week into regular, overtime and double
time, calculates and settles commission, and produces a CSV a payroll bureau
takes.

## The problem

Labour is the largest expense in a service business and the easiest one to get
wrong in a way nobody notices.

Every punch carries the rate that was applied to it, and nothing was writing
those columns. So every entry's cost was null, every technician's hours cost
nothing, and job costing reported a gross margin missing its largest expense. A
contractor reading that screen would conclude their least profitable work was
their best.

The second failure is commission recorded as a number on a report. The
technician sold the job, the company owes them, and if it shut its doors that
afternoon it would still owe it. A product that does not post that liability has
a company whose accounts never show what it owes its own people.

## Key concepts

**A rate is frozen at the moment an entry closes, from the scale in effect on
the day the work happened.** Not a cache. A rate read live at report time changes
retroactively when somebody edits a scale, so last quarter's job costing moves
after the quarter closed, and nobody can explain why the number they wrote down
is no longer the number on the screen.

**Wage scales are dated.** A union agreement raises rates on a date, and an entry
worked before that date must keep costing what it cost. Resolving by "the active
row" would reprice last year's jobs every time somebody loads a new agreement.

**An entry with no scale is visibly unpriced rather than wrongly priced.** A
company that does not run wage scales should not have its punches refused.

**The week's classification is derived, never stored.** A stored overtime total is
a number somebody can edit, and a payroll figure nobody can explain is the one
thing worse than a wrong one. What is stored is the rate, because that is the
thing that must not move.

**An hour is never paid a premium twice.** That rule lives in core, where it can
be tested without a database, along with the daily and weekly interaction that
makes it hard.

**A pay period has to be a whole number of workweeks and start on the policy's
workweek boundary.** Overtime is measured over a workweek, so a period cutting one
in half cannot be settled: half the hours that decide whether Thursday was
overtime are in the other period, which may already be closed and paid.
Semimonthly periods do exactly this, and are refused by name.

**A period has to be closable, and reopenable by the same power.** Without a
close, the same hours get exported twice and the second file looks as
authoritative as the first. A period closed by mistake that cannot be reopened is
not a control but an obstacle, and people get around obstacles by back dating.

**An export is reproducible, asserted by a checksum rather than hoped for.** Every
input is frozen, including the clock: the statement builder takes the instant as a
parameter so a re-run of a closed period gives the answer it gave the first time,
and the close's own instant is what is passed.

**An edit after an export is visible.** The close records a fingerprint over every
punch and commission line inside the period, and the export recomputes it and
refuses when it has moved. Refusing is the point: a second file with different
numbers and no warning on it is the failure this exists for.

**CSV and only CSV.** Every bureau takes one, no vendor has to approve it, and a
self hoster can open it. A second format would be a format this project has to
keep correct for somebody else's importer.

**A commission is a liability the moment it is earned.** Earning posts an expense
and a liability; paying is a separate event that clears it. This is the deposit
argument with the sign reversed, and it is made just as often.

**A commission plan is superseded, not edited.** A plan that can be edited
reprices commissions already earned and, on a plan edited downward, already paid.
Deactivating and declaring a new one is the supported path, and the earned rows
freeze the basis and the rate anyway, so even a plan deleted outright cannot move
what was paid under it. That is why the commission screen has no edit control.

**A commission plan carries what its basis is wrong about, beside the choice.**
Revenue, gross margin and a flat amount each mislead in their own way, and a note
behind a link is a note nobody reads while choosing.

**Payroll is not processed here.** The export goes to Gusto, ADP, Paychex or
QuickBooks Payroll. BUILD.md says so, and it is a deliberate boundary rather than
a gap.

## Setup

Declaring the pay calendar, the overtime policy and the wage scales all need
`payroll:configure`, which is a different permission from running an export,
because stating what people are owed is a different act from paying them.

## Using it

### Clock and approve

`GET /v1/timeclock/me` is somebody's own clock, with `timeclock:own`.
`GET /v1/timesheets/week` and `GET /v1/timesheets/entries` are the week, with
`timesheet:read`, and `POST /v1/timesheets/approvals` approves it, with
`timesheet:approve`. `/timesheets` is the screen.

### Run payroll

`POST /v1/payroll/periods` declares a period with `payroll:configure`.
`GET /v1/payroll/register` is the register, where every line carries a reason and
the people who cannot be paid are named first.
`POST /v1/payroll/periods/close` and `POST /v1/payroll/periods/reopen` close and
reopen. `POST /v1/payroll/exports` produces the CSV and
`GET /v1/payroll/exports` lists what has been produced. `/payroll` and
`/payroll/{id}` are the screens.

### Commission

`GET /v1/commissions/plans` lists the plans and
`POST /v1/commissions/plans` declares one, both with `commission:configure` to
write. `POST /v1/commissions` settles an earning,
`POST /v1/commissions/reversals` reverses one, and
`POST /v1/payroll/commission-payments` records them as paid, which is a payroll
act and takes `payroll:export`. `/payroll/commissions` is the screen.

### Tips

A tip a customer adds when paying an invoice from the portal (M05, M13) is
split evenly between the technicians on the job's visits and arrives owed to
them. Each share is its own line on that technician's register and export,
`tip` in the pay category column, in the period the payment arrived in, and a
technician who was tipped and not on the clock that period is still on the
register. A commission reversal is never taken out of a tip: it is measured
against wages, carried forward when wages cannot take it, and the tips are
added whole afterwards, because a tip is the technician's money and an
employer keeping part of one is what US federal law forbids. A tip arriving
inside a period after it closed moves the period's fingerprint, so the export
refuses until it is reopened and closed again.

`POST /v1/payroll/tip-payments` records the tips as passed on, from a closed
period, everything owed up to its end; it debits Tips payable against cash and
marks each share with the period that paid it, so running it twice pays nothing
twice. **Record tips as paid** on `/payroll/{id}` is the same thing.

### Declare overtime and wage scales

`/payroll/pay-rules` is the screen: the overtime rule in use and the ones it
replaced, every wage scale with its dates, and who is paid at which classification
with the people whose time would cost nothing named. Reading it takes
`timesheet:read` and changing anything `payroll:configure`.

`GET /v1/payroll/overtime-policies` lists the policies and
`POST /v1/payroll/overtime-policies` declares a new one, which replaces the old one
and says when it reclassifies weeks already approved.
`GET /v1/payroll/wage-scales` lists the scales and `POST /v1/payroll/wage-scales`
loads one. `POST /v1/payroll/wage-scales/{id}/revisions` changes a rate from a date:
the old scale is closed the day before and a new one opened from that day with
everything else it said, in one step, so time worked before keeps its rate. A change
dated on or before the day the scale began is refused, because that scale was wrong
rather than changed: `POST /v1/payroll/wage-scales/{id}/retire` stops it on a date
and the right one is loaded. Nothing is deleted.
`GET /v1/payroll/crew-rates` says who costs what today and
`POST /v1/payroll/classifications` sets a person's classification. Loading,
changing and declaring answer a retried request with the first answer rather than
writing a second row.

## Permissions

| Role | Access |
|---|---|
| Owner | Everything |
| Administrator | Nothing in payroll unless it is granted explicitly |
| Office manager | Reads timesheets |
| Dispatcher | Reads timesheets |
| Technician | Clocks in and out. Their own time only |
| Accountant | Reads payroll, runs the export, reads commission |

`payroll:read` and `commission:read` are both on the sensitive list, and the
administrator preset deliberately excludes `payroll:read`, `payroll:export` and
`payroll:configure`: running the system is not the same job as paying people.

## API

| Call | Needs |
|---|---|
| `GET /v1/timeclock/me` | `timeclock:own` |
| `GET /v1/timesheets/week` | `timesheet:read` |
| `POST /v1/timesheets/approvals` | `timesheet:approve` |
| `POST /v1/payroll/periods` | `payroll:configure` |
| `GET /v1/payroll/register` | `payroll:read` |
| `POST /v1/payroll/periods/close` | `payroll:export` |
| `POST /v1/payroll/exports` | `payroll:export` |
| `GET /v1/commissions` | `commission:read` |
| `POST /v1/commissions/plans` | `commission:configure` |
| `POST /v1/payroll/commission-payments` | `payroll:export` |
| `POST /v1/payroll/tip-payments` | `payroll:export` |
| `GET /v1/payroll/overtime-policies` | `timesheet:read` |
| `POST /v1/payroll/overtime-policies` | `payroll:configure` |
| `GET /v1/payroll/wage-scales` | `timesheet:read` |
| `POST /v1/payroll/wage-scales` | `payroll:configure` |
| `POST /v1/payroll/wage-scales/{id}/revisions` | `payroll:configure` |
| `POST /v1/payroll/wage-scales/{id}/retire` | `payroll:configure` |
| `GET /v1/payroll/crew-rates` | `timesheet:read` |
| `POST /v1/payroll/classifications` | `payroll:configure` |

## Common questions

**Why does the export refuse after somebody edits a punch?** Because the numbers
would differ from the file already sent, with nothing saying so. Reopen the
period, close it again, and export.

**Can a technician see their own pay rate?** Only with `payroll:read`, which the
technician preset does not hold. The applied rates on a punch are redacted by the
same permission.

**Why is there one commission permission for declaring a plan and settling an
earning?** Declaring and settling are different acts and a larger product would
separate them, but a third permission no role preset grants is a power nobody
could hold, which is worse than a coarse one.

## What is not built

No payroll processing, by design. A wage scale's own overtime multipliers and
apprentice ratio are taken by the API and not offered on the pay rules screen,
which loads a scale's classification, rates, authority, reference, jurisdiction
and start date; and a scale cannot be corrected in place: a wrong one is retired and the right one
loaded. Tips given through the portal are paid through payroll; a cash tip
handed to a technician at the door is not recorded anywhere, and a tip is
split evenly with no way to split it otherwise. Reimbursements and per diem
are not modelled. Certified payroll reporting is not built. Commission
splits across several people are computed by core and settled one earning at a
time rather than from a screen.
