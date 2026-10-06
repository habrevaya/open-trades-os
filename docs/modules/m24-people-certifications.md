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

### Onboarding

`/people/onboarding` keeps a checklist per role: documents to collect,
training to give, equipment to hand over (`POST /v1/onboarding-checklist`).
`POST /v1/people/{membershipId}/onboarding` copies the checklist for the
person's role onto them, once per line, so running it again after the
checklist grows adds only the new lines and editing the checklist never
rewrites what somebody already part way through was asked. Each line is
ticked with who and when, and a note of what was collected or handed over
(`POST /v1/onboarding-lines/{id}`). A person is onboarded when every required
line is done, not when a percentage gets close.

### Documents people sign themselves

`/people/documents` holds the words the company asks its own people to sign:
the handbook, the drug and alcohol policy, the vehicle use agreement
(`POST /v1/staff-documents`, `GET /v1/staff-documents`). The words cannot be
edited afterwards, because a signature is worth what the record of what was
signed is worth: a new version is a new document, and retiring the old one
(`POST /v1/staff-documents/{id}/retire`) stops anybody new being asked and
keeps every signature it has. People are asked from the document's page or
their own (`POST /v1/staff-documents/{id}/requests`), and asking twice asks
once. A document line on a role's onboarding checklist can be one the person
signs: starting their onboarding asks them, and their signature ticks the
line. `GET /v1/staff-documents/{id}` says who signed, when, and how.

Each person signs from their own record, by typing their name or drawing it.
The signature is kept as every signature in the product is, a
`document_signature` with their name and email, the moment, the address and
browser it came from, and a hash of the exact words they were shown; a drawing
is kept as a picture beside it.

**A signed document prints as a PDF.** On the document's page
(`/people/documents/{id}`) each signature has "Print as PDF", as does the line
for the document on the person's own page (`/people/{membershipId}`), and
whoever signed prints their own copy from `/me`. The office's copy is
`/people/documents/{id}/signed/{requestId}/pdf` and needs `user:read`, the
permission that reads who signed; a person's own is `/me/documents/{requestId}/pdf`
and needs `profile:own`, and a request that is somebody else's is not found. The
page says, in this order: the document's title, who signed, their email, when (in
the company's own clock and zone), how (typed their name or drew it), the address
and browser the signature came from when the screen recorded them, the fingerprint
of the words the signature carries, the words exactly as they were signed, and the
signature: the name in bold when typed, the drawn picture when drawn. A drawing a
PDF cannot carry is said in a line rather than dropped. It is set in the bundled
Noto Sans like every other PDF here. A document nobody has signed yet is refused
in words, because the words alone are the document and not the record of anybody
having signed it. The PDF has no `/v1` route, as the invoice's has none.

### A person's own record

`/me` is the record of whoever is signed in, for everybody, on a phone first
(`GET /v1/me`): the documents waiting for their signature, their onboarding,
who to ring if they are hurt, the facts of their employment, and for somebody
who goes out to jobs their certifications with when each runs out and the
continuing education toward each renewal. They do three things to it
themselves: sign what they were asked to sign
(`POST /v1/me/documents/{requestId}/sign`), tick their own onboarding lines
and untick the ones they ticked (`POST /v1/me/onboarding-lines/{id}`), and keep
the people to ring (`POST /v1/me/emergency-contacts`,
`POST /v1/me/emergency-contacts/{id}/remove`). Their pay is on `/me/pay` and
their time off on `/me/time-off` (M17).

None of these takes a person: each is the signed in person's own membership,
from the session, so a line, a contact or a document of anybody else's is not
found. Reading anybody else's record is still `user:read`. All of it is
`profile:own`, which every preset holds.

### Who to ring, and the facts of their employment

`POST /v1/people/{membershipId}/emergency-contacts` keeps who to ring, in the
order to ring them, each with a number. `PUT /v1/people/{membershipId}/employment`
keeps the start and end date, the employment type, how they are paid (hourly,
salary, piece rate, commission only) and the id payroll knows them by. Never
what they are paid: that is payroll's, behind `payroll:read`. All of it is the
roster's, `user:read` to read and `user:write` to change, and it is on
`/people`, where somebody with nobody on file to ring is said in words.

