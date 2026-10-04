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
does about it: custom fields on the eight records a company writes things down
about, kinds of record of its own (a permit, a warranty registration, a truck
inspection) with their own lists, forms and reports, triggers, conditions, waits
that survive a deploy, versioned workflows a person can see and switch off, and a
sandbox to try all of it in without a real customer.

## The problem

Two problems, and they look unrelated until you notice they are both about meaning
without enforcement.

Customers, properties and jobs each carried a free form field bag the services read and
wrote. So the storage shipped and the meaning did not. A company could put anything
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

**Eight records carry fields.** A customer, an address and a job carry theirs on
their own create and update. An invoice, an estimate, a visit, a unit and a
technician grew a column later, and each of their own writes is guarded by rules
about money or the board that have nothing to do with a field (an issued invoice's
lines are frozen, a sent estimate is hashed), so their fields are saved by one write
of their own, under that record's own write permission and scope. Filling in a
permit number on an invoice is editing the invoice, not changing its price.

**A kind of record is a list a company keeps that the product never heard of.** A
permit, a warranty registration, the Monday truck inspection: a name, its own
fields, what each one may point at (a customer, an address, a job, a unit) and who
may see and change one. Its fields are ordinary custom field definitions on the
entity type `object:<key>`, so every rule above (closed types, a key that never
changes, a change refused when it contradicts what is stored, every refusal at once)
applies to a permit's fields by the same code. Its key never changes either, for the
same reason a field's does not. A record put on a job points at that job's customer
and address too, when the kind offers those links.

**Who may see a record is a gate and a narrowing.** Every record needs `record:read`
to be seen and `record:write` to be changed, which is what a role is built with. A
kind can narrow either with a permission of its own (supplier rebates only for whoever
may see job costs, permits only for whoever may edit customers); a reader then needs
both. Writing needs reading as well, because somebody who may add a permit and may not
see one would add it and then be told it does not exist. And a record pointing at a
customer is about that customer, so somebody whose customers are narrowed (a
technician sees the people they have been sent to) sees a record when it is on a job
they may see, when it points at nothing of a customer's, or when they wrote it.

**A spreadsheet loads all of it or none of it.** Every row goes through the same
create as one typed on the form, and if any row is refused nothing is written and
every refusal is listed: half a spreadsheet loaded is one nobody can load again
without duplicating the half that went in. The export carries what each record points
at by id as well as by name, so it loads back unchanged.

**A sandbox is a second company, not a flag on records.** Row level security already
keeps two companies apart on every table, and that is what keeps practice data out of
the real one: nothing tried in a sandbox can reach a real customer because no query in
it can see one. Its configuration is copied (job types, fields, kinds of record, saved
reports, proposal layouts, automations switched off), its integrations are not, so it
cannot text, email or charge anybody, and sample work in it has invented names,
streets, emails and 555-01xx phone numbers. Copying back is item by item, through the
real company's own services as the person copying, all or nothing.

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

**A branch asks three kinds of question, and the canvas shows which is which.**
Every condition under "All of these have to hold", at least one under "At least one
of these has to hold", and none under "None of these may hold": the three lists the
engine has always evaluated, each drawn as its own box with its rule as its
heading, its own rows and its own add button, and a sentence under them reading the
whole condition back the way the engine takes it. Three lists and never deeper,
because that is what the engine runs. Adding a row puts the cursor in it, and every
field is named for its group and row.

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

**A report can go to the customer the event is about, and is then about them
only.** The step names "the customer this is about" instead of people, and the
customer is read from the event: an event naming two different customers is a
failed step that sends nothing, never a guess. The report runs as the publisher,
narrowed in SQL by that customer's id (never by a name, so two customers called the
same thing are two people), on top of the publisher's own scope. Only a report on
jobs, invoices, estimates or visits can go to a customer, and only with columns and
filters the product ships for that dataset and that need no permission of their
own: cost, margin, an estimate's value and the company's own fields are the
company's business. Both rules are checked at publish and again on the day it runs,
because a saved report can be edited after the automation was published. It goes
to the address on the customer's record, as transactional mail with the
spreadsheet and the PDF and no link to sign in to, and nobody else gets it in the
same step. An automation on a clock cannot send one, because it is about nobody.

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

