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

**The programme is the trade pack's checkpoint list, derived and never stored
twice.** Two representations of one programme is a defect this codebase has
already produced twice. The checkpoint list stays the one stored form, the
template core validates is the one derivation, and a checkpoint list that cannot
lift into a valid template is refused when the programme is SAVED rather than
discovered when somebody tries to inspect with it.

**A template's problems are invisible until a technician is standing in a plant
room.** Items that cannot be answered, items that can fail with no stated meaning
for the failure, ranges that exclude their own limits. None of those is
recoverable there, so all of them are refused at the save.

**Changing a programme publishes a new version.** An inspection records the
version it was performed under, because a report in a compliance file has to keep
meaning what it meant. Editing the checkpoints in place rewrites what every past
inspection claims to have checked, which is the one thing a compliance record must
never do.

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

**The backlog's ageing is measured against a supplied instant.** A backlog report
has to be reproducible, and one measured against whenever it happened to run says
something different every time it is run for the same month end.

**Ending a finding needs a reason, and declining needs one most of all.** A
customer who declined a safety finding is the single sentence somebody will want in
writing later, and a blank there is the record that was not kept.

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

## Setup

A trade pack declares the inspection programmes for its trade, with the standard
performed under as text that is never interpreted as a rule, who receives the
report, how often, and the checkpoints with their ranges and remedies. Publishing a
programme into a company lifts that list into a validated template and refuses it
if it cannot be answered.

Defining and revising a programme needs `compliance:write`.

## Using it

### Publish a programme

Define it from the pack's declaration. Revising publishes a new version, and past
inspections keep pointing at the version they were performed under.

### Inspect

Record what was found, checkpoint by checkpoint, with the readings. The outcome is
computed: pass, fail or partial, with partial meaning nobody has finished looking.
Findings become deficiencies with a severity and a response deadline.

### Work the backlog

The backlog is everything found and not yet put right, worst and most overdue
first. `/inspections` is the screen. Moving a finding along needs a reason when the
move ends it.

### Sell the remedy

The proposal for a property prices the open findings from the remedies the
checkpoints declared, against the contractor's own price book, and refuses to price
anything with no evidence behind it.

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
inspection work grants them to the people who do it.

## API

| Call | Needs |
|---|---|
| `GET /v1/inspection-programs` | `compliance:read` |
| `POST /v1/inspections` | `compliance:write` |
| `GET /v1/inspection-deficiencies` | `compliance:read` |
| `POST /v1/inspection-deficiencies/{id}/status` | `compliance:write` |

Filing an inspection sends ANSWERS and gets the verdict back. The outcome is not an
input, which is the one thing this surface must not allow: accepting one would let a
half finished inspection be filed as a pass, and that report goes in a compliance
file, is handed to a buyer and is shown to an insurer.

The backlog's ageing is measured against an instant the caller supplies, so a report
run for a month end says the same thing every time it is run.

## Common questions

**Can a technician file an inspection from the field app?** Not yet. The field app
records readings against a visit; an inspection against a programme is an office
screen.

**Does this file anything with an authority?** No. The submission is tracked in
M23 and there is no per authority formatter, so the filing itself is done by a
person.

**What is the residential version of this?** A service recommendation: the same
idea with no compliance obligation and no third party reader.

## What is not built

Defining or revising a programme is not on the API: a programme comes from a trade
pack, and publishing one is content rather than an integration. Neither is the
proposal, whose shape is core's own decision union and would freeze an internal type
into a published contract. No statutory report document: the data that a fire
marshal's form needs is held and nothing renders the form, which is the gap the
problem statement at the top is about. Nothing files a submission. The field app
cannot run an inspection. Resolving a deficiency does not automatically create the
job that fixes it: the proposal is built and converting it is M07's path.
