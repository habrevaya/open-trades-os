---
title: Reporting and Business Intelligence
module: M21
domain: Grow
phase: 5
status: partial
---

# Reporting and Business Intelligence

> Module M21. Domain: Grow. Ships in phase 5.

## What it does

Answers the questions an owner asks on a Sunday night. What did we invoice
last month, who owes us money and how long have they owed it, what is open,
what is stuck, who did how much work. Eight of those ship in the box and run
on the first day. Anything else is built on the screen: pick what the report
is about, pick what to group it by, pick what to count.

## The trade scorecard

Separate from the report builder and answering a different question. A report
is "show me these rows grouped this way". A KPI is "of the numbers my trade
runs on, what are they this month".

Eight trade packs declare sixty three KPIs between them, forty seven distinct
keys, each with a label, a format, a target and a definition precise enough to
name the way that metric is usually got wrong. `KpiSeed` validated every one of
them at import and nothing read them: searching the product for `kpis` returned
the schema line that parses them and nothing else.

`GET /v1/kpis` is the reader, and `GET /v1/kpi-catalogue` is the whole list
with what the product can do about each.

### Every number comes with its two halves

"$620" is an assertion. "$186,000 over 300 jobs" is an arithmetic a contractor
can argue with, and arguing with it is how they come to trust it. Every
definition in every pack turns out to be a ratio of two countable things, which
is not a coincidence: a KPI that is not is usually one nobody can reproduce.

A zero denominator is **null, never zero**. Nought per cent close rate says
every estimate was lost; no estimates presented says there is nothing to
measure. Those are different months with different answers, and this codebase
makes the same choice in `utilisation`, `reachRate` and `overageCapture`.

The exception is a total. A replacement pipeline over no declined
recommendations is zero dollars, which IS the fact, and reporting it as unknown
would send an owner looking for a report that is working correctly.

### The unavailable list is the other half of the answer

Twenty one of the forty seven are answered: seventeen computed here, four by
M22's fleet report. The other twenty six each name the single datum that is
missing.

Two moved off the list when it was checked against what has shipped since.
`drive_time_pct` turned out not to need a commute flag: the definition says
where the commute leg is, before a person's first stop of the day and after
their last, so a drive is counted when the same person has a stop that ended
before it and another that started after it, on the same day in the company's
calendar. A day that records no driving (or no stop) is left out of both
halves rather than read as nought per cent. `backflow_recert` needed a typed
last test date on the assembly, and M33 gave it one: a backflow test is an
inspection whose checkpoint is about a `backflow-assembly` and whose answer
names the unit, on a real date. The rest were checked too, and where something
has shipped that answers half of one (a customer's own cancel request, a van's
odometer, an inspection naming a water heater, a change order) the `needs`
sentence now says which half is still missing.

That is a product decision rather than an apology. **Most of these definitions
name an exclusion**, and a KPI computed without its exclusions is worse than an
absent one, because it looks like the definition. `drive_time_pct` excludes the
commute leg; without that exclusion the number is about where people live
rather than about how the route was built, and a company in a sprawling metro
would read it as a dispatch problem. `recurring_retention` excludes customers
who sold the house; without it a retention figure moves with the local property
market and an owner concludes their service is getting worse.

A dashboard showing six real numbers and naming the two it cannot compute is
worth more than one showing eight where two are guesses, because the guesses are
the ones somebody makes a hiring decision on.

### Three missing data would unlock most of the rest

- **A coded cancellation reason.** Four KPIs need it: every retention and
  renewal figure has to separate churn from a house sale.
- **A cost posting.** `ACCOUNTS.COGS` is declared in core and nothing debits it,
  so margin KPIs would read material and labour and miss subcontract and
  disposal, which is exactly where a badly estimated install goes wrong.
- **A finer job type class.** `job_revenue_class` was added for these and
  unlocked five. A trade's own upsell path (a drain job that became a lining, a
  troubleshooting call that converted on the visit) needs the pack to mark which
  of its own job types and price book items are the upsell.

