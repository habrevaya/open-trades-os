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

Both calls need `report.financial:read` AND `job.cost:read`. Two permissions
because they are two different exposures: one is "may this person see financial
reporting at all" and the other is "may this person see what work costs". A
company that gives an office manager cost visibility on a job and not the P and L
is a normal company.

## Permissions

| Role | Access |
|---|---|
| Owner | Everything |
| Administrator | Everything |
| Office manager | Reads job cost and margin. Not financial reporting |
| Dispatcher, CSR, technician | Neither |
| Accountant | Both |

`job.cost:read` and `report.financial:read` are both on the sensitive list.

## API

| Call | Needs |
|---|---|
| `GET /v1/profitability/jobs/{id}` | `report.financial:read`, `job.cost:read` |
| `GET /v1/profitability/summary` | `report.financial:read`, `job.cost:read` |
| `GET /v1/jobs/{jobId}/material-cost` | `inventory:read` |

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

No drill through from a rolled up row to the jobs behind it, so an owner who
wants the detail opens the jobs. There is no overhead allocation model: the
statement is direct cost against revenue, and a burden rate is not applied. No
budget against actual at the company level, though M12 does it per project.
