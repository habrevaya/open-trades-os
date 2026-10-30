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

And it tells people. A notice is one sentence about one record for one person:
a task given to you, a late task, an order waiting for your approval, an app
asking to connect, a toolbox talk you have not signed, your expense answered,
your licence running out, a deadline about to be missed, a customer asking to
change a visit, an automatic payment that failed. It shows on the bell in the app, goes to the phone
app for somebody who has it, and is texted to their own mobile when they
turned that on themselves, each kind switched per person on `/me`. Nobody is
told about a record they cannot open.

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
`task:write`: a technician claims work off the queue, ticks its checklist and marks a
task assigned to them done, and creates none.

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

Among the things that put work in the queue without anybody creating it:

- A customer asking from their link to move or cancel a visit (M05). The task
  is raised high and due before the visit, and it is answered rather than
  ticked off: the queue shows the request with "Agree" and "Say no", answering
  closes the task, and "Done" is not offered on it, because a task ticked off
  without the answer would leave the visit unmoved and the customer untold.
- A renewal notice that could not be sent (M08), so somebody tells the member
  another way before their plan renews.
- The estimate follow up's call (M07 and M29), linked to the estimate.
- A job left on hold longer than the company said it may be (M10), linked to the
  job: naming the job, the reason and the days, closed as done when the job comes
  off hold. Off until the company sets the days. It can be given a due date (so the
  late rules below act on it), be raised again every so many days while the job
  stays on hold (only once the last one is closed), and be given to whoever put the
  job on hold or a named colleague, all off until the company asks.
- A part a technician asked for from the field (M10), linked to the job: one
  task for each request, in the office queue and nobody's name, naming the job,
  the part in their words and who asked. Its page offers "Put the job on hold
  for this part", naming the purchase order, which places the hold and finishes
  the task.