### What `job_revenue_class` is, and is not

Added in the same change as the scorecard, because a third of these definitions
depend on it and nothing could answer them: "install revenue", "completed
service calls to non members", "the recurring route average", "deep cleans,
move outs and post construction, which are all day jobs".

`capacity_model` is a different question. It says HOW work is scheduled: one
technician, a crew, a route, a container on hire. Two job types with the same
capacity model can be an install and a maintenance visit, which carry different
margins and belong in different numbers. In the HVAC pack `repair` and `maint`
are both `technician_dispatch`, and they are `service` and `recurring`.

Five values: `install`, `service`, `recurring`, `project`, `internal`. It is
REQUIRED on a pack's job type rather than defaulted, so the compiler asks once
per job type and a pack author cannot skip the one decision those numbers
depend on. On the table it defaults to `service`, which is the least wrong thing
to assume about a job type somebody created by hand without saying.

`internal` is the one worth explaining. A yard repair and an estimate
walkthrough consume capacity and earn no customer revenue, and in a
revenue-per-day denominator that is exactly the thing that has to be
distinguishable rather than absent.

### The screen

`Reports > Trade scorecard`. Under Reports rather than beside it, because a top
level item for one screen is how a rail becomes a list of every screen, and it
is a child rather than one of the eight built-in reports because it is not a
report: a report shows rows grouped a way you chose.

The window defaults to the month so far in the COMPANY's timezone. Dated by the
server's clock it would roll over at seven in the evening in Austin and show an
owner an empty month.

The number is large and its two halves are under it, always, and each half is
a link to the records behind it (below). A null value reads
"Not this window" rather than 0%, which is the service's decision carried
through to the last step: a screen that rendered the null as a zero would undo
it. The unavailable list is below, each row naming its one missing datum, and the
four the fleet report already answers are named with the endpoint rather than
computed again, because two screens computing one number from two queries is how
they come to disagree.

### The records behind a KPI

Every half of every computed KPI is written as the list of records it counts,
each with what it adds: a completed job and its ledger revenue, an estimate
presentation, a plan sold, a technician day, a drive between two stops, an
assembly due a retest. The scorecard's number is the sum of those rows, and
clicking a half on `Reports > Trade scorecard` opens `/reports/scorecard/records`
listing the same rows, so the total at the bottom is the half that was clicked
by construction. Each record opens on its own screen: a job, an estimate, an
agreement, a visit, a customer, the week's timesheets, or the unit.

It is refused, in words, rather than trimmed, in three cases. The figure is
the whole company's, so somebody whose scope is narrower (a technician who
sees their own jobs) is refused: a list of only their records would not add up
to the number above it. A record kind the reader may not read is refused,
naming the permission. Revenue per job needs `report.financial:read`.
`kpi-drill.integration.test.ts` drills every half of every computed KPI under
every trade and checks the rows add up to what the scorecard shows.

### The guard

`kpis.integration.test.ts` fails if a pack declares a KPI the catalogue does not
account for, if the catalogue accounts for one no pack declares, if a pack and
the catalogue disagree about a format, or if a `needs` sentence is vague enough
to be "not built".

The computed set is a NAMED LIST rather than a count. This codebase learned that
once already: `SOFT_DELETE_NOT_OFFERED` was a count that stayed at twenty four
while one table was fixed and another broke. Listed, a KPI moving from `needs`
to `computed` is a line in a diff with the implementation beside it, and one
moving the other way has to be argued for.

The guard earned itself immediately. Six of the trash bin pack's eight KPIs were
written across several lines, my extraction missed them, and the test named all
six: a scorecard for that trade would have shown two numbers and silently
dropped the rest.

## Key concepts

**A report definition is data, not SQL.** It names a dataset, some dimensions,
some measures and some filters, all of them drawn from a catalogue the product
declares, and the service turns that into a query. Every fragment that reaches
the database was written by us.

