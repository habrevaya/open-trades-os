---
title: Inspections and the Deficiency Backlog
module: M33
domain: Operate
phase: 6
status: partial
---

# Inspections and the Deficiency Backlog

> Module M33. Domain: Operate. Ships in phase 6.

## The problem

The inspection finds the deficiency, the deficiency becomes the proposal, the proposal becomes the work order, the work order becomes the invoice. Fire protection, elevator, backflow, boiler, kitchen suppression, generator and pressure vessel work all run on that loop.

## What it does

Recurring inspection programs against equipment and sites, inspections that
produce deficiencies with severity and a code reference, and a backlog that
converts into proposals carrying the evidence with them.

The backlog is simultaneously a compliance record and the highest converting
sales pipeline a commercial contractor owns, and most of them run it on paper.

## Key concepts

**A deficiency is a record, not a note on a job.** Written as a job note it
disappears when the job closes. As its own record it survives, ages, reports
and converts, and it is what the contractor sells against for the next two
years.

**A statutory report is not a customer report.** For fire, backflow and
pressure work the audience is an authority having jurisdiction with a format
requirement and a filing deadline. A document that satisfies a homeowner is
rejected by a fire marshal, and the contractor finds out months later.

**`service_recommendation` is the residential shadow of this.** Same idea, no
compliance obligation and no third party reader.

## Key concepts, continued

**Two severity vocabularies, and one of them decides things.** The database enum
says critical, major, minor, advisory. Core says safety, failure, wear,
recommendation, and attaches a response deadline to each: a safety finding is
today, a failure is thirty days, wear is a hundred and eighty, a recommendation
has no deadline at all. Core's is the one that decides anything, so it is the one
the product thinks in, and the mapping is stated once rather than re-derived at
every call site. The database words survive because trade packs ship them and an
authority's own form uses them.

**The programme is a checkpoint list, derived and never stored twice.** A
trade pack declares one, or the company writes its own. Two representations of
one programme is a defect this codebase has already produced twice. The
checkpoint list stays the one stored form, the template core validates is the
one derivation, and a checkpoint list that cannot lift into a valid template is
refused when the programme is SAVED rather than discovered when somebody tries
to inspect with it.

**A fail has to say how serious it is.** Core will not default a checkpoint's
failure severity ("defaulting is the trap"), and the pack loader defaults it to
minor. A programme the company writes is refused when a checkpoint whose fail is
a finding does not say, because a person who left the box empty has not decided
that a fail is wear.

**A template's problems are invisible until a technician is standing in a plant
room.** Items that cannot be answered, items that can fail with no stated meaning
for the failure, ranges that exclude their own limits. None of those is
recoverable there, so all of them are refused at the save.

**Changing a programme publishes a new version, and every version is kept
whole.** An inspection records the version it was performed under, because a
report in a compliance file has to keep meaning what it meant. Editing the
checkpoints in place rewrites what every past inspection claims to have checked,
which is the one thing a compliance record must never do. So each version is kept
as it was published (`inspection_program_version`): its name, standard, who gets
the report, the authority, how often, the checkpoints, what changed from the one
before, a note, and who published it, or which trade pack version did. The
programme row holds the version in force. A programme is the same programme from
one version to the next, the way a trade pack knows its programmes by name: a
pack's programme keeps its name when the company changes it, and two programmes
offered to technicians never share one.

**An inspection done offline keeps the version it was done with.** The phone
sends the version it ran with the answers. One run against version 3 and sent
after version 4 was published is judged against version 3's checkpoints, keeps
version 3's checkpoints and is stamped version 3, rather than refused because
version 4 no longer has a checkpoint the technician answered. The report prints
the name, standard and authority of the version it was done under.

**A revision names the version it changed.** Two people editing one programme
would otherwise each publish over the other without seeing it, so a revision
made from a version that has since moved on is refused in words.

**The outcome is not an input.** A technician says what they saw; whether that is
a pass is a conclusion drawn from the template. Accepting an outcome from the
caller would let a half finished inspection be filed as a pass, which is the
single most dangerous artefact this module can produce: that report goes in a
compliance file, gets handed to a buyer, gets shown to an insurer, and asserts
that somebody looked at things nobody looked at.

**Incomplete is not failed.** A failed inspection says the thing is wrong; a
partial one says nobody has finished looking. A compliance file needs to tell them
apart.

**A reading has to be judgeable against something.** A checkpoint that takes a
reading carries a range, because a number with nothing to judge it against goes
into a report and nothing decides whether it is a finding.