A person's own page, `/people/{membershipId}`, also says who they report to
("Reports to", linked to the manager's page, or "Nobody recorded"), and
`GET /v1/people/{membershipId}` carries it as `reportsTo`. The line is the one the
escalation screen sets (M34) and nothing here changes it; the page links there for
somebody who may.

### Skills with dates and evidence

`POST /v1/technicians/{technicianId}/skills` records a skill with since when
and what showed it (who signed it off, the course, the test), and puts it on
the list the assignment check reads. `POST /v1/technician-skills/{id}/end`
takes it off with the day and the reason and keeps the record, so "could Sam
braze in March" still has an answer. Evidence is required. A skill on the
list with no record says so on the person's page.

### Continuing education

`POST /v1/technicians/{technicianId}/continuing-education` logs hours of a
course toward a certification type, and a type can say how many hours a
renewal needs. `GET /v1/technicians/{technicianId}/continuing-education`
counts the hours since the current holding was issued against that, so the
hours behind the last renewal do not count twice. It is a compliance record,
`compliance:read` and `compliance:write`, beside the register.

### A job that needs more than its type

`PUT /v1/jobs/{id}/required-skills` gives one job skills beyond its type's: a
lift ticket for a rooftop unit, a confined space entry for a crawlspace. They
are checked wherever the type's are, for a technician sent alone and for a
crew, at booking and in the suggestions. The job's page takes them. The other direction, a job
dropping one of its type's skills with a reason, is `POST /v1/jobs/{id}/dropped-skills` and is
described in M10.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything |
| Office manager, branch manager | The roster. Not the certifications, under the presets as they stand |
| Dispatcher, CSR, technician | Neither |
| Accountant | Neither |
| Everybody | Their own record on `/me`, and nothing of anybody else's |

Onboarding, emergency contacts, the employment record, skills and the
documents people are asked to sign are read with `user:read` and changed with
`user:write`, which the office manager preset does not hold, because it is
also what assigns roles. A company that wants its office manager keeping these
records grants it by name.

Everybody holds `profile:own`: their own record, and nobody else's.

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
| `GET /v1/roster` | `user:read` |
| `GET /v1/people/{membershipId}` | `user:read` |
| `POST /v1/people/{membershipId}/onboarding` | `user:write` |
| `POST /v1/people/{membershipId}/emergency-contacts` | `user:write` |
| `PUT /v1/people/{membershipId}/employment` | `user:write` |
| `POST /v1/technicians/{technicianId}/skills` | `user:write` |
| `POST /v1/technicians/{technicianId}/continuing-education` | `compliance:write` |
| `PUT /v1/jobs/{id}/required-skills` | `job:write` |
| `POST /v1/technicians/{id}/photo` | `user:write` |
| `GET /v1/staff-documents` | `user:read` |
| `GET /v1/staff-documents/{id}` | `user:read` |
| `POST /v1/staff-documents` | `user:write` |
| `POST /v1/staff-documents/{id}/retire` | `user:write` |
| `POST /v1/staff-documents/{id}/requests` | `user:write` |
| `GET /v1/me` | `profile:own` |
| `POST /v1/me/emergency-contacts` | `profile:own` |
| `POST /v1/me/emergency-contacts/{id}/remove` | `profile:own` |
| `POST /v1/me/onboarding-lines/{id}` | `profile:own` |
| `POST /v1/me/documents/{requestId}/sign` | `profile:own` |

## Common questions

**Why is a certificate scan not stored on the certification row?** Because the
bytes belong to the attachment path, which already handles any entity, and a second
place to put a file is a second reference count to get wrong.

**Can a technician see their own certifications?** Yes, their own, on `/me`, with
when each runs out and whether the office has seen the card. The register of
everybody's needs `compliance:read`, which the technician preset does not hold.

**Does a lapsed licence stop dispatch?** Yes. A lapsed or revoked certification
for a skill the work needs refuses the assignment with the person's name and the
date it ran out, for a crew and for a technician sent alone. Somebody holding
`visit:assign_unqualified` can send them anyway with a reason, which the audit
log keeps beside the refusal.

## What is not built

This is a qualification register and the office's record of each person, not
an HR system. Certificates and scans attach through the ordinary attachment
path; the documents people sign are text written here, not uploaded files, and
a printed copy is a record made from them on the day, not a stored file. A person keeps their own
emergency contacts and nothing else of their record: a new address or phone
number goes to the office. A person can tick any line of their own onboarding,
and the office sees that they ticked it rather than the office. A skill's
record has no expiry of its own: only a certification can say until when.
Continuing education counts hours toward a renewal and does not check that a
course is one the authority accepts, and a person cannot log their own hours.
Editing the list of skills on the technicians screen does not end their
records here; a skill taken off that way is called out on the person's page
until its record is ended. Signing through the API records no address or
browser, because the route does not see them; the screen does.
