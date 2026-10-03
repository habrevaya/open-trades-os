---
title: Tasks and the Office Work Queue
module: M34
domain: Company
phase: 6
status: partial
---

# Tasks and the Office Work Queue

> Module M34. Domain: Company. Ships in phase 6.

## The problem

The work that is not a job: call this customer back, chase this approval, this invoice needs a purchase order before it can be sent, somebody promised a quote on Friday.

## What it does

A task queue for office work. Created by a person, raised by the workflow
engine or by a recurring template, assigned to somebody or to a queue, due
dated, escalated by rule when it stays late, and carrying a checklist when the
work is several things.

Tasks attach to the record they are about, so following one up opens the
estimate rather than a sentence describing it.

## Key concepts

**A task hangs off the record it is about.** A to-do list of sentences makes
somebody reconstruct the context before they can act, and the reconstruction is
most of the work.

**The workflow engine raises most of them.** Relying on a person to notice that
an estimate went unanswered for five days is relying on a report nobody runs.
The events are already in the log; a task is what turns one into something
somebody actually sees.

**Where the money leaks.** An unapproved estimate nobody followed up is a sale
that did not happen and leaves no record that it existed. That is the case this
module is for.

## Key concepts, continued

**Reading and writing are separate permissions.** A technician can be handed a task
and complete it; letting them create work for other people is a different thing, and
a queue anybody can add to stops being a queue anybody reads.

**Overdue is derived from the due date and the clock, never stored.** A task that has
to be marked overdue by a nightly job is quietly not overdue whenever that job fails,
which is the same argument the invoice aging board makes.

**A task an automation raises is idempotent.** A workflow firing on every event would
otherwise raise the same "chase this estimate" task every hour until somebody turns
the automation off, which is how a queue becomes something people stop opening. It
also carries the run that raised it, so "why is this here" has an answer.

**Dismissed is a separate state from done.** "We decided not to" and "we did it" are
different facts, and a queue where the second quietly absorbs the first tells an
owner nothing about how much of the raised work was worth raising.

**Deadlines are one primitive, not a date column on six tables.** SLA clocks,
acknowledge by, on site by, invoicing windows, warranty registration deadlines and
claim windows are all the same thing, and the reason for one table is that the thing
everybody actually needs is what is about to breach, across all of them.

**A breach is derived, not trusted.** The obvious read is a filter on the stored
state, and that read is wrong in the one case that matters: if the sweep that moves
rows to breached has not run, was never deployed, or died three weeks ago, the query
returns nothing and the screen says everything is fine. A monitoring system whose
failure mode is silence and a clean bill of health is worse than none. So overdue is
computed from the due date on every read, and the stored state is only ever used to
exclude what somebody has finished with: satisfied, waived or cancelled.

**The obligation that nobody could see.** Exactly one place in the product wrote an
obligation, and it was the one a technician creates by finishing work on a visit
dispatch had cancelled, with the consequence "confirm whether to bill it". Nothing
selected from the table, so every one of those rows was written and never read, and
the work they describe, deciding whether to bill somebody for work that was done
after the job was called off, simply did not get done. The money is real: it is a
completed visit that nobody invoiced.

**An obligation is keyed by the record it is about, not the convenient parent.** The
completed-after-cancellation one names the visit rather than the job, because a job
can carry several visits and only one of them was done after the cancellation, and
collapsing it to the job loses which. The screen resolves the visit's job for the
link rather than the obligation giving up the precision to make linking easier.

## Setup

Nothing to configure. A company gets the queue, and `task:read` and `task:write` are
on the office presets from the start. The technician preset holds `task:read` and not
`task:write`, for the reason above.

## Using it

### Work the queue

`/tasks` is the screen: tasks assigned to somebody or to a queue, overdue first, with
the record each one is about linked rather than described. The deadlines section
beside it is the obligations, computed overdue rather than trusted.

### Create and finish

A task is created by a person on the screen, or raised by a workflow step. Finishing
and dismissing are different actions, and the second is not a quieter version of the
first.

