---
title: Job Costing and Profitability
module: M15
domain: Money
phase: 5
status: partial
---

# Job Costing and Profitability

> Module M15. Domain: Money. Ships in phase 5.

## What it does

Answers which work makes money. Per job, with the rows behind every number, and
rolled up by job type, technician, customer, business unit, month or day of the
week.

## The problem

Every owner in this industry has a number they believe is their margin and a
suspicion that it is wrong. Usually it is, for one of three reasons: labour was
counted at a wage rather than a loaded rate, material that was issued from a van
was never costed, or the job is not finished and the number is being read as
though it were.

A margin shown without its caveat is the one that gets quoted back in a board
meeting as though it were net profit.

## Key concepts

**This is not a second reporting engine, and there is a line where it stops
being one.** Everything that is a group by lives in the report catalogue as the
profitability dataset and runs through the same builder as every other report in
the product. That builder already scopes a job read, drops soft deleted rows,
bounds a date range, refuses a measure the caller may not see and stops at a
thousand rows. A parallel aggregator would mean writing all of that again and
getting one of them slightly different, and the one that is usually different is
scope.

**What is here instead is the two things an aggregate cannot be.** A statement
for one job, which has to show the rows behind each number, because an owner who
does not believe a margin wants the ledger transactions, the lines and the
punches, and a group by has thrown all of those away by the time it returns. And
a verdict on whether the number is finished: work in progress, hours with no rate
on them, lines nobody has billed or written off. Those are facts about one job,
stated as sentences, and they do not survive being summed.

**One copy of the arithmetic.** Both the per job statement and the rolled up
dataset read their numbers from the same SQL object the dataset's measures are
built from. A per job margin and a rolled up margin that disagree by six dollars
is a meeting nobody recovers from, and the only way to be sure they agree is for
there to be one copy.

**Every number travels with what it is wrong about.** The same shape the review
rating uses: the caveat is part of the answer rather than a footnote somebody
can drop.

**Two margins, never one instead of the other.** The direct (gross) margin is
revenue less materials, hours at the loaded wage frozen on each punch, card
and financing fees, and what people spent for the job that the company agreed to
pay back (below). Beside it, the fully loaded margin takes off labour burden
and overhead at rates the company sets itself. No rate is a default somebody did
not choose: with none set the two margins are equal. An allocation is a choice
and not a measurement, and the statement says what each basis does to it: by
revenue every job keeps its margin percentage, by the hour a job that ran long
is charged twice for the overrun, per job a quick call carries as much as an
install.

**Overhead can be a mix.** Per paid hour, per job, as a share of revenue, as a
share of material cost, per visit and per truck day, in any combination. The parts set on one day are the whole of the
overhead from that day: a mix is replaced whole on a later day rather than
added to, because the other reading (each basis its own history) would turn
every change of basis a company already made into a mix it never chose. So a
company charging $20 an hour from January that sets 3% of revenue and $25 a
job from July charges those two from July and no longer the hourly part. Each
part is reported on its own: on the job's statement as `overheadParts`, under
the overhead figure on `/jobs/{id}`, and as the `overhead_per_hour`,
`overhead_per_job`, `overhead_revenue_share`, `overhead_material_share`,
`overhead_per_visit` and `overhead_per_truck` measures on the profitability
dataset, which add up to `overhead`. The rule is core's `costing.overheadMixOn`
and `costing.overheadParts`, with unit tests, and an integration test holds the
SQL to it.

**The three later bases, and what each is charged on.** By material cost is a
percentage of the job's material cost, the same figure as the materials on its
statement (its lines at cost and the cost of goods sold posted to it). Per visit
is an amount for each of the job's visits that was not cancelled and was not
brought in from an old system. Per truck day is an amount for each company
vehicle that went out on the job, once for each day it did: a vehicle went out
on a visit's day when the vehicle register (M22) says it was held that day by
somebody on the visit, or by the job itself. A visit's day is when they
arrived, else its window, else when it was finished, in the company's
calendar. The statement says what the last two were charged on
(`overheadMeasures`: visits and truck days). **The conservative reading
taken:** a visit by somebody holding no vehicle that day adds no truck day,
because the register is the only record of which truck went, and a guess would
charge a truck that stayed in the yard; so a company that does not keep custody
in the register charges nothing per truck, and the settings screen says the
part is read from the register.