- Photos or a PDF a customer sent to a job from their account (M05), linked to
  the job: one task a day for each job, in the office queue and nobody's name,
  its title saying how many files so far ("Nina Patel sent 3 files to job
  1042"). It is finished on its own, as done, when nothing the customer sent to
  the job is left unopened (opened from the job's page or through the API, or
  taken back by the customer). A file sent after that day's task was finished
  raises a new one.

### A checklist inside a task

A task can carry a checklist: given when it is created (on `/tasks`, or
`checklist` on `POST /v1/tasks`), copied from a recurring template, or added to
on the task's own page at `/tasks/{id}`. Items are ticked one at a time and
each says who ticked it. The queue shows "2 of 5 ticked" on each task. A task with a
checklist is closed from its own page, or on the phone and `/my-day`, where its items
are ticked and the reason for unticked ones is asked for before it is sent.

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

`/tasks/recurring` is the work that comes round every day, every weekday
(Monday to Friday), on the days of the week the company ticks (Monday,
Wednesday and Saturday for a crew that works those), every week on a weekday,
every other week or every so many weeks on a weekday, every month on a date
(the 31st is held to the last day of a shorter month), on the first, second,
third or fourth given weekday of every month (the first Monday), or on the last
given weekday of every month (the last Friday, whether it is the fourth or the
fifth), with who it goes to, when on the day it is due, its priority and a
checklist. The rules for which day each one is for are in core's `tasks`
module with unit tests, so the worker, the API and the screen cannot count
differently.

An every other week task is counted from its first day: the first of its
weekday on or after "Starting", and every fourteenth day after that, so
"Starting" is what says which of the two weeks is the on week, and editing it
moves the on week. Every so many weeks (two to fifty two) is counted the same
way with its own gap, so every third Wednesday starting on a Monday is that
Wednesday and every twenty first day after it. The fifth given weekday of a
month is not offered, because most months do not have one; the last one is. A
weekdays task is never raised for a Saturday or a Sunday, and a ticked days task
is never raised on a day that is not ticked; a worker that was down over a
weekend raises Friday's, as it raises the latest one of any schedule, and
nothing more. In the API the frequencies are `daily`, `weekdays`,
`chosen_weekdays` (with `daysOfWeek`, any of 0 for Sunday to 6 for Saturday,
stored once each and in order), `weekly`, `every_other_week`, `every_n_weeks`
(with `intervalWeeks`), `monthly`, `nth_weekday_of_month` (with `monthWeek`, 1
to 4) and `last_weekday_of_month`, and the ones that come round on a named day
take `weekday`. A template keeps only the settings its schedule reads, so one
changed from ticked days to monthly forgets the days. The worker raises each one
on the day in the COMPANY'S timezone, so Monday's task is not raised on Sunday
evening in Chicago, and each is paused and resumed from the same screen.

An every other week or every so many weeks task may name SEVERAL days of the week:
every third Monday and Thursday is one template, not two. On the form the days are the
same boxes as "on the days I tick" (tick two or more, or tick none and use the day of
the week box; one ticked day is just that weekday). In the API it is `daysOfWeek`
(`[1, 4]`) beside `intervalWeeks` on `every_n_weeks`, or on `every_other_week`, in place
of `weekday`. The weeks run Monday to Sunday, the first week is the one the first
occurrence falls in (the first named day on or after "Starting", so a start on a
Wednesday skips that week's Monday and takes its Thursday), and it comes round on every
named day of that week and of every gap after it, which is why editing "Starting" moves
the on week exactly as it does for one day. A schedule naming one day is counted exactly
as it always was. The service stores one day as `weekday` and several as `daysOfWeek`
and never both, changes between the two forms without keeping the other, and refuses a
day that is not a day of the week, no day at all, and two different ways of naming one
day, in plain words. It reads back as "Every 3 weeks on Monday and Thursday".

A template can be told to skip holidays ("Not on a holiday" on the form,
`skipHolidays` in the API): an occurrence on a date the company's holiday list
(`/settings/holidays`, M02) says it is closed raises nothing, and the day is
written down as dealt with, with an audit line naming the holiday, so it is not
raised the day after instead. A short day on the list is a working day and is
raised as usual. The schedule reads back with ", not on a holiday". It is
switched on and off on an existing template from the same list ("Skip
holidays" and "Raise on holidays too", `skipHolidays` on
`PATCH /v1/task-templates/{id}`), and applies from the next occurrence: a day
already skipped stays skipped.

Every row on the list has a "Change" link to `/tasks/recurring/{id}`, which shows
the same boxes as adding one with the template's own values in them: what needs
doing, more detail, how often and on which day, the due time, the starting day,
the priority, skipping holidays, who it is for and the checklist. Saving sends the
whole form to `PATCH /v1/task-templates/{id}` (`task:write`), so a box emptied is a
thing taken off (no detail, nobody in particular, no checklist), and the screen
reads the same function that adding one does, so a schedule is refused in the same
sentence either way ("A weekly task needs the day of the week it comes round on.").
The page says, above the button and again in the answer after it, that the change
applies from the next time the task comes round: the tasks it has already raised
are people's work in progress and are not rewritten, and a day missed meanwhile is
not made up. Changing the starting day of an every other week or every few weeks task
moves which week is the on week, and the note under the boxes says how the weeks are counted. A task
given to somebody who has since left is shown with "(no longer works here)" and
saving it is refused until somebody else is chosen, rather than handing it to the
queue unnoticed. Someone who can read tasks and not change them sees the list and
the page without the form. The change is audited as `task_template.updated`, with
what it replaced.

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

Each rule counts either the clock or the company's working hours. The default is the
clock, which is what a company with an on call week wants: a task due Friday at five
escalates on Saturday morning under a twelve hour rule. A rule set to count working
hours ("Count only the hours you work" on the form, `workingHours` in the API) counts
only the minutes inside the company's business hours (the weekly hours kept under
Online booking), on a day it is open, and not on a day its holiday list says it is
closed; a short day on the list counts by its own hours. The same task then escalates
on Tuesday at eleven under the same twelve hours, for a company that opens at eight and
closes at five. The rule's sentence says "working hours" and so do the task and the
email it raises ("12 working hours past due"). It is switched on and off on an existing
rule from the same screen ("Count working hours" and "Count every hour") and applies to
tasks the rule has not acted on yet. Saving a working hours rule is refused until the
company has set its business hours, because counting every hour of every day is the
opposite of what was asked for; if the hours are removed later, only holidays are left
out of the count and the escalation's note says so. The counting is core's
`workingMinutesBetween` in `holidays`, so it reads the same week and the same holiday
list as booking, the phones and the after hours rate, with unit tests. A task about a
job, or about one of its visits, reads that job's branch's own week (the company's where
the branch keeps none) and its own holidays beside the company's (M02), so a branch's
day off is not counted as working time on its work and its Saturday morning is; any
other task reads the company's week and list.

"The manager" is who the person answers to, which the same screen records
(`user:write`, because it is a fact about people), and which the person's own
page at `/people/{membershipId}` shows as "Reports to", linked to the manager's
page, with "Nobody recorded" when there is none and a note when the manager has
since left (`GET /v1/people/{membershipId}` carries it as `reportsTo`, with the
person's `userId` and the manager's, which `POST /v1/reporting-lines` is set by).
Somebody with `user:write` also sets it on that page, from a list of the people who
work there now (never the person themselves), or clears it with "Nobody recorded":
the page posts the same call as the escalation screen, so it is the same permission,
the same refusals ("Somebody cannot be their own manager", "A manager has to be
somebody who works here now", and a loop, below) and the same audit line (`membership.reports_to_set`,
with the line it replaced), and either screen shows what the other set. A manager who
has left stays in the list, marked, so saving the page does not take the line off
unnoticed. A line that would make a loop is refused in words naming the people in it:
"That would make a loop. Ana would report to Ben, Ben reports to Cy, and Cy reports to
Ana. Change one of those lines first." (a `409` from `POST /v1/reporting-lines`, and the
message on both screens). The check is in `setReportsTo`, the one function every path
posts to, and walks the whole chain above the new manager, including people who have
left, because their lines still stand; saves are taken one at a time per company so two
people saved at once cannot each look fine and together make a loop. Without `user:write`
the page shows the line and no list. With no manager recorded, an
unassigned task, nobody in the chosen role, or a named person who has left, the
owners are told and the escalation says so in words.
`GET /v1/task-escalation-rules`, `POST /v1/task-escalation-rules`,
`PATCH /v1/task-escalation-rules/{id}`, `GET /v1/tasks/{id}/escalations`,
`GET /v1/reporting-lines`, `POST /v1/reporting-lines` and `GET /v1/reporting-lines/loops`.

