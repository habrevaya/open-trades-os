---
title: Projects and Multi-Phase Work
module: M12
domain: Operate
phase: 7
status: partial
---

# Projects and Multi-Phase Work

> Module M12. Domain: Operate. Ships in phase 7.

## What it does

Holds work that runs for weeks: a bathroom refit, a system changeout, a
commercial fit out. Phases that wait for each other, a schedule of values, draws
raised as invoices as the work progresses, and the spend against the budget the
whole time.

## The problem

A job in this product is one piece of work at one address, usually a trip or
three. A fit out is not that, and the tempting shortcut is to model its phases as
child jobs.

That breaks two things that already exist. `job.parent_job_id` means "this job is
warranty rework on that one", and the review module counts rows by it and calls
the result the callback rate. Phases modelled as children would make every
project read as rework and suppress the review ask on the parent for the life of
the job. So a project is its own container.

## Key concepts

**The schedule of values cannot exceed the contract.** A fit out is applied for
against a schedule of values, and one that adds up to more than the contract is
rejected by whoever is certifying it. Refusing the phase that breaks it is the
only moment anybody is in a position to fix it cheaply.

**A contract value cannot be cut below what has been billed.** The draws raised
are invoices the customer has, and lowering the contract under them leaves a
project that has billed more than it is worth, which every number downstream reads
as an overbill. Nor below what the phases add up to, for the reason above.

**A phase waits for at most one other phase, in the same project, and never for
itself or anything downstream of itself.** The cycle check walks the chain rather
than looking one step back: A waits for B, B waits for C, and making C wait for A
is a project where nothing can ever start and nothing says so.

**A project is not complete while a phase is not.** "Completed" is read by whoever
is deciding to invoice the retention and to stop paying attention, and a project
marked complete with a phase still open is the version of that where somebody
stops looking.

**No money arithmetic lives here.** Budget against actual reads through the same
SQL objects the profitability reports are built from. A project margin and a per
job margin that disagree by six dollars is a meeting nobody recovers from.

**No invoices are created here.** A draw becomes an invoice through the billing
service, which knows about numbering, the price book, rate cards, tax and the
ledger posting. Raising a draw is idempotent across the transaction boundary
billing insists on.

**Materialising follows the same rule as the other two materialisers.** Recurring
schedules and service routes both turn a definition into jobs and both are
idempotent by reading what already exists for a stable identity and skipping it,
reporting a count rather than failing. This is the third, and it does not invent a
fourth answer to "has this already been created".

**No permission is invented.** There is no project permission in the catalogue,
and a string that is not in the catalogue cannot be granted to anybody. Reads use
`job:read` and structural writes use `job:write`, because a project is a container
for work. The billing schedule uses `invoice:write`, because planning and raising
a draw is deciding what a customer is charged and when, and the dispatcher preset
that holds `job:write` very deliberately holds nothing that touches money.

## Using it

### Set one up

`POST /v1/projects` with the customer, the property and the contract value.
`POST /v1/projects/{projectId}/phases` adds a phase with its share of the
schedule, and `POST /v1/project-phases/{id}/dependency` says which phase it waits
for. `/projects/new` is the office form.

### Run it

`POST /v1/projects/{id}/materialise` turns the phases into jobs, one per phase.
`POST /v1/project-phases/{id}/status` moves a phase.
`POST /v1/projects/{projectId}/jobs` attaches a job that already exists.
`/projects/{id}` is the screen.

### Bill it

`POST /v1/projects/{projectId}/draws` plans a draw and
`POST /v1/project-draws/{id}/raise` turns it into an invoice. Both need
`invoice:write`.

### Watch the money

`GET /v1/projects/{id}/profitability` is budget against actual, and needs
`job.cost:read` with `report.financial:read`.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything |
| Office manager | Reads, builds the structure, plans and raises draws |
| Dispatcher | Reads and writes the structure. Nothing that touches money |
| CSR | Reads |
| Technician | Reads their own jobs within it |
| Accountant | Reads the profitability |

## API

| Call | Needs |
|---|---|
| `GET /v1/projects` | `job:read` |
| `POST /v1/projects` | `job:write` |
| `POST /v1/projects/{projectId}/phases` | `job:write` |
| `POST /v1/project-phases/{id}/dependency` | `job:write` |
| `POST /v1/projects/{id}/materialise` | `job:write` |
| `POST /v1/projects/{projectId}/draws` | `invoice:write` |
| `POST /v1/project-draws/{id}/raise` | `invoice:write` |
| `GET /v1/projects/{id}/profitability` | `job.cost:read`, `report.financial:read` |

## Common questions

**Can a phase wait for two others?** No. One dependency per phase, which covers
the sequences that actually occur and keeps the cycle check answerable.

**What happens to a draw if the contract is revised down?** The revision is
refused if it would go below what has been billed. Revising upward is fine.

**Is retention modelled?** Not as its own concept. A retention draw is a draw like
any other, held back until somebody raises it.

## What is not built

No Gantt view, no critical path and no resource levelling: the dependency chain is
one phase waiting for one other, and the screen shows it as a list. Change orders
are a contract revision rather than their own object, so the history of what was
agreed when is in the audit log rather than on a document. No lien waiver or
notice tracking, and no application for payment document: BUILD.md is explicit
that this project records lien dates and does not author the rules.
