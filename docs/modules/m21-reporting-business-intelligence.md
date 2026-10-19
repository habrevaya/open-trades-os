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

All forty seven are answered: forty three computed here, four by M22's fleet
report. None is left that names a datum it still lacks; a reader without a
KPI's permissions still finds it on the list, with the permission it needs.

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
hours for a job (a job now carries its own crew hour budget, below); a permit could be filed against a job as a compliance
document, but not the city's visits to it (they can now, below); the pest pack's template already asks why no
product was applied, so record completeness lacked only the list of fields a
report was required to capture when it was written (a report keeps it now, below); the electrical pack
declares a panel's rating, open spaces and known concern, but the register
held no value to that declaration (it does now, below); a job could be put on hold, but nothing said
it was waiting on a part (it can now, below); and the phone's positions are kept three days by
design, so a month's route miles were gone before a month's figure could read
them (each finished day is now summed before they go, below).

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
  troubleshooting call that converted on the visit) needed the pack to mark which
  of its own job types and price book items are the upsell, and the packs do now
  (M02), which unlocked drain call conversion and, with the question of where
  the fault was, troubleshooting conversion (below).

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

### Panel upgrade pipeline, and the typed details it waited on

The electrical pack's **panel upgrade pipeline** is "total value of declined
panel and service upgrade recommendations on panels recorded as full, flagged
as a known concern, or rated below 100 amps, counting only properties still on
the customer list". The pack declares those three on a service panel with their
kinds, and the register stored whatever it was sent under the keys, so "100A"
or "yes" could not be read. The register now holds a unit's details to the
declaration (M04), and the figure reads only values held to it.

- A recommendation is a finding recorded against the panel itself, declined in
  the window, with a quoted value, on a live unit whose kind is the pack's
  service panel (by code or name).
- **Full** is no open spaces (a number, nought or below); **a known concern** is
  yes; **below 100 amps** is a rating from the pack's own list under 100.
- **Still on the customer list** is a customer, not merged away, whose link to
  the address has not ended.
- Like the replacement pipeline it is a total, over the recommendations
  counted, which the second half lists.
- A panel carrying one of the three as words from before the register checked
  them, and nothing that qualifies it, is **counted beside** the figure as not
  known and never in it.

The rule is core's `reporting.panelQualifies` (and `field.typedAttributes` for
the register), with unit tests, written again in SQL over the typed values, and
`kpi-panel-pipeline.integration.test.ts` checks a month worked out by hand, puts
the same panels through both, and fails if the pack stops declaring the panel.

### The first time inspection pass rate

The electrical pack's **first time inspection pass rate** needed the city's
visits to a permitted job, and whose work a fail was about. M33's inspections
are the contractor's own, of a property, against a programme of checkpoints;
the inspector signing off a panel change is neither. So the authority's visits
are recorded against the permit itself (M23): a permit is a compliance document
of kind `permit` filed against the job, and each visit under it has its day,
its stage, passed or failed, and on a fail what the inspector wrote and whose
work it was, ours or something outside our work. Both are required on a fail
and the second is chosen from two words, never read out of the first.

A permitted job is counted **once, in the window of its first inspection**, and
judged on every inspection recorded on it since. It is signed off first time
only when no inspection on it failed for our work, which is the strict reading:
a rough in that passed and a final that failed for our work is not a first time
pass. A job failed only for somebody else's work (another trade, a site not
ready, the customer's own equipment) is out of both halves and counted beside
the number, so the exclusion cannot quietly grow; one failed for both is
counted as failed, because the crew's miss is in it. A failure recorded next
month on a job first inspected this month counts against this month, where the
job is, so a month's figure can go down after it ends; that is the conservative
choice, made so a failure is never dropped for arriving late. The rule is
core's `reporting.inspectionPass`, and `permit-inspections.integration.test.ts`
puts the same rows through it and through the SQL and requires the same jobs in
every half. The records open on the job.

### Route density

The pest and lawn packs' **route density** is completed stops over the miles
driven between them, and EXCLUDES the drive from the yard to the first stop and
home from the last. The miles can only come from the phone's positions, which
are deleted after a few days on purpose (M11), so a month's figure could never
read them, and a van's odometer is one reading a day that includes both yard
legs. So the worker sums each finished day before the purge, for each person
who shared their location, into a **route day** (`route_day`): their completed
stops that day (visits they were sent on by name or with their crew, completed,
with an arrival time), the drives from each stop's completion to the next stop's
arrival, and how far those drives went, the straight line between one position
and the next added up along the drive. The way out and the way home are not
between two stops and are never read. Nothing else of the positions is kept.

