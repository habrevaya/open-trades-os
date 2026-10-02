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

A task queue for office work. Created by a person or raised by the workflow
engine, assigned to somebody or to a queue, due dated, escalating and
reportable.

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
| `GET /v1/obligations` | `task:read` |
| `POST /v1/obligations/{id}/satisfy` | `task:write` |
| `POST /v1/obligations/{id}/waive` | `task:write` |
| `POST /v1/obligations/sweep` | `task:write` |

Tasks themselves have no `/v1` routes: the queue is office only, and an integration
or an agent cannot create or complete a task.

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

No `/v1` routes for tasks. No escalation: a task that goes overdue stays overdue and
nothing reassigns it or tells anybody. No recurring tasks. No task templates or
checklists within a task. The obligation primitive has one writer, so the SLA clocks,
acknowledge by and claim windows the schema describes are a shape waiting for the
modules that would use it.