### Tasks other modules raise

Three things put work in the queue without anybody creating it:

- A customer asking from their link to move or cancel a visit (M05). The task
  is raised high and due before the visit, and it is answered rather than
  ticked off: the queue shows the request with "Agree" and "Say no", answering
  closes the task, and "Done" is not offered on it, because a task ticked off
  without the answer would leave the visit unmoved and the customer untold.
- A renewal notice that could not be sent (M08), so somebody tells the member
  another way before their plan renews.
- The estimate follow up's call (M07 and M29), linked to the estimate.

### A checklist inside a task

A task can carry a checklist: given when it is created (on `/tasks`, or
`checklist` on `POST /v1/tasks`), copied from a recurring template, or added to
on the task's own page at `/tasks/{id}`. Items are ticked one at a time and
each says who ticked it. The queue shows "2 of 5 ticked" on each task, and a
task with a checklist is closed from its own page.

Closing as done with items unticked needs a reason, kept apart from the
outcome (`checklistOverrideReason`), because "gauge missing, tyres not checked"
on a van check is a finding and folding it into "done" is how it stops being
one. Dismissing never asks, since a dismissal already carries its reason.

Ticking is acting on your own work: the person a task is assigned to may tick
its items with `task:read`, the same class of act as claiming it, and anybody
else needs `task:write`. `GET /v1/tasks/{id}/checklist`,
`POST /v1/tasks/{id}/checklist`, `POST /v1/tasks/{id}/checklist/{itemId}/tick`
and `POST /v1/tasks/{id}/checklist/{itemId}/remove`.

### Recurring tasks

`/tasks/recurring` is the work that comes round every day, every week on a
weekday, or every month on a day (the 31st is held to the last day of a
shorter month), with who it goes to, when on the day it is due, its priority
and a checklist. The worker raises each one on the day in the COMPANY'S
timezone, so Monday's task is not raised on Sunday evening in Chicago, and
each is paused and resumed from the same screen.

Never twice: the task carries the template and the day, a unique index on the
pair decides, and the worker inserts with `on conflict do nothing`, so a worker
killed mid pass, restarted, or running twice raises the day's task once. A
worker that was down raises the LATEST occurrence, not every day it missed,
because a queue full of last week's van checks is one people stop reading.
`GET /v1/task-templates`, `POST /v1/task-templates` and
`PATCH /v1/task-templates/{id}`.

### Escalation

`/tasks/escalation` holds the rules for a task that stays late: so many hours
past due (and optionally only at or above a priority), tell the assignee's
manager, everybody in a role, or a named person, and optionally hand the task
to somebody. The worker applies each rule to each task once. The record of
having done so (`task_escalation`) is inserted FIRST with
`on conflict do nothing`, and only the pass whose insert landed tells anybody,
all in one transaction.

Telling somebody is a high priority task in their own queue, linked to the late
one, and an email through the outbox when they have an address and the company
sends email; when the email cannot go, the reason is kept on the escalation
rather than thrown. The late task is marked escalated, and its page lists every
escalation with who was told and why those people.

"The manager" is who the person answers to, which the same screen records
(`user:write`, because it is a fact about people). With no manager recorded, an
unassigned task, nobody in the chosen role, or a named person who has left, the
owners are told and the escalation says so in words.
`GET /v1/task-escalation-rules`, `POST /v1/task-escalation-rules`,
`PATCH /v1/task-escalation-rules/{id}`, `GET /v1/tasks/{id}/escalations`,
`GET /v1/reporting-lines` and `POST /v1/reporting-lines`.

### Deadlines

`GET /v1/obligations` is what is open and what is overdue.
`POST /v1/obligations/{id}/satisfy` records that it was dealt with,
`POST /v1/obligations/{id}/waive` records a decision not to, and
`POST /v1/obligations/sweep` is what the worker calls to stamp the breaches. All of
them use the task permissions, because an obligation is work in the same queue.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything |
| Office manager | Reads and writes tasks and obligations |
| Dispatcher | Reads and writes |
| CSR | Reads and writes |
| Technician | Reads tasks assigned to them. Creates none |
| Accountant | Reads and writes |

