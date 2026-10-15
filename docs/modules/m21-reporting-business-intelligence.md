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

Thirty two of the forty seven are answered: twenty eight computed here, four
by M22's fleet report. The other fifteen each name what they still lack.

Four moved off the list when it was checked against what has shipped since.
`drive_time_pct` turned out not to need a commute flag: the definition says
where the commute leg is, before a person's first stop of the day and after
their last, so a drive is counted when the same person has a stop that ended
before it and another that started after it, on the same day in the company's
calendar. A day that records no driving (or no stop) is left out of both
halves rather than read as nought per cent. `backflow_recert` needed a typed
last test date on the assembly, and M33 gave it one: a backflow test is an
inspection whose checkpoint is about a `backflow-assembly` and whose answer
names the unit, on a real date. `revenue_per_crew_day` needed a crew clock, and
a crew's clock is what its members punch on the crew's own visits, so a crew
day is counted once per crew however many people are on it (below).
`install_gross_margin` needed somewhere for the office to put a subcontractor's
bill or a disposal receipt against a job, and a journal line can now name the
job (M14) and job costing reads it (below). Every one of the rest was checked
again against what has shipped since (crews, terms and breakage, member holds,
purchasing returns and late freight, part days off, estimate expiry, credit
payouts, retainage, push notices). Where something answers half of one the
`needs` sentence says which half is still missing: a hire's invoice is linked
to it but holds only part of what the haul earned, and a cost can be put on a
job but nothing marked a supply as billed back (something does now, below). The four retention, renewal and
churn figures moved when a cancellation got a coded reason (below).

The nineteen (as they then were) were checked once more against everything that has shipped since:
punches on a crew's visits, costs journalled to a job and overhead as a mix,
staff notices, call queues and calling back, inspections signed on the phone,
hauls to a disposal facility and a truck's own kind, shared commission, budgets
by branch and job type, part days off, and review reminders. None of them
supplies a datum one of the nineteen names, so none moved, and none is computed
from something close to its datum instead. Where one of them comes near, the
sentence now says how near: the company budget is money for a month and never
hours for a job (a job now carries its own crew hour budget, below); a permit can be filed against a job as a compliance document,
but not the city's visits to it; the pest pack's template already asks why no
product was applied, so record completeness lacked only the list of fields a
report was required to capture when it was written (a report keeps it now, below); the electrical pack
declares a panel's rating, open spaces and known concern, but the register
holds no value to that declaration; a job could be put on hold, but nothing said
it was waiting on a part (it can now, below); and the phone's positions are kept three days by
design, so a month's route miles are gone before a month's figure could read
them.

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

- **A coded cancellation reason.** It arrived, and unlocked the four that
  needed it (below): cancelling an agreement now asks why from a fixed list,
  and a move or a sale offers to end the customer's link to the address.
- **A flag for supplies billed back.** Two cost ratios need it. A cost posting
  was the other half of this item, and it exists now: an accountant can journal a
  subcontractor's bill or a disposal receipt to a job (M14) and job costing counts
  it, which is what unlocked install gross margin. The flag itself arrived
  later: a supply on a job can be marked billed back at cost (M10), which
  unlocked the supply cost share of revenue (below).
- **A finer job type class.** `job_revenue_class` was added for these and
  unlocked five. A trade's own upsell path (a drain job that became a lining, a
  troubleshooting call that converted on the visit) needs the pack to mark which
  of its own job types and price book items are the upsell.

### The two that were unlocked, and what they leave out

**Revenue per crew day** divides the ledger's revenue on completed jobs a crew
worked (a job with a completed visit sent to a crew, every revenue class but
internal) by crew days. A crew day is a crew and a day in the company's calendar
on which both are true: somebody on the crew was on the clock on the crew's own
visit, in a kind of time that is a crew's day, and the crew completed a stop. That
is the definition's three exclusions made literal. Yard and shop time is not a
crew's day (the shop is a technician's day on the clock but not a crew's, which
is why the two lists differ), a rain day has punches and no completed stop, and a
punch on no visit belongs to no crew. A crew of four is one day, not four. The
rule is `reporting.crewDays` in core, and the integration test puts the same rows
through it and through the SQL and requires the same days. Each half is dated by
its own record, the job by its completion and the day by the clock, so a job that
ran across a month end puts its revenue in one month and some of its days in the
other. `stops_per_day` is still counted per technician day for every trade that
declares it, a lawn crew's included, because the one entry serves cleaning teams
and pest technicians too.

