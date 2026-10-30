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
lines are frozen, a sent estimate is hashed), so after the record exists their fields
are saved by one write of their own, under that record's own write permission and
scope. Filling in a permit number on an invoice is editing the invoice, not changing
its price. An invoice, an estimate, a visit and a unit are also asked for their fields
when a person or an integration makes them, so a required one cannot be left out and
found blank later. A technician is added by inviting a person on the team screens,
which this does not change, so a technician's required fields are asked for when they
are saved on the person's page.

**A required field is asked for when somebody makes the record, and not when the
product does.** The routes and the screens that make an invoice, an estimate, a visit
or a unit pass the company's required fields through the same check a customer's are.
An invoice a project's billing makes, an estimate an AI draft or an inspection finding
makes, a visit the first booking of a new job or a recurring job or a rental or an AI
intake adds, a unit a part installed from stock registers, and anything a migration
loads, start with none, because there is nobody at a form to ask and a field the
company made required last week must not stop a progress bill going out or an
automation running. Their backlog is counted on the settings screen, as it is for a
record from before the field was required.

**A kind of record is a list a company keeps that the product never heard of.** A
permit, a warranty registration, the Monday truck inspection: a name, its own
fields, what each one may point at (a customer, an address, a job, a unit, an
invoice, a person in the company, or one record of another kind the company
keeps, named on the kind: the truck an inspection is of) and who may see and
change one. Its fields are ordinary custom field definitions on the
entity type `object:<key>`, so every rule above (closed types, a key that never
changes, a change refused when it contradicts what is stored, every refusal at once)
applies to a permit's fields by the same code. Its key never changes either, for the
same reason a field's does not. A record put on a job points at that job's customer
and address too, when the kind offers those links, and one put on an invoice points
at the invoice's customer. Pointing at an invoice needs `invoice:read`, and pointing
at another record needs being able to open it, so a record is never the way to learn
that an invoice or a record exists. A person is pointed at by their membership, so
somebody who has left is still the person it was about.

