---
title: Jobs and Work Orders
module: M10
domain: Operate
phase: 1
status: partial
---

# Jobs and Work Orders

> Module M10. Domain: Operate. Ships in phase 1.

## What it does

A job is one piece of work for one customer at one address. A visit is one trip
to do some of it. Everything the company does to earn money hangs off those two
rows.

## The problem

Most systems model an appointment and then discover that one piece of work takes
three trips, or that two technicians go on Tuesday and one comes back Thursday
for the part. Modelling the trip as the unit means a job's history is a list of
appointments nobody can total, and modelling the job as the unit without visits
means a schedule nobody can read.

So both exist, and the job is what gets invoiced.

## Key concepts

**A job's status is a lifecycle, not a field.** Lead, estimating, scheduled, in
progress, on hold, completed, invoiced, paid, cancelled. The office genuinely
does edit a booked job, so an ordinary update is allowed; what is not ordinary
is walking the status backwards, because a job that has been invoiced going back
to scheduled is how an invoice ends up attached to work that is no longer
claimed to have happened.

**A visit carries an arrival WINDOW, not a time.** Contractors promise "between
one and four", and storing a single timestamp is what produces the angry review.

**`completed_after_cancellation` looks like a contradiction and is the most
important state in the enum.** A technician works offline, dispatch cancels the
visit while they are in a crawlspace with no signal, and the technician
completes the work and syncs. The naive resolution is to reject the write
because the server is authoritative. That destroys the labour record, the
photos, the signature, the readings and, in a regulated trade, a compliance
record that legally has to exist. The work physically happened, and deleting the
evidence does not undo it. So the write is accepted into a distinguished state
and an obligation is raised for a dispatcher, keyed by the visit rather than the
job, because a job can carry several visits and only one of them was done after
the cancellation.

**Completion is idempotent.** A retry from a truck must not double complete.

**Nobody is booked onto a day they have off.** Approved time off has been on the
board since it was built, so an empty slot on somebody's day off looked
bookable. Checked for work still to come only, because a visit whose window has
already ended is a record of something that happened.

**A callback has to point at real work for the same customer.** A parent from
another company is a cross tenant read; a parent belonging to a different
customer is the one that slips through, and it is how a callback rate stops
meaning anything.

**A job number is allocated under an advisory lock and a unique index.** Two
people booking in the same second both read the same maximum and both got job
41. The lock serialises allocation for the rest of the transaction and the index
makes a duplicate impossible rather than merely unlikely. Sequences were the
obvious alternative and are wrong, because numbering is per company and gaps on
a rolled back transaction are a real problem for invoice numbering in several
jurisdictions.

**Cost on a job line is redacted by the same rule as everywhere else.**
`job.cost:read` is what separates a technician reading the price from a manager
reading the margin.

## Using it

### Book work

`POST /v1/jobs` with the customer, the property, the type and a summary, then
`POST /v1/jobs/{id}/visits` for the first trip. `/jobs/new` does both on one
form, and `/jobs` is the list.

### Run the day

`GET /v1/dispatch/board` is the board, `POST /v1/visits/{id}/assign` puts
somebody on a visit, `POST /v1/visits/{id}/crew` puts a crew on one, and
`POST /v1/dispatch/route` reorders a day. `POST /v1/visits/{id}/on-my-way`
tells the customer somebody is coming, which needs `message:send` rather than a
visit permission because it is a message.

### Finish it

`POST /v1/visits/{id}/complete` records what was done, the notes, the checklist
and the signature. `/jobs/{id}` does the same from the office.

### See what it cost

`GET /v1/jobs/{id}/lines` is what was used. `GET /v1/jobs/{jobId}/material-cost`
is the stock side and needs `inventory:read`.
`GET /v1/jobs/{jobId}/attribution` is where the job came from and needs
`adspend:read`, because that is a marketing question about a job rather than a
job question.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything |
| Office manager | Books, edits, completes, and reads cost and margin |
| Dispatcher | Reads and writes jobs, assigns and reschedules visits. No cost |
| CSR | Books work. Cannot dispatch |
| Technician | Their own jobs and visits, completes them, no cost or margin |
| Crew lead | The same, scoped to the crew rather than to themselves |
| Accountant | Reads jobs and their cost |

Completing is its own permission, `job:complete`, separate from `job:write`,
because a technician may finish work and may not re-describe it.

## API

| Call | Needs |
|---|---|
| `GET /v1/jobs` | `job:read` |
| `GET /v1/jobs/{id}` | `job:read` |
| `POST /v1/jobs` | `job:write` |
| `PATCH /v1/jobs/{id}` | `job:write` |
| `GET /v1/jobs/{id}/lines` | `job:read` |
| `POST /v1/jobs/{id}/visits` | `visit:write` |
| `POST /v1/visits/{id}/assign` | `visit:dispatch` |
| `POST /v1/visits/{id}/complete` | `job:complete` |
| `GET /v1/job-types` | `job:read` |
| `GET /v1/dispatch/board` | `visit:read` |
| `POST /v1/dispatch/route` | `visit:reschedule` |

## Common questions

**Can a job have no visits?** Yes. A lead is a job before anybody has promised
to turn up.

**Who sees whose jobs?** A technician's job scope is `own` by default and a crew
lead's is `crew`. That is scoping, not permissions, and it is the filter that
stops a departing technician paging through the company's work.

**Why is on my way a message permission?** Because that is what it is. A
dispatcher who may not text customers should not be able to text them through a
button on a visit.

## What is not built

`job:delete` is in the catalogue and nothing checks it: a job is cancelled
rather than deleted, which keeps the visits, the labour and the obligations that
reference it explicable. Route optimisation is manual reordering, not a solver.
There is no dispatch map. A job's required skills are declared on the job type
and checked for crews; for an individual technician the check is not wired.