**A day seen whole, or not at all.** When two positions on a drive between stops
are further apart than three of the company's intervals (never less than
fifteen minutes), or there is no position that close to one end of a drive, or a
stop was begun before the one before it was closed, the straight line across
the gap would be shorter than the road and the day would read as a tighter route
than was driven. Such a day is kept as not counted, with the reason in words,
out of both halves, and counted beside the figure. A day of one stop is no
route. A day is read again when positions for it arrive late (a phone that
synced the next morning), and never from fewer positions than before, so the
purge cannot shrink a day already summed.

**Per person.** Each person's day counts their own stops over their own miles,
so a crew of three in one truck counts its stops and its miles three times and
the ratio is the crew's. A stop closed from the office with no arrival time is
not one of the day's stops, and the drive across it is still measured, which
reads lower, never higher. Straight lines between positions a minute apart are
the road to within a few per cent and a little short of it on a winding road,
which reads slightly high; positions are what the product has, and the doc says
so. A company that does not share locations has no route days and reads "Not
this window".

The rule is core's `reporting.routeDay`, with unit tests, and
`route-days.integration.test.ts` works a month by hand. Each record is a
person's day ("Ana, Jun 10: 3 stops, 2.073 miles between them") and opens on
that week's timesheets. Because it is made from where people drove, the records
are listed only to people who dispatch (`visit:dispatch`), who already see the
map; turning sharing off for the company or a person deletes their route days
with their positions.

### The re-clean rate, from why a return was free

The trash bin trade's **re-clean rate** is "free re-cleans divided by completed
stops. Counts only our-fault returns, not bins that were not out." It was listed
as needing whose fault a return was, and the product already records that: a
job's coverage ("Who is paying, and why" on the job, M10) says why it is free.
"Rework on our own work" (`no_charge_callback`) and "Our own warranty"
(`our_warranty`) are our fault and are counted; "Goodwill", the free second trip
for a bin that was not out, is not, which is the definition's exclusion. Counting
our own warranty as our fault is the reading that makes the number higher, and
it is chosen for that reason. A job counts in the window it was completed, over
the window's completed visits, a return's own visit among them.

A free return nobody gave a reason for (a job back for an earlier one, no
revenue, no coverage recorded) is not counted, because nothing says it was our
fault, and it is not hidden: how many there are is said beside the figure and
opens on the jobs, so the office can say which they were.

### Cancellation rate by route, and who called a visit off

Cleaning's **cancellation rate by route** is "stops cancelled or skipped inside
the notice window divided by stops scheduled, reported per route and per
weekday", and it EXCLUDES "visits the company cancelled for weather or
staffing, which are a separate and more serious number". A cancelled visit
said neither who nor when: a customer ringing at seven and the owner calling
off a rained out day were the same row. Every path that cancels a visit now
says both (M09): the office calling off one visit, a job cancelled with its
visits (M10), a customer's request from their link (the customer, asked when
they sent it), and a visit brought in from history. The company's notice
window (Settings, "Late cancellations", a day unless it says otherwise) is
frozen on each visit when it is called off.

- A **stop** is a visit with a window in the window, on customer work (every
  class but internal), whatever became of it.
- **Late** is the customer calling it off with less notice than the window
  frozen on it, measured from when they asked to the start of its window, or
  after the window began (turned away at the door). Exactly the notice asked
  for is in time. A visit called off late and done anyway, on a phone that
  missed the cancellation, is still a late cancellation.
- A stop the **company** called off is out of both halves and counted beside,
  and each record behind that count says why in the words the company chose
  (rain or weather, crew short, equipment, or something else with what it said),
  or "no reason given" for a day called off before reasons were kept or by a
  caller that gave none (M09).
- A stop called off with **nobody saying who** (before this was recorded, or by
  an API caller that did not say) is out of both halves and counted beside as
  not known, never read as either.
- Each record names the stop's route (or its crew, with no route) and its
  weekday. The figure is the company's, and "Break it down by" under it on the
  scorecard splits it per route or per weekday (below).

The rule is core's `reporting.cancellationOf`, with unit tests, written again
in SQL, and `kpi-cancel-rate.integration.test.ts` checks a month worked out by
hand, puts the same stops through both, and checks every path that cancels a
visit records who and when; `visit-cancellation-paths.test.ts` reads the
service layer and fails when a new path cancels a visit without saying who.

### Drain call conversion, from what the plumbing pack marks

Plumbing's **drain call conversion** is "drain jobs that produced a camera
inspection, a lining or an excavation, divided by all drain jobs", and it
EXCLUDES "repeat visits on the same line within thirty days, because counting the
rework as a second conversion flatters the number". Both halves are `service`
work to `revenue_class`; the plumbing pack (version two, M02) now marks its
drain call and its camera inspection, lining and excavation items.

- A **drain call** is a completed job of a type the company's trade pack marks as
  a drain call, in the window it was completed.