This is the choice most products get wrong in the other direction. Letting
somebody write the query is arbitrary read access against a multi-tenant
database in a product people self host: row level security would still hold,
but scope would not, field redaction would not, and a technician with the
report builder would have the cost column. It is the same argument as workflow
conditions, which are also data and also never evaluated.

The cost is real. You cannot express every query, and a contractor who wants a
window function is out of luck. What they get instead is direct SQL against a
read-only analytics credential with its own grants, rather than a builder that
quietly becomes one.

**A report is a read like any other.** It is scoped. A technician running
"jobs by status" counts their own jobs, not the company's. Without that, the
report builder is the most convenient way around scope in the product: count
the jobs by customer and read the customer list off the group labels.

Every dataset in the catalogue has to declare its scope filter, and a test
compares the two lists. A dataset added without one fails closed and fails the
build, in that order.

**A permission missing is a refusal, not a blank column.** Ask for a measure
you may not see and the report does not run, and says which permission it
needed. A report that quietly omits the cost column teaches whoever ran it
that the cost is zero, and they act on it.

**A saved report is a stored question, not a stored permission.** The
definition is re-resolved against whoever runs it. An owner saving "revenue by
month" does not thereby hand it to a technician.

**Every number opens onto the records behind it, and they add up to it.** A row
of a report is already a precise description of a set of records: the report's
own definition (dataset, filters, date range, scope) with each grouped dimension
pinned to the value on that row. So drill through is not a second query written
per report or per screen. It is the same conditions the aggregate used, with one
`is not distinct from` per dimension and the grouping taken off, which is why a
group the report shows as "Not set" opens the records with nothing in that field
rather than none at all. Each measure is selected per record from the same SQL
fragment the aggregate sums, so the drilled list shows what each invoice or job
added to the number, and the totals at the bottom are the number that was
clicked.

What each dataset adds is only what one of its rows IS: its id, what to call it,
which screen opens it, and a few columns to recognise it by. That is
`RecordShape` in `packages/core/src/reporting/drill.ts`, and it is REQUIRED on a
dataset, so a dataset added tomorrow cannot be summed without saying what it
summed. A job opens on `/jobs/{id}`, an invoice on `/invoices/{id}`, an estimate
on `/estimates/{id}`, a visit on `/visits/{id}`, a task on `/tasks/{id}`, the
job costing and margin rows on the job (which carries the per job statement),
and the customer on each record links to the customer.

`report-drill.integration.test.ts` runs every report that ships and every tile
on every dashboard that ships against a company with invoices in every aging
bucket, a draft with no issue date, a voided invoice, a part paid one, a card
fee and hours at a frozen rate, drills every row, adds the records up itself and
compares. Money and counts exactly, hours to a millionth, averages at four
places.

**A report that arrives is the same report, run as somebody.** A schedule points
at a report (one that ships, or a saved one) rather than copying it, so
correcting the report corrects what is emailed. It runs as the person who set it
up, re-read from their membership on the day it runs, so somebody who loses the
right to see it stops receiving it in their name. Each person in the company it
goes to must be able to open that report themselves, and what they are sent is
the report run again AS THEM, with their own scope: a technician who may run
"jobs by status" is emailed their own jobs, not the company's. An address outside
the company (the accountant) is sent the run of the person who set it up, which
is the owner's own decision, and it is on every delivery row.

**Once per occurrence is a unique index.** Each delivery row carries the key of
the occurrence it was for, `schedule:{id}:{day}` in the company's calendar, and
is inserted first in the same transaction as the emails and the move of the
schedule's clock. A worker that dies rolls all three back; a second worker, a
restart, or somebody moving the time from seven to eight after the seven o'clock
one went inserts nothing and sends nothing.