**Install gross margin** is install revenue less material, subcontract, disposal
and burdened labour, over install revenue, for completed jobs of the `install`
class. The costs are the job's own statement's (M15, one copy of the SQL): the
job's lines of every kind but labour, so subcontract and disposal are in, plus
the cost of goods sold posted to the job, a journalled bill included; hours at the
loaded rate frozen on each punch; and payroll taxes, benefits and workers'
compensation at the company's rates, which makes the labour burdened. Card fees
and overhead are not in the definition and are not here. **Only installs whose
costs are all in are counted, in both halves**: no hours ever recorded, a punch
still running, hours no wage scale could price, a line with no cost, and work
nobody has billed or excused all make a job's margin read higher than it earned,
and an install that used a subcontractor nobody has booked yet is the likeliest
of them. The figure is over fewer jobs and the records behind each half are
exactly the jobs counted, so an owner can see which. This is the conservative
choice, and the cost is that a company that never records costs sees "Not this
window". An install booked with no subcontract cost still reads high: the number
is only as complete as the books, and a warranty return on an install counts at
its cost with no revenue against it. Because it is what jobs cost, it takes what
a job's margin takes: reading it needs the job costing permission and the
financial reports permission (`job.cost:read` and `report.financial:read`), and a
reader without them is told which in the unavailable list instead of being shown
a margin one division away from the cost column.

### First time fix, and the two data it waited on

Plumbing's, HVAC's and electrical's **first time fix rate** is completed jobs
done in one visit over completed jobs, and all three definitions leave jobs
out: HVAC's those "planned as multi visit", plumbing's those and "jobs held for
a part order", electrical's those and jobs held "for a part order or an
inspection". Visit counts were always here; the plan and the reason a job
waited were not. Both are recorded now (M10): a job can say it is **planned for
more than one visit**, when it is booked or before anybody has arrived at a
visit on it, and a **hold has a reason** from a fixed list, a part hold naming
the purchase order the part is on.

- A visit counts when it was done: completed, or completed on a phone that
  missed its cancellation. A completed job none of whose visits was done
  (finished from the office, brought in from history) has no count to judge
  and is in neither half.
- A plan counts only when it was said no later than the first arrival on the
  job, so a job that went badly cannot be relabelled afterwards. The jobs
  service refuses a late one as well.
- A hold counts only when it was placed before the job was finished and for a
  reason the company's trade leaves out (`reporting.FIRST_TIME_FIX_HOLDS` in
  core), and a part hold only once its order went to the supplier and was not
  cancelled: a draft is a part nobody has ordered.
- Customer work only, every class but internal, as the callback rate counts it.

The jobs left out are **counted beside the number** and open like a half
(`half=excluded`), so the exclusion is visible rather than a way to tidy the
figure. The rule is core's `reporting.firstTimeFixOf`, with unit tests, written
again in SQL, and `kpi-first-time-fix.integration.test.ts` checks a month worked
out by hand under each of the three trades and puts the same jobs through both.
The catalogue's records take the company's trade for this one key, because the
three packs define it three ways.

### Budgeted hour variance, and the hours it waited on

Lawn and landscape's **budgeted hour variance** is "actual crew hours minus
budgeted hours on completed jobs, as a percentage of budgeted", and it EXCLUDES
"change order hours that were separately approved, or every approved upsell
reads as an overrun". It needed budgeted hours on a job, which nothing held (a
job type's duration is a scheduling default, a phase's budget and the company
budget are money), and hours on a change order, which carried only money. A job
now carries the crew hours it was budgeted, fixed from the first punch on it
(M10), and a change order the crew hours it adds and the project job they are
worked on (M12).