**Five kinds of answer, and two of them are never a finding.** A checkpoint is
answered with pass or fail, a reading, a count, a photo or a note. A count says
the fewest there should be, and fewer is a finding at the severity the checkpoint
names, the same way a reading outside its range is. A photo and a note are what was
seen: they are printed on the report and never become a deficiency, so they are not
asked how serious a fail is. The stored checkpoint says a photo, a note or a count
in `answerKind`; a pass or fail and a reading are stored as they always were
(`requiresReading`), so every version published before kinds existed reads exactly
as it did, and a revision that only spells a reading out as a reading publishes
nothing.

**An optional checkpoint can be left blank, and the report says it was.** Core lets
an optional item be skipped without leaving the inspection not finished. The report
prints it as "Optional, not checked", and core's opening sentence says how many
optional checkpoints were not checked rather than "Every item was checked".

**Sections are the checkpoints' own headings.** Each checkpoint can name the section
it sits under; checkpoints next to each other with one heading are one section, in
the order they were written, and a list with no headings is one section as before. A
heading used in two places that are not next to each other is refused at the save
("The section ... is in two places"), because the technician who finishes the first
half believes the section is done.

**A code reference is the company's words.** Each checkpoint can carry the clause it
comes from ("NFPA 25 5.4.1.4"), typed by the company and never read as a rule: no code
book is built in. It is shown to the technician beside the question, printed beside
the checkpoint on the report, kept on the finding a fail produces, and written into
the quote made from that finding, which is how it reaches the customer in the portal.

**A draft is saved work nobody can use.** A company programme can be saved as a
draft: kept as typed, not checked for whether it could be filed, never offered to
technicians, with no version kept and nothing filed against it. The usual reason is a
copy of a trade pack's programme whose ranges the company has still to find out.
Publishing it makes version 1 and offers it, under exactly the checks a programme
saved whole goes through, so a draft is never a way round them. A draft takes the
place of another programme only when it is published, and is thrown away rather than
kept, because nothing points at it.

**The backlog's ageing is measured against a supplied instant.** A backlog report
has to be reproducible, and one measured against whenever it happened to run says
something different every time it is run for the same month end.

**Ending a finding needs a reason, and declining needs one most of all.** A
customer who declined a safety finding is the single sentence somebody will want in
writing later, and a blank there is the record that was not kept.

**Why they said no is a code as well as words.** A decline can say why from a
fixed list (too dear, not now, already booked with another company, something
else), `declineCode` on `POST /v1/inspection-deficiencies/{id}/status`, and the
code stands as the reason when no words are given. "The customer said no" beside
each open finding on the unit's page (`/equipment/{id}`, M04) asks for one, and so does
the same words on each row of the backlog (`/inspections`), so the office does not open
each piece of equipment: both post the one call above, and both are `compliance:write`. The
words are kept beside it and never read for a meaning: plumbing's water heater
capture (M21) leaves out a unit whose finding was declined as already booked
with another company, and reads only the code for that.

**A price with no evidence behind it is refused.** The proposal builder refuses a
finding with no observation and a remedy with no rationale, and the refusal names
the findings so somebody can go and attach the photo or the reading they took. That
property is the reason the module exists.

**What a failure suggests selling is declared on the checkpoint, as a key into the
contractor's own price book and never a price.** The mapping from "the backflow
preventer failed" to "the part number we sell for that" is a decision each
contractor makes differently and has to be able to see and argue with. Without it
every finding came out of the proposal builder unmapped: real, shown, and with no
work behind it, which is a backlog that turns into a list somebody stops reading.

**An inspection keeps what was asked and what was said.** The checkpoints as
they stood when it was filed, and every answer with who gave it and when, are
kept on the inspection. The report is rendered from those, so a report printed a
year later after the programme was revised still prints the prompts and ranges
the technician was shown. The verdict on each checkpoint is core's, drawn again
from the kept answers, so the report and the backlog cannot disagree about a
reading.

**The phone files answers, never a verdict.** A technician runs the programme's
checkpoints on the visit, offline if need be, and the whole inspection goes as
one operation; the server draws pass, fail or not finished from the programme,
against the visit's own customer and address. Only somebody the company lets file
inspections (`compliance:write`) is offered a programme on the phone, and a
filing from anybody else is refused in words.