**A day is the company's day.** Every KPI and every report counts whole days in
the company's timezone: a window runs from the first moment of its first day to
the last of its last day where the company is, a day, month or day of the week
it groups by is the one the company was in, and the aging buckets age against
the company's today. A job finished at eight in the evening in Chicago on the
30th is the 30th's, though it is the 1st in UTC. A column that is already a
date (an invoice's issue date) is compared as the date it is.

## Setup

Nothing. The catalogue and the built-in reports ship with the product, and
both are filtered by what the reader holds, so an owner and a dispatcher see
different lists rather than the same list with half of it erroring.

## Using it

### Run one of the reports that ship

`/reports` lists them by the question each one answers. Every one has a date
range, and the range lives in the URL, so a report sent to a bookkeeper opens
on the same months.

### See it as a chart

Every report grouped by a date or a category is drawn above its table, from
the same rows. Grouped by a date, it is a line, oldest on the left, and "Columns"
draws the same numbers as columns; grouped by anything else, it is bars in the
report's own order (biggest first, or the aging buckets in age order). A loss
is drawn below the axis in red, and every bar and point opens the records
behind it, as the numbers in the table do. A report counting several things
draws the first and offers the others ("Draw"). A report grouped by two things
is drawn by one of them with the other added up, and says so, unless what it
counts cannot be added up (an average), in which case it says why there is no
chart. Twenty five bars at most, and four hundred points; the table always
has every row. The chart is SVG drawn on the server: no chart library, it
prints, and it works with JavaScript off.

### Print it, or save it as a PDF

"Print or save as PDF" on any report opens `/reports/print`: the company's
name, the report, its dates, filters and branch in words, who printed it and
when, the chart and every row, with nothing else on the page. The browser's
own print dialog makes the PDF.

### Narrow a report to one branch

For somebody who sees the whole company in a company with branches, every
report has a Branch choice beside its dates, and the builder has it under
"Narrow it down". The records behind a number and the print view keep it. It
narrows the jobs, invoices, estimates, visits and job profitability datasets
to the branch's jobs and what hangs off them; the tasks and calls datasets do
not belong to branches, and a branch on them is refused rather than ignored.
Those same datasets can be grouped by Branch. A branch manager's reports are
their branch's already, through their scope.

### Build your own

`/reports/new`. Choose what it is about, tick what to group by, tick what to
measure, narrow it down. The whole builder state is the query string, so it
works with JavaScript off, the back button behaves, and the report you built
is a link you can send.

"Edit a copy" on any built-in report opens the builder with that definition
loaded, which is the usual way a custom report starts.

### Save one

Named, described, and visible to everybody who can read reports. What they see
when they run it is still their own work.

### Open the records behind a number

Every number on a report, and every number, bar and month on a dashboard tile,
is a link to `/reports/drill`. The page names the row (Age: Over 90 days), says
the report's filters and dates in words, lists the records with what each added
to every measure, and totals them under the columns. Up to a thousand records
are listed; the totals are always over every one, and the page says when the
list was cut short.

### Have a report emailed

"Email on a schedule" on any report, or `/reports/schedules/new`. Every day,
every week on the days ticked, or every month on a day from 1 to 28, at a time
in the company's timezone. Pick which days it covers (the day, seven days or
month before, this month so far, or everything) and who gets it. The email is a
summary of the first twenty rows, with two files attached: the whole report as a
CSV for a spreadsheet, and the same run as a PDF with the chart the screen would
draw, the dates, whose run it is, and every row. Both are made from the run that
recipient is sent, so a technician's PDF is their own jobs. People in the
company also get a link back to it in the app. The first one goes at the next
occurrence, not straight away.

The PDF is written by the product itself rather than by a browser: see
`packages/core/src/pdf/writer.ts` for why, and for what it cannot print.

"Send now" beside each schedule sends it straight away, to the same people and
covering the same days measured back from now, run as the person pressing it
(it is their decision to send it) and refused if they could not run the report
themselves. The schedule's clock does not move, and a paused schedule can still
be sent by hand.

`/reports/schedules` lists every schedule with when it next goes, and its last
delivery: when, which dates, how many rows, and for each recipient the
message's status or why it was not sent (left the company, may not see it,
asked not to be emailed, no email connected). Pause keeps the history and comes
back on the clock without catching up on what it missed; Change makes the
person saving it whose authority it runs under; Stop deletes it and keeps what
it sent.