- Actual crew hours are every working punch on the job, each person separately:
  on site and travelling to it, never leave or an unpaid break.
- An approved change order's crew hours come off that job's actual hours. One
  sent and not yet approved does not.
- A completed job is **left out of both halves** with no budget, a punch still
  running, or no hours at all, because a job nobody clocked would read as
  entirely under budget. Customer work only, every class but internal.
- The numerator's records are the jobs counted, each adding its hours over
  budget (negative when under); the denominator's, each adding its budget. A
  negative figure is under budget.

The rule is core's `reporting.budgetVarianceOf`, with unit tests, written again
in SQL, and `kpi-budget-hours.integration.test.ts` checks a month worked out by
hand and puts the same jobs through both.

### Supply cost share of revenue, and the flag it waited on

Cleaning's **supply cost share of revenue** is "chemical, consumable and
equipment consumable cost divided by invoiced revenue", and it EXCLUDES
"supplies stocked for a commercial account and billed back at cost, which are a
pass through and not a margin leak". A cost could already be put on a job; what
was missing was a flag for supplies billed back, and a supply used on a job can
now be marked billed back to the customer at cost (M10).

- A supply is a job's `part` line: what a chemical, a consumable and an
  equipment consumable are. Equipment fitted is capital and labour is hours.
- Revenue is the ledger's on completed customer jobs, as every revenue figure
  here is.
- A supply marked billed back that is **on an invoice issued and not voided**
  leaves both halves: its cost from the top, what it was billed at (net of
  discounts, before tax) from the bottom. One marked and not yet billed counts
  as a cost, because nothing has come back for it.
- A job with a supply whose cost nobody recorded is **left out of both halves**,
  rather than read as free.
- The supplies passed through are counted beside the number and open like a
  half.

It is what supplies cost, so like install margin it needs `job.cost:read` and
`report.financial:read`, and a reader without them sees it in the unavailable
list with the permissions named. The rule is core's `reporting.supplyCostOf`,
with unit tests, written again in SQL, and
`kpi-supply-cost.integration.test.ts` checks a month worked out by hand and puts
the same jobs through both.

### Application record completeness, and the list it waited on

Pest control's **application record completeness** is "completed visits where
every regulated field required by the operator's configuration was captured,
divided by completed visits", and it EXCLUDES "visits recorded with a no product
applied reason, which have their own required set". The exclusion was always
readable (the pack's template asks for `no_product_reason`); what a visit was
required to capture was not, because a template keeps only its current fields.
A report now keeps that list, frozen from its template when it is written (M11),
and the operator sets what is required on Settings, Service reports.

- A visit counts when it was done (completed, or completed on a phone that
  missed its cancellation), on customer work.
- **Complete**: a report on it captured every regulated field it was required
  to. A field is captured when it holds a number, a yes or no, words that are not
  only spaces, or one of a chemical application's regulated columns.
- A completed visit with **no report at all** is not complete: it is the most
  incomplete record there is.
- A visit recorded with a no product applied reason is **left out** and counted
  beside, as the definition says.
- A visit whose reports were held to **no regulated field** (written before the
  list was kept, or the operator required none) is left out of both halves and
  counted beside as not known, rather than read as complete for having been
  asked nothing.

The rule is core's `reporting.recordCompletenessOf`, with unit tests, written
again in SQL, and `kpi-record-completeness.integration.test.ts` checks a month
worked out by hand, puts the same visits through both, and checks that a
report's list is frozen when the phone writes it and does not move when the
template is edited.

### The four that waited on a coded cancellation reason

Cleaning's **recurring customer retention**, pest control's **program renewal
rate**, lawn's **programme renewal rate** and the trash bin trade's **monthly
subscription churn** all exclude the customer who moved or sold the home,
because that is not churn the owner can do anything about. They are computed
now, each as core's rule (`reporting.retention`, `reporting.renewals`,
`reporting.churn`, with unit tests) written again in SQL, and
`plan-retention.integration.test.ts` puts the same agreements through both
and requires the same records in every half.