- It **produced** the upsell when it, or a job raised from it and not cancelled,
  carries a line of one of the marked items, or an estimate the customer
  approved whose chosen option does. An option the customer did not choose
  produced nothing.
- A **return** is a drain call at an address that had another drain job finished
  in the thirty days before it, on the same unit when both name one (two jobs on
  different laterals are two lines). It is out of both halves and counted beside;
  the earlier job is counted as itself.

The rule is core's `reporting.drainCallOf`, with unit tests, written again in
SQL, and `kpi-drain-conversion.integration.test.ts` checks a month worked out by
hand, puts the same jobs through both, and reads the marks from the pack.

### Troubleshooting conversion, and where the fault was

Electrical's **troubleshooting conversion** is "troubleshooting calls that
produced approved repair work on the same visit, divided by all troubleshooting
calls", and it EXCLUDES "calls where the fault was found in equipment another
trade owns, which the electrician was never going to close". `revenue_class`
put a troubleshooting call among all `service` work, and nothing recorded whose
equipment the fault was in. The electrical pack (version two, M02) now marks its
troubleshooting call and its charges for finding a fault, and its service report
asks "Where the fault was": in our electrical work, in equipment another trade
owns, or no fault found. The technician answers it on the phone's readings, and
the office reads the answer on the visit's page.

- A **call** is a job of a type the company's trade pack marks as
  troubleshooting, counted once, in the window its first visit that was done was
  finished.
- It **converted** when, on that visit, the customer approved an estimate on the
  job between the visit's arrival and its finish, or work was recorded on the
  visit other than the pack's charges for finding the fault (a breaker fitted, a
  neutral tightened). An approval on a visit nobody timed cannot be placed, so
  only work recorded on it converts it; an approval on a later visit is not the
  same visit.
- A call whose report's last answer is "In equipment another trade owns" is out
  of both halves and counted beside.

The rule is core's `reporting.troubleshootingOf`, with unit tests, written again
in SQL, and `kpi-troubleshooting.integration.test.ts` checks a month worked out
by hand, puts the same calls through both, and checks the pack's template asks
the question.

### Water heater opportunity capture, and why the customer said no

Plumbing's **water heater opportunity capture** is "water heaters replaced
divided by water heaters recorded as over ten years old and inspected in the
period", and it EXCLUDES "units the customer has already scheduled with someone
else, so the ones nobody followed up on stay visible". Both halves were already
recorded (a visit's units worked and an inspection's answers name the unit, the
install date gives its age, the register records a replacement), but why a
customer declined a recommendation was words. A decline now carries a code
(M33), and "already booked with another company" is the one this reads.

- A water heater is a unit whose kind is the plumbing pack's water heater, by
  code or name. It is counted **once**, on the first day in the window somebody
  worked on it on a completed visit or named it in an inspection, and is old when
  its install date is more than ten years before that day.
- **Caught** is the register recording it replaced, on or after that day, on a
  job of ours that was not cancelled. A month's figure rises as the
  replacements it led to are done, which is the point of a capture rate. A
  replacement recorded with no job of ours named might be somebody else's and is
  not counted as caught.
- An old heater with a finding still declined, on or after that day, as booked
  with another company, and not replaced by us after all, is out of both halves
  and counted beside.
- A heater inspected with **no install date** is out of both halves and counted
  beside as not known, so a register with no ages does not read as a company
  with no old heaters.

The rule is core's `reporting.heaterCaptureOf`, with unit tests, written again in
SQL, and `kpi-heater-capture.integration.test.ts` checks a month worked out by
hand, puts the same heaters through both, checks a decline keeps its code, and
fails if the pack stops declaring the water heater.

### Homes per served street, and the street it waited on

The trash bin trade's **homes per served street** is "active subscriptions
divided by the number of distinct streets on the route", and it EXCLUDES
"commercial stops, which have their own economics". It waited on a street
rather than an address line: `address_line1` is the whole line, "12 Oak
Street" and "14 Oak St" are one street and two strings, and splitting the line
on a space would count twice the streets and report half the density. An
address now keeps its street apart from the line (M03): the geocoder's own
street component where it gives one, or typed on the address's page (picked
from the streets already recorded in the town), never read out of the line.

- **Active** is a subscription running on the window's last day, as churn
  reads it.