### Email a report from an automation

"Run and email a report" is a step on the automation canvas. It goes through the
same delivery as a schedule, runs as whoever published the automation, and is
sent once per run, so a run resumed after a wait does not send it again.

## Permissions

| Role | Access |
|---|---|
| owner, admin | Everything, including the financial datasets |
| manager | Everything their scope covers |
| accountant | The financial datasets |
| dispatcher, csr | The operational datasets. Invoices and estimate values are refused |
| technician | Their own work only, and only where `report:read` is granted |

`report:read` runs reports, opens the records behind them and lists schedules.
`report:build` saves and deletes reports and sets up, changes, pauses and stops
schedules. The financial datasets additionally need `report.financial:read`, and
a drill is refused exactly where its report would be, in the same words.

## API

`reports.run(ctx, definition)` takes a definition and returns columns and
rows. `reports.drill(ctx, { definition, match })` returns the records behind one
row. `reports.available(ctx)` returns the catalogue trimmed to what the
caller holds, which is what the builder is drawn from. `reports.builtIn(ctx)`,
`list`, `save`, `remove` and `runSaved` cover the rest.

| Call | Needs |
|---|---|
| `POST /v1/reports/drill` | `report:read` |
| `GET /v1/kpis` | `report:read` |
| `GET /v1/kpi-records` | `report:read`, and see above |
| `GET /v1/report-schedules` | `report:read` |
| `POST /v1/report-schedules` | `report:build` |
| `PATCH /v1/report-schedules/{id}` | `report:build` |
| `POST /v1/report-schedules/{id}/paused` | `report:build` |
| `POST /v1/report-schedules/{id}/send` | `report:build` |
| `DELETE /v1/report-schedules/{id}` | `report:build` |
| `GET /v1/report-deliveries` | `report:read` |

The worker sends what is due on every pass (`docs/self-hosting/worker.md`), and
then hands that company's outbox to its mail provider.

## Common questions

**Can I write SQL?** Not through this. Point a read-only credential at the
database and write whatever you like: that is a separate grant you control,
which is the honest version of the same capability.

**Why does my report stop at a thousand rows?** It says so when it does.
Nobody reads a ten thousand row report on a screen, and a report cut off
without saying so is the worst failure this screen has.

**Why is "To" exclusive?** So a range of one month does not silently include
the first moment of the next one.

**Why did my report not arrive?** `/reports/schedules` says, on the row: the
person who set it up can no longer see it, the person it was for may not, the
address asked not to be emailed, or no email provider is connected. A schedule
emails nothing until one is (Settings, Integrations).

**Why does my technician's copy show fewer jobs than mine?** Because it is their
copy: everybody in the company is sent the report as they would see it.

**The aging buckets have numbers in front of them in the database.** They sort
that way on purpose: "Over 90" lands between "1 to 30" and "31 to 60"
alphabetically. The catalogue marks the column, and the screen takes the
prefix off.

## What is not built

Twenty six of the forty seven declared KPIs cannot be computed, and each one
names the single missing datum rather than saying not built, because most of
these definitions turn on an exclusion and a KPI computed without its exclusions
looks like the definition. The records behind a KPI are listed only for a
reader whose scope is the whole company. A drill, of a report or of a KPI, lists at most a thousand records (its
totals still cover all of them).

The PDF is set in the standard Helvetica faces, which cover Western European
characters: a letter they lack prints as its unaccented base letter where it
has one and as "?" where it does not. An emailed report appears as a
thread in the inbox like every other email this product sends, and "send now"
queues it for the worker's next pass rather than sending it in the request.
Nothing is emailed until an email provider is connected. Dashboard tiles keep
their own bars and columns rather than the report chart. A chart draws one
measure at a time and does not stack a second grouping. No cross company report
other than the four network aggregates, which are `docs/concepts/networks.md`.