**What says the home was left.** A cancellation coded `moved` or `sold` (M08),
or the customer's link to the agreement's address ended
(`customer_property.ended_on`) after the agreement started and by the end of
the window. The second is the one that matters most: a plan that simply
lapsed because the house was sold was never cancelled, and only the address
says why. Cancelling with a move or a sale offers to end that link.

**When an agreement is on.** From the day it started until the day it was
cancelled, or for one that lapsed until its end date, the first day without
cover. A pending one has not started; one still active past its end is
waiting on the worker's renewal and is on.

- **Retention** is accounts (customers) on a plan on the window's first day
  still on one on its last, over accounts on a plan on its first day. A
  customer lost because the home was left is out of both halves. A customer
  on two plans who keeps either is kept, and a one time clean is never an
  account.
- **Program renewal** and **programme renewal** are the same records: terms
  whose end date falls in the window and has come by today, on an agreement
  not cancelled before it (one cancelled half way through never reached a
  renewal decision), renewed when the agreement went on to a later term. A
  term written down (`agreement_term`) is used, and the agreement's own end for
  a current term never written down. A term not renewed because the home was
  left is out of both halves.
- **Churn** is subscriptions on at the window's start and not on at its end,
  cancelled or lapsed, other than for a move or a sale, over every
  subscription on at the start. The definition's denominator is the plain
  count at the start, so the exclusion comes off the losses only.

**Two counts beside each number.** The pest definition asks for the
exclusions to be "counted separately so the exclusion cannot be abused", so
every one of the four shows how many it left out because the home was left.
And cancellations made before reasons were coded have only words, which are
never read for a reason ("sold" might be the house or a competitor's pitch):
such a loss is counted as the definition counts any loss, and the figure says
how many of its losses are unknown. Both counts open their records like a
half (`half=excluded` and `half=unknown` on `GET /v1/kpi-records`), and on
`GET /v1/kpis` they are each figure's `besides`.

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
assembly due a retest, a crew's day. The scorecard's number is the sum of those rows, and
clicking a half on `Reports > Trade scorecard` opens `/reports/scorecard/records`
listing the same rows, so the total at the bottom is the half that was clicked
by construction. Each record opens on its own screen: a job, an estimate, an
agreement, a visit, a customer, the week's timesheets (a crew's day opens on
them too), or the unit.