- **Distinct streets** are the street, the town and the state, trimmed, spaced
  once and in small letters (core's `geo.streetKey`). A Main Street in two
  towns is two streets. Nothing expands an abbreviation, so two spellings typed
  by hand count as two streets, which reads lower and never higher.
- A **commercial** customer's subscription leaves both halves and is counted
  beside the number.
- A home whose street is **not recorded** for its address as it is now, or a
  plan with no address of its own, is **left out of both halves** and counted
  beside as not known, each opening on the address so the office can record
  it. Counted on top and not underneath it would read as a denser route than
  the one driven.

Each street served is a record of its own ("Oak Street, Austin TX: 2 homes"),
opening on one of its addresses. The rule is core's `reporting.streetDensityOf`,
with unit tests, written again in SQL, and
`kpi-street-density.integration.test.ts` checks a month worked out by hand, puts
the same plans through both, and checks the geocoder writing the street from
its own parts, once per address, never over a typed one.

### Fresh water per stop, and the reading it waited on

The trash bin trade's **fresh water per stop** is "fresh water used divided by
completed stops, per truck", because a truck drifting upward is a nozzle or a
burner going and shows here before it shows in a complaint. Nothing recorded
water. A truck's day now has the fresh water its driver read off the tank (M22,
`truck_water_day`), on the phone at the end of the day (`truck.water`, M11) or
typed by the office on `/fleet/water`.

- **A truck's stops** on a day are the visits completed that day, in the
  company's calendar, by whoever had it checked out (sent to them by name or
  with a crew they are on), a multi bin stop being one visit.
- **Only truck days with both count.** A day with stops and no reading is left
  out of both halves and counted beside as not read, never as no water; a
  reading on a day the truck completed no stop (a tank flushed in the yard) is
  left out of both and counted beside.
- **Per truck.** Each record of either half is one truck, its water over its
  own stops with the truck's own gallons a stop in its words ("Truck 2: 25
  gallons over 3 stops, 8.3 a stop"), opening on that truck's days on
  `/fleet/water`; the number is the trucks' together.

The rule is core's `reporting.waterPerStopOf`, with unit tests, written again
in SQL, and `kpi-water-per-stop.integration.test.ts` checks a month worked out
by hand, puts the same truck days through both, and records a reading from the
office and from the phone.

### Revenue per container month and disposal cost per haul, and the share they waited on

The dumpster pack's **revenue per container per month** is "rental, overage,
disposal and fee revenue attributed to a container divided by the months that
container was in the fleet, including months it never left the yard", and it
EXCLUDES "taxes and permit amounts passed through at cost". Its **disposal cost
as a percent of revenue** is "tipping and disposal cost taken from scale tickets
divided by invoiced revenue on the same hauls", EXCLUDING fuel, driver labour
and truck cost. Both waited on each container's share of what a job earned: a
hire sold at a flat price has its price on the job, and a swap chain puts
several cans on one job and one invoice. A hire's own invoice now names the haul
each of its lines bills (the period, the meters, the charges found, the disposal
fee passed on), and the office names the haul a job's own line bills (M10).
Nothing is read from a line's words.

- **Revenue on a haul** is the invoice lines naming it, on invoices issued and
  not voided, net of discounts and before tax (tax is held apart on the line),
  and never a `permit` line.
- **Revenue per container month** counts lines on invoices issued in the
  window, per container, over the container's months in the fleet in the
  window: each day it was on the register as a share of its own month, from the
  day it was entered (or its first hire, if earlier) until it was retired, the
  yard and the repair shop included. Lines on a job a container was on that
  name no container are counted beside, opening on the job.
- **Disposal cost** counts the hauls collected in the window (the pickup or
  swap that took the full can to the facility): the facility's fee recorded on
  the haul over what was invoiced on it, whenever it was invoiced. A haul with
  no fee recorded is left out of both halves and counted beside as not known; a
  haul with a fee and nothing invoiced yet is left out and counted beside too.
  It is what hauls cost, so like install margin it needs `job.cost:read` and
  `report.financial:read`.

