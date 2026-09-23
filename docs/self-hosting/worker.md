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

## The database role

The worker needs one privilege the request path deliberately does not have.

Finding out which organizations have unread events is a cross tenant read by
definition, and row level security is forced on every tenant table, so it
cannot be done by selecting. It goes through
`app.pending_event_organizations`, which returns organization ids and a count
and nothing else.

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