## API

| Call | Needs |
|---|---|
| `GET /v1/tasks` | `task:read` |
| `GET /v1/tasks/counts` | `task:read` |
| `POST /v1/tasks` | `task:write` |
| `PATCH /v1/tasks/{id}` | `task:write` |
| `POST /v1/tasks/{id}/claim` | `task:read` |
| `POST /v1/tasks/{id}/close` | `task:write` |
| `GET /v1/obligations` | `task:read` |
| `POST /v1/obligations/{id}/satisfy` | `task:write` |
| `POST /v1/obligations/{id}/waive` | `task:write` |
| `POST /v1/obligations/sweep` | `task:write` |
| `GET /v1/tasks/{id}/checklist` | `task:read` |
| `POST /v1/tasks/{id}/checklist` | `task:write` |
| `POST /v1/tasks/{id}/checklist/{itemId}/tick` | `task:read`, and `task:write` unless it is your task |
| `POST /v1/tasks/{id}/checklist/{itemId}/remove` | `task:write` |
| `GET /v1/task-templates` | `task:read` |
| `POST /v1/task-templates` | `task:write` |
| `PATCH /v1/task-templates/{id}` | `task:write` |
| `GET /v1/task-escalation-rules` | `task:read` |
| `POST /v1/task-escalation-rules` | `task:write` |
| `PATCH /v1/task-escalation-rules/{id}` | `task:write` |
| `GET /v1/tasks/{id}/escalations` | `task:read` |
| `GET /v1/reporting-lines` | `user:read` |
| `POST /v1/reporting-lines` | `user:write` |

Claiming needs only `task:read`, and it is the one write in the module guarded by
a read. Taking an unclaimed task is acting on your own work, which is the same
class of act as clocking yourself in. It is conditional, so two people opening the
queue at the same moment cannot both take it and do the work twice.

## Common questions

**Why is a task not just a job with no customer?** Because a job carries a property,
a price, visits and a ledger trail, and none of that is true of ringing somebody
back. Modelling it as a job would put the office's to-do list into the revenue
reports.

**Who gets a task a workflow raised?** Whoever the definition says, which can be a
person or a queue. A task with nobody on it is still visible, because the queue is
read by the office rather than only by an assignee.

**What raises an obligation today?** One thing: a visit completed after it was
cancelled. The primitive is built for more than that and nothing else writes one yet.

## What is not built

A TECHNICIAN CAN TAKE A TASK AND CANNOT CLOSE IT. Claiming needs `task:read` and
closing needs `task:write`, which the technician preset does not hold, so a
technician who picks work off the queue leaves it in progress for the office to
finish. The service's own header used to say a technician "can be handed a task
and complete it", which was false in the direction that matters, and the sentence
is corrected rather than the permission widened: whether a person should be able
to close a task assigned to them is a product decision, and the right place to
make it is not a guard in a service file.

Escalation counts hours, not working hours: a task due Friday at five escalates
on Saturday morning under a twelve hour rule, and a company without weekend
cover sets the rule at sixty. A rule edited after it has acted does not act
again on the tasks it already acted on. The notice is a task and an email; there
is no text message or push notification to staff, because the product has no
staff messaging channel apart from email.

Recurring tasks are daily, weekly on one weekday, or monthly on one day; there
is no "every other week", no "last Friday of the month" and no "weekdays only".
A change to a template applies to the tasks it raises from then on, and a missed
occurrence is not backfilled, deliberately.

Reporting lines are recorded only for escalation, on the escalation screen;
nothing else in the product reads them, and there is no people screen they
belong on yet.

The obligation primitive has one writer, so the SLA clocks, acknowledge by and
claim windows the schema describes are a shape waiting for the modules that would
use it.
