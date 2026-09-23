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

## Setup

Nothing. The catalogue and the built-in reports ship with the product, and
both are filtered by what the reader holds, so an owner and a dispatcher see
different lists rather than the same list with half of it erroring.

## Using it

### Run one of the reports that ship

`/reports` lists them by the question each one answers. Every one has a date
range, and the range lives in the URL, so a report sent to a bookkeeper opens
on the same months.

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

## Permissions

| Role | Access |
|---|---|
| owner, admin | Everything, including the financial datasets |
| manager | Everything their scope covers |
| accountant | The financial datasets |
| dispatcher, csr | The operational datasets. Invoices and estimate values are refused |
| technician | Their own work only, and only where `report:read` is granted |

`report:read` runs reports. `report:build` saves and deletes them. The
financial datasets additionally need `report.financial:read`.

## API

`reports.run(ctx, definition)` takes a definition and returns columns and
rows. `reports.available(ctx)` returns the catalogue trimmed to what the
caller holds, which is what the builder is drawn from. `reports.builtIn(ctx)`,
`list`, `save`, `remove` and `runSaved` cover the rest.

## Common questions

**Can I write SQL?** Not through this. Point a read-only credential at the
database and write whatever you like: that is a separate grant you control,
which is the honest version of the same capability.

**Why does my report stop at a thousand rows?** It says so when it does.
Nobody reads a ten thousand row report on a screen, and a report cut off
without saying so is the worst failure this screen has.

**Why is "To" exclusive?** So a range of one month does not silently include
the first moment of the next one.

**The aging buckets have numbers in front of them in the database.** They sort
that way on purpose: "Over 90" lands between "1 to 30" and "31 to 60"
alphabetically. The catalogue marks the column, and the screen takes the
prefix off.
