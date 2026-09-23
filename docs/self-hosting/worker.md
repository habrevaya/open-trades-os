# The worker

Two processes, not one. The web app serves requests; the worker drains the
event log and runs workflows. They are separate because they scale and fail
differently: a serverless web deployment has nowhere to run a loop, and a
worker that dies must not take the UI down with it.

Without a worker running, the product works and automations do not. Events
are still written, and they are still there when a worker starts.

```
pnpm --filter @opentradesos/api worker
```

## What it needs

| Variable | Default | What it is |
|---|---|---|
| `WORKER_DATABASE_URL` | falls back to `DATABASE_URL` | The connection the worker uses |
| `WORKER_INTERVAL_MS` | `5000` | How long to wait after a pass that found nothing |

A pass that found work goes straight round again, so a backlog drains at the
speed of the database rather than the speed of the timer. The interval only
applies when there is nothing to do.

## The clock

The same loop also fires scheduled workflows, before each drain, so anything a
schedule produces goes out on the same pass rather than the next one. Turn it
off with `schedules: false` if you would rather run the clock somewhere else;
there is nothing else to configure.

A schedule is a five field cron expression **in the company's timezone**, not
the server's. Every night at eleven means eleven where the company is, which
is the whole reason this is harder than adding a day to a timestamp: the
answer has to survive the clocks changing. What the engine decides, so that
nobody has to guess:

| Case | What happens |
|---|---|
| A wall time that does not exist, on the morning the clocks go forward | Skipped for that day. It runs the next day as normal |
| A wall time that happens twice, when the clocks go back | Fires once, on the first |
| Both a day of the month and a day of the week are given | Fires on either, which is what cron has always meant and is easy to get backwards |
| The worker was down for three days | One run, for the occurrence it was due, and then back on the normal clock. Not three |
| An expression nothing can read | Recorded on the row with a reason, rather than quietly becoming "never" |

## Waiting for something not to happen

The third trigger kind, and the one the other two cannot express. An event
fires when something happens and a schedule fires on a clock; neither of them
fires when something has NOT happened, and "the estimate nobody answered" is
the single most valuable automation a contractor can have, because it is money
that quietly did not arrive and leaves no record that it was supposed to.

The shapes are declared by the product rather than written by a workflow, for
the same reason a report names a dataset rather than a table:

| Shape | The question |
|---|---|
| An estimate nobody answered | Which quotes have gone quiet? |
| An invoice past its due date | Who has owed us money for a while? |
| A task nobody has taken | What has been sitting in the queue? |
| Work finished and not invoiced | What did we do and never bill for? |

Each one is measured from a column that means "entered this state", never
from `updated_at`. A customer opening a quote sets `viewed_at` and touches the
row, so dwelling on `updated_at` resets the clock every time they look at it
without deciding, which is exactly the customer worth chasing.

A sweep runs on every pass, so each record is chased ONCE, ever: the run is
keyed on the record rather than on the event, because each sweep emits a new
event with a new id and keying on that would chase the same customer every few
minutes until somebody turned the automation off.

## Waiting, mid run

"Wait three days, then chase" is what most of the automations a contractor
actually wants look like. The naive version of that step is `setTimeout`,
which does not survive a deploy, and the symptom is the quietest possible
one: the chase never happens and nothing anywhere records that it was
supposed to.

So a wait is a time written on the run. The process holds nothing, the run
shows as waiting with the time it is waiting for, and the same pass picks it
back up. A resume reads the step rows and skips what already succeeded, so a
run that sent the text and then waited does not send it again on the way
back, and it finishes on the version it started on rather than on whatever
the workflow has been edited into since.

```json
{ "kind": "wait", "config": { "days": 3 } }
{ "kind": "wait", "config": { "hours": 2, "minutes": 30 } }
{ "kind": "wait", "config": { "until": "2026-10-01T09:00:00Z" } }
```

A wait of zero, or until a time that has passed, carries straight on rather
than parking. A wait longer than a year is refused, because that is always
somebody's units rather than an instruction.

Two workers is a capacity decision rather than a duplicate-message incident.
Claiming a due schedule is a conditional update on its own due time, claiming
a parked run is the status transition from waiting to running, and in both
cases the claim and the work share one transaction, so a process that dies
mid-run rolls back the claim and the next pass tries again.

## The database role

The worker needs one privilege the request path deliberately does not have.

Finding out which organizations have unread events is a cross tenant read by
definition, and row level security is forced on every tenant table, so it
cannot be done by selecting. It goes through
`app.pending_event_organizations`, which returns organization ids and a count
and nothing else. The clock uses a second one, `app.scheduled_workflows`,
which returns ids, the cron expression and the company's timezone.

`authenticated`, the role every request runs as, is **not** granted execute on
it. A web request being able to enumerate every tenant with pending work is an
information leak even though the rows themselves stay protected.

The migrations create a `background` role for this, which is a member of
`authenticated` so the worker can drop into the ordinary tenant context for
the actual work. It discovers organizations with one privilege and then does
everything else with none.

```sql
-- Created by the migrations. Give it a password and a login to use it.
alter role background login password 'change-me';
```

```
WORKER_DATABASE_URL=postgresql://background:change-me@host:5432/opentradesos
```

In development, leaving `WORKER_DATABASE_URL` unset uses `DATABASE_URL`, which
is usually a superuser and can call anything.

## Running more than one

Safe, and useful once one is not keeping up.

The cursor is a position, not a lock. Two workers means some events are
handled twice, and that is harmless: a workflow run is keyed on
(version, event) behind a unique index, so the second attempt inserts nothing
and sends nothing. The cursor only ever moves forward, so a slower worker
finishing after a faster one cannot rewind it and hand the same events out
again.

There is no coordination to configure, and nothing breaks if one of them dies
mid-event: the events it had not reached are still unread, and the run it was
part way through is keyed so the retry resumes rather than repeats.

## Shutting it down

`SIGINT` or `SIGTERM` stops the loop between events rather than mid-event, so
a run is never abandoned half finished with a row saying it is still running.
The process then closes its connection pool and exits, which takes
milliseconds.

If your orchestrator reports that the worker had to be killed, that is a bug
worth reporting rather than something to tune the grace period around.

## What it is not

It is not a queue. The event log is already durable and already ordered, and a
queue beside it would be a second source of truth about what happened.

It does not poll for schedule triggers yet: a workflow that runs at 8am, or
one that waits two days before its next step, needs a timer this does not have.
Event triggers work; time does not.