The records are each container ("Container 101 (20 yd): 2 lines invoiced") and
each haul ("Container 101 (20 yd), collected Jun 8, Austin Transfer, ticket
T-1"). The rules are core's `reporting.haulRevenue`, `reporting.containerMonths`
and `reporting.disposalHaulOf`, with unit tests, written again in SQL, and
`kpi-container-revenue.integration.test.ts` checks a month worked out by hand,
puts the same lines and hauls through both, and checks a hire's invoice naming
the haul on every line.

### Turnaround between pickup and redelivery, and the three times it waited on

The dumpster pack's **turnaround between pickup and redelivery** is "hours from
a container being emptied at the facility to it being placed on the next
customer site", and it EXCLUDES "cans routed to the yard for repair and cans
held at customer request, since neither is a dispatch failure". Nothing
recorded either end to the hour: a pickup kept the scale ticket, which is the
weighbridge and not the tip, and the board took a delivery as a day at
midday. And the exclusions were the can's state today, with no history. Now
(M22):

- **The tip.** A haul has the moment its full can was emptied (`tipped_at`),
  tapped on the driver's phone (`haul.time`, M11) or typed on the board when
  the ticket arrives. Never the collection and never the weighbridge.
- **The drop.** A hire says whether its delivery is the moment the can was put
  down (`delivered_time_known`): the board takes a time with the day, the phone
  taps it, and a delivery recorded only as a day stays one.
- **The holds.** A repair (tagged out and back) and a customer hold (kept for
  somebody who asked) are periods with a start and an end (`container_hold`).

What it counts:

- A **placement** is a hire of a can put down in the window, in the company's
  calendar, that had a hire of the same can before it, collected. The can's
  previous hire is found by delivery, not by collection, because a collection
  recorded as a day sits at midday and a can put back out that morning must
  not skip back a hire. A can's first placement is no turnaround.
- Its **hours** run from the previous hire's tip to this placement.
- **Not known**, left out of both halves and counted beside: a placement
  recorded only as a day (every hire from before the time was kept among
  them), a previous haul whose tip nobody recorded, and times that run
  backwards (which recording refuses, so only data from elsewhere can have
  them). Never given an hour.
- **Left out**, and counted beside: a can out for repair or held for a
  customer at any moment between the tip and the placement, the whole
  turnaround and not the hours of the hold, because the definition excludes
  the can. A repair already running when the history began started before
  anything measured.

The numerator's records are each placement with its hours ("Container 101 (20
yd): emptied Jun 2, 2:00 PM, placed Jun 3, 9:30 AM"), the denominator's the same
placements one each, opening on the container fleet. The rule is core's
`reporting.turnaroundOf`, with unit tests, written again in SQL, and
`kpi-turnaround.integration.test.ts` checks a month worked out by hand, puts
the same placements through both, and records the drop, the tip and the holds
from the office and the tip and the drop from the phone.

### Production per crew hour, and the mobilisation it waited on

Lawn and landscape's **production per crew hour** is "production units
completed, in the unit on the job type, divided by crew hours on site", and it
EXCLUDES "drive time" and "mobilisation on the first day of a multi day job,
when nothing is produced but the crew is paid". A crew loading the trailer,
driving out and unloading punched it as on site time, so a two day build read
as slower than a one day one for no reason the crew controls. The timeclock now
has a kind for it, **getting a job ready** (`mobilisation`, M17), offered on the
phone and `/my-day` against one of the day's stops (M11) and filed on its job. It
is paid exactly as on site time, so nobody's pay or payroll export changes, and
only this figure reads it. How much work a job is, in its job type's unit, is
set on the job's page (M10).

- A **job** is a completed customer job (every class but internal) whose job
  type has a production unit, in the window it was completed.
- **Units** are the amount of work recorded on it. **Crew hours on site** are
  every person's on site punches on the job and paid breaks there, each person
  separately, on whatever day they were punched. Travel is drive time and getting
  the job ready is the mobilisation, and **neither is counted on any day**:
  getting the job ready holds the drive out, which the definition also leaves
  out. Each record says how many hours getting it ready were left out, so the
  exclusion is visible on the job.
- A job with **no amount recorded, no hours on site, or a punch still running**
  is left out of both halves and counted beside as not known, each saying which.
  Counted, the first reads as nothing produced and the others as work done in no
  time.