**A finding becomes a quote in one action, and never without evidence.** The
repairs the checkpoint declared, frozen on the finding, become the lines of a new
estimate priced from the price book by item code, with what was seen, by whom and
when on it. A finding with no observation is refused, as is a repair whose code
is not in the price book; a finding whose checkpoint declares no repair needs the
price for correcting it.

## Setup

A trade pack declares the inspection programmes for its trade, with the standard
performed under as text that is never interpreted as a rule, who receives the
report, how often, and the checkpoints with their ranges and remedies. Applying the
pack sets them up in the company as version 1.

As shipped, every pack programme asks for a reading with no range somewhere, which
core refuses to judge, so an inspection cannot be filed against one until the
company gives the range. That is what writing your own is for.

A company writes its own on `/inspections/programmes`: from nothing, or from a copy
of a trade pack's programme or of one it already has. Writing, revising and
offering a programme need `compliance:write`; reading them needs
`compliance:read`.

## Using it

### Write your own programme

`/inspections/programmes` lists the programmes offered to technicians, the ones no
longer offered (kept, with every version, for the inspections done under them), and
every trade pack's programmes, the company's own trades first. A programme that
cannot be filed against says so ("Cannot be filed yet").

"Write a new programme" opens the editor empty; "Start from this" on a pack's
programme, or "Make a copy" on one of the company's, opens it with the copy in it
and nothing saved yet. The copy says what stops it being filed, before anything is
saved. Each checkpoint has:

- the question the technician is asked
- what it is about, the kind of equipment such as `backflow-assembly`, or nothing
  for the whole property (a suggestion list from the company's trades, its
  programmes and, for somebody who may see equipment, its register)
- the answer: pass or fail, a reading with its unit, the lowest and highest that
  pass, and how close to either is said to be close, a count with the fewest there
  should be, a photo, or a note
- the section it sits under, picked from the ones already typed or a new one
- a code reference, as the company's code book words it
- whether it is optional
- how serious a fail is (or too few, for a count): safety (fix today), failed (30
  days), wearing out (180 days) or worth knowing (no deadline); not asked for a
  photo or a note
- the repairs to quote when it fails, by price book code, with how many and why

Checkpoints are moved up and down and taken off. Saving makes version 1, offered to
technicians at once, and is refused in words when it could not be filed against, or
when technicians are already offered a programme of that name.

"Save as a draft" keeps it as it is, problems and all, under "Drafts" on the list and
offered to nobody. Its page opens it in the editor again with "Save the draft",
"Publish it" and "Throw the draft away". "Publish it" saves what is on the screen
first, so a refusal ("It was not published: ...") never loses the edits; a draft with
the name of a programme technicians are offered says "Use this instead of" that one,
ticked. A copy of a pack's
programme the company has in use offers "Use this instead of" the pack's own, ticked:
the pack's own stops being offered as the copy is saved, so the copy can keep the
pack's name and there is never a moment with both, or neither, on the phone. A copy
records where it came from (the pack, the pack's version and its code, or the
programme and its version), and the page says so.

### Revise a programme

The programme's page (`/inspections/programmes/{id}`) is the editor for somebody
holding `compliance:write`, and the programme in words for anybody else who may
read inspections. "Publish version N" publishes the next version with what changed,
in the person's words if they give them; sending what the version in force already
says publishes nothing. The page lists every version, newest first, with the date,
who published it (or which trade pack), the parts that changed and the note, and
"See it" shows an earlier version as it was published. A repair code the price book
does not have is named on the page, because quoting a finding that needs it is
refused. "Stop offering it to technicians" takes it off the phone and keeps it;
offering it again is refused while it could not be filed against, or while another
programme technicians are offered has its name.

A programme a trade pack set up can be revised here too. It keeps its name, and a
later version of the pack leaves it as the company has it (the upgrade lists it as
changed by you). To keep the pack's own beside a changed one, copy it.

### Inspect

Record what was found, checkpoint by checkpoint, with the readings. The outcome is
computed: pass, fail or partial, with partial meaning nobody has finished looking.
Findings become deficiencies with a severity and a response deadline.

### Work the backlog

The backlog is everything found and not yet put right, worst and most overdue
first. `/inspections` is the screen. Moving a finding along needs a reason when the
move ends it.

"The customer said no" on a row (an open, quoted or deferred finding, for somebody
holding `compliance:write`) asks why from the fixed list (too dear, not now, already
booked with another company, something else) and for their words if there are any.
Choosing nothing is refused in words ("Say why they said no."). Recorded, the finding
leaves the backlog, the page says so, and the unit's page still lists it as declined
with the code and the words. It is `POST /v1/inspection-deficiencies/{id}/status` with
`declined`, so the audit entry and the water heater capture are exactly what the unit's
page makes. A finding already approved or scheduled is not offered the form, because
the customer said yes to it.

