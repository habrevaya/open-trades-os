---
title: Documents, Compliance and Safety
module: M23
domain: Company
phase: 7
status: partial
---

# Documents, Compliance and Safety

> Module M23. Domain: Company. Ships in phase 7.

## What it does

Holds the documents a company has to keep current, the filings it owes an
authority, and the published figures its work depends on. It tells somebody what
has expired and what is about to, and it never tells them they are compliant.

## The problem

Three tables were in the first compliance migration with comments describing a
working feature, and only one of them was ever written by anything.
`document:write` was in the permission catalogue, on every office role, and
asserted nowhere, which means an owner who withheld it withheld nothing.

## Key concepts

**This module must never tell a contractor they are compliant, and the reason is
not caution.** The sentence is unsupportable by anything in this database.

"You are compliant" is a claim about a set: that the documents, filings and figures
a business is required to hold are all present and all current. The software holds
the numerator, which is the rows somebody put here. It does not hold the
denominator and cannot: which documents a given business must hold depends on the
trade, the jurisdiction, the licence classes it works under, the contracts it has
signed, what its insurer requires, and what all of those said this year rather than
last.

A green tick assembled from an unknown denominator is not an optimistic summary, it
is an assertion about law made by a system with no access to the facts the
assertion depends on. And it is the single most dangerous artefact this module could
produce, because that screenshot goes to a general contractor, to an insurer, into a
bid package, and everyone downstream believes it.

**So every read returns facts about rows, each of which the code can defend.** This
document expired on this date, that many days ago. This document expires on this
date and the operator said it needs this many days' notice. This submission was
acknowledged with this reference. This submission was rejected, and here is what the
authority said. This figure's published window ended and no later one exists.

**There is no rollup, no score and no boolean.** The summary returns counts rather
than a verdict, and the counts are statements about the register: "four documents on
file have expired" is true of the rows. "You have no expired documents" would be
true of the rows too, and it is deliberately not phrased as "you are covered",
because a register with nothing in it produces the same zero.

**Everywhere this looks like a compliance judgement, it is holding the operator to
something they declared.** Whether a document is required for work is their flag on
their document. The notice period is their estimate of their own renewal lead time.
A submission's due date is a date they supplied rather than one computed from a
statute. The posture is copied from the call recording policy, which holds a claim
the operator made and not a statement of law: the software's job is to hold them to
it consistently and to refuse to record when their own declaration does not cover
the call.

**A renewal deadline is an obligation, not a second queue.** The obligation table
exists so that "what is about to breach" is one question across SLA clocks,
acknowledgements and now expiries. A second queue on a compliance screen is how a
licence lapses in a product that knew the date.

**The bytes are a stored file pointed at by an attachment.** This module writes no
storage key of its own, which keeps the reference count honest.

**The submission programme is the trade pack's own list and is not copied into a
table.** Two representations of one programme is a defect this codebase has already
produced twice. A declared kind takes its authority, jurisdiction and route from the
pack, and an input that would state them a second time is refused.

**A person's own credential is not here.** M24 holds what an individual holds, and
the renewal lead time belongs on the certification type rather than on a scan of a
card. A technician's licence recorded in both places is two expiry dates for one
credential, and the first time they disagree nothing can say which is right. What
this register holds is a document the company holds: its contractor licence, its
liability cover, a permit on a job, a safety data sheet.

## Using it

### The register

`GET /v1/compliance/documents` is what is on file and when each runs out.
`GET /v1/compliance/documents/blocking` is the lapsed ones the operator marked as
needed for work, and `GET /v1/compliance/documents/summary` is the counts.
`/compliance` is the screen.

### Keep it current

`POST /v1/compliance/documents` registers one,
`POST /v1/compliance/documents/{id}/renew` renews it, and
`POST /v1/compliance/documents/{id}/withdraw` takes one out of the register.

### Filings