`/settings/custom-fields` lists the fields on customers, properties, jobs, estimates,
invoices, visits, equipment and technicians with how many records hold a value for each (and, for a required one, how many do not
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
`/properties/{id}`, `/jobs/{id}`, `/estimates/{id}`, `/invoices/{id}`, `/visits/{id}`,
`/equipment/{id}` and, for a technician, `/people/{membershipId}`, editable by whoever
can change that record and read only for everybody else. A date is a date picker, a choice is its options, and
yes or no has a third answer, "not said". The same rules bind
`POST /v1/customers`, `PATCH /v1/customers/{id}`, `POST /v1/properties`, `PATCH /v1/properties/{id}`,
`POST /v1/jobs` and `PATCH /v1/jobs/{id}`, and an address created with its customer
is held to the property fields. The other five are saved with
`PUT /v1/invoices/{id}/custom-fields`, `PUT /v1/estimates/{id}/custom-fields`,
`PUT /v1/visits/{id}/custom-fields`, `PUT /v1/equipment/{id}/custom-fields` and
`PUT /v1/technicians/{id}/custom-fields`, each with the whole set as it should be,
under the record's own write permission and scope; only what the write changed is
checked. A record the product makes by itself (an invoice from a converted estimate,
a visit the board adds) starts with no values, and a required field's backlog is on
the settings screen.

A refused save is a 422 with one sentence per field, each at `customFields.<key>`
(or `property.customFields.<key>` for an address created with its customer) and
starting with the field's label: "Permit number is required.", "Units has to be a
number." A screen shows all of them at once under the form.

### Find records by them

The customer list filters by a field: choose the field, type or pick the value.
Then choose another and press "Add this filter", and the list is the records both
hold for: the customers on the Annual plan who have pets. Each field applied is
listed with a link that takes it off and leaves the rest, and the address carries
every one, so the list is a link somebody can send. So do `/jobs`, `/invoices`,
`/estimates`, `/people` (by a technician's fields) and each kind of record's own
list.
A choice matches exactly, several choices match a customer holding that one among
theirs, yes or no matches as stored, a number matches as a number, and free text
matches anywhere in the value, ignoring case. `GET /v1/customers`,
`GET /v1/jobs`, `GET /v1/invoices`, `GET /v1/estimates`, `GET /v1/properties`,
`GET /v1/people` and `GET /v1/custom-records` take `fields`, repeated, each the
field's key, a colon and the value (`fields=plan:Annual&fields=has_pets:yes`), every
one of which has to hold, up to ten; `fieldKey` and `fieldValue` still work and are
one more beside them. A key the company has not declared on that record is refused
in words rather than matching nobody, and so is a filter that is not a key, a colon and a value.

In the report builder every field is a column, a filter and a grouping on the
dataset its record is a row of (a job's fields on Jobs and Job profitability, an
invoice's on Invoices, an estimate's on Estimates, a visit's on Visits, a kind of
record's on its own dataset), and a number field is also its total and its average.
The fields of the records a row hangs off are there too, named for the record: a
customer's as "Customer: ..." on Jobs, Job profitability, Invoices, Estimates,
Visits, Calls and every kind of record that links a customer; an address's as
"Address: ..." on Jobs, Job profitability, Invoices, Estimates, Visits and the
kinds that link an address; a job's as "Job: ..." on Invoices, Estimates, Visits,
Calls and the kinds that link a job; a unit's as "Unit: ..." on the kinds that link
a unit; and the lead technician's as "Technician: ..." on Visits. Each needs the
permission that reads that record (`property:read`, `job:read`,
`equipment:read`, `user:read`) to group or filter by, the customer's excepted, and
a filter is held to it exactly as a grouping is.

### Keep a list of your own

`/settings/records` defines a kind of record: the key it is stored under (never
changed), what one is called and several, what each one's name is called ("Permit
number"), what it may point at, and who may see and change them.
`/settings/records/{key}` is one kind: its fields, managed exactly as the fields on a
customer are, what it is, and retiring it (refused while records are on file unless
"retire it anyway" is ticked, with the count; defining the key again brings them back).

`/records` lists the kinds the reader may see. `/records/{type}` is one kind's list,
searched across the name and every value, filtered by a field, downloaded as a CSV
and loaded from one at `/records/{type}/import` (checked first if you like, then all
or nothing). `/records/{type}/new` adds one, carrying the job, customer, address or
unit it was opened from, and `/records/{type}/{id}` changes or removes it. Every
kind that can point at a job, a customer, an address or a unit has a panel on that
record's page with its records and "Add one".

Adding and changing one emits `record.created` and `record.updated`, carrying the
kind (`record.type`), its name and every value (`record.fields`), with the values
before the change on an update, so "when a permit's status becomes approved" is a
trigger on `record.updated` and a condition on `record.type` and
`record.fields.status`. Each kind is a dataset in the report builder: counted, grouped
by month, by customer, by job type and by any of its fields, with each number field
totalled and averaged, and each number opens the records behind it. And they are in
the company's data export like every other table.

### Try things in a sandbox

`/settings/sandbox` makes a practice copy of the company's settings, with up to
twenty five sample jobs if asked for, opens it, and throws it away. Inside it a band
on every screen says it is a sandbox and of which company, and the same page lists
its settings (kinds of record, custom fields, proposal layouts, automations) with
what copying each back would do, checks the copy without making it, and copies the
ticked ones. `GET /v1/sandbox`, `POST /v1/sandbox`, `DELETE /v1/sandbox`,
`GET /v1/sandbox/settings` and `POST /v1/sandbox/copy-back` are the same from the
real company; making one and copying back need `sandbox:manage`. Moving a signed in
session between the two is the web app's, through a database function that allows
only this company's own pair and only a member of where they are going.

### Build an automation

`/automations` is what exists, what it did and how to stop it. `/automations/new`
writes a definition, and `/automations/{id}` is one workflow with its recent runs step
by step.

### Turn on a recommended one

The top of `/automations` offers four, each with what it does, what it needs from
the company, and its one or two settings:

- **Follow up an estimate that has not been answered.** On `estimate.sent`: wait
  some days, stop unless the estimate is still waiting for an answer, text the
  customer a fresh link to it, email one, and raise a call in the office queue.
  A link minted for a message that could not go is withdrawn. A new company
  starts with this one installed and on, waiting three days, put there by its
  owner when the company is created (`onForNewCompanies` on
  `GET /v1/workflow-templates`); it is turned off from the list like any other.
- **Ask for a review after a paid job.** On `invoice.paid`: wait some hours, put
  the job to the reviews module's own decision, waiting again if it says later,
  and send the ask with the review site's link. M20 has the decision.
- **Text back a missed call.** On `call.missed`: wait some minutes, stop unless
  nobody has spoken to the caller since, text the number that rang to say the
  company will ring back, and raise a high priority call back in the office
  queue. Offered only once the company has a number cleared to text that is not
  a tracking number. M19 has where the event comes from.
- **Ring before a warranty runs out.** Waits on "a unit's warranty about to run
  out" (M04), some days before (thirty unless set, one to a hundred and eighty),
  and raises a call in the office queue about the unit, so it opens the unit's
  page. Each end date is called about once. Off until somebody turns it on, like
  the two above.

`GET /v1/workflow-templates` lists them with whether each is on, and
`POST /v1/workflow-templates/{key}/install` turns one on.

### The steps

Send a message (by text or by email, with a subject), raise a task, wait, only
if, and four added for these:
`stop_unless` (carry on only while a declared fact still holds), `send_estimate`
(a fresh link to the estimate by text or email, only while it is undecided, and
refused as a failed step if the wording has lost its link), `request_review`
(the reviews module's decision, parking the run when it says later) and
`send_review_request` (the queued ask, marked sent or failed with the reason) and
`text_caller` (text the number on a `call.missed` event, through the consent
checked transactional sender, from the company's ordinary number and never a
tracking one; a refusal by STOP is a step that did not send, not a failure).
`stop_unless` asks one of five questions: `estimate_undecided`,
`caller_not_reached` (no later call from that number was answered and nobody here
rang it), `invoice_unpaid` (the invoice is open or part paid with money still
owing), `visit_still_booked` (not cancelled, finished or a no show, and still at
the time the event said, because a move raises its own event) and `job_not_done`
(not finished, invoiced, paid or cancelled). Each reads the record the event names
(its own entity, or the id the payload carries), and a no ends the run as
finished with the rest written down as skipped. A plain message by email goes
through the email sender, from the company's address, checked against the do not
email list when it is sent; it is always transactional, and a step asking for a
marketing email is refused at publish, because a promotion needs an unsubscribe
link and goes as a campaign. `text_caller` needs
`message:send`.
`send_estimate` needs `estimate:send`, `portal:grant` and `message:send`;
`request_review` needs `review:respond`; `send_review_request` needs both of
those last two.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Defines fields and kinds of record, writes and publishes workflows, makes a sandbox and copies settings back |
| Office manager | Reads the automations and their runs. Adds and changes the company's records |
| CSR | Adds and changes the company's records |
| Dispatcher, technician, read only | Read the company's records |
| Accountant | None of it |

`record:read` and `record:write` are the gate every kind passes; a kind can name a
further permission of its own for either. `sandbox:manage` is separate from
`settings:write` because copying settings back changes how the real company runs in
one press.

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
| `PUT /v1/invoices/{id}/custom-fields` | `invoice:read`, `invoice:write` |
| `PUT /v1/estimates/{id}/custom-fields` | `estimate:read`, `estimate:write` |
| `PUT /v1/visits/{id}/custom-fields` | `visit:read`, `visit:write` |
| `PUT /v1/equipment/{id}/custom-fields` | `equipment:read`, `equipment:write` |
| `PUT /v1/technicians/{id}/custom-fields` | `user:read`, `user:write` |
| `GET /v1/custom-objects` | `record:read` |
| `GET /v1/custom-objects/{key}` | `record:read` and the kind's own |
| `POST /v1/custom-objects` | `customfield:write` |
| `PATCH /v1/custom-objects/{id}` | `customfield:write` |
| `DELETE /v1/custom-objects/{id}` | `customfield:write` |
| `GET /v1/custom-records` | `record:read` and the kind's own |
| `GET /v1/custom-records/{id}` | `record:read` and the kind's own |
| `POST /v1/custom-records` | `record:read`, `record:write` and the kind's own |
| `PATCH /v1/custom-records/{id}` | `record:read`, `record:write` and the kind's own |
| `DELETE /v1/custom-records/{id}` | `record:read`, `record:write` and the kind's own |
| `GET /v1/custom-objects/{key}/export` | `record:read` and the kind's own |
| `POST /v1/custom-objects/{key}/import` | `record:read`, `record:write` and the kind's own |
| `GET /v1/workflows` | `workflow:read` |
| `GET /v1/workflows/{id}/runs` | `workflow:read` |
| `GET /v1/workflows/{id}` | `workflow:read` |
| `POST /v1/workflows` | `workflow:write` |
| `POST /v1/workflows/{id}/versions` | `workflow:write` |
| `DELETE /v1/workflows/{id}` | `workflow:write` |
| `POST /v1/workflows/{id}/enabled` | `workflow:write` |
| `GET /v1/workflow-events` | `workflow:read` |
| `GET /v1/workflow-steps` | `workflow:read` |
| `GET /v1/workflow-templates` | `workflow:read` |
| `POST /v1/workflow-templates/{key}/install` | `workflow:write` |
| `GET /v1/sandbox` | `settings:read` |
| `POST /v1/sandbox` | `sandbox:manage` |
| `DELETE /v1/sandbox` | `sandbox:manage` |
| `GET /v1/sandbox/settings` | `sandbox:manage` |
| `POST /v1/sandbox/copy-back` | `sandbox:manage` |

Reading, stopping, writing and publishing a workflow are all on the API.
`GET /v1/workflows/{id}` is the definition as the engine runs it: the trigger, the
conditions (three lists of conditions, never deeper) and the flat list of steps with a
branch counting its arms, which is what the canvas's tree is translated into by core.
`POST /v1/workflows` writes one switched off and `POST /v1/workflows/{id}/versions`
publishes a new version, both held to the same check as the canvas's save, against
what the CALLER holds: an app or an agent acting for a person cannot publish a step
that person could not. Defining a field, a kind of record or a workflow, importing
records and copying back from a sandbox all take a dry run, which runs the route and
rolls it back (M28).

## Common questions

**Are custom field values validated on save?** Yes, on create and update of a
customer, a property, a job and a company's own record, and whenever the fields of an
invoice, an estimate, a visit, a unit or a technician are saved, from the API and the
screens. Only what the write
changed is checked: a value contradicting its field's type or options is refused, and
so is a required field left empty on a create or cleared on an update. A key nothing
defines is never refused on save, because companies stored custom data under no
definition for a long time; `GET /v1/custom-fields/usage` is where those show up.

**What happens to records created before a field became required?** They keep
saving. A field that was empty and is still empty has not been touched by the write,
so it is not checked; on the screens an empty box for a field never filled in stays
absent rather than becoming an empty value. Filling it in later is checked, and so is
clearing it once it holds something. A new record is held to it from the start.

**Can I add a whole new object, not just a field?** Yes: a kind of record, under
Settings, Kinds of record, with its own fields, list, form, page, CSV, report dataset
and automation events.

**Can I try an automation without it touching a customer?** Yes, in a sandbox: a
practice copy of the settings with sample work whose people are invented and with
nothing connected to send with.

**Is the automation builder visual?** It is a canvas that only goes downwards: a
trigger, steps, and a branch opening two lanes that rejoin. It draws only shapes
the engine actually runs.

**Can a recommended automation be changed?** Yes, on the canvas like any other.
Changing it does not change the template, and deleting it lets the template be
turned on again from its original wording.

## What is not built

Custom field values on an invoice, an estimate, a visit, a unit and a technician are
saved through their own route and panel, not on those records' create forms or
create routes, so a required field on one of them is asked for when the fields are
saved rather than when the record is made, and a record the product makes by itself
starts with none. Visits and units have no company wide list to filter, so their
fields are filtered in the report builder rather than on a list screen. Several
fields on a list are joined by AND only; there is no "any of these" across fields.
The Tasks dataset has no fields to filter by, because a task can be about anything. A field's key
cannot be changed once made (`/settings/custom-fields` says why), and neither can a
kind of record's. A kind of record links to a customer, an address, a job or a unit
and to nothing else (not to an invoice, another kind, or a person), its records are
not in the customer portal, the phone app or the global search, and its name is the
only thing a record is required to have beyond its fields. The record form takes a job
by its number when opened on its own; a customer, an address or a unit is linked by
opening the form from that record's page. A CSV import links by id or job number, not
by name. The report builder groups a kind of record by its fields, its month, its
customer and its job type, and not by another record's fields.

The sandbox copies job types, custom fields, kinds of record, saved reports, proposal
layouts and automations; it does not copy the price book, roles, message templates,
branches, booking rules or the trade pack's checklists, and copying back offers kinds
of record, custom fields, proposal layouts and automations only. Its only member is
the person who made it. One sandbox per company at a time; throwing it away signs its
people out and leaves its rows in the database, unread. A copied back automation that
emails a saved report needs a report with the same name in the real company.

A branch's conditions are three groups and never deeper: there is no "any of
these, or all of those" inside one group, on the canvas or in the engine.
There is no loop and there will not be one: a flat list only goes forwards, which
is the second loop guard, because the two upstream ones catch a workflow
re-triggering itself and not one looping inside a single run. A report sent to
a customer can be on jobs, invoices, estimates or visits only, with the product's
own columns that need no permission, and never with the company's own fields, a
cost or a margin; it goes to the address on their record and nowhere else, and a
copy to somebody in the company is a second step.
There are four recommended automations and the list is code, not something a company or a trade pack can add
to. `stop_unless` asks five questions, from a catalogue in core: there is none yet
about an agreement, a task or one of the company's own records. The plain message
step emails only transactional mail.
