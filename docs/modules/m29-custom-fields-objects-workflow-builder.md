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

**"Run and email a report" runs the report as whoever published the version.** A
run's own actor holds only the permissions its steps declared and no scope, and a
report run under no scope is a report of nothing; running it as the company would
hand anybody who can publish an automation the owner's books. So the step declares
`report:read` and `message:send`, and the report itself is read as the publisher, as
they are on the day it runs, through the same delivery a scheduled report uses
(M21): each person picked must be able to open the report and is sent it as they
would see it, the delivery is recorded with each recipient's outcome, and it is keyed
on the run and the step, so a run resumed after a wait does not send it twice. The
report and the people are checked against the author at publish, with the step's
number in the refusal.

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

**Some questions have to be asked again after a wait.** A branch reads the
event, so three days after "an estimate was sent" it can only ever say it was
sent. `stop_unless` asks the database one declared question (today, whether
the estimate is still waiting for an answer and has not been sent again since)
and, when the answer is no, ends the run as finished with the steps after it
written down as skipped. A customer who approved on day two is the follow up
working, not failing. The questions are a catalogue in core, like the dwell
shapes: a workflow names one and never writes a query.

**A recommended automation is an ordinary one.** Turning one on from the
recommended list installs a workflow through the same check, permission rule
and versions as one drawn on the canvas, switched on because the person just
read what it does and pressed the button. It is labelled with the template it
came from so the list knows it is on and a second press is refused, and that
label is all that is special about it: its steps are on the canvas and the
company edits them like any other.

**The step rows are the point of the detail screen.** "Why did this customer get that
text in March" is the question it answers, and a run row on its own says only that
something happened. Seeing that is `workflow:read`, which the office manager preset
holds, because the office manager is the person who gets asked.

## Using it

### Declare a field

`/settings/custom-fields` lists the fields on customers, properties and jobs with
how many records hold a value for each (and, for a required one, how many do not
yet), declares a new one (its label, the key it is stored under, the kind of
answer, the choices for a list, and whether it is required), changes the label,
choices, order and whether it is required, and retires one. Retiring is refused
while records hold a value until "retire it anyway" is ticked, and the count is
in the sentence: the values stay in the records, unseen, and come back if a field
with the same key is defined again. Values stored under a key nothing defines (an
import, usually) are listed under the record type they are on. Reading the screen
needs `settings:read` and changing it `customfield:write`.

`POST /v1/custom-fields` defines one, `PATCH /v1/custom-fields/{id}` changes it and
`DELETE /v1/custom-fields/{id}` removes it, all with `customfield:write`.
`GET /v1/custom-fields` lists them and `GET /v1/custom-fields/usage` says how many rows
actually carry each one, which is what tells a company whether a field they added two
years ago is used.

`POST /v1/custom-fields/validate` checks a set of values against the definitions
without writing anything.

### Fill one in

The fields a company declared are drawn on the screens that make and change the
record: `/customers/new` (the customer's fields, and the address's beside the
address), `/jobs/new`, and a "Your fields" panel on `/customers/{id}`,
`/properties/{id}` and `/jobs/{id}`, editable by whoever can change that record and
read only for everybody else. A date is a date picker, a choice is its options, and
yes or no has a third answer, "not said". The same rules bind
`POST /v1/customers`, `PATCH /v1/customers/{id}`, `POST /v1/properties`, `PATCH /v1/properties/{id}`,
`POST /v1/jobs` and `PATCH /v1/jobs/{id}`, and an address created with its customer
is held to the property fields.

A refused save is a 422 with one sentence per field, each at `customFields.<key>`
(or `property.customFields.<key>` for an address created with its customer) and
starting with the field's label: "Permit number is required.", "Units has to be a
number." A screen shows all of them at once under the form.

### Find customers by one

The customer list filters by a field: choose the field, type or pick the value.
A choice matches exactly, several choices match a customer holding that one among
theirs, yes or no matches as stored, a number matches as a number, and free text
matches anywhere in the value, ignoring case. `GET /v1/customers` takes the same
as `fieldKey` and `fieldValue`, and refuses a key the company has not declared on
customers, in words, rather than matching nobody.

### Build an automation

`/automations` is what exists, what it did and how to stop it. `/automations/new`
writes a definition, and `/automations/{id}` is one workflow with its recent runs step
by step.

### Turn on a recommended one

The top of `/automations` offers three, each with what it does, what it needs from
the company, and its one or two settings:

- **Follow up an estimate that has not been answered.** On `estimate.sent`: wait
  some days, stop unless the estimate is still waiting for an answer, text the
  customer a fresh link to it, email one, and raise a call in the office queue.
  A link minted for a message that could not go is withdrawn.
- **Ask for a review after a paid job.** On `invoice.paid`: wait some hours, put
  the job to the reviews module's own decision, waiting again if it says later,
  and send the ask with the review site's link. M20 has the decision.
- **Text back a missed call.** On `call.missed`: wait some minutes, stop unless
  nobody has spoken to the caller since, text the number that rang to say the
  company will ring back, and raise a high priority call back in the office
  queue. Offered only once the company has a number cleared to text that is not
  a tracking number. M19 has where the event comes from.

`GET /v1/workflow-templates` lists them with whether each is on, and
`POST /v1/workflow-templates/{key}/install` turns one on.

### The steps

Send a message, raise a task, wait, only if, and four added for these:
`stop_unless` (carry on only while a declared fact still holds), `send_estimate`
(a fresh link to the estimate by text or email, only while it is undecided, and
refused as a failed step if the wording has lost its link), `request_review`
(the reviews module's decision, parking the run when it says later) and
`send_review_request` (the queued ask, marked sent or failed with the reason) and
`text_caller` (text the number on a `call.missed` event, through the consent
checked transactional sender, from the company's ordinary number and never a
tracking one; a refusal by STOP is a step that did not send, not a failure).
`stop_unless` asks `estimate_undecided` or `caller_not_reached` (no later call
from that number was answered and nobody here rang it). `text_caller` needs
`message:send`.
`send_estimate` needs `estimate:send`, `portal:grant` and `message:send`;
`request_review` needs `review:respond`; `send_review_request` needs both of
those last two.

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
| `GET /v1/workflow-templates` | `workflow:read` |
| `POST /v1/workflow-templates/{key}/install` | `workflow:write` |

Reading and stopping are on the API, and so is turning on a recommended
automation, whose input is a template's name and a few values; writing a
definition is not, and that is a decision rather than an omission. A definition carries a condition group, which is
a recursive shape the OpenAPI generator cannot describe, so publishing one would
mean publishing a document that does not say what the request is. And the authority
check on a publish is against what the AUTHOR holds, which is a question about a
session rather than about a payload, so the builder stays where the check can see
who is asking.

## Common questions

**Are custom field values validated on save?** Yes, on create and update of a
customer, a property and a job, from the API and the screens. Only what the write
changed is checked: a value contradicting its field's type or options is refused, and
so is a required field left empty on a create or cleared on an update. A key nothing
defines is never refused on save, because companies stored custom data under no
definition for a long time; `GET /v1/custom-fields/usage` is where those show up.

**What happens to records created before a field became required?** They keep
saving. A field that was empty and is still empty has not been touched by the write,
so it is not checked; on the screens an empty box for a field never filled in stays
absent rather than becoming an empty value. Filling it in later is checked, and so is
clearing it once it holds something. A new record is held to it from the start.

**Can I add a whole new object, not just a field?** No. The module's name says objects
and what exists is fields on the six entities that have somewhere to put them.

**Is the automation builder visual?** It is a canvas that only goes downwards: a
trigger, steps, and a branch opening two lanes that rejoin. It draws only shapes
the engine actually runs.

**Can a recommended automation be changed?** Yes, on the canvas like any other.
Changing it does not change the template, and deleting it lets the template be
turned on again from its original wording.

## What is not built

Custom objects: fields only. Custom field values are checked on customers,
properties and jobs and on nothing else, because nothing else has a `custom_fields`
column. Only the customer list filters by a custom field; the property and job
lists do not yet, and neither does the report builder. A field's key cannot be
changed once made (`/settings/custom-fields` says why). Writing a workflow definition is office only, as
above. The canvas offers `all` conditions only. The engine evaluates `any` and `none`
too, and a screen offering all three needs a nested group editor to say which
applies to what; every condition on a branch has to hold, which is what somebody
means by "only if" nine times out of ten, and the API takes the other two.
There is no loop and there will not be one: a flat list only goes forwards, which
is the second loop guard, because the two upstream ones catch a workflow
re-triggering itself and not one looping inside a single run. The report step
emails a report to people picked on the canvas; it cannot send a report to the
customer the event is about.
There are three recommended automations and the list is code, not something a
company or a trade pack can add to. `stop_unless` can ask two questions so far.
The canvas's plain message step is text only; the estimate and review steps
can email.