LOOPS ALREADY IN THE DATA. The check above stops a loop being made; it cannot see one
that was there already, from lines saved before it existed or by a path that did not
run it. The reporting lines section on `/tasks/escalation` scans the whole company for
them every time it is drawn and says so in words: "No loops." when there are none, or
"There is a loop in who answers to whom." with each loop named once, in reporting order:
"Ana Reyes reports to Ben Cole and Ben Cole reports to Ana Reyes.", "Ana reports to
Ben, Ben reports to Cy, and Cy reports to Ana.", or "Dee Lund is recorded as reporting
to themselves." The scan walks everyone on record, so a person who has since left is
still a link in the chain and is named with "(no longer works here)". Someone who only
reports INTO a loop is not in it and is not named. It ONLY READS: it never changes a
line, because which line in a loop is the wrong one is the company's to say, and the
page says that nothing was changed and what to do (change one line in each loop). The
same list is `GET /v1/reporting-lines/loops` (`user:read`, like the lines): `loops`,
each with its `people` (`userId`, `name`, `active`) in reporting order and its
`sentence`. The rule is core's `reportingLoopsInData`, with unit tests.

### Notices to the company's own people

The bell sits at the top of the menu (in the bar beside "Menu" on a phone). It
shows the newest notices for the person signed in, each a sentence, the kind,
when, and a dot while it is unread; the whole line is the link to the record
it is about. `/notices` is the whole list (the last hundred, or only the
unread), with "Mark read" and "Mark all read". Opening one goes through
`/notices/{id}`, which marks it read and goes to the record, asking again
whether this person may still open it.

