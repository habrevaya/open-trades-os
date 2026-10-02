---
title: Custom Fields, Objects and Workflow Builder
module: M29
domain: Platform
phase: 7
status: partial
---

# Custom Fields, Objects and Workflow Builder

> Module M29. Domain: Platform. Ships in phase 7.

## What it does

Lets a company say what it tracks that this product does not, and automate what it
does about it: triggers, conditions, waits that survive a deploy, and versioned
workflows a person can see and switch off.

## The problem

Two problems, and they look unrelated until you notice they are both about meaning
without enforcement.

Customers, properties and jobs each carry a free form field bag the services read and
write. So the storage shipped and the meaning did not. A company could put anything
under any key on any row, and nothing said what the keys were, what they were called,
what shape a value was meant to be, or which of them somebody had to fill in. The
symptom is not an error: it is a screen with no custom fields on it above a database
full of them, an export with a column header nobody can read, and two offices writing
"yes", `true` and "Y" into the same field for a year before anybody tries to count
them.

And the automation engine ran for a long time with no way to make a workflow except
inserting rows by hand, and no way to stop one except the same. An automation sending
the wrong thing to customers with no button to stop it is the failure that ends a
trial, and it is worse than the automation not existing.

## Key concepts

**A definition is the only thing that makes a custom field a field.** Without one
there is a bag of strings. With one there is a label to draw, a type to check against,
and an answer to "what does this company track that we do not".

**The key is the join and there is no foreign key under it.** The value lives under
that key on another table, matched by string. Nothing in the database enforces that
correspondence, which is why every rule in the module is about protecting it: the
definition and the data agree because the service refuses to let them disagree, or they
do not agree at all.

**Which entities can have a custom field is a closed list, and an entity outside it is
refused rather than accepted and ignored.** A definition on an entity with nowhere to
store a value is the worst possible failure here: the field renders, somebody types
into it, the save succeeds because the save never looked, and the value is gone.
Nobody reports that as a bug, because from the outside it looks like it worked.

**Table identifiers come from a fixed map and never from input.** That ordering is the
whole safety argument for the raw identifiers in the queries: a caller cannot reach
them with a string of their own, because a string of their own is refused before a
table name is ever chosen.

**The type vocabulary is closed, because an open one is the same as no type.** A type
is only worth a column if a screen can draw a control from it and the service can
refuse a value that contradicts it. A free string means the screen falls back to a text
box for everything it does not recognise, which is a text box for everything, which is
where this started.

**A date field is an ISO calendar date and deliberately not a timestamp.** The value
lands in a JSON column where a date object does not survive the round trip, and a field
a company labels "Warranty expires" is a day rather than an instant. Two offices
writing `2026-03-01` and a full timestamp into the same field produce two values that
are never equal and sort against each other wrongly, and neither one looks wrong on its
own.

**Keys are lowercase, and the reason is that the storage is case sensitive.**
`Warranty` and `warranty` are two different fields that read as one on a screen and in
an export header, and the office that created the second one will never find out why
half the rows are blank.

**The builder is a canvas, and it is a vertical flow rather than a graph.** The
shape an automation has is a trigger at the top, steps down the page, and a
branch opening two lanes that rejoin. A free-form graph with boxes and arrows
somebody connects by hand can express a cycle and a dangling node, and this
engine runs a list that only goes forwards, so an editor that can draw what the
runner cannot run is an editor whose every save is a possible refusal.

**Branching is a flat list with counts, not a tree.** A branch counts the steps
that follow it: that many belong to the arm that runs when the condition holds,
the next that many to the arm that runs when it does not, and the other arm is
written down as skipped. A tree would mean a path instead of an index, which
means a new resume model, a new unique index and a migration, to express what
the flat form expresses exactly. Nesting falls out of it rather than being a
second feature, and the arms are bracket matched at the save, because a list
whose arms overlap does something no reading of the definition predicts.

**The arm not taken is written down.** That is what makes a branch and a wait
compose: a run that parks inside an arm resumes at the next index, and without
the skipped rows it would run the arm the branch decided against, three days
later, with nothing on the screen explaining why. It is also the honest record,
because "the condition did not hold" is a different fact from "nothing
happened".

**A branch reads nothing.** It compares values the event already carried, so its
answer cannot change between the moment it was taken and the moment the run
resumes.

**One translation between the canvas and the engine.** The tree a person draws
and the flat list the engine runs are converted by one pair of functions in
core, used by both the screen and the server. Two implementations of a
translation disagree eventually, and the one that would be wrong is the
server's, which is the one that decides what actually runs.

**Conditions are data, evaluated by the engine, and never code.** A builder that
accepts an expression string and evaluates it has handed anybody who can write a
workflow the ability to run arbitrary code on the server, in a product whose whole
premise is that a contractor self hosts it. A small declarative shape is less
expressive and that is the trade being made deliberately. A condition path is author
supplied, so prototype keys are refused rather than resolved.