It is refused, in words, rather than trimmed, in three cases. The figure is the
whole company's, so somebody whose scope is narrower (a technician who sees their
own jobs) is refused: a list of only their records would not add up to the number
above it. A record kind the reader may not read is refused, naming the permission.
Revenue per job needs `report.financial:read`, and what each install cost and
earned needs `job.cost:read` as well, which is also what shows install margin on
the scorecard at all.
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
is drawn below the axis in red (in a breakdown, below it in its value's own colour), and every bar and point opens the records
behind it, as the numbers in the table do. A report counting several things
draws the first and offers the others ("Draw"). A report grouped by two things
is drawn by one of them with the other added up, and says so, unless what it
counts cannot be added up (an average), in which case it says why there is no
chart. Under the chart, "Break down by" offers each other grouping the report
has, and choosing one cuts every bar or column into that grouping's values:
"Stacked" puts them end to end, which is a total with its parts and so needs
something that can be added up, and "Side by side" sets them beside each other,
which any measure allows and which draws a line for each value when the first
grouping is a date (columns again with "Columns"). Each value has a colour, and
a legend names every colour in words beside its swatch, because a colour on its
own says nothing to everybody; each part is named in its own tooltip. Six values
are told apart at most: the five biggest and the rest added together as "Everything
else", which the chart says, and which opens no records because it is not one
value. A part opens the records of that bar and that value together, and a bar's
own label opens every value of it. The choice lives in the address (`split` and
`arrange`), so it survives being sent and prints. Twenty five bars at most (twelve
clusters side by side, sixty columns over time), and four hundred points for a
line; the table always has every row. The chart is SVG drawn on the server: no chart
library, it prints, and it works with JavaScript off.

Every chart starts its scale at zero, because a bar or a column is read by its
length and an axis that starts at 400 makes 410 look twice 405. One exception,
asked for and never chosen for you: a **line** of a plain number (a count, an
average, a reading: never an amount of money, never bars, columns or a chart
that is cut) whose values all sit on one side of zero offers **Scale: From zero
/ Around the data**. Around the data starts the scale near the lowest value,
with a tenth of the spread above and below and gridlines on round numbers, so a
reading that moves in a narrow band (a pH between 7.2 and 7.6) is not a flat
line. A chart drawn that way says so on its face: a break in the axis, "Scale
starts at 7, not zero" in the picture, the same in its description for a screen
reader, and a line of words under it that small changes look bigger than they
are. The choice lives in the address (`scale=data`), so it is sent and printed;
the emailed PDF keeps the usual scale.

A dashboard tile is drawn by the same chart, and not by bars and columns of its
own: a tile and the report it came from cannot disagree about which bar is
longest, and the tile has the chart's accessibility, including "View as a table"
under it, which a tile needs because it has no table of the report beneath it the
way a report screen does. A tile keeps its columns over time.

A tile can be **broken down** the way a report's chart is. A tile on a report
grouped by two things draws the first grouping (the date, for a trend) and cuts
every bar or column by the second: "Stacked" puts the parts end to end, which
needs something that adds up (a count or a sum), and "Side by side" sets them
beside each other, which any measure allows. It is part of how the tile is
drawn, like bars or a trend, so it is chosen when the tile is added ("Broken
down" on the saved dashboard's Add a tile) and stored on the tile, not on the
report it points at. The legend names every colour in words, "View as a table"
has a column for each value and a total, a part opens the records of that bar
and that value together, and a bar's own label opens the whole bar. A report
grouped by two things on a tile that is not broken down is refused in words that
say to break it down, a tile broken down needs exactly two groupings, and an
average is refused stacked and offered side by side, all when the tile is
saved rather than when somebody opens the dashboard. The Operations dashboard
ships one: open jobs by type, stacked by status.
The emailed PDF of a report draws the chart as the screen draws it before anybody
breaks it down: a breakdown is a choice made on the screen, and is on the printed
page and not in the schedule.

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

The catalogue the builder offers is the company's own: the product's datasets with
the company's custom fields added (a job's fields on Jobs and Job profitability, an
invoice's on Invoices, an estimate's on Estimates, a visit's on Visits), and the
fields of the records each row hangs off, named for the record ("Customer: ...",
"Address: ...", "Job: ...", "Unit: ...", "Technician: ...", on every dataset whose
rows reach one, Calls included), each a column, a filter and a grouping, with a
number field also totalled and averaged. A related record's fields need the
permission that reads that record, for a filter as much as for a grouping; M29
lists which reach where. And a dataset for each of
the company's own kinds of record (M29), counted and grouped by its fields, its
month, its customer and its job type. Every fragment is still written by the
product: a field's key reaches the SQL only after matching the lowercase key pattern
every definition is held to, and a value is read as a number only where the stored
value is one. A kind of record's dataset is read through the same visibility its
list uses, and needs `record:read` and the kind's own permission.

### Save one

Named, described, and visible to everybody who can read reports. What they see
when they run it is still their own work.

### Open the records behind a number

Every number on a report, and every number, bar and month on a dashboard tile,
is a link to `/reports/drill`. The page names the row (Age: Over 90 days), says
the report's filters and dates in words, lists the records with what each added
to every measure, and totals them under the columns. The records are listed a
thousand to a page, newest first; past a thousand, "Next page" and "Previous
page" walk the rest, the page lives in the address (`page`), and the line under
the list says which records these are of how many. The totals are over every
record on every page, so each page totals to the number that was clicked and
never to its own thousand. A link to a page past the last (the list shrank since)
opens the last page. The records behind a KPI (`/reports/scorecard/records`)
page the same way, latest day first, with the half's own total on every page.

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
Install gross margin and the supply cost share on the trade scorecard are what
jobs cost, so they need `job.cost:read` and `report.financial:read` on top of
`report:read`, and a reader without them sees them in the unavailable list with
the permissions named.

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
without saying so is the worst failure this screen has. The records behind one
of its numbers do not stop: they go on a thousand to a page.

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

Fifteen of the forty seven declared KPIs cannot be computed, and each one
names the single missing datum rather than saying not built, because most of
these definitions turn on an exclusion and a KPI computed without its exclusions
looks like the definition. They were checked again against everything shipped
since they were written and none of the fifteen has its datum yet (above, "The
unavailable list"); none is computed from something near it instead.

First time fix leaves out a part hold only when it names a purchase order in
this product that went to the supplier, so a part bought over the counter and
never written as an order counts as a return visit; the conservative choice,
because a hold the office could claim without an order is the easiest way to
tidy the figure. A job planned as several visits after somebody arrived counts
as a return visit for the same reason. Holds are placed in the office, not on
the phone.

The budgeted hour variance is only as good as the budget typed: nothing takes a
job's hours from its estimate, so a company that does not budget its jobs in
hours sees "Not this window". A change order's crew hours are typed by the
office and are not on the page the customer signs, so "separately approved" is
the change order being approved, not those hours by name.

The supply cost share counts what a supply cost on the job line, as job costing
does; stock bought for a van and never put on a job is not a supply cost here,
and neither is a receipt for supplies paid back to a cleaner (M17) unless it was
put on the job as a line. A supply billed back is left out only once its
invoice is issued, so a month's figure can move when the invoice goes out.

Application record completeness judges a report written before reports kept
their required list as not known, so a company's first months after this change
read "Not this window" or a figure over only the new reports; nothing guesses
the old list from the template's version, because the template keeps only its
current fields. Which fields a regulator asks for is the trade pack's, and the
"no product applied" exclusion is read from the pest pack's own field key. The records
behind a KPI are listed only for a reader whose scope is the whole company. A
page of records, of a report or of a KPI, is always a thousand: the API takes
which page, not how many to a page. A custom field on an address, a unit or a
technician is on the datasets whose rows hang off one, never as a dataset of its
own, because no dataset is a row of one; a unit's fields reach only the kinds of
record that link a unit, and a technician's only Visits, through its lead.

The retention, renewal and churn figures know a move or a sale only from a
coded cancellation or from the customer's link to the address being ended.
A plan that lapsed because the house was sold, where nobody cancelled it and
nobody ended the link, still reads as a lost customer; ending the link on the
address is the fix, and the cancellation form offers it. A cancellation made
before reasons were coded is never guessed at from its words: it counts as a
loss and is counted as unknown beside the figure. A plan that covers the
customer at any address has no one address to end, so only its cancellation
code can say they moved. "Moved out of the service area" is not told apart
from a move across town: both are coded `moved` and both are left out.

The PDF is set in the Noto Sans that ships inside the product, as every PDF is,
so a customer, a technician or a column in Latin, Vietnamese, modern Greek or
Cyrillic prints as spelled (a test prints a report whose title, column heading and
rows are Greek, Cyrillic and Vietnamese and reads them back out of the file). A
script the face does not carry (Chinese, Arabic, Hebrew) and the polytonic Greek
accents print as the plain letter where there is one and as "?" where there is
not. An emailed report appears as a
thread in the inbox like every other email this product sends, and "send now"
queues it for the worker's next pass rather than sending it in the request.
Nothing is emailed until an email provider is connected. A chart draws one
measure at a time. A tile is broken down only by the second grouping of the
report it points at, in the order that report groups (first drawn, second cut
by); to cut it the other way round, save the report grouped the other way.
A dashboard is not emailed or printed: a schedule points at a report, so what
arrives is the report as its own chart draws it, never a tile broken down. No cross company report
other than the four network aggregates, which are `docs/concepts/networks.md`.