What raises one, each in the same transaction as the thing it is about:

- **A task given to you**, from `/tasks`, `POST /v1/tasks`, a hand over on
  `PATCH /v1/tasks/{id}`, a recurring template, a workflow, or an escalation
  rule that hands the task on. Giving one to yourself tells nobody.
- **A late task**, to everybody an escalation rule tells, beside its task and
  its email.
- **An order waiting for your approval**, to each holder of the role the
  waiting step names, as the approval email is (M16).
- **An app asking to connect**, to everybody who could approve it (M26).
- **A toolbox talk not signed**, to a person on the sheet whose line is
  still unsigned an hour after the talk was held, once, within a week of it
  (M23). It opens `/my-day`, where they sign.
- **Your expense answered**, approved or refused with the reason (M17). It
  opens `/me/expenses`.
- **A licence or a skill running out**, when its renewal period starts (the
  card's own number of days where it was given one, else the certification
  type's, or the skill record's own) and on the day, raised by the worker once
  each, to the person who holds it (on `/me`), to the person they report to (on
  the holder's own page at `/people/{membershipId}`) when that manager may read
  the holder's record, and to each of the people the company names as keeping
  the renewals list, which is nobody until it names somebody (M24). A renewal
  recorded since stops it. It is the one kind that also comes by email.
- **A deadline about to be missed**, when a clock reaches its warning time and its
  task lands in the office queue (a contract's clock on a job, a warranty to
  register, a filing falling due). It goes to everybody who may deal with it
  (`task:write`) and may open the task, or to whoever of them is on call (see "On
  call for the office" below), and opens `/tasks/{id}`. It is raised
  beside the task, once, by the pass that raises the task, so a deadline already
  past its warning when this was built is not announced afterwards.
- **A customer asking to change a visit**, when a customer asks from their link
  to move or cancel one. It goes to everybody who may answer it
  (`visit:reschedule`) and can open the job under their own scope, or to whoever of
  them is on call, and opens the
  job at `/jobs/{id}`, where the request and its buttons are. A dispatcher, who
  holds no `task:read`, is told all the same, because the job is where it is
  answered. It says who asked, which visit, what they ask for and what they said.
  The customer taking or turning down a time the office offered is not a notice:
  it stays a task.
- **An automatic payment that failed**, when the worker charges a customer's saved
  card for a bill and it does not go through (declined at once, or the processor
  says no later). It goes to everybody who may charge a saved card
  (`payment:charge_saved`) and can open the invoice, or to whoever of them is on
  call, and opens `/invoices/{id}`.
  The second try the next day that fails is told as its own failure, so the people
  who handle it hear that it will not be tried again. A failed bank payment keeps
  the task it already raised and no notice, as before. A failed charge the office
  itself pressed is not announced: the person who pressed the button is looking at
  the answer.
- **A photo or file from a customer**, to the people on the visit a customer
  sent a photo or a PDF to from their account, or for one sent to the job, to
  the people on its visits still to come, each about their own soonest one
  (M05). Once a day for each job, however many files. It opens their day on
  `/my-day` (the visit, on the phone), or the visit's page for somebody who
  reads visits but is not on it.

NEVER ABOUT A RECORD THEY CANNOT OPEN. Before anything is written, the person
is resolved the way their own session would be, and the record is opened with
their permissions and their scope: a late task needs `task:read`, an order
`po:read`, an app request `settings:read` and `integration:write`, an expense
or a talk is their own, and a licence is their own or one of the people their
scope reaches with `user:read`. Where they cannot open it they are not told,
whatever the rule or the role says: a dispatcher preset, which holds no
`task:read`, is told about a late task by its task and email but gets no
notice. The bell asks again when it lists, so somebody whose access was
narrowed since stops seeing what they can no longer open.

WHERE EACH KIND GOES is the person's own choice, on `/me` under "What you are
told, and where": one row per kind with a box for the app, the phone app and a
text, and for a licence or skill running out a box for email. Until they change
it, every kind comes in the app and on the phone, and none by text; a licence or
skill running out also comes by email to the address they sign in with. A kind switched off in the app is kept off the bell; the notice
is still written, so the worker does not raise it again.

WHAT A NEW PERSON STARTS WITH is the company's to set, on Settings under "What new
people are told" (`GET /v1/notice-defaults` with `settings:read`,
`PATCH /v1/notice-defaults` with `settings:write`, audited as
`staff_notice_defaults.changed`). Per kind, whether a person added from then on has
it in the app, on the phone app and, for a licence or skill running out, by email.
Until a company changes a kind it starts people on the product's own (app and
phone, a licence or skill also by email). The company's choice is COPIED onto each
person as their own switches the moment they join, by a database trigger on the
membership, so the setup wizard, an invite and a row put in by hand all start a
person the same way. It seeds and never overrules: people already here keep exactly
what they have, however long ago they joined; editing the defaults changes nobody;
a person's own choice on `/me` is never replaced; and a later change to the defaults
reaches only people added after it. There is no text setting, deliberately: a text
goes to somebody's own mobile and only because they turned it on with their own
number, so the copied row always says text is off.