**Who may see a record is a gate and a narrowing.** Every record needs `record:read`
to be seen and `record:write` to be changed, which is what a role is built with. A
kind can narrow either with a permission of its own (supplier rebates only for whoever
may see job costs, permits only for whoever may edit customers); a reader then needs
both. Writing needs reading as well, because somebody who may add a permit and may not
see one would add it and then be told it does not exist. And a record pointing at a
customer is about that customer, so somebody whose customers are narrowed (a
technician sees the people they have been sent to) sees a record when it is on a job
they may see, when it points at a unit recorded on a visit of such a job (the unit in
front of them, not the customer's other units), when it points at nothing of a
customer's (no customer, address, job, unit or invoice), or when they wrote it.

**A customer sees a record only when the office says so, field by field.** A kind is
shown to customers only when somebody ticks "The customer may see these" on it, and
then each of its fields only when somebody marks that field for the customer; both
are off until then, and a field added later, or defined again under a retired key,
starts unmarked. What reaches the portal is built from the marked definitions by one
function in core, never from the stored values' keys, so an unmarked value is never
sent, not merely not drawn. A record is about a customer when every customer it
names agrees: its customer, its job's and its invoice's, whichever it carries, are
that one customer. One that names one customer and another's job goes to neither,
and an address or a unit alone puts nothing on a portal, because a house changes
hands.

**A spreadsheet loads all of it or none of it.** Every row goes through the same
create as one typed on the form, and if any row is refused nothing is written and
every refusal is listed: half a spreadsheet loaded is one nobody can load again
without duplicating the half that went in. The export carries what each record points
at by id as well as by name, so it loads back unchanged.

**A sandbox is a second company, not a flag on records.** Row level security already
keeps two companies apart on every table, and that is what keeps practice data out of
the real one: nothing tried in a sandbox can reach a real customer because no query in
it can see one. Its configuration is copied (job types, fields, kinds of record, saved
reports, proposal layouts, automations switched off, and the job stages a connected
application set, standing on their own), its integrations are not, so it cannot text,
email or charge anybody, and sample work in it has invented names, streets, emails
and 555-01xx phone numbers. Copying back is item by item, through the real company's
own services as the person copying, all or nothing.

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
number in the refusal. The step can name a whole dashboard instead (M21): it is
then sent as one PDF to the people picked, each drawn as they would see it, never to
a customer and with no dates of its own, checked the way a dashboard schedule is.

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
the estimate is still waiting for an answer, has not been sent again since and
has not been given longer by the office since it was sent, unless the office asked for the
follow up to start again from that day, in which case it is a run of its own, started by the
extension, that stops only if the date is moved again)
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
is held to the property fields. `POST /v1/invoices`, `POST /v1/estimates`,
`POST /v1/jobs/{id}/visits` and `POST /v1/equipment` take `customFields` the same way and
refuse the same way, and the screens that call them draw the fields: `/invoices/new`,
`/estimates/new`, "Add a visit" on a job (`/jobs/{id}`) and "Add a unit" on an address
(`/properties/{id}`). The first visit booked together with a new job is the job's, so
`/jobs/new` asks for the job's fields and not a second set for the visit. The five are
then saved, and changed afterwards, with
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
every one, so the list is a link somebody can send. From the second field on, the
customer list also has a link, "Show customers that match any of these", that joins
them by "or" instead (the Annual plan or pets), says so in the sentence above the list
("whose Plan is Annual, or whose Pets is yes"), carries it in the address as
`fieldmatch=any`, and offers "Show only customers that match all of these" to go back.
So do `/jobs`, `/invoices`, `/estimates`, `/people` (by a technician's fields) and
each kind of record's own list (`/records/{type}`), each with its own words ("Show
jobs that match any of these"), and each list's search box keeps the choice while it
searches. "Any" only widens which of the fields has to hold: the rows are still
the ones the reader's scope shows on that list, so a technician asking for any of
two fields sees their own jobs that hold either, never somebody else's.
A choice matches exactly, several choices match a customer holding that one among
theirs, yes or no matches as stored, a number matches as a number, and free text
matches anywhere in the value, ignoring case. `GET /v1/customers`,
`GET /v1/jobs`, `GET /v1/invoices`, `GET /v1/estimates`, `GET /v1/properties`,
`GET /v1/people` and `GET /v1/custom-records` take `fields`, repeated, each the
field's key, a colon and the value (`fields=plan:Annual&fields=has_pets:yes`), every
one of which has to hold, up to ten; `fieldKey` and `fieldValue` still work and are
one more beside them. Each of them also takes `fieldMatch`: `all` (the default) or
`any`, which lists the records for which at least one of the fields holds (the Annual plan
or pets), joined in one place (`listFilter` in `services/custom-fields.ts`) for every
list; one field is the same either way, and any other word is refused. A key
the company has not declared on that record is refused in words rather than matching
nobody, whichever is chosen, and so is a filter that is not a key, a colon and a value.

In the report builder, with two or more filters on fields, a choice under "Narrow it
down" joins them by "every one has to match" or "any one can match" (`fieldMatch` on the
report definition, `fieldmatch=any` in the address). It joins only the filters on the
company's own fields: a filter on a status, a branch or a date narrows the report either
way, so "any" can only widen the fields' own part. The drill, a saved report and a
printed one carry it, and the sentence that says what applied reads "Any of: ..." so it
cannot be taken for each field narrowing alone.

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

A kind's own page also says what the customer sees: the kind is shown to customers or
not ("The customer may see these" on its form, `customerVisible`), and each field is
marked "Show ... to the customer" or kept in the office, one press each (`customerVisible`
on `PATCH /v1/custom-fields/{id}`, refused on a field that is not on a kind of record).