`GET /v1/compliance/submissions/declared` is what the trade pack says this trade
owes and to whom. `POST /v1/compliance/submissions` opens one,
`POST /v1/compliance/submissions/{id}/state` advances it, and
`POST /v1/compliance/submissions/{id}/resubmit` sends it again after a rejection.
`GET /v1/compliance/submissions` is the history.

### Published figures

`GET /v1/compliance/constants` reads a figure for a date,
`POST /v1/compliance/constants` publishes one with its window, and
`GET /v1/compliance/constants/stale` is the ones whose window has ended with no
later one.

### Toolbox talks

`/compliance/safety` lists every talk with who signed; `POST /v1/safety/meetings`
records one with its topic, time, place, who led it and who was there, and
`/compliance/safety/{id}` is its sign in sheet. Each of the company's own people
signs from My day (`/my-day`), drawing a signature with a finger that is kept as a
stored file: `GET /v1/safety/my-meetings` is their own lines and
`POST /v1/safety/meetings/{id}/sign` signs, for the person signed in and nobody
else, refused before the talk was held and after the sheet closed. Somebody without
an account (a supplier's rep, a subcontractor) is marked signed from the paper sheet
with `POST /v1/safety/meetings/{id}/attendees/{attendeeId}/signed`, which says so on
the line, and the paper is photographed onto the talk.
`POST /v1/safety/meetings/{id}/close` closes the sheet; nobody is added or signs
after.

**The company's own topics.** `/compliance/safety/topics` is a library of talk
topics, each a title and the words to cover, written by the company
(`GET /v1/safety/topics`, `POST /v1/safety/topics`, `PATCH /v1/safety/topics/{id}`).
It starts empty: this product writes no safety content, because what a crew is
told is the company's to decide and answer for. A talk recorded on
`/compliance/safety` can be taken from the library (`topicId`), and keeps a copy
of the topic's words, so editing a topic later does not change a sheet already
signed. A topic is retired, not deleted.

**Talks on a schedule.** `/compliance/safety/schedules` puts a topic on a schedule
for one crew or one person (`GET /v1/safety/schedules`, `POST /v1/safety/schedules`,
`POST /v1/safety/schedules/{id}/active` to pause and resume), on the same
schedules a recurring task uses (M34): every day, every weekday, a weekday every
week or every other week, a date every month, or the last given weekday of the
month, at a time of day. The worker raises the talk on its day in the company's
zone, with the crew's members as they are that day on the sheet, once whatever it
does (a unique index on the schedule and the day), and only the latest occurrence
after it was down. A paused schedule, or one whose topic is retired, raises
nothing.

**Signed on the phone app.** The talks on a technician's own sheet lines come with
their day on the phone, and "Toolbox talks to sign" opens them: what was covered,
then a pad to draw a signature on. It goes through the field queue like
everything else the phone does, so it works with no signal: the drawn signature
is kept on the phone and sent as an upload for the talk, then the `safety.sign`
operation names it. The line is found from the phone's own technician, and a
sheet the office closed while the phone was offline, a talk not held yet, or a
person not on the sheet is refused in the same words `/my-day` uses, and the
signature is then attached to nothing.

**Who has not signed.** `/compliance/safety` lists, first, every name not signed
on a talk already held whose sheet is still open, oldest talk first
(`GET /v1/safety/unsigned`); a name from the paper sheet says so. A closed sheet
is finished, whoever signed it.

### Incident reports

`POST /v1/safety/incidents`, or `/compliance/incidents/new` from a phone: what kind of
thing (an injury, a near miss, damage, a vehicle, a spill, something else), when,
where, what happened in the reporter's own words, what was done straight away, who
was there and how, and a photograph. An injury report must say who was hurt. The
office is told by an urgent or high task in its queue, raised in the same
transaction. `/compliance/incidents` is the register, or a reporter's own reports
for somebody who cannot read the register, and `/compliance/incidents/{id}` is one.
Follow up actions are tasks tied to the report
(`POST /v1/safety/incidents/{id}/follow-ups`), and
`POST /v1/safety/incidents/{id}/close` closes it with what was learned, refused
while any follow up is open.

### Keeping records and letting them go

`/compliance/retention` reads each retention rule back as a sentence and shows what
a purge would remove under it today, from `GET /v1/compliance/retention/preview`,
which uses the same function as the purge. Every seeded rule arrives with purging
off, and so does a rule the company writes itself on the same screen ("Write a
rule", `POST /v1/compliance/retention/rules`): a name, the kind of record, a kind
within it when only some are meant, the months, when they are counted from, and
why. Only a kind of record something here removes can have a rule written about
it, and when the time starts is fixed once it is written. Turning it on (`PATCH /v1/compliance/retention/rules/{id}`) lets the worker's
daily pass remove what the preview lists; `POST /v1/compliance/retention/purges`
runs a pass now and `GET /v1/compliance/retention/purges` lists them, with any
record that could not be removed and why.

A record is removed only when four things all say yes: the rule's purging is on,
its clock has run out, no other active rule over the same record keeps it longer or
has purging off, and nobody has put a hold on it. A clock that cannot be worked out
(a job not finished, a report not prepared) keeps the record. A hold
(`POST /v1/compliance/retention/holds`, released with
`POST /v1/compliance/retention/holds/{id}/release`) keeps one record whatever its
age, for a claim or a dispute, and the call recordings sweep honours it too. A
hold is placed and lifted on the record's own page as well as from the preview:
an incident report (`/compliance/incidents/{id}`), a toolbox talk
(`/compliance/safety/{id}`), a job's photographs (`/jobs/{id}`, under Photos) and
a call's recording (`/marketing/calls/{id}`), each saying whether it is held, why
and since when. `GET /v1/compliance/retention/holds` takes a record's type and id
for that. Every
record removed leaves an audit line naming the rule, the clock and the day it became
due. A removed record's photographs go from Postgres at once, and from the
deployment's bucket, when files are kept in one, on the worker's next sweep.

The purge acts on incident reports, toolbox talks, service reports and inspections,
with their photographs and signatures, and on two kinds added since:

| Kind | What goes | What stays | Kept whatever the clock says |
|---|---|---|---|
| A job's photographs (`photo`, held by the job's id) | Every photograph on the job and on its visits, and their files | The job, its visits, its invoices, its reports, and every signature on a visit (what a customer signed an estimate or an invoice with) | While the job is not finished, and while an invoice on it is still owed |
| Lead form submissions (`form_submission`) | What was sent on the form, and any file with it | The customer, the job and the marketing touch it led to | While a booking draft made from it is waiting for the office |

A rule naming a kind matches by the incident's kind, the code of a service report's
or a job's job type, the trade pack's code for an inspection's programme, or a lead
form's name in its embed code; the screen says which. A file goes through the file
store: from Postgres at once, and from the deployment's bucket on the worker's next
sweep. A photograph an invoice or an estimate also shows is a second attachment
pointing at the same stored file, so the file stays until nothing points at it, and
nothing in the ledger or on an invoice is ever removed. A rule about anything else
is shown as one this product cannot act on.

### Attachments

`POST /v1/attachments` uploads one against a record and
`GET /v1/attachments` lists them. These are the document permissions rather than
the compliance ones, because an attachment is a file on a record.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything |
| Office manager | Reads documents. Writing them is granted, not inherited |
| Dispatcher, CSR, technician | Reads documents |
| Accountant | Neither |

Two permission pairs, and they are different questions. `document:read` and
`document:write` are the register of files. `compliance:read` and
`compliance:write` are the filings, the figures, the retention rules and the purge,
and, in M24, the certifications.

Safety records are their own three: `safety:read` is the register of talks and
incidents, `safety:write` runs talks and follows reports up (office managers and
crew leads hold both), and `safety:report` reports an incident, held by everybody
on the office, dispatch and field presets. A technician signs their own line on a
talk with `field:sync`.

## API

| Call | Needs |
|---|---|
| `GET /v1/compliance/documents` | `document:read` |
| `POST /v1/compliance/documents` | `document:write` |
| `GET /v1/compliance/documents/blocking` | `document:read` |
| `GET /v1/compliance/submissions` | `compliance:read` |
| `POST /v1/compliance/submissions` | `compliance:write` |
| `GET /v1/compliance/constants` | `compliance:read` |
| `POST /v1/attachments` | `document:write` |
| `GET /v1/safety/meetings` | `safety:read` |
| `POST /v1/safety/meetings` | `safety:write` |
| `POST /v1/safety/meetings/{id}/sign` | `field:sync`, for your own line |
| `GET /v1/safety/topics`, `GET /v1/safety/schedules`, `GET /v1/safety/unsigned` | `safety:read` |
| `POST /v1/safety/topics`, `PATCH /v1/safety/topics/{id}`, `POST /v1/safety/schedules` | `safety:write` |
| `POST /v1/safety/incidents` | `safety:report` |
| `GET /v1/safety/incidents` | `safety:report`; the register needs `safety:read` |
| `POST /v1/safety/incidents/{id}/follow-ups` | `safety:write` |
| `GET /v1/compliance/retention/preview` | `compliance:read` |
| `POST /v1/compliance/retention/rules` | `compliance:write` |
| `PATCH /v1/compliance/retention/rules/{id}` | `compliance:write` |
| `POST /v1/compliance/retention/holds` | `compliance:write` |
| `POST /v1/compliance/retention/purges` | `compliance:write` |

## Common questions

**Why is there no compliance score?** Because the denominator is unknowable from
this database, and a number assembled from an unknown denominator ends up in a bid
package.

**What makes a document block work?** The operator's own flag on it. Nothing in the
product decides that a licence is required.

**Where do retention rules come from?** The trade pack declares them, with the
clock start stated explicitly, because retention almost never runs from when the row
was created. They say what the pack was written to, not what your state requires,
which is why every one arrives with purging off.

**Does this tell me whether an incident must be reported?** No. That depends on the
jurisdiction, the injury and what a doctor did, none of which this database holds.

## What is not built

The purge acts on six kinds of record; rules about any other kind are kept on
file and act on nothing, and a new one cannot be written about them. The others
are left alone because removing them is not safe or not complete: a timesheet is
what somebody was paid from, an agreement, a contract and a rate card are what an
invoice was priced from, a disposal (scale) ticket is what a haul's weight was
billed from, and equipment is what a warranty and a service history point at, so
removing any of them would leave the ledger or an invoice describing something
that is gone; a key custody log, an application record and an occupant notice are
not records this product holds as their own kind. Removing a service report or an inspection removes that record and its
photographs, not the job or the address it was about, and removing a job's
photographs leaves the job. A rule's clock start cannot be changed once written,
only its period and whether it purges. A service report, an inspection and a lead
form submission have no page of their own in the office screens, so they are held
from the preview or by kind and id there.

Incident reports are not sent to anybody: no authority form (an OSHA 300 log, for
one) is produced, and nothing decides whether an incident is reportable. The talk
library holds only what the company writes; no topic is shipped, deliberately. A
scheduled talk is for one crew or one person, not for a role or the whole company,
and is not skipped for a holiday. A topic is not editable on the screen once
written, only retired and put back (the API changes its words), and a schedule is
paused rather than changed: a different topic, crew or time is a new schedule.
The phone app signs a talk; it does not record one, add people to one or close
one, which stay with the office. A signature refused on the phone is told to the
technician as a problem on their day; the talk is not offered for signing again
until the office reopens it as a new talk. Nobody is reminded to sign by text or
push: the unsigned list is the office's to chase. A submission is
tracked and not transmitted, because there is no per authority formatter, and the
trade pack is explicit that a submission seed describes what the software must
produce and to whom, never what the business is legally required to do.