**What people spent for a job is a cost of it.** A receipt a person paid for the
job that the office approved, and the company's rate for each day somebody was away
on it, are `expenseCost` on the job's statement and the "Expenses and per diem"
measure on the profitability dataset, subtracted in the gross margin and in the
project roll up (M17: `GET /v1/jobs/{jobId}/expenses` lists them, `job.cost:read`).
Read from the two tables rather than the ledger, because neither is posted to it.
A receipt still waiting for the office is not counted, and the statement says so
in words while there is one; a receipt for the shop, with no job, is on no job.

**Rates are dated.** Payroll taxes, benefits, workers' compensation and overhead
are each a history: the rate in effect on a day is the latest one on or before
it, so a punch is burdened at the rate of the day it started and a job carries
the overhead of the day it finished. Raising workers' compensation in July does
not reprice March, and a zero switches a component off from a date. A
percentage burden is of the BASE wage on the punch, because those costs are
charged on wages and the fringe already in the loaded rate is a benefit.

**The budget is read against the ledger.** Twelve numbers a line, a line being
Revenue, Materials, Labour, Overhead or one account, and the actual is the
ledger grouped by month in the company's calendar, so it agrees with the trial
balance. Revenue is the 4xxx accounts net of discounts, materials is 5000,
labour the other 5xxx accounts, overhead 6xxx and above. This product posts no
wages itself, and posts to materials only freight or duty billed after a
delivery (M16), so those lines are only as complete as the journals an
accountant posts (M14), and the report says so.

**A job type has a budget of its own, the same way.** A line can be one job
type's instead of a branch's (never both), read against the ledger entries on
that type's jobs: their invoices, discounts, card fees, write offs, commission
and any journal line that names one of them. A job moved to another type later
moves its entries with it, because the question is about the kind of work.
Nothing that is not on a job can be in a job type's figures (rent, trucks,
payroll, a journal to no job), so a job type's report counts the year's entries
on no job and adds up their debits, as a branch's counts the entries with no
branch. The company's report does not add a job type's lines in.

**The forecast is an estimate, and says so.** Every line has a year end
forecast: the months already over (every month before the one the company is
in) at what the ledger says, and this month and the rest at their budget, at
the run rate of the months already over, or shaped like last year, as the
company chooses, or a blend of the three. The
month in progress is not read at its actual so far, because ten days of
October are not October. The budget is the default because it is the figure
the company already wrote down; a month with no budget counts as nothing, and
the line says how many. The run rate reads a seasonal year wrongly, which the
screen says, and with no month over yet there is none, so the budget is used and
the screen says that too.