`/records` lists the kinds the reader may see. `/records/{type}` is one kind's list,
searched across the name and every value, filtered by a field, downloaded as a CSV
and loaded from one at `/records/{type}/import` (checked first if you like, then all
or nothing). `/records/{type}/new` adds one, carrying the job, customer, address or
unit it was opened from, and `/records/{type}/{id}` changes or removes it.
That page also lists what the record points at, one line for each link its kind
offers, with "Change" (or "Choose") and, when it is set, "Take it off". "Change"
opens `/records/{type}/{id}/link?to=job` (or `customer`, `property`, `equipment`,
`invoice`, `membership`, `record`), which finds the new one with words the way the
search box does, through the same lists and so at the writer's own scope: a
technician allowed to file records is offered the work they were sent to, a branch
manager their branch's. "Point at this one" saves it and goes back to the record. A
job brings its customer and address with it when the kind points at those too.
`PATCH /v1/custom-records/{id}` does the same through the API, and both are held to
exactly the checks making a record with that link is: the kind's write permission,
the permission that reads the thing pointed at, and the writer's scope on it (a job,
a customer and an invoice through their own lists' scopes, an address and a unit by
the work at the address, a person on the writer's people list or the writer, a
record they may open). Something they cannot open is refused in words at its key,
the same as something that is not there, so a record cannot be used to find out
what exists. A link sent as it already was is not checked again, so a branch
manager can correct a permit's name beside a link somebody at head office set.
Every change is in the audit log with the record before and after, and emits
`record.updated` with the links before and after. Every
kind that can point at a job, a customer, an address, a unit, an invoice or a person
has a panel on that record's page (`/invoices/{id}` and `/people/{membershipId}`
among them) with its records and "Add one", and a record's own page lists the
records of other kinds pointing at it (a truck's inspections) the same way. The form
offers the team to pick a person from, for whoever holds `user:read`, and the records
of the kind it points at; an invoice is carried in from the invoice's page.

### Find anything

The search box at the top of the menu (`/search`, `GET /v1/search`) finds
customers by name, email or phone; jobs by their number or by words in what the
job is, its description, the customer's own words from when it was booked, any of
its visits' notes (the technician's and what the office chose to show the
customer) or the customer's name; invoices by their number, the customer's name,
the memo, or what any line says (its name or its description); estimates by
their number, their title, the customer's name, or what any option or any line
says; addresses by their street; units by the serial on their sticker or their
make and model; a customer's notes by what they say; price book items by their
name, code or description; the company's people by their name, their email or
the name they go by on the board; and the company's own records by their name
or any value. Every
word typed has to be somewhere, and each word may be in a different place
("smith furnace" finds the Smiths' job when "furnace" is only in a technician's
note on it, either way round). A number on its own is also a job's, an invoice's
or an estimate's number, with or without its `#`, and a typed `%` or `_` is the
character it is. The words are read once, in core (`search`), and each comparison
is a trigram match a pg_trgm index answers, the notes, lines and options through
an `exists` on the job, invoice or estimate being listed.

Each part is read through its own list's service with the reader's own
permission and scope, so it finds nothing the reader could not open from that
list, whatever words are typed and wherever they are written: a technician finds the work they were sent to, a branch manager their
branch's, somebody without `invoice:read` sees no invoices, and a kind of record
they may not read is not searched. A note, a line or an option is only looked
in for a job, invoice or estimate the list already shows the reader, and each of
those is on that record's own page for anybody who may open it, so the box never
shows somebody a word they could not already read; a word written only in another
company's notes, or on a job the reader was not sent to, finds nothing. Addresses and units have no narrowed list of
their own, so the box narrows them the way customers are narrowed, by the work at
the address: at a restricted scope an address is found only when a job the reader
can see is at it, and a unit only at such an address. An address or a unit in the
box says where and what, never whose.