**Two loop guards, and they catch different loops.** A workflow that edits a job
produces an event that can trigger the same workflow, and without a guard the only
symptom is a company sending ten thousand texts overnight. One guard stops a workflow
responding to its own output; the other stops the indirect loop where A triggers B
triggers A, which no single workflow check can see.

**A workflow runs as its author's authority, not as the owner's.** Running them as the
owner would hand every author the owner's powers. Instead a version declares the
permissions its steps need, the author must hold all of them, and the run gets exactly
that set. Publishing is checked against what the author holds rather than against
whether they may touch workflows at all, which is the part that stops the escalation.

**A step this build does not know is refused at publish rather than skipped at run
time.** Skipping would let a definition written against a newer version run here with
the steps it could not perform quietly dropped.

**A subscription to an event nothing emits is refused.** A workflow subscribed to a
dead event is a workflow that never runs, and the person who built it believes they
automated something.

**Switching a workflow off does not touch runs already in flight.** The switch is the
most important control on the screen and the reason the screen exists: an automation
misbehaving is a thing somebody needs to stop in seconds, without a deploy and without
a database client.

**The step rows are the point of the detail screen.** "Why did this customer get that
text in March" is the question it answers, and a run row on its own says only that
something happened. Seeing that is `workflow:read`, which the office manager preset
holds, because the office manager is the person who gets asked.

## Using it

### Declare a field

`POST /v1/custom-fields` defines one, `PATCH /v1/custom-fields/{id}` changes it and
`DELETE /v1/custom-fields/{id}` removes it, all with `customfield:write`.
`GET /v1/custom-fields` lists them and `GET /v1/custom-fields/usage` says how many rows
actually carry each one, which is what tells a company whether a field they added two
years ago is used.

`POST /v1/custom-fields/validate` checks a set of values against the definitions
without writing anything.

### Build an automation

`/automations` is what exists, what it did and how to stop it. `/automations/new`
writes a definition, and `/automations/{id}` is one workflow with its recent runs step
by step.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Defines fields, writes and publishes workflows |
| Office manager | Reads the automations and their runs. Writes neither |
| Dispatcher, CSR, technician | Neither |
| Accountant | Neither |

Reading an automation and changing it are separate permissions on purpose: an owner
asking "why did this customer get that text" needs the first, and the answer to the
second is a much smaller list of people.

## API

| Call | Needs |
|---|---|
| `GET /v1/custom-fields` | `settings:read` |
| `POST /v1/custom-fields` | `customfield:write` |
| `PATCH /v1/custom-fields/{id}` | `customfield:write` |
| `DELETE /v1/custom-fields/{id}` | `customfield:write` |
| `GET /v1/custom-fields/usage` | `settings:read` |
| `POST /v1/custom-fields/validate` | `settings:read` |
| `GET /v1/workflows` | `workflow:read` |
| `GET /v1/workflows/{id}/runs` | `workflow:read` |
| `POST /v1/workflows/{id}/enabled` | `workflow:write` |
| `GET /v1/workflow-events` | `workflow:read` |
| `GET /v1/workflow-steps` | `workflow:read` |

Reading and stopping are on the API; writing a definition is not, and that is a
decision rather than an omission. A definition carries a condition group, which is
a recursive shape the OpenAPI generator cannot describe, so publishing one would
mean publishing a document that does not say what the request is. And the authority
check on a publish is against what the AUTHOR holds, which is a question about a
session rather than about a payload, so the builder stays where the check can see
who is asking.

## Common questions

**Are custom field values validated on save?** Not yet, and the reason is a migration
rather than an oversight. Every company that already stored custom data under no
definition would have its next save refused for keys it has been using for a year.
Switching the validator on is product work; discovering it that way is not.

**Can I add a whole new object, not just a field?** No. The module's name says objects
and what exists is fields on the six entities that have somewhere to put them.

**Is the automation builder visual?** No, deliberately. It is what exists, what it did
and make it stop. The definitions it can write cover the shapes the engine actually
implements.

## What is not built

Custom objects: fields only. The validator is written and not wired into the
customer, property and job writes. Writing a workflow definition is office only, as
above. The canvas offers `all` conditions only. The engine evaluates `any` and `none`
too, and a screen offering all three needs a nested group editor to say which
applies to what; every condition on a branch has to hold, which is what somebody
means by "only if" nine times out of ten, and the API takes the other two.
There is no loop and there will not be one: a flat list only goes forwards, which
is the second loop guard, because the two upstream ones catch a workflow
re-triggering itself and not one looping inside a single run. Scheduled report
delivery is not built, and neither is a workflow step that runs a report.
