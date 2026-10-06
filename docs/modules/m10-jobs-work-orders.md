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

**Nobody is booked or sent alone onto work they are not qualified for.** A job's
required skills, its type's and any the job adds of its own for one unusual
piece of work (`PUT /v1/jobs/{id}/required-skills`, M24), are checked for each
technician named when a visit is
booked or assigned, with a sentence naming the person and the skill. The answer
comes from M24: a live certification clears a skill, a lapsed or missing one
refuses it, and for a skill no certification grants, the person's recorded
skills decide once anybody in the company is recorded with that skill. A skill
nobody is recorded as doing cannot be checked and does not refuse, and the
assignment says so. Like time off, it is checked for work still to come only.
Booking has no override; assigning does, with `visit:assign_unqualified` and a
reason the audit log keeps.

**A job can drop one of its type's skills, and the reason stays on the job.** An
unusual job (the gas is already capped, the licensed part was done last week)
does not need a skill its type ordinarily asks for. `POST /v1/jobs/{id}/dropped-skills`
drops one with a reason of a sentence or more, and `POST /v1/jobs/{id}/dropped-skills/restore`
asks for it again. Only a skill the job's type asks for can be dropped. From then on it is
not asked of whoever is sent on that job, on the board when somebody is assigned, at booking
with somebody named, for a crew, in the suggestions, and in the room counted for a member's
booking of that job, because every one of those reads the job's skills through one function
that takes the drops away. The reason is shown wherever the job's skills are read: on the
job's page under "Skills this work needs" with who dropped it and when, in
`GET /v1/jobs/{id}/required-skills` (`dropped`, and `checked` for what is actually asked), in
the board's notice when somebody is sent ("This job does not need epa_608: the refrigerant
side was done last week."), in `droppedSkills` on the answer to `POST /v1/visits/{id}/assign`,
and in the audit entry of every assignment made while it stands. Dropping needs
`visit:assign_unqualified` as well as `job:write`, because it lets people be sent without the
skill with no override at the moment they are sent: it is the same decision, so it sits with
the same people (the office manager, not the dispatcher). Putting a skill back only tightens
the check and needs `job:write`. Dropping a skill twice keeps the first reason. A drop for a
skill the type has since stopped asking for does nothing.

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
somebody on a visit (refused for somebody not qualified for the work, unless
overridden with a reason by a caller holding `visit:assign_unqualified`), `POST /v1/visits/{id}/crew` puts a crew on one, and
`POST /v1/dispatch/route` reorders a day. `POST /v1/visits/{id}/on-my-way`
tells the customer somebody is coming, which needs `message:send` rather than a
visit permission because it is a message.

### Call it off

`PATCH /v1/jobs/{id}` with `status: "cancelled"` cancels the job. With
`cancelVisits: true` as well (which also needs `visit:reschedule`) it
cancels the job's visits still to come: those not started whose window has
not ended, or that have no time yet. Each one is cancelled the way a visit
is cancelled on a customer's request: off the route order, its technicians
(and a crew's members) told "Do not go" on their phones, and any request of
the customer's still waiting on it closed. Visits somebody is on the way to
or working, finished ones, and ones whose window passed without anybody
marking them are left as they are. "Cancel this job" on `/jobs/{id}` offers
it, ticked, says how many visits it would cancel, and names the ones under
way it leaves.

### Finish it

`POST /v1/visits/{id}/complete` records what was done, the notes, the checklist
and the signature. `/jobs/{id}` does the same from the office.

### Look at one visit

`/visits/{id}` is one trip on its own: its window and when the van was sent,
left, arrived and finished, who was on it, the technician's notes and the
checklist, what it used by name and quantity (the cost stays on the job's
statement), the time on the clock against it for whoever may read timesheets,
the units it worked, its service report and any inspection filed from it, what
the customer asked to change, its photographs, and the other visits on the
same job. Each visit number on a job's page opens it, and so does every link
that is about one visit rather than the job: a report's records, a deadline, a
customer's request to move it. `GET /v1/visits/{id}` is the same read. It is
scoped by the job, so a visit on work somebody was never sent to is not found.

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
| `PATCH /v1/jobs/{id}` | `job:write`, and `visit:reschedule` with `cancelVisits` |
| `GET /v1/jobs/{id}/lines` | `job:read` |
| `POST /v1/jobs/{id}/visits` | `visit:write` |
| `POST /v1/visits/{id}/assign` | `visit:dispatch` |
| `POST /v1/jobs/{id}/dropped-skills` | `job:write`, `visit:assign_unqualified` |
| `POST /v1/jobs/{id}/dropped-skills/restore` | `job:write` |
| `POST /v1/visits/{id}/complete` | `job:complete` |
| `GET /v1/visits/{id}` | `visit:read` |
| `GET /v1/job-types` | `job:read` |
| `GET /v1/dispatch/board` | `visit:read` |
| `POST /v1/dispatch/route` | `visit:reschedule` |
| `GET /v1/dispatch/optimise` | `visit:read` |
| `GET /v1/dispatch/suggestions` | `visit:read` |

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
reference it explicable. Route optimisation is a proposal per technician that a
person applies (M09), not an automatic reorder. A job can add skills of its own
to its type's and drop one of its type's with a reason, one skill at a time: there is no
"drop for every job of this type" (that is editing the type), and no expiry on a drop. The
public booking page's count of free slots reads the job type's skills only, because there is no
job yet to drop anything from. Booking with a technician who
is refused has no override; book the visit unassigned and send them from the
board. Cancelling a job does not cancel its visits unless the office ticks
it; an API caller has to ask with `cancelVisits`, so an integration that
cancels jobs today keeps its behaviour. A visit somebody is already on the
way to is never cancelled with the job: the office rings them.