**A typo is forgiven, after what was typed.** Each group is read as typed
first. When that finds fewer than the group shows, it is read again with each
word of four letters or more allowed to be one letter off a word that is
written (a letter wrong, missing or extra), or two letters off for a word of
eight or more: "furnice" finds the furnace job, "jonson" finds the Johnsons,
"thermstat" finds the thermostat. Those come after every exact match, marked
"Close to what you typed" (`close` on the API), so a guess is never taken for
what was asked. A number is never guessed at, because one digit off is a
different invoice or a different house, and neither is a word of three letters
or anything with a digit in it. The trigram indexes the box already uses hand
over the candidates (pg_trgm's strict word similarity, at a low bar), and the
letters are counted only on those (`app.has_close_word`, with Postgres's
`fuzzystrmatch`), so the second look stays an index read; it is taken only when
the first came up short, and never for a query with no word long enough. Close
matches go through the same lists with the same permission and scope as exact
ones, so a typo finds nothing a correct spelling would not.

**Notes, prices and people.** A customer's notes are a group of their own for
whoever holds `customer:read`, found through the customer under the reader's
customer scope exactly as the customer's page lists them: a branch manager
their branch's customers' notes, a technician only the notes marked for the
field on customers they were sent to. Each hit is the customer, with the part
of the note around the word, and opens the customer's page. Price book items
are a group for `pricebook:read`, opening the item. The company's people are a
group for `user:read`, narrowed the way the people list is (a branch manager
finds their branch's people), and somebody who has left is listed after
everybody who is here, saying so.

Five of each, and a group with more says "See all", which opens its own list
filtered by the same words: `/customers?q=`, `/jobs?q=`, `/invoices?q=`,
`/estimates?q=`, `/pricebook?q=` and `/records/{type}?q=`, each with a search box of its own that
reads words the same way (`q` on `GET /v1/customers`, `GET /v1/jobs`,
`GET /v1/invoices`, `GET /v1/estimates` and `GET /v1/custom-records`). A kind
of record's list matches each word in the record's name or in one of its
values, not in the keys the values are stored under. Addresses, units, customer
notes and people have no list screen searched by words, so theirs is the search
page showing that group alone, at up to fifty (`/search?q=...&in=addresses`,
`in` on the API). "See all" and `more` are about the exact matches: the lists
behind them read words exactly, and the close ones are only in the box.

On a technician's day, in the phone app and on `/my-day`, each visit lists the
company's records pointing at its job or at a unit recorded on the visit, of the
kinds they may read, with every field holding a value, read only ("Records on this
job"). They come with the day and are on the phone with no signal; a change to one
reaches the phone on its next sync.

On the customer's portal (their account link and their sign in), each kind shown to
customers is a read only block headed with its plural, listing the records about them
with each one's name and the fields marked for the customer, and nothing else.

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

The top of `/automations` offers the product's four, each with what it does, what it needs from
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
  and send the ask with the review site's link. M20 has the decision. Its install
  also asks "Which jobs to ask about": paid jobs, as before, or every finished job
  that owes nothing, which adds `invoice.credited` (a credit note settled an invoice)
  and `job.completed` as triggers and counts a job never invoiced as owing nothing.
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

Beside them, a company that applied a trade pack is offered the recommended
automations that pack declares, each marked with the pack it came from. A pack
declares them as data, in the same shape as the four (a key, what it does, what
it needs, its number settings with a default and bounds, and the workflow it
installs: the events it starts on and its steps, with `{ "$param": "days" }`
where the company's number goes), and core's `checkPackAutomation` holds each to
what this build can run when the pack is loaded: steps it knows, events
something emits, a question `stop_unless` can ask, branches whose arms add up,
and every setting a step names declared, so a pack that fails is a build that
fails rather than a company finding out when it presses "Turn on". Its key is
`<pack id>.<key>`. Turning one on is the same install as the four, held to the
same check and permission rule, switched on and refused a second time; it is
refused to a company that has not applied the pack. The HVAC pack carries the
one example: some days after a plan is sold, if it is still active, a call in
the office queue to book the member's first tune up.

`GET /v1/workflow-templates` lists them with whether each is on and which
pack, if any, declared it, and `POST /v1/workflow-templates/{key}/install`
turns one on.

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
`stop_unless` asks one of ten questions: `estimate_undecided`,
`caller_not_reached` (no later call from that number was answered and nobody here
rang it), `invoice_unpaid` (the invoice is open or part paid with money still
owing), `visit_still_booked` (not cancelled, finished or a no show, and still at
the time the event said, because a move raises its own event), `job_not_done`
(not finished, invoiced, paid or cancelled), `agreement_active` (the agreement is
active, not cancelled, lapsed, paused, past due or finished),
`agreement_not_renewed` and `agreement_renewed` (whether the agreement has started
a new term since the event, read from its terms on file, so a renewal by the
worker counts the same as one by a person), `task_open` (the task is open or
being worked, not done or dismissed) and `record_field_unchanged` (a field on one
of the company's own records still holds a value; the step names the field by its
key, "Which field" on the canvas, and what to compare it with, "Compare the field
with" on the canvas). By default that is what the event carried: the run carries on
while the field still says what it said when the record was added or changed. Choose
"A value I type" instead (`compare: "value"` and `value` in the step) and the run
carries on while the field is that value, whatever the event said, so it can be
pointed at a record whose event carried no fields at all. The typed words are read as
the field's own kind, from the definition of the record's kind as it is when the step
runs (the kind is only known then): a number field takes 12 or 12.50, a date field a
real date like 2026-03-01, a yes or no field yes, no, true or false, a choice field
one of its options exactly as listed, a field with several choices the options
separated by commas in any order, a text field the words as typed. A step with no
field, a field that is not a key, a typed comparison with no value or one longer than
two hundred letters, or a comparison that is neither the event nor a value, is refused
at publish with its number. A typed value that cannot be read as that field, or a
field the kind does not have, FAILS the step when it runs, with the reason in words,
rather than ending the run as finished: a typo is the author's to see, and a quiet
"no" would hide it forever. A record removed since is still a quiet no.) Each reads the record the event names
(its own entity, or the id the payload carries), and a no ends the run as
finished with the rest written down as skipped. A record removed since, or an
event naming nothing the question is about, is a no as well. A plain message by email goes
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
| `PATCH /v1/custom-records/{id}` | `record:read`, `record:write` and the kind's own; a new link also needs the permission that reads what it points at (`job:read`, `customer:read`, `property:read`, `equipment:read`, `invoice:read`, `user:read` for anybody but yourself) |
| `DELETE /v1/custom-records/{id}` | `record:read`, `record:write` and the kind's own |
| `GET /v1/custom-objects/{key}/export` | `record:read` and the kind's own |
| `GET /v1/search` | Signed in; each part needs its own list's permission (`customer:read` for customers and their notes, `job:read`, `invoice:read`, `estimate:read`, `property:read`, `equipment:read`, `pricebook:read`, `user:read` for people, `record:read` and the kind's own) |
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

A technician's required fields are asked for when they are saved on the person's page and
not when the person is invited, because the invitation carries no field. A record the
product makes by itself starts with none, as above, and so does the first visit booked
together with a new job. Visits and units have no company wide list to filter, so their
fields are filtered in the report builder rather than on a list screen. "Any of these"
across several fields is on every list that filters by fields and in the report
builder, but it is one choice for the whole list: there is no "this one, or both of
those".
The Tasks dataset has no fields to filter by, because a task can be about anything. A field's key
cannot be changed once made (`/settings/custom-fields` says why), and neither can a
kind of record's. A kind of record points at one record of one other kind, not
several, and an invoice, a person and a record are chosen on the form only as
described above: an invoice is carried in from its page, a person is picked only by
somebody holding `user:read` (anybody else opens the form from the person's page),
and the record list offered is the first two hundred. A record's links are changed
one at a time on its page, by finding the new one with words: there is no form
that changes several at once (the API's `PATCH` does). The page that chooses a
person offers the people the writer may see and themselves, and the page that
chooses a record offers fifty of the kind it points at, narrowed by words. An
address or a unit can be pointed at only when the writer can see work at that
address, or sees every address, which is stricter than the address's own page
(M04 reads the whole company there): a record with no job yet at a new address is
linked by somebody who sees the whole company. Its name is the only thing a record
is required to have beyond its fields. The form that adds a record takes a job by
its number when opened on its own; a customer, an address or a unit is linked by
opening that form from that record's page, or afterwards on the record's own page. A CSV import links by id or job number, not by name. The report builder groups
a kind of record by its fields, its month, its customer and its job type, and not by
another record's fields, its invoice, its person or the record it points at.

The search box matches pieces of words, and words a letter or two off, not
meanings or sounds: "furnice" finds "Furnace" but "fone" does not find "phone",
and there is no stemming. Only the box forgives a typo: the lists behind "See
all", and `q` on the list routes, match words exactly, so a group of only close
matches has no "See all" to more of them. A number, a word of three letters
and a word with a digit in it are matched only as typed. Close matches are
listed after the exact ones in each list's own order, not ranked by how close
they are. The box looks in a visit's notes only to find the visit's job, and
does not list visits or messages, nor read the text of an attached file.
Addresses and units are narrowed by scope in the search box only: the address
list (`GET /v1/properties`) and a unit's page read the whole company for anybody
holding `property:read` or `equipment:read`, as they did before, and narrowing
them is M04's to decide, because a branch manager booking the first job for a new
customer has to be able to pick the customer's address. On the phone and `/my-day` the records are read
only and are those on the visit's job or a unit recorded on the visit, not every
unit at the address. On the portal a customer reads their records and cannot
change, add or comment on one, a record's attachments are not shown, and a record
reaches a portal only through its customer, job or invoice. Whether to show the
record's name is decided with the kind, not per record: a kind shown to customers
shows every record's name.

The sandbox copies job types, custom fields, kinds of record, saved reports, proposal
layouts, automations and the job workflows connected applications registered (M28),
which stand on their own there because a sandbox has no applications; it does not
copy an application's pricing rules or report types, the price book, roles, message templates,
branches, booking rules or the trade pack's checklists, and copying back offers kinds
of record, custom fields, proposal layouts and automations only. Its only member is
the person who made it. One sandbox per company at a time; throwing it away signs its
people out and leaves its rows in the database, unread. A copied back automation that
emails a saved report needs a report with the same name in the real company, and a
copied back kind of record that points at another kind needs that kind in the real
company first, so that kind is copied back before it.

A branch's conditions are three groups and never deeper: there is no "any of
these, or all of those" inside one group, on the canvas or in the engine.
There is no loop and there will not be one: a flat list only goes forwards, which
is the second loop guard, because the two upstream ones catch a workflow
re-triggering itself and not one looping inside a single run. A report sent to
a customer can be on jobs, invoices, estimates or visits only, with the product's
own columns that need no permission, and never with the company's own fields, a
cost or a margin; it goes to the address on their record and nowhere else, and a
copy to somebody in the company is a second step.
There are four recommended automations the product ships, and they are code; a
trade pack adds its own as data; a company cannot add one to the list (it builds the workflow on
the canvas instead). A pack's automation starts on an event and never waits on a
record the way the warranty call does, because the shapes a record can wait in
belong to the service and a pack cannot be checked against them when it loads;
its settings are whole numbers only, with no review site or other choice from
the company's own setup; and only the HVAC pack declares one, as the example.
`stop_unless` asks ten questions, from a catalogue in core, and a company
cannot write its own: a question is a query, and a workflow never carries one.
The record question compares one field with what the event carried or with a
value typed into the step, equal only: it cannot ask "greater than" or "one of
these", and it cannot ask about two fields at once (two steps do). A typed value
is checked against the field only when the step runs, not when it is published,
because the automation does not say which kind of record it will meet, so a
typo shows as a failed step and not a refused publish. An empty field cannot be
compared with, because a typed comparison needs a value: "still blank" is not
something it can say. The plain message step emails only transactional mail.