ON CALL FOR THE OFFICE ("On call for the office"). The three kinds the office queue raises (a deadline about
to be missed, a customer asking to change a visit, an automatic payment that failed)
tell everybody who holds the permission that answers them. A company can instead keep
an office rota on Settings, "Office on call" (`/settings/office-on-call`): a person
and the first and last company day they cover, both included, with a note. It then
ticks which of the three kinds go to whoever is on call that day, one by one; every
kind starts off, so nothing changes for a company that never opens the page. For a
ticked kind, only the people on call today who hold the permission and can open the
record are told, each where they chose on `/me`. Two people on call on one day are
both told. When nobody is on call, or nobody on call can answer that kind or open the
record, everybody who handles it is told instead, as before, so a gap in the rota is
never how a failed payment goes unheard. A person on call who was told already counts
as told, so a second look at the same thing does not spill over to everybody. The day
is the company's day when the notice is raised. A turn must be for somebody who works
here and can answer at least one of the three kinds (somebody who could never be told
would be a gap that looks covered), at most 366 days long, and not over already; the
same person for the same days again is the turn already there. A person sees their
own next turn on `/me`, under "What you are told, and where". This is not the
technicians' after hours rota for customers' calls (`/v1/on-call`, M09), which names a
technician and a branch by the minute: the people who answer the office queue mostly
have no technician record. `GET /v1/office-on-call` with `settings:read`;
`PATCH /v1/office-on-call` (which kinds), `POST /v1/office-on-call/turns` and
`DELETE /v1/office-on-call/turns/{id}` with `settings:write`, each audited
(`office_on_call.kinds_changed`, `office_on_call.turn_added`,
`office_on_call.turn_removed`). The rota is kept with `settings:write`, which an office
manager does not hold by default, deliberately: who hears about a failed payment is a
company setting like what new people are told, and the owner gives it to an office
manager by name where they want them to keep it.

BY EMAIL, only for a licence or skill running out, to the person's address on
the company's own email, through the company's email outbox, as one more delivery
beside the push and the text (`staff_notice_delivery`, channel `email`) so
"was I told, and if not why" has an answer in words: no email connected, an
address on the do-not-email list, or not sent within three days. It is queued in the
same transaction that marks it sent, so nobody is emailed twice about one notice. It
is not held for quiet hours. The person switches it off on `/me` (`email` on `POST
/v1/me/notice-settings`, refused for a kind that is never emailed).

