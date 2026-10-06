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

**Material cost is the job's lines plus late freight.** A job's material cost is
what its lines cost, and on top of that its cost of goods sold entries in the
ledger: the share of a freight or duty bill that arrived after a delivery and
landed on parts this job had already used (M16), less any taken back when a
unit came back off the job. Using stock posts nothing else, so this cannot
count a line twice. The statement lists those entries beside the lines
(`costEntries`), so the number still traces to its rows.

**Revenue is read from the ledger, not from the invoice total.** That is what
makes the job costing report agree with the trial balance to the cent, and it is
what the booked-to-paid browser test asserts.

## Using it

### One job

`GET /v1/profitability/jobs/{id}` is the statement. `/jobs/{id}` shows the same
figures to whoever may read both sides.

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
at a $30 wage costs today with them, and a form to add one. `GET /v1/costing/rates`
lists them, `POST /v1/costing/rates` adds one (a second rate for one component on
one day is refused) and `DELETE /v1/costing/rates/{id}` removes one entered by
mistake. The job statement, `/jobs/{id}` and the job costing report then show
labour burden, overhead and the fully loaded margin; the profitability dataset has
`labour_burden`, `overhead` and `fully_loaded_margin` as measures.

### The budget

`/books/budget` shows the year by line and month: the budget, the ledger's
actual, the difference and whether it is better or worse, and year to date. A
line is set there all twelve months at once, or the year is loaded from a CSV
with a header row of months (`Line,Jan,...,Dec`), where each line in the file
replaces that line and nothing loads unless the whole file reads.
`GET /v1/budgets/{year}` is the report, `PUT /v1/budgets/{year}/lines` sets a
line, `DELETE /v1/budgets/{year}/lines/{line}` removes one and
`POST /v1/budgets/{year}/import` loads a CSV.

## Permissions

| Role | Access |
|---|---|
| Owner | Everything |
| Administrator | Everything |
| Office manager | Reads job cost and margin. Not financial reporting |
| Dispatcher, CSR, technician | Neither |
| Accountant | Both |

`job.cost:read` and `report.financial:read` are both on the sensitive list.

Setting burden and overhead rates and the budget needs `finance:configure`,
which the owner, the administrator and the accountant hold and the office
manager does not: a rate changes what every fully loaded margin says. The rates
are read with `job.cost:read`, the budget with `report.financial:read`.

## API

| Call | Needs |
|---|---|
| `GET /v1/profitability/jobs/{id}` | `report.financial:read`, `job.cost:read` |
| `GET /v1/profitability/summary` | `report.financial:read`, `job.cost:read` |
| `GET /v1/jobs/{jobId}/material-cost` | `inventory:read` |
| `POST /v1/reports/drill` | `report:read`, and the report's own permissions |
| `GET /v1/costing/rates` | `job.cost:read` |
| `POST /v1/costing/rates` | `finance:configure` |
| `DELETE /v1/costing/rates/{id}` | `finance:configure` |
| `GET /v1/budgets/{year}` | `report.financial:read` |
| `PUT /v1/budgets/{year}/lines` | `finance:configure` |
| `POST /v1/budgets/{year}/import` | `finance:configure` |

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

Overhead has one basis at a time: a company that wants part per hour and part
per job picks the one that matters most. The overtime premium is still not on a
job, for the reason above. Burden and overhead are applied in reporting only;
nothing posts them to the ledger, which keeps them as the company's choice
rather than an entry in its books. The budget has no per branch or per job type
split and no forecast; labour and materials actuals depend on journals, because
nothing here posts wages or supplier bills.
