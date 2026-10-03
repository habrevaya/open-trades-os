---
title: People and Certifications
module: M24
domain: Company
phase: 7
status: partial
---

# People and Certifications

> Module M24. Domain: Company. Ships in phase 7.

## What it does

Who may do what, and the proof. The roster, and a register of what each person
holds, until when, and whether anybody has actually looked at the card.

## The problem

The crew service already refuses a crew missing a skill the work needs, by
comparing two lists of opaque strings. That refusal is the only qualification check
in the whole product and it can say exactly one thing: this list does not contain
that string. It cannot say the person holding the certification left in March, or
that the licence ran out three weeks ago, because nothing in the schema knew that a
skill was a certification, that a certification belongs to a named person, or that
it has a date on it.

## Key concepts

**Three permissions, and they are different questions.** `user:read` is the roster:
who works here, what their role is, whether they are still active, and the office
manager preset holds it because an office manager is the person who maintains the
list of people. `compliance:read` and `compliance:write` are the certifications, and
the office manager preset holds neither. A licence number, an expiry and who
verified it are compliance records about a named person; a roster is a staff list.

**No new permission is invented.** The catalogue is the whole of the authorization
model, and a string that is not in it cannot be granted to anybody, so a guard
naming one is a guard nobody can satisfy.

**A type that expires and has no way to know when is refused.** Expiring is the
default because almost every trade certification does, and a type declared that way
with neither a default validity nor an expiry supplied at recording time produces
holdings with a null expiry, which this module reads as never expiring. That is the
dangerous direction: every lapsed card in the company would read as current forever,
on a screen built to tell somebody when to renew.

**Whether a type expires is not editable.** Flipping it on a type that already has
holdings reinterprets every one of them: the rows whose expiry is null stop meaning
"this does not run out" and start meaning "nobody recorded when this ran out", and a
dispatch check that cleared this morning refuses this afternoon with no row having
changed. A company that got it wrong declares the right type and retires the old
one, which leaves the old holdings readable and attached to the thing they were
recorded under. Retiring is a flag rather than a delete, so "was Dana certified in
March" still has an answer.

**Renewing is recording it again, and the old row stays.** "Was this person
certified on the day they did that work" is the question the row exists to answer,
and an expiry overwritten every two years cannot answer it. The current holding is
the one with the furthest expiry.

**Verifying is a separate call from recording.** Recording is usually an office
manager typing from an email; verifying is somebody holding the licence in their
hand. A company being audited is asked which of the two happened, and one timestamp
cannot tell them apart.

**Suspended and revoked are separate from expiry.** A suspended licence may come
back and a revoked one will not, and neither is a lapse: the person did not forget to
renew, an authority took it off them. The standing check refuses all three and says
which, because "renew this" and "this person cannot do this work any more" are
different instructions to whoever is reading the board.

**The day it expires is still a day it is valid.** A licence that expires on the
fourteenth is good on the fourteenth and not on the fifteenth, which is how every
authority this was checked against words it.

**Expiry is compared as calendar date strings, which is correct here and only
here.** Both sides are ISO dates in the same format, so string ordering is date
ordering, and it avoids turning a calendar date into an instant, which is how an
expiry moves a day for half the country twice a year.

**The renewal window is per certification type, not one number for the company.** A
licence whose renewal takes a day of paperwork and one that takes six weeks of
continuing education do not want the same warning.

**Already expired rows are included and flagged.** A renewal list that drops a
certification the moment it lapses is a list that is empty exactly when somebody
needed to look at it. The same reasoning applies to the holdings list, which includes
the lapsed and the revoked: a list of only what is current would silently lose the
row a compliance officer is looking for.

**Assignment asks this module, one person at a time.** Sending a technician on
their own is checked against the job type's required skills by asking the
skill standing for THAT person, not for a group, because Dana's licence does not
qualify Sam to go alone. Covered clears the skill, even when the person's
profile forgot it; lapsed and absent refuse it with this module's own sentence,
even when the profile lists it, because the register knows the date and the
profile is a string somebody typed.