**Shaped like last year.** The months already over are taken as the same share
of the year they were last year, and the rest of the year follows in proportion:
a company that did a third of last year by May, and has done 40,000 by May this
year, is forecast 120,000. Each line is shaped by its own last year, in the same
branch and job type, read from the ledger the same way as the actuals, and rounded
once, to the cent (`budget.seasonalToCome`). The shape can be the average of
up to five past years instead of last year alone: their months are added
together, month by month, and the year is shaped like that ("shaped like the
average of 2023 to 2025"), so a big one off job in one March counts for a
fraction of what it would alone. Choosing it is refused, in words, unless the
books hold all of those years ("Use fewer years, or take the months to come
at their budget or at the run rate until they are."). A line with nothing last year, or
with nothing or less by this point of last year, has no shape to follow and is
taken at its budget; the line says so ("Nothing last year to follow, so at its
budget", `noShape`), and the assumption counts those lines. With no month over
yet there is nothing to scale, so the budget is used, as for the run rate.
Choosing it is refused, in words, unless the books hold the whole of last year:
their first entry is in its January or earlier ("Shaping 2026 like 2025 needs all
of 2025 in your books, and the first entry in them is on 2025-03-15, so 2025 is
not whole."). It is one more choice for the year, set with `finance:configure`,
like the other two. The assumption is written above the table every time,
with "This is an estimate, not a promise." Nothing about it posts or is stored
but the choice. The rule is core's `budget.forecastLine` and
`budget.closedMonths`, with unit tests.

**A blend of the three.** The owner sets whole percentages of the budget, the
run rate and the seasonal shape that add up to 100 ("70% at their budget and
30% at the run rate so far"); anything else is refused in words. Each part is
worked out exactly as it would be on its own, falling back to the budget where
it would (no month over yet, nothing to shape), and the months to come are the
weighted sum, so 50 budget and 50 run rate is halfway between the two
forecasts. Each line says what each part alone would make the months to come
(`forecast.parts`). A blend that weighs the shape needs the shape's years in
the books, like the seasonal choice. It is the same one choice for the year as
the other three, set with `finance:configure`.

**The forecast by month.** Every line also gives the year month by month
(`forecast.months`): a month already over at its actual, a month to come at its
budget, at an even part of the run rate, at its share of the past years'
shape, or at the weighted mix of those for a blend, to the cent, adding up to
the year end figure. The rule is core's `budget.forecastLine`, with unit tests.
**The conservative reading taken:** the forecast, by month or for the year, is
never stored, as the budget or anywhere else; it is worked out each time the
report is read. Only the choice (the method, the weights and the number of
years) is kept, so the budget the company wrote down is never quietly replaced
by an estimate.

**Three judgements the product owner has not made, and the conservative reading
taken.** The forecast's default is the budget rather than the run rate, because
it repeats a figure the company chose instead of inventing one. The month in
progress counts at its budget, not its actual so far, so a forecast does not
swing on the first of the month. And the forecast is one choice per year that
every reader sees, set with `finance:configure`, rather than a toggle each
reader flips, so two people in a meeting are not reading two different year
ends.

**A branch has a budget of its own.** A budget line can be one branch's, and
the report can be read for one branch: that branch's lines against the ledger
entries that carry that branch, which is every posting made from a job or
invoice in it since branches were carried (M14). The whole company's report is
the lines set for the company against everything, as it always was; a branch's
lines are not added into it, because a company that budgets Revenue for itself
and for each shop has said two things, and adding them would count the money
twice. **A job type in a branch** ("service in the north shop") has a budget of its
own the same way: its lines are read against the entries that carry the branch
and are on that type's jobs, the report says both what carries no branch and
what is on no job, and it is added into neither the branch's nor the job type's,
nor they into it. A branch's report says how many of the year's ledger entries carry no
branch and what their debits add up to (payroll, a payment spread over two
branches, and everything from before branches were recorded), because none of
that can be in a branch's figures. Nothing old is moved: every line written
before this is the company's. A retired branch's year can be read and is given
no new lines.

**Material cost is the job's lines plus the cost posted on the job.** A job's
material cost is what its lines cost (each line's cost taken from the price book
version per the unit the line counts: an item bought by the gallon and used by
the ounce is costed per ounce, M06), and on top of that its cost of goods sold
entries in the ledger: the share of a freight or duty bill that arrived after a
delivery and landed on parts this job had already used (M16), less any taken
back when a unit came back off the job, and any cost an accountant journalled to
the job (M14). Using stock posts nothing to cost of goods sold, so late freight
cannot count a line twice. The statement lists those entries beside the lines
(`costEntries`), so the number still traces to its rows.

**A journal line on a job is in its margin, once.** A line of a manual journal
can name a job (M14), and a line that does is a ledger entry with that job on it,
which is what job costing already reads by job. So there is no second query to
count it a second time: revenue (4000, 4100, 4900) takes a journalled credit,
materials (5000, cost of goods sold) take a journalled debit, which is where an
accountant puts a subcontractor's bill, a disposal receipt or a supplier's
invoice for the job's parts, and card fees (6100) take one too. A reversal puts
the same job on its lines and nets them out. A journal line on the job in any
other account is listed on the statement as booked to the job and not counted, and
the one that matters is labour: hours come from the timeclock at the rate frozen
on each punch, so a payroll journal to the same job would count the same hours
twice. The commission expense stays out of margin, as it always has. The one
way left to count a cost twice is to journal to a job a cost that is already on
one of its lines, which the statement and the journal screen both say, and
which job costing now warns about (below).

**A cost that may be counted twice is flagged, never changed.** A journal's
debit to cost of goods sold (5000) on a job is matched against the job's own
lines (every kind but labour, each at quantity times unit cost). A pair is
flagged when the amounts are the same to the cent and either the same vendor
is named on both, or the two days are within 30 days of each other. "The same
vendor" is one of the company's vendors whose name is in the journal's memo or
the journal line's note, and also in the line's name or description, or who
sells the line's price book item. Thirty days because a supplier's or
subcontractor's bill often arrives weeks after the work, and a warning that can
be dismissed in one click is cheaper than a cost counted twice. A reversed
journal and its reversal are never flagged, because together they are nothing.
The rule is core's `costing.possibleDoubleCount`, with unit tests, and the SQL
is `DOUBLE_COUNT_PAIRS_SQL` in report-catalogue.ts, held to it by an
integration test. The job page says "This cost may be counted twice", lists
each pair with why it was flagged ("Same amount, 4 days apart."), and leaves
both costs in the materials figure. The margin reports carry a "Possible
double counts" measure (`possible_double_counts`) from the same SQL, on the job
costing report and margin by job type. Whoever posts journals can say a pair is
"Not the same cost", with a note: the warning becomes a line saying who checked
it, and can be taken back. Neither the warning nor the mark changes a figure,
and both the mark and taking it back are audited.

**Two judgements the product owner has not made, and the conservative
reading taken.** The warning never removes or adjusts a cost by itself,
because only the bookkeeper knows whether a $480 bill and a $480 line are one
cost, and a margin that quietly dropped one would be wrong half the time in
the direction nobody checks. And marking a pair is for whoever holds
`ledger:post` (the owner and the finance role), not for everyone who reads
job cost, because the mark is a statement about a journal.

**Revenue is read from the ledger, not from the invoice total.** That is what
makes the job costing report agree with the trial balance to the cent, and it is
what the booked-to-paid browser test asserts.

## Using it

### One job

`GET /v1/profitability/jobs/{id}` is the statement. `/jobs/{id}` shows the same
figures to whoever may read both sides, and under them lists "Booked to this job
by journal": each journal line that names the job, with the journal's number, and
whether it is counted in revenue, materials or card fees or not counted here. Over
the API those are `journalLines`, and the ledger rows carry the journal's number.

Above the figures, a journalled cost that matches one of the job's lines is
shown as "This cost may be counted twice", with the journal, the line, the
amount and why. Somebody holding `ledger:post` sees a "Not the same cost"
button with an optional note under each pair, and "Take back" on a pair
already marked. Over the API the pairs are `doubleCounts` on the statement
(each with `notTheSame`, null while the warning stands) and
`possibleDoubleCounts` is how many journal lines are still flagged;
`POST /v1/profitability/jobs/{id}/not-the-same` marks a pair (idempotent, and
marking one already marked returns the mark) and
`DELETE /v1/profitability/jobs/{id}/not-the-same/{markId}` takes it back.

### The roll up

`GET /v1/profitability/summary` is the aggregate. `/reports` holds the margin
reports and the job costing report beside them.

### The jobs behind a rolled up number

Every number on the job costing report and the four margin reports opens the
jobs behind it: margin by technician opens that technician's jobs, Saturday's
margin opens Saturday's jobs, with each job's revenue, costs and margin beside it
and the totals underneath equal to the number that was clicked. They are the same
SQL fragments evaluated one job at a time, so a job's line on that list is the
figure on its own statement. Each job opens on `/jobs/{id}`, where the statement
is. Over the API, a summary row is drilled with `POST /v1/reports/drill`, the
`profitability` dataset and the row's values.

Both calls need `report.financial:read` AND `job.cost:read`. Two permissions
because they are two different exposures: one is "may this person see financial
reporting at all" and the other is "may this person see what work costs". A
company that gives an office manager cost visibility on a job and not the P and L
is a normal company.

### Burden and overhead

`/settings/costing` holds the rates with the day each took effect, what an hour
at a $30 wage costs today with them, the overhead charged today in a sentence
("$12.00 per paid hour, $25.00 per job and 3% of revenue"), a form to set
overhead from a date as a mix (six boxes: per paid hour, per job, share of
revenue, share of material cost, per visit and per truck day, any left empty,
started from today's figures so changing one part does not drop the others),
and a form to add one rate. `GET /v1/costing/rates` lists them with `overheadNow`,
`POST /v1/costing/overhead` sets the mix from a date (a day that already has
overhead is refused unless the same mix is sent again),
`POST /v1/costing/rates` adds one rate (a second rate for one burden component
on one day is refused; an overhead rate by another basis on a day that has
overhead is added to that day's mix) and `DELETE /v1/costing/rates/{id}`
removes one entered by mistake. The job statement, `/jobs/{id}` and the job costing report then show
labour burden, overhead and the fully loaded margin; the profitability dataset has
`labour_burden`, `overhead` and `fully_loaded_margin` as measures.

### The budget

`/books/budget` shows the year by line and month: the budget, the ledger's
actual, the difference and whether it is better or worse, and year to date. A
line is set there all twelve months at once, or the year is loaded from a CSV
with a header row of months (`Line,Jan,...,Dec`), where each line in the file
replaces that line and nothing loads unless the whole file reads. A Branch
choice above the table reads and sets one branch's budget instead of the
company's, and a CSV loaded while a branch is chosen goes into that branch.
A Job type choice beside it does the same for one job type, and the page
says how much of the year was booked to no job. Both at once are that job
type's budget in that branch ("Budget 2026, Service in North shop"), set and read
there like the others.

Each line has a "Year end forecast" column: the forecast, the year's budget
and whether it is better or worse, and how many months with no budget were
counted as nothing. Above the table, "How the forecast is made" says what was
assumed. "The forecast" section, for whoever sets the budget, chooses how the
months to come are taken: at their budget, at the run rate so far, or shaped
like last year, for the whole year, which every branch's and job type's report
uses too. A blend takes three boxes of percentages, and "Shape from" chooses
last year alone or the average of up to five past years. Under the table, "The
forecast by month" opens each line's year month by month, saying it is never
saved as the budget.

`GET /v1/budgets/{year}` is the report, `PUT /v1/budgets/{year}/lines` sets a
line, `DELETE /v1/budgets/{year}/lines/{line}` removes one and
`POST /v1/budgets/{year}/import` loads a CSV; each takes `businessUnitId` for a
branch's own lines, `jobTypeId` for a job type's, or both for a job type's in a
branch, and the report
then carries `branch` with the count of entries that carry no branch, or
`jobType` with the count on no job (both, for a job type in a branch). Every
line carries `forecast` and the report carries `forecast` with the method chosen
(`budget`, `run_rate`, `seasonal` or `blend`), the one used, the months already
over, the lines with no shape last year, the blend's `weights`, the
`seasonalYears` the shape is averaged over and the assumption in words; each
line's `forecast` has `months` (twelve figures adding up to it) and, for a
blend, `parts`. `PUT /v1/budgets/{year}/forecast` chooses the method, with
`weights` for a blend and `seasonalYears` (1 to 5).

## Permissions

| Role | Access |
|---|---|
| Owner | Everything |
| Administrator | Everything |
| Office manager | Reads job cost and margin. Not financial reporting |
| Dispatcher, CSR, technician | Neither |
| Accountant | Both |

`job.cost:read` and `report.financial:read` are both on the sensitive list.

Marking a possible double count as two different costs, or taking that back,
needs `ledger:post` and `job.cost:read`, in the caller's scope: the owner and
the finance role. The administrator and the office manager read the warning
and cannot mark it.

Setting burden and overhead rates, the budget and how its forecast is made needs `finance:configure`,
which the owner, the administrator and the accountant hold and the office
manager does not: a rate changes what every fully loaded margin says. The rates
are read with `job.cost:read`, the budget with `report.financial:read`.

## API

| Call | Needs |
|---|---|
| `GET /v1/profitability/jobs/{id}` | `report.financial:read`, `job.cost:read` |
| `GET /v1/profitability/summary` | `report.financial:read`, `job.cost:read` |
| `POST /v1/profitability/jobs/{id}/not-the-same` | `ledger:post`, `job.cost:read` |
| `DELETE /v1/profitability/jobs/{id}/not-the-same/{markId}` | `ledger:post`, `job.cost:read` |
| `GET /v1/jobs/{jobId}/material-cost` | `inventory:read` |
| `POST /v1/reports/drill` | `report:read`, and the report's own permissions |
| `GET /v1/costing/rates` | `job.cost:read` |
| `POST /v1/costing/rates` | `finance:configure` |
| `POST /v1/costing/overhead` | `finance:configure` |
| `DELETE /v1/costing/rates/{id}` | `finance:configure` |
| `GET /v1/budgets/{year}` | `report.financial:read` |
| `PUT /v1/budgets/{year}/lines` | `finance:configure` |
| `POST /v1/budgets/{year}/import` | `finance:configure` |
| `PUT /v1/budgets/{year}/forecast` | `finance:configure` |

## Common questions

**Why does a job show a margin while it is still open?** Because an owner wants
to know, and the statement says it is work in progress rather than pretending the
number is final.

**Are unpaid hours counted?** Hours with no rate on them are named as a reason
the number is not finished, rather than being silently treated as free.

**Does free work show up?** Yes, through M32: a job whose coverage source is our
own warranty, goodwill or a callback is a zero on a revenue report with a cause
attached to it.

## What is not built

Overhead can be a mix of per paid hour, per job, a share of revenue or of
material cost, per visit and per truck day, and a mix is replaced whole on a new
day rather than one part at a time. A truck day is only what the vehicle
register's custody record says: there is no truck chosen on the visit or from
the phone, so a company that does not record who holds which vehicle charges
nothing per truck, and a vehicle held by two people on one visit is one truck
day. Per visit counts every visit that was not cancelled, a callback and a
visit nobody worked included. The overtime
premium is still not on a job, for the reason above. Burden and overhead are
applied in reporting only; nothing posts them to the ledger, which keeps them
as the company's choice rather than an entry in its books. A job type's actuals, in a branch or not, are only what was booked to its jobs,
and a branch's only what carries the branch. The forecast is one choice for the
whole year (the budget, the run rate, shaped like past years, or a blend of the
three by whole percentages), by month and for the year; it is shown, never
stored or posted. The run rate weighs every month over the same: there is no
weighting of recent months. The months to come of the run rate are even, not
shaped. A blend's weights are the same for every line and every month: a line
cannot be weighted differently, nor the months late in the year. A shape is
the plain average of the years chosen, each counted the same, the most recent
no more than the oldest, and a year with a one off month still shapes the
year, by a share of it. Whether a company
has the years a shape needs is read from the first entry in its books, for the whole
company: a branch or a job type that is newer is not refused, its lines simply
have nothing to follow and are at their budget, saying so. The history needed is
the whole calendar year before, from its January; a company whose books start on
the second of February waits a year more, which is the conservative reading. A branch's budget is not read for a branch manager's
own branch automatically: the report is a company financial report under
`report.financial:read`, and whoever holds that chooses the branch. Labour and materials actuals depend on journals, because
nothing here posts wages or supplier bills. A journal can now put a supplier
bill or a subcontractor's cost on a job, and the margin counts it; a journalled
cost that matches one of the job's lines (the same amount, and a vendor named on
both or within 30 days) is flagged on the job and counted on the margin reports,
but never taken out: until somebody removes one of the two, both are in the
margin. A cost that was split (one bill journalled as two lines, or a line for
part of a bill) is not matched, because only the same amount is; nor is a cost
on the ledger by any other route than a manual journal, such as late freight. A
vendor is matched by name in the words, so a bill whose memo does not name the
vendor and that arrived more than 30 days after the line is not flagged. Labour
journalled to a job is listed and not counted, so a payroll run cannot double the
hours. A subcontractor's labour is not hours on this company's clock, so it is
booked to account 5000 to be counted.