ON THE PHONE APP, through the same push service as a technician's notices
about their day (M11), to every phone they are signed in on, without a sound
inside the company's quiet hours. Somebody not on the board has no phone
registered, so a push has nowhere to go and the page says so.

A tap on one opens what it is about: the task, on the phone's Tasks screen, for
a task notice, and the page in the phone's browser for kinds the phone has no
screen for; opening it marks it read on the bell, through the field queue as
`notice.read`, so it counts even when the tap was where there is no signal (M11).

BY TEXT, only after the person turns texts on themselves on `/me`: their own
mobile number and a ticked box beside the exact words they agree to, kept on
their consent with when and from where. This consent is theirs and separate
from customers' consent: a customer's yes for the same number turns nothing on,
and nobody in the office can turn somebody else's on. A text goes from the
company's registered number straight to its carrier, not through the inbox,
because a notice names records only its person may open. It is asked again at
the moment it goes: a STOP from that number, texts turned off, or a new number
since stop it with the reason on its row; inside quiet hours it waits until
they end rather than being lost; a text not sent within twelve hours is
skipped as old news. Turning texts off stops every text still waiting.

Every send is a row (`staff_notice_delivery`): which phone or number, whether
it went, and why not. `GET /v1/me/notices`, `POST /v1/me/notices/read`,
`GET /v1/me/notice-settings`, `POST /v1/me/notice-settings`,
`POST /v1/me/notice-texts` and `POST /v1/me/notice-digest`, all `profile:own`
and all the signed in person's own, taking no person.

A DAILY EMAIL OF WHAT IS UNREAD, only for a person who turns it on, on `/me`
under "What you are told, and where" (`POST /v1/me/notice-digest`); it is off
for everybody until then, and nobody else can turn it on for them. Once a day,
at the company's morning hour, the worker emails the address they sign in with,
through the company's own email outbox, a list of the notices on their bell they
have not read: up to twenty, each with its kind, its words and its link, then a
count of the rest, a link to `/notices` and one to switch it off. The list is
asked the way the bell asks, with the person's own permissions now, so it never
names a record they can no longer open, and leaves out a kind they keep off the
bell. Nothing is sent on a day nothing is unread. The morning hour is when the
company's quiet hours end (eight without them), the hour the company already
starts texting people, and it is not sent inside quiet hours; a worker that was
down at the hour sends it later that day, and a day it never came back on is not
sent late. It is decided once per company day (`staff_notice_digest.last_on`),
claimed in the transaction that queues the email, so two workers send one. What
happened is on `/me` in words: how many it listed, nothing unread, or why it
could not go (no email connected, an address on the do-not-email list). Turning
it on or off is audited.

HOW LONG READ NOTICES ARE KEPT is the company's, on Settings under "Read notices"
(`GET /v1/notice-keeping` with `settings:read`, `PATCH /v1/notice-keeping` with
`settings:write`, audited): a number of days from seven to ten years, or empty
to keep them for good, which is where every company starts and what always
happened. The worker then removes notices read longer ago than that, with their
sends, and ones a person keeps off their bell raised longer ago, since nobody
was going to read those. Never an unread one on the bell. A licence or skill
notice stays at least a year and eight days after it was raised, and a toolbox
talk nudge at least nine, whatever the setting says, because the notice row is
how the worker remembers it told somebody, and removing it while the card or the
talk could still raise it would tell them again. One audit line per sweep says
how many went. A longer number later does not bring back what a shorter one
removed.

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
| Technician | Reads tasks, claims one, ticks and finishes their own. Creates and dismisses none |
| Accountant | Reads and writes |

## API