- **One unit at a time.** Square feet and cubic yards do not add, so the figure
  is over the unit the window's measured jobs spent the most hours on site in
  (the alphabetically first on a tie), and a job in another unit is left out of
  both halves and counted beside with its own rate on its record ("#12 Mulch
  refresh: 12 cubic yards over 4.00 hours, 3.00 an hour").

The records open on the job. The rule is core's `reporting.productionOf` and
`reporting.productionPerCrewHour`, with unit tests, written again in SQL, and
`kpi-production.integration.test.ts` checks a month worked out by hand, puts the
same jobs through both, and clocks in to get a job ready from the phone.

### Chemical cost per stop, and the register it waited on

Pest control's **chemical cost per stop** is "cost of product applied, valued
from the product register, divided by completed stops", and it EXCLUDES
"devices, bait stations and monitors, which are capital placed at a site
rather than chemistry consumed on a visit". The application record already held
the product, its EPA number, how much and the unit, but the product was typed
by name, and a name cannot be valued without reading words for a meaning. The
price book now marks the materials that are chemicals (M06), with the unit
their cost is per and their EPA number, and the product applied is chosen from
them on the phone, on `/my-day` and on the visit's page in the office (M11),
the item's name, EPA number and unit carried onto the regulated record.

- A **stop** is a completed visit (done, or done on a phone that missed its
  cancellation) on customer work, in the window it was completed.
- An **application** is the latest answer to one of its reports' chemical
  questions that says how much was applied. It is **valued** at the cost per
  unit of the item it was chosen from, in the price book version in force when
  the stop was completed (a price change dated the 15th values a stop on the
  20th at the new cost), in the unit that cost is per.
- **Devices are never applications**: only a material can be marked as a
  chemical, and a station, a trap or a monitor is the book's equipment. A
  marked item cannot be changed to another kind until the mark is taken off.
- A stop where nothing was applied costs nothing, and counts.
- A stop with any application that **cannot be valued** (a product typed by
  name, on an older record or not in the book; an item with no cost recorded
  on that day; one recorded in a unit its cost is no longer per) is **left out
  of both halves** and counted beside the figure, each opening on the visit
  with what was wrong in words. Counted at nothing it would read as a cheaper
  stop than it was.

Each record of the top half is one application ("Bifen IT, 2 gal at $3.00,
#41 visit 1, Quarterly service"), opening on the visit; the bottom half is the
stops. It is what product cost, so like install margin it needs
`job.cost:read` and `report.financial:read`. The rule is core's
`reporting.chemicalCostOf`, with unit tests, written again in SQL, and
`kpi-chemical-cost.integration.test.ts` checks a month worked out by hand, puts
the same stops through both, records products from the phone and the office,
and checks a phone's typed name and number are replaced by the book's.

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

### A figure broken down

A figure whose records already name a grouping can be broken down by it on
the scorecard: "Break it down by" under the figure, a choice in the address
(`kpi` and `by`) like every other on these screens. Three do, because every
record behind every half of them names the group, and none is worked out from
anything near it:

- **Cancellation rate by route**, by route (a stop's route, or its crew when
  it has none) and by weekday, which is what its definition asks for.
- **Route density**, by person and by weekday: every route day is one
  person's day.
- **Fresh water per stop**, by truck: every record is a truck or one of its
  days, which is the "per truck" its definition asks for.

Each group shows its figure and its two halves, and the counts beside the
figure (the company's own cancellations, the stops nobody said who called
off) for that group. A half is the figure's records added up by the group
each names, so it opens onto that group's records
(`/reports/scorecard/records` with `by` and `group`), and the groups add up
to the figure, on the last row. A group whose bottom half is empty reads "Not
this window", never nought. Only one figure is broken down at a time. The
others (close rate "by technician", revenue per technician) are not offered:
their records do not name a technician on both halves, and a split guessed
from a job's lead would be the near thing this scorecard refuses to compute
from. `kpi-breakdown.integration.test.ts` works a month out by hand, opens a
group's records, and runs every declared breakdown under a trade that declares
it, so a records query that forgot the group's columns fails there.

A breakdown is refused exactly where the records behind the figure are, in
the same words: a reader whose scope is narrower than the company, a record
kind they may not read, and a money half without `report.financial:read`.

### The records behind a KPI

Every half of every computed KPI is written as the list of records it counts,
each with what it adds: a completed job and its ledger revenue, an estimate
presentation, a plan sold, a technician day, a drive between two stops, an
assembly due a retest, a crew's day, a permitted job, a person's route day, a
scheduled stop, an old water heater inspected, a troubleshooting call, a drain
call, a street served, a truck, a container, a haul (a placement of a can, for
turnaround), a product applied. The scorecard's number is the sum of those rows, and
clicking a half on `Reports > Trade scorecard` opens `/reports/scorecard/records`
listing the same rows, so the total at the bottom is the half that was clicked
by construction. Each record opens on its own screen: a job, an estimate, an
agreement, a visit, a customer, the week's timesheets (a crew's day and a
route day open on them too), the unit, an address on the street, or the
truck's days of water, or the container fleet.

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

Which grouping cuts it is the tile's too, picked from the two its report is
grouped by: "Cut by" under a tile broken down, on a saved dashboard, offers
both, and picking the first draws the tile along the second and cuts each bar
by the first. So "visits by technician and status" is a bar per technician cut
by status on one tile and a bar per status cut by technician on another,
without saving the report twice. It is stored on the tile (`splitBy`) and
checked when the tile is saved: a grouping the report does not have, a cut on
a tile that is not broken down, and a trend cut by its own date (which would
leave it running along something that is not a date) are each refused in
words. A tile that picked no cut is cut by the second, as before.
The emailed PDF of a report draws the chart as the screen draws it before anybody
breaks it down: a breakdown is a choice made on the screen, and is on the printed
page and not in the schedule.

### Print it, or save it as a PDF

"Print or save as PDF" on any report opens `/reports/print`: the company's
name, the report, its dates, filters and branch in words, who printed it and
when, the chart and every row, with nothing else on the page. The browser's
own print dialog makes the PDF.

### Print a whole dashboard, or save it as a PDF

"Download as PDF" on any dashboard (`/dashboards/{slug}/pdf` for one that
ships, `/dashboards/saved/{id}/pdf` for one somebody assembled) is one file
of every tile, in the dashboard's order: a number tile as its number, a chart
tile as the chart the screen draws (cut by its second grouping, with the
legend in words, when the tile is broken down) with its rows printed under
it, and a broken tile as the sentence the screen shows in its place. It is
drawn through the same function the screen is, so it has the same readers,
scope and permissions: each tile is the reader's own run of its report. A
tile the reader may not see is left out of the file and NAMED at the end of
it, by title only ("Not on this copy ... Dee Dispatch may not see it:
Receivables by age"). The screen still drops such a tile without a word, as
the navigation drops a link; a page handed to somebody else that left part of
the dashboard out without saying so would read as the whole dashboard. A
dashboard with nothing on it the reader may see is missing for them, as its
page is. The file is written by the product (`pdf.dashboardPdf` in core), not
the browser's print of the page, because a grid of cards laid out for a wide
screen splits its charts across pages when a browser prints it. It needs
`report:read`, and each tile what its own report needs.

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
Through the API (`POST /v1/reports/drill`, `GET /v1/kpi-records`) both also
take `perPage`, from one to a thousand and a thousand when it is left out, so
a client can walk them in smaller pieces; the count and the totals are still
over every record, and anything outside those bounds is refused at the door.

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

### Have a dashboard emailed

"Email on a schedule" on a dashboard opens the same form, starting on that
dashboard; the form's list offers every dashboard beside the reports. The
same cadence, the same people and outside addresses, the same once per
occurrence, the same authority (the person who set it up, as they are on the
day), and the same outbox and do-not-email list: an address that bounced or
asked to stop is not sent it, and the delivery says so. What arrives is one
PDF of every tile, the file "Download as PDF" makes, with the number tiles
listed in the email's body. Each person in the company is sent the dashboard
drawn AS THEM, their scope on every tile and the tiles they may not see named
and left out (the email says which too); somebody who may see nothing on it
is refused at the save and again on the day. An outside address is sent the
copy of the person who set it up. There is no CSV, because a dashboard is not
one table.

A dashboard is sent as it stands, each tile with its own report's dates (most
have none and read "as of now"), and the page says when it was drawn. So a
dashboard schedule takes no dates of its own: "Everything, with no dates" is
its only period, and any other is refused in words rather than laid over
every tile, which would turn "Outstanding, every unpaid balance" into last
week's invoices without a word on the page. That is the conservative reading,
and the product owner has not been asked for another.

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
| `GET /v1/kpi-breakdown` | `report:read`, and refused where the records are |
| `GET /v1/report-schedules` | `report:read` |
| `POST /v1/report-schedules` | `report:build` (a report, or a dashboard by `dashboard` or `dashboardId`) |
| `PATCH /v1/report-schedules/{id}` | `report:build` |
| `POST /v1/report-schedules/{id}/paused` | `report:build` |
| `POST /v1/report-schedules/{id}/send` | `report:build` |
| `DELETE /v1/report-schedules/{id}` | `report:build` |
| `GET /v1/report-deliveries` | `report:read` |

A dashboard has no API of its own: a schedule names one that ships by its
slug (`operations`, `money`) or a saved one by the id in its address.

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

None of the forty seven declared KPIs is left uncomputed. Each one that waited
named the single missing datum rather than saying not built, because most of
these definitions turn on an exclusion and a KPI computed without its exclusions
looks like the definition, and none was computed from something near it while it
waited.

Production per crew hour is only as good as the clock: the phone's ordinary
"Clock in" names no job, so on site hours reach a job only from a punch that
names it (the field sync's `jobId` or the stop it is for, which an API client or
a crew's tablet sends), and a company whose crews clock in once a day with no job
sees its jobs counted beside as having no hours on site. Getting a job ready is
left out on every day it is punched, not only the first day of a multi day job,
because it holds the drive out; a crew that unloads on day three and punches it
as getting ready makes that day read faster. The amount of work is the office's
number on the job, not measured, and one amount for the whole job: a job half
done at the end of the month is counted only when it is completed. Only the unit
with most hours is added up, so a company that sells by several units sees one
of them on the scorecard and the others on their records.

Chemical cost per stop values only products chosen from the price book: every
application typed before chemicals could be chosen, and every product the book
does not hold, leaves its stop out of the figure and is counted beside it, so a
company's first months read over the newer stops only. Nothing matches a typed
name to an item. Each answer to a chemical question that says how much was
applied is one application, so a technician who picks the same product with an
amount under two questions of one report has it counted twice (the higher
cost, never a hidden one). A product is valued at the version in force when
the stop was completed, not at the moment it was recorded, and at the item's
cost, not at what a particular drum was bought for: purchasing's own costs are
not read. Changing the unit an item's cost is per leaves its earlier
applications out as not valued rather than converting them.

Drain call conversion reads the drain call and the upsell items the company's
trade pack marks, by code: a camera inspection sold under an item the company
made itself is not counted. A job that names no unit is read as being on the same
line as any drain job at its address, which leaves it out as a return rather than
letting it count twice. A camera, lining or excavation done on a new job that was
not raised from the drain call is not linked to it.

Troubleshooting conversion reads the job types and charges the company's trade
pack marks, by the codes it seeded: a troubleshooting job type made by hand under
another code is not a call. A call whose technician never answered where the
fault was is counted, never left out; a report answered before the electrical
pack's version two asked has no answer. Repair work done on the visit counts as
approved by being done; a customer who agreed out loud to work booked for later,
with no estimate signed on the visit, is not converted.

Water heater capture knows a customer booked elsewhere only from a finding on
the unit declined with that code: a "they said no" on the phone is an estimate's,
which names no unit, and a decline in words only excludes nothing, so such a
heater stays in the bottom half. A replacement counts as ours only when the
register's record of it names one of our jobs. A heater whose install date was
never recorded is counted beside the figure, not in it.

The cancellation rate by route is broken down per route and per weekday on
the scorecard, one figure at a time; a route's own figure is not tracked over
months anywhere. It judges lateness by the company's one notice window, not one per job type or
plan. A visit is not called off from the phone, so a team turned away at the
door is recorded by the office; a cancellation recorded before who asked was
kept, or by an API caller that did not say, is counted beside the figure as not
known. A visit with the customer not there (`no_show`) counts as a kept stop,
not a skipped one, because nobody called it off.

Homes per served street is only as complete as the streets recorded: an
address the geocoder could not name a street for, and one with a pin placed by
hand, has none until the office types it, and is counted beside the figure
until then. "Oak St" and "Oak Street" typed by hand are two streets; the screen
offers the town's streets to pick from rather than guessing they are one.
Which customers are commercial is the customer's type, not the plan's.

Fresh water per stop is only as good as the gauge the driver reads: there is no
flow meter connection, and a truck's stops are counted only for a person who
had it checked out that day, so a truck nobody checked out has no stops and a
stop by somebody holding no truck is on no truck. A stop done by two people on
two trucks counts on both.

Revenue per container month and disposal cost read only lines that name a
haul: a line typed straight onto an invoice names none, and a hire invoice's
draft whose lines the office replaces before issuing loses the names, so that
revenue is not any container's (it reads lower, never higher). Every permit line
is left out, whether or not it carried a markup, the conservative reading of
"passed through at cost". A credit note against an issued invoice is not taken
off a container's revenue. When a container joined the fleet is the day it was
entered on the register or its first hire, not the day it was bought, which the
register does not hold. A disposal fee is what was recorded on the haul; the fee
worked out from a ticket's weight at the facility's rate is an estimate and is
not read.

Turnaround between pickup and redelivery is only as complete as the times
recorded: a delivery recorded as a day (every hire from before the time was
kept among them) and a haul whose tip nobody recorded are counted beside the
figure, never given an hour, so a company's first months read "Not this window"
or a figure over only the placements timed since. A can collected empty and
never tipped has no tip, and its next placement is counted beside as not known.
A repair or a customer hold running at any moment between a tip and the next
drop leaves the whole turnaround out rather than the hours it ran; that is the
conservative reading of "EXCLUDES cans held", and the product owner has not
ruled on it. A hold is only what the office records: a can kept back for a
customer with no hold recorded counts as a slow turnaround.

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
"no product applied" exclusion is read from the pest pack's own field key.

The panel upgrade pipeline counts a recommendation recorded against the panel
itself, whatever it recommends: a finding has no field saying it is an upgrade
rather than a repair, and one on a breaker under the panel is not counted. A
panel whose details were typed before the register checked them is counted
beside, not in, until somebody corrects it on the unit's page.

The first time inspection pass
rate is only as complete as what the office types in: an inspection nobody
recorded is not counted, and a fail recorded as somebody else's work is left
out on that word. Route density has no figure for a company that does not share
locations, counts only the days whose drives between stops were seen whole, and
measures them as straight lines between positions rather than along the road; a
route day is shown only behind the figure and in its breakdown by person and
by weekday. The re-clean rate is only
as good as the coverage the office records on a return: one left without a reason
is counted beside the figure, not in it. The records
behind a KPI, and a figure's breakdown, are listed only for a reader whose
scope is the whole company. A page of records is a thousand on the screens,
which take no smaller page; the API takes fewer (`perPage`) but never more. A
custom field on an address, a unit or a
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
measure at a time. A tile is cut by one of its report's two groupings and drawn
along the other: a report grouped by three things is still refused on a tile,
because the third would be added up out of sight, and the cut is chosen on the
tile once it is added ("Add a tile" always starts on the second).
A dashboard is printed and emailed whole (above), and only on a schedule: the
"Run and email a report" step of an automation sends a report and not a
dashboard. A dashboard emailed or printed takes no dates of its own, and its
PDF prints the screen's chart with the usual scale, never "Around the data".
No cross company report
other than the four network aggregates, which are `docs/concepts/networks.md`.