### Run one in the field

On a visit, on the phone app or on `/my-day`, "Run an inspection" offers the
programmes (never a draft). The checkpoints come under their section headings, each
with its code reference beside the question and "Optional" when it is. Pass or fail,
a reading with its range beside it (a reading outside it is said before it is
saved), a count with the fewest there should be beside it (a count short of it, or
not a whole number, is said before it is saved), a photo to take ("Take a photo to
answer this" until one is taken), a note to write, not applicable with a reason, a
photo and a note per checkpoint, the inspector's name and licence, and a signature.
Checkpoints left unanswered are named first, and filing anyway files it as not
finished; an optional one left blank is not named and does not hold it up. Photos,
notes and counts go in the same `inspection.record` operation as readings, through
the same queue, so they are filed offline the same way. A phone app older than
answer kinds shows a photo, note or count checkpoint as pass or fail, and the server
refuses that filing in words ("The wrong kind of answer was recorded for ...") rather
than guessing; the app needs updating to run such a programme.

The signature is drawn on both. On `/my-day` the inspector draws it in a box
with a finger, a stylus or a mouse (Clear takes it off and they draw again) and
types their name beside it. The picture is kept in the browser and put into the
same upload queue as the phone app's, recorded before the inspection that names
it, so a lost signal in a plant room loses neither; it is stored as the phone's
is, and the printed report shows it. Typing the name alone still files the
inspection, because a browser that cannot keep the picture (private browsing, no
storage) must not stop one being filed: it then says so in words and files
nothing until the drawing is cleared, rather than filing a report that looks
signed and is not. The name is always asked for.

### Print the report

`GET /v1/inspections/{id}/report` is the report's data, and
`/inspections/{id}/report` prints it. `GET /v1/inspections` lists those filed. Each
checkpoint prints under its section heading with its code reference; a photo or a
note prints as "Recorded", never as a pass; a count prints the fewest there should be
as what was acceptable; an optional checkpoint left blank prints as "Optional, not
checked".

### Sell the remedy

The proposal for a property prices the open findings from the remedies the
checkpoints declared, against the contractor's own price book, and refuses to price
anything with no evidence behind it. "Quote it" on a backlog row, or
`POST /v1/inspection-deficiencies/{id}/quote`, writes the estimate for one finding
and moves it to quoted; pressing it again opens the same estimate.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything |
| Office manager | Nothing: `compliance:read` is not on the preset |
| Dispatcher, CSR | Neither |
| Technician | Neither, under the presets as they stand |
| Accountant | Neither |

One pair of permissions, `compliance:read` and `compliance:write`, shared with M23
and M24, because an inspection record is a compliance record. A company running
inspection work grants them to the people who do it. Programmes follow the same
pair: anybody who may read inspections reads the programmes and every version of
them, drafts included, and writing, revising, copying, offering one, and saving,
publishing or throwing away a draft, is `compliance:write`. The
repair codes offered in the editor come from the price book only for somebody who
may read it; anybody else types the code.

## API

| Call | Needs |
|---|---|
| `GET /v1/inspection-programs` | `compliance:read` |
| `GET /v1/inspection-programs/{id}` | `compliance:read` |
| `GET /v1/inspection-programs/{id}/versions/{version}` | `compliance:read` |
| `GET /v1/trade-packs/inspection-programs` | `compliance:read` |
| `POST /v1/inspection-programs` | `compliance:write` |
| `POST /v1/inspection-programs/{id}/versions` | `compliance:write` |
| `PUT /v1/inspection-programs/{id}/offered` | `compliance:write` |
| `PUT /v1/inspection-programs/{id}/draft` | `compliance:write` |
| `POST /v1/inspection-programs/{id}/publish` | `compliance:write` |
| `DELETE /v1/inspection-programs/{id}/draft` | `compliance:write` |
| `POST /v1/inspections` | `compliance:write` |
| `GET /v1/inspection-deficiencies` | `compliance:read` |
| `POST /v1/inspection-deficiencies/{id}/status` | `compliance:write` |
| `GET /v1/inspections` | `compliance:read` |
| `GET /v1/inspections/{id}/report` | `compliance:read` |
| `POST /v1/inspection-deficiencies/{id}/quote` | `compliance:write`, `estimate:write` |

`POST /v1/inspection-programs` writes a programme of the company's own, with
`copiedFrom` naming a trade pack's programme (`trade_pack`, the pack and its code)
or one of the company's (`program`), and `replaces` naming one that stops being
offered in the same step. `POST /v1/inspection-programs/{id}/versions` takes the
whole programme as it should now read and `baseVersion`, the version it was changed
from. Both take an idempotency key and answer a retry with what the first one
wrote. A checkpoint takes `answerKind` (photo, note or count; a reading is still
`requiresReading`), `expectedAtLeast` for a count, `optional`, `section` and
`codeReference`. `draft: true` on `POST /v1/inspection-programs` saves a draft (with
`replaces` refused: that goes with publishing); `PUT /v1/inspection-programs/{id}/draft`
writes the whole draft again; `POST /v1/inspection-programs/{id}/publish` makes it
version 1 and offers it, with `replaces` and a `note`; `DELETE
/v1/inspection-programs/{id}/draft` throws it away. Each is refused for a programme that
is not a draft, and filing, offering, revising or copying a draft is refused in words.
Every one writes an audit entry (`inspection_program.drafted`, `.draft_saved`,
`.published`, `.draft_discarded`). `GET /v1/trade-packs/inspection-programs` lists every pack's programmes whole,
with what has to be fixed before each could be filed and the company's own row of it
when the pack set one up. `POST /v1/inspections` takes `programVersion`, the version
the answers were given against.

Filing an inspection sends ANSWERS and gets the verdict back. The outcome is not an
input, which is the one thing this surface must not allow: accepting one would let a
half finished inspection be filed as a pass, and that report goes in a compliance
file, is handed to a buyer and is shown to an insurer.

The backlog's ageing is measured against an instant the caller supplies, so a report
run for a month end says the same thing every time it is run.

## Common questions

**Can a technician file an inspection from the field app?** Yes, when the company
grants them `compliance:write`, which the technician preset does not hold. The
phone app and `/my-day` both run one against the visit and file it offline.

**Can we change a pack's programme?** Yes. Change it in place on its page, or copy
it and change the copy. Every pack programme shipped today needs a range given for
a reading before an inspection can be filed against it.

**What happens to inspections done before a change?** Nothing. Each keeps the
version it was done under, with that version's checkpoints and its report header.

**Does this file anything with an authority?** No. The submission is tracked in
M23 and there is no per authority formatter, so the filing itself is done by a
person.

**What is the residential version of this?** A service recommendation: the same
idea with no compliance obligation and no third party reader.

## What is not built

The proposal for a whole property is not on the API, because its shape is core's
own decision union and would freeze an internal type into a published contract; one
finding is quoted through the API. The report is this product's own document with
everything an authority's form asks for; no authority's own form is rendered, and
nothing files a submission. Inspections filed before the checkpoints were kept print
the programme's current prompts and say so. A programme published before versions
were kept has no copy of its earlier versions: its page lists the version it is on,
and the version before a revision is kept from then on. Resolving a deficiency does
not automatically create the job that fixes it: the estimate is written and
converting it is M07's path. A finding is declined, with its code, from the backlog
page, the unit's page or the API; the phone does not decline one, and a "they said
no" on the phone is the estimate's, which names no unit. A decline written before
codes were kept, or with words only, has no code.

"Not a finding" on a checkpoint is not offered on the screen: core refuses any
checkpoint that can fail without saying what a fail means. What a checkpoint is about
is a kind of equipment as words; the phone does not narrow a checkpoint to the units of
that kind at the address. A retention rule a trade pack writes for its programme by the
pack's code does not reach inspections done under a company's copy of it: those are
kept unless a rule for all inspections says otherwise, which is the conservative reading
of a rule written for somebody else's programme.

Trade packs still ship pass or fail and readings only, and their readings still have no
range: filling those in is the product owner's decision, so a company writes the range
on its own copy (now as a draft while it finds out). A code reference is free text and
nothing checks it against a code book. A draft is a new programme only: a published
programme is not drafted, it is changed by publishing a version, so there is no draft
of version 2 sitting beside version 1. The customer portal does not show the inspection
report itself, because what a customer is told about an inspection (and whether a report
meant for an authority is theirs to see) is the product owner's decision; the code
reference reaches the customer on the quote made from a finding. A phone app older than
answer kinds cannot run a programme with a photo, note or count checkpoint: it shows
them as pass or fail and the filing is refused in words until the app is updated.