| Call | Needs |
|---|---|
| `GET /v1/tasks` | `task:read` |
| `GET /v1/tasks/counts` | `task:read` |
| `POST /v1/tasks` | `task:write` |
| `PATCH /v1/tasks/{id}` | `task:write` |
| `POST /v1/tasks/{id}/claim` | `task:read` |
| `POST /v1/tasks/{id}/close` | `task:read` to mark your own task done; `task:write` to dismiss one or close anybody else's |
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
| `GET /v1/reporting-lines/loops` | `user:read` |
| `GET /v1/me/notices` | `profile:own` |
| `POST /v1/me/notices/read` | `profile:own` |
| `GET /v1/me/notice-settings` | `profile:own` |
| `POST /v1/me/notice-settings` | `profile:own` |
| `POST /v1/me/notice-texts` | `profile:own` |
| `POST /v1/me/notice-digest` | `profile:own` |
| `GET /v1/notice-keeping` | `settings:read` |
| `PATCH /v1/notice-keeping` | `settings:write` |
| `GET /v1/notice-defaults` | `settings:read` |
| `PATCH /v1/notice-defaults` | `settings:write` |
| `GET /v1/office-on-call` | `settings:read` |
| `PATCH /v1/office-on-call` | `settings:write` |
| `POST /v1/office-on-call/turns` | `settings:write` |
| `DELETE /v1/office-on-call/turns/{id}` | `settings:write` |

Claiming, ticking your own task's checklist and marking your own task done need only
`task:read`, and they are the writes in the module guarded by a read. Each is acting
on your own work, which is the same class of act as clocking yourself in. Claiming is
conditional, so two people opening the queue at the same moment cannot both take it
and do the work twice.

## Common questions

**Why is a task not just a job with no customer?** Because a job carries a property,
a price, visits and a ledger trail, and none of that is true of ringing somebody
back. Modelling it as a job would put the office's to-do list into the revenue
reports.

**Who gets a task a workflow raised?** Whoever the definition says, which can be a
person or a queue. A task with nobody on it is still visible, because the queue is
read by the office rather than only by an assignee.

**Who is told about a late task?** Whoever the rule names, by a task in their
queue, an email when the company sends email, and a notice wherever they
switched late tasks on, if they can open tasks at all.

**Can the office turn texts on for somebody?** No. Only the person, on their
own page, with their own number. The office's part is having a registered
number that can send texts.

**What raises an obligation today?** Several things, listed at the end of "What is not
built": a visit completed after it was cancelled, a contract's clocks on a job, an
invoice the contract does not price, compliance documents and filings, and a serialised
unit installed on a job whose maker wants it registered. The primitive is built for more
than that.

## What is not built

A technician finishes their own task and does not dismiss it. Marking a task assigned
to you done needs only `task:read`, the same class of act as claiming it and ticking
its checklist, and `/tasks` and the task's own page offer "Done" to its assignee.
Dismissing, "we decided not to", is a judgement about whether the work was worth
raising, so it stays with `task:write`, as does closing anybody else's task. The rule
is in `tasks.close` rather than a wider grant, so nothing else a technician could do
changed. On the phone and on `/my-day` a technician sees their own tasks and the ones
nobody has taken, takes one, ticks its checklist and finishes their own, through the
field queue (M11), so it works with no signal and the second of two people taking the
same task is told somebody else has it. Ticking is the queue operation `task.tick`, an
item set to ticked or not rather than flipped, kept per item by the time the person did
it; the later of two ticks of one item wins when they arrive out of order, ticks of two
items never replace each other, and a task finished meanwhile refuses a tick in words.
Finishing with items unticked asks for the reason on the phone before it is sent, in
the words the office's page uses, and keeps it apart from the outcome
(`overrideReason` on `task.close`); the server asks again. The phone gets a task's items
with the day and does not show them for a task nobody has taken, because ticking is for
the person it is assigned to. Adding or removing an item is the office's, on the task's
own page. The server stamps a tick with when it was done on the phone, so "ticked at"
may be earlier than when it arrived.

Escalation counts the clock unless a rule says working hours. A working hours rule reads
the company's week and holiday list, not any one person's shift or leave, so a task
sitting with somebody on a week off still counts the company's open hours against it. A rule edited after it has acted does not act
again on the tasks it already acted on. The people a rule tells get a task, an
email, and a notice on the bell, the phone app or a text as each of them chose;
somebody who cannot open tasks gets the task and the email and no notice.