**For a skill no certification grants, the person's recorded skills decide,
once the company uses them for that skill.** A technician's skills are recorded
on the technicians screen. A skill nobody in the company is recorded with
cannot be checked and does not refuse: every trade pack declares required
skills on every job type and nothing recorded a technician's skills before this
check, so refusing on an empty list would have stopped every assignment on the
day it shipped. Recording the first person who does it is what starts refusing
everybody who is not recorded with it.

**These tables hold the person and the qualification and never the bytes.** No file
column, no storage key, no document id. A certificate attaches through the ordinary
attachment path, which needs nothing from this module.

## Using it

### The roster

`GET /v1/people` is who works here, with `user:read`.
`POST /v1/memberships/{membershipId}/active` turns somebody off, with `user:write`.

### Declare what the company recognises

`POST /v1/certification-types` declares a type with its default validity and its
renewal notice period, and `PATCH /v1/certification-types/{id}` edits or retires
one. `GET /v1/certification-types` lists them.

### Record what people hold

`POST /v1/certifications` records a holding,
`POST /v1/certifications/{id}/verify` records that somebody saw the card, and
`POST /v1/certifications/{id}/status` suspends, revokes or reinstates.
`GET /v1/certifications` is the register and
`GET /v1/certifications/expiring` is what is about to run out, with the already
expired included and flagged. `/certifications` is the screen.

### Ask whether people can do the work

`POST /v1/people/skill-standing` answers it for a set of people and a set of
required skills, and says why not when the answer is no. The crew check calls
it for the crew, and assignment calls it for each technician sent on their own
(`POST /v1/visits/{id}/assign`, booking with a technician, and the dispatch
suggestions at `GET /v1/dispatch/suggestions`).

### Record what each technician does

`/schedule/technicians` records a technician's skills, beside any
certification, with `PATCH /v1/technicians/{id}`, which needs `user:write`,
along with their own working hours and whether their location is shared while
they work (see M09 and M11). `POST /v1/technicians/{id}/photo` sets or clears
the photograph a customer sees beside their first name on a tracking link.
`GET /v1/technicians` lists them.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything |
| Office manager | The roster. Not the certifications, under the presets as they stand |
| Dispatcher, CSR, technician | Neither |
| Accountant | Neither |

## API

| Call | Needs |
|---|---|
| `GET /v1/people` | `user:read` |
| `GET /v1/certification-types` | `compliance:read` |
| `POST /v1/certification-types` | `compliance:write` |
| `GET /v1/certifications` | `compliance:read` |
| `POST /v1/certifications` | `compliance:write` |
| `POST /v1/certifications/{id}/verify` | `compliance:write` |
| `POST /v1/certifications/{id}/status` | `compliance:write` |
| `GET /v1/certifications/expiring` | `compliance:read` |
| `POST /v1/people/skill-standing` | `compliance:read` |
| `GET /v1/technicians` | `visit:read` |
| `PATCH /v1/technicians/{id}` | `user:write` |
| `POST /v1/technicians/{id}/photo` | `user:write` |

## Common questions

**Why is a certificate scan not stored on the certification row?** Because the
bytes belong to the attachment path, which already handles any entity, and a second
place to put a file is a second reference count to get wrong.

**Can a technician see their own certifications?** Not under the presets: reading
the register needs `compliance:read`, which the technician preset does not hold. A
company that wants that grants it.

**Does a lapsed licence stop dispatch?** Yes. A lapsed or revoked certification
for a skill the work needs refuses the assignment with the person's name and the
date it ran out, for a crew and for a technician sent alone. Somebody holding
`visit:assign_unqualified` can send them anyway with a reason, which the audit
log keeps beside the refusal.

## What is not built

A job's skill requirement comes only from its job type, so one unusual job cannot
ask for a skill of its own. Recorded skills on a technician are strings with no
date and no evidence; only a certification can say until when. Continuing education hours are not tracked, only the resulting certification. There
is no onboarding checklist, no emergency contact and no employment record: this is a
qualification register beside a roster, not an HR system.