Notices are raised by the ten things listed under "Notices to the company's
own people" and nothing else: the rest of what the queue holds reaches people as
tasks, as before, and so does a customer taking or turning down a time the office
offered for their visit, and a failed bank payment. A deadline's notice is raised
when its task is, so a deadline that was already past its warning time before the
notice existed is not announced after the fact. These three tell everybody who
holds the permission that answers them and may open the record, unless the company
sends the kind to its office rota, and then whoever is on call that day. The rota is
whole company days, not hours: a turn from six in the evening to eight in the morning
is two days, and there is no rule for the night apart from the day. It is one rota for
the company, not one per branch, and it reads the person's permissions and scope, not
which branch the record is in. Nobody is told that it is their turn when it starts;
they see it on `/me`. A person on leave who is on the rota is still on call, because
the rota does not read time off. A text goes from whichever registered number the company
sends customer texts from, in the company's quiet hours (not the person's own), and a reply to it
lands in the inbox like any text from a number nobody recognises; a STOP is
honoured. There is no notice by email one at a time beyond a licence or skill running
out and the emails the escalation, the approval and the app request already
send; the daily digest is the other way to get them by email, and it lists, it does
not send each. The digest's hour is the end of the company's quiet hours, not a
setting of its own or the person's, deliberately; it is plain text, and it goes
only to the address the person signs in with. There is no per company
setting for which kinds exist, and the company's defaults for a new person are
copied once and never applied to people already here, never include a text, and
do not include the daily digest, which only the person can turn on. A licence notice goes to
the holder, to whoever they report to and to the people named to keep the
renewals list, not to everybody who can read it, deliberately; a talk is nudged once, an hour after it was held,
and not again. Read notices are kept for good unless the company chooses a number
of days on Settings; there is no per person choice, and nothing archives a
removed notice anywhere: it is gone. A notice whose record had its date moved
after the notice was removed can be raised again for the new date, which is the
right notice to get.

Recurring tasks have no fifth given weekday of the month (most months have
none; the last one is offered instead) and no gap of more than fifty two weeks.
Several weekdays are for the tasks counted in weeks and for "the days I tick";
the first, second, third, fourth or last given weekday of a month is still one
weekday (the first Monday and Thursday is two templates), because "the first
Monday and the third Thursday" has no one honest answer for what a company with
both meant. A template set to skip holidays skips the occurrence
on a closed holiday rather than moving it to the next working day,
deliberately, and an every other week task's off week stays the off week
whatever the holidays. A change to a template applies to the tasks it raises
from then on, and a missed occurrence is not backfilled, deliberately. The
recurring screen adds templates, pauses and resumes them, switches skipping
holidays and changes an existing one's title, schedule, person and checklist on its own
page, with the change applying from the next occurrence.

Reporting lines are read by escalation and by the licence notice, and shown on the
person's own page, where they can also be set; nothing else in the product reads them.
They are one manager per person, with no limit on how long a chain is. A new line that
would make a loop is refused, and a loop already in the data from before the check is
found and named in words on `/tasks/escalation`, but never repaired: which line is wrong
is the company's to say, and escalation looks one step up and no further, so a loop does
no harm while it waits. Nothing runs the scan on a schedule or tells anybody: it is what
the page shows when somebody opens it.

Obligations are raised by work finished on a cancelled visit, by a contract's
clocks on a job (respond by, on site by, finished by, invoice by and claim by,
M31), by an invoice carrying an item the customer's rate card does not price or
going over a contract's not to exceed amount, by compliance documents running out and filings falling due
(M23), and by a serialised unit installed on a job whose price book item says its maker
wants it registered within so many days (`warranty.register_by`, M32). That last one is
kept on the unit rather than the job, and is closed by recording the registration on the
unit with `equipment:write`, not the task permissions an obligation is normally closed
with. A unit put on the register by hand, or an item not tracked by serial number, raises
no registration deadline.
