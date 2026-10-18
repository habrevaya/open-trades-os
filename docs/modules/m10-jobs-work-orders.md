---
title: Jobs and Work Orders
module: M10
domain: Operate
phase: 1
status: partial
---

# Jobs and Work Orders

> Module M10. Domain: Operate. Ships in phase 1.

## What it does

A job is one piece of work for one customer at one address. A visit is one trip
to do some of it. Everything the company does to earn money hangs off those two
rows.

## The problem

Most systems model an appointment and then discover that one piece of work takes
three trips, or that two technicians go on Tuesday and one comes back Thursday
for the part. Modelling the trip as the unit means a job's history is a list of
appointments nobody can total, and modelling the job as the unit without visits
means a schedule nobody can read.

So both exist, and the job is what gets invoiced.

## Key concepts

**A job's status is a lifecycle, not a field.** Lead, estimating, scheduled, in
progress, on hold, completed, invoiced, paid, cancelled. The office genuinely
does edit a booked job, so an ordinary update is allowed; what is not ordinary
is walking the status backwards, because a job that has been invoiced going back
to scheduled is how an invoice ends up attached to work that is no longer
claimed to have happened.

**A visit carries an arrival WINDOW, not a time.** Contractors promise "between
one and four", and storing a single timestamp is what produces the angry review.

**`completed_after_cancellation` looks like a contradiction and is the most
important state in the enum.** A technician works offline, dispatch cancels the
visit while they are in a crawlspace with no signal, and the technician
completes the work and syncs. The naive resolution is to reject the write
because the server is authoritative. That destroys the labour record, the
photos, the signature, the readings and, in a regulated trade, a compliance
record that legally has to exist. The work physically happened, and deleting the
evidence does not undo it. So the write is accepted into a distinguished state
and an obligation is raised for a dispatcher, keyed by the visit rather than the
job, because a job can carry several visits and only one of them was done after
the cancellation.

**Completion is idempotent.** A retry from a truck must not double complete.

**Nobody is booked onto a day they have off.** Approved time off has been on the
board since it was built, so an empty slot on somebody's day off looked
bookable. Checked for work still to come only, because a visit whose window has
already ended is a record of something that happened.

**Nobody is booked or sent alone onto work they are not qualified for.** A job's
required skills, its type's and any the job adds of its own for one unusual
piece of work (`PUT /v1/jobs/{id}/required-skills`, M24), are checked for each
technician named when a visit is
booked or assigned, with a sentence naming the person and the skill. The answer
comes from M24: a live certification clears a skill, a lapsed or missing one
refuses it, and for a skill no certification grants, the person's recorded
skills decide once anybody in the company is recorded with that skill. A skill
nobody is recorded as doing cannot be checked and does not refuse, and the
assignment says so. Like time off, it is checked for work still to come only.
Booking has no override; assigning does, with `visit:assign_unqualified` and a
reason the audit log keeps.

**A job can drop one of its type's skills, and the reason stays on the job.** An
unusual job (the gas is already capped, the licensed part was done last week)
does not need a skill its type ordinarily asks for. `POST /v1/jobs/{id}/dropped-skills`
drops one with a reason of a sentence or more, and `POST /v1/jobs/{id}/dropped-skills/restore`
asks for it again. Only a skill the job's type asks for can be dropped. From then on it is
not asked of whoever is sent on that job, on the board when somebody is assigned, at booking
with somebody named, for a crew, in the suggestions, and in the room counted for a member's
booking of that job, because every one of those reads the job's skills through one function
that takes the drops away. The reason is shown wherever the job's skills are read: on the
job's page under "Skills this work needs" with who dropped it and when, in
`GET /v1/jobs/{id}/required-skills` (`dropped`, and `checked` for what is actually asked), in
the board's notice when somebody is sent ("This job does not need epa_608: the refrigerant
side was done last week."), in `droppedSkills` on the answer to `POST /v1/visits/{id}/assign`,
and in the audit entry of every assignment made while it stands. Dropping needs
`visit:assign_unqualified` as well as `job:write`, because it lets people be sent without the
skill with no override at the moment they are sent: it is the same decision, so it sits with
the same people (the office manager, not the dispatcher). Putting a skill back only tightens
the check and needs `job:write`. Dropping a skill twice keeps the first reason. A drop for a
skill the type has since stopped asking for does nothing.

**A drop can end.** `through` on `POST /v1/jobs/{id}/dropped-skills` (the form's "Last day it is
not needed") is the last day the drop holds, a company date that is today or later; a date that
has passed is refused, and leaving it off gives a drop with no end, as every drop was before.
Each visit is judged on its own day, the day its window starts in the company's zone (today for
a visit with no window): a visit on or before the last day is not asked for the skill, and a
visit after it is, on the board, at booking with somebody named, for a crew
(`GET /v1/crews/for-job`) and in a booking calendar, which is cut where the drop ends and
asked once for each side. A visit booked for the 25th is therefore checked for the skill even
if it is assigned on the 18th while a drop through the 20th stands. Nothing has to run on the
day it ends: there is no scheduled job, the day is simply compared. The job's page says "Not
needed on this job through Oct 20: epa_608. After that it is asked for again."; once the day
has passed it says "Was not needed on this job: epa_608. That ended on Oct 20, so it is asked
for again.", keeps the reason and who dropped it as the record, offers no "Ask for it again"
(there is nothing to put back), and lists the skill to drop again. `GET /v1/jobs/{id}/required-skills`
gives each drop `through` and `ended`, and `checked` is what is asked today. The board's notice
when somebody is sent inside a drop names the end ("This job does not need epa_608 through Oct
20, and is asked for it again after that: ..."), `droppedSkills` on the answer to
`POST /v1/visits/{id}/assign` and in the assignment's audit entry carries `through` on a drop that
has one, and a refusal for a skill whose drop ended before the visit's day says so ("This job did
not need epa_608 through 2026-10-20, and that has ended, so it is asked again for this day.").
Dropping a skill whose drop still stands changes nothing, its end included: moving an end later
loosens the check, so it is done by putting the skill back and dropping it again, which asks for
a reason again. Dropping one whose drop has ended starts a new one and replaces the old record
(the audit log keeps both). Nothing is re-checked when a drop ends: a visit already sent to
somebody is not taken off them, because it was judged on its own day when they were sent.

**A callback has to point at real work for the same customer.** A parent from
another company is a cross tenant read; a parent belonging to a different
customer is the one that slips through, and it is how a callback rate stops
meaning anything.

**A job number is allocated under an advisory lock and a unique index.** Two
people booking in the same second both read the same maximum and both got job
41. The lock serialises allocation for the rest of the transaction and the index
makes a duplicate impossible rather than merely unlikely. Sequences were the
obvious alternative and are wrong, because numbering is per company and gaps on
a rolled back transaction are a real problem for invoice numbering in several
jurisdictions.

**Cost on a job line is redacted by the same rule as everywhere else.**
`job.cost:read` is what separates a technician reading the price from a manager
reading the margin.

## Using it

### Book work

`POST /v1/jobs` with the customer, the property, the type and a summary, then
`POST /v1/jobs/{id}/visits` for the first trip. `/jobs/new` does both on one
form, and `/jobs` is the list.

### Run the day

`GET /v1/dispatch/board` is the board, `POST /v1/visits/{id}/assign` puts
somebody on a visit (refused for somebody not qualified for the work, unless
overridden with a reason by a caller holding `visit:assign_unqualified`), `POST /v1/visits/{id}/crew` puts a crew on one, and
`POST /v1/dispatch/route` reorders a day. `POST /v1/visits/{id}/on-my-way`
tells the customer somebody is coming, which needs `message:send` rather than a
visit permission because it is a message.

### Call it off

`PATCH /v1/jobs/{id}` with `status: "cancelled"` cancels the job. With
`cancelVisits: true` as well (which also needs `visit:reschedule`) it
cancels the job's visits still to come: those not started whose window has
not ended, or that have no time yet. Each one is cancelled the way a visit
is cancelled on a customer's request: off the route order, its technicians
(and a crew's members) told "Do not go" on their phones, and any request of
the customer's still waiting on it closed. Visits somebody is on the way to
or working, finished ones, and ones whose window passed without anybody
marking them are left as they are. "Cancel this job" on `/jobs/{id}` offers
it, ticked, says how many visits it would cancel, and names the ones under
way it leaves.

**Who asked goes with the visits.** The form asks who wanted the visits called
off, the customer or the company itself (weather, staffing), and will not
cancel them without an answer; on the API it is `cancelledBy`, with
`cancelAskedAt` for a call taken earlier than now. Each visit keeps who and
when, with the company's notice window as it was (M09), because cleaning's
cancellation rate counts a customer's late cancellation and leaves the
company's own out (M21). An API caller that does not say is recorded as not
known, which that rate counts beside the number rather than in it. One visit
on its own is called off from its page, `/visits/{id}` (M09).

### Put it on hold, and say why

"Put on hold" on `/jobs/{id}` asks why the job is waiting, from a fixed list:
a part, an inspection, the customer, the weather, or something else said in
words. A part hold names the purchase order the part is on, chosen from the
company's open orders, and is refused without one, because a part nobody has
ordered is a job waiting on the office rather than on a supplier. An
inspection, or something else, says which. The job page then says it is on
hold, why, since when and by whom, with the order linked and whether it has
been sent; the order's own page (`/purchasing/{id}`) lists the jobs waiting on
it. "Take off hold" puts the job back where it was, booked or under way. The
same through the API: `POST /v1/jobs/{id}/holds` places one (`job:write`, and
`po:read` to name an order), `POST /v1/job-holds/{id}/released` takes the job
off it, and `GET /v1/jobs/{id}/holds` lists every hold the job has had. A job
moved off hold by a plain status change has its hold closed too, and a job
put on hold that way before reasons existed can be given one. Every hold is on
the audit log.

A job can also say it is **planned for more than one visit** (a two day
install, a rough in and a trim out): ticked when it is booked on `/jobs/new`,
or "Planned for more than one visit" on its page, or `multiVisitPlanned` on
`POST /v1/jobs` and `PATCH /v1/jobs/{id}`. It is refused once anybody has
arrived at a visit on the job, and the page stops offering it, because a plan
said after the work is a return visit described kindly. Both are what the
first time fix rate (M21) leaves out.

### Budget its crew hours

A job can carry the **crew hours it was budgeted**, people times hours with the
drive, as the bid was built: "Budget the crew hours" on `/jobs/{id}`, or
`budgetedHours` on `POST /v1/jobs` and `PATCH /v1/jobs/{id}` (null takes it
off). The page then shows the budget against the working hours punched on the
job so far, each person separately, and the hours of change orders the customer
approved for it. The budget is fixed from the first punch on the job and the
service refuses a change after that, because a budget moved once the hours are
known is a budget fitted to them: hours the customer agrees to add go on a
change order (M12). The budgeted hour variance (M21) reads both.

### Record how much work it is

A job whose type is measured in a unit of work (square feet, cubic yards, linear
feet: the job type's production unit) shows "Amount of work" on `/jobs/{id}`: how
much it is, in that unit, the crew's hours on site so far (each person separately,
on site and paid breaks there), and the hours spent getting it ready (loading,
driving out, unloading), which are not counted as on site. The office sets the
amount when it books the work and corrects it once the work is done if the crew
did more or less (`productionQuantity` on `PATCH /v1/jobs/{id}`, `job:write`, on
the job's audit line; null takes it off; anything but a number more than nought
is refused in words). Lawn and landscape's production per crew hour (M21) reads it
on completed jobs as the units the crew produced.

### Finish it

`POST /v1/visits/{id}/complete` records what was done, the notes, the checklist
and the signature. `/jobs/{id}` does the same from the office.

### Look at one visit

`/visits/{id}` is one trip on its own: its window and when the van was sent,
left, arrived and finished, who was on it, the technician's notes and the
checklist, what it used by name and quantity (the cost stays on the job's
statement), the time on the clock against it for whoever may read timesheets,
the units it worked, its service report (with the last answer to each field it
recorded, in words: a reading and its unit, a yes or no, a choice, a product and
how much) and any inspection filed from it, what the customer asked to change,
who called it off and when if it was (M09), its photographs, and the other
visits on the same job. Each visit number on a job's page opens it, and so does every link
that is about one visit rather than the job: a report's records, a deadline, a
customer's request to move it. `GET /v1/visits/{id}` is the same read. It is
scoped by the job, so a visit on work somebody was never sent to is not found.

### Print a work order

"Download the work order" on `/jobs/{id}` is the job as a PDF
(`/jobs/{id}/work-order`): the number with its branch's code ("RR-1042") and
the branch by name, the status and the kind of job, the customer with their
phone, the address with the property's access and hazard notes, what the
customer said and the job's description, each visit still going ahead with
its window in the company's own clock, its status, who was sent (the lead
first), when work started and finished, and its checklist with what is already
done marked, then the signature the customer drew on the phone ("Signed on the
phone", with when) and the photographs taken at that visit (each with its phase,
"Before" or "After", and when, in the company's clock, at most three inches tall so
a page holds two), then the parts and labour used with prices, and lines for the
customer's signature, their name, the date and the technician. "Print for the
technician, without prices" (`?for=technician`) is the copy for the van: the
same, read without a single price, so there is none to leave out by mistake.
With nothing recorded yet it leaves rows to write in what was used. Both are
printed with the bundled Noto Sans by core's `pdf` module, like the invoice.

It downloads under `job:read` and the job's own scope, the same as the page: a
technician who sees only their own work gets their own jobs and a not found
for the rest. No copy prints what a part cost the company, the gate code or the
technician's own notes, because the office copy is the one handed to a customer
to sign, and the technician has the gate code and their notes on their phone.
A cancelled visit is left off.

**What the phone took.** The pictures are the attachments on the job and its visits
(`kind` photo or signature, M23), printed under the visit they were taken at, a job's
own photographs under "Photographs on the job". Three rules decide which are printed.
First, a picture is printed only for somebody who may open one: the work order is
`job:read` and the job's own scope, and a photograph also needs `document:read`, the
permission `/files/...` asks for, so a role that reads jobs and not documents gets the
work order with a line saying photographs and signatures are not shown to it and no
picture. Second, the office copy is the one handed to the customer, so it prints the
photographs the customer's own job link would show them (the ones somebody marked with
`POST /v1/attachments/{id}/customer-sharing`, or every one when the company's portal
setting shows them all) and says how many it held back, and the technician's copy, which
stays with the company, prints every photograph; a technician photographs a panel with
the alarm code written on it as readily as a finished install. The customer's drawn
signature is theirs and is on both copies; when there are two on a visit the later is
printed. Third, a file the customer sent in, a document and a picture on a cancelled
visit are never printed. A picture this file cannot carry (a HEIC straight off a phone, a
sixteen bit or interlaced PNG) is said in one line under its visit, with its caption,
rather than dropped. At most 24 photographs and 40 MB of them are printed, and the page
says how many more are on the job's page. The times are when the picture reached the
server, which for one taken offline is when the phone synced. The paper signature lines
are still printed, for anything not signed on the phone.

### See what it cost

`GET /v1/jobs/{id}/lines` is what was used. A supply on it (a part) can be
marked **billed back to the customer at cost**, for paper, liners and soap a
company stocks for an account and bills back at what it paid: "Billed back at
cost" beside the supply on `/jobs/{id}`'s "Used on this job", or
`POST /v1/job-lines/{id}/billed-back` (`job:write`), with "Not billed back" to
take it off. It is a pass through, so the supply cost share of revenue (M21)
leaves it out once it is on an issued invoice. Labour and equipment fitted are
refused, because they are not supplies. `GET /v1/jobs/{jobId}/material-cost`
is the stock side and needs `inventory:read`.
A line on a roll off job can name **the container it bills**: on a job at an
address where containers have been, "Used on this job" has a "Container it
bills" column offering each haul there (a can's time on the site, from
delivery to the pickup or swap that took it), or `POST /v1/job-lines/{id}/haul`
(`job:write`, audited; a container at another address is refused). A hire sold
at a flat price has its price on the job and a swap chain puts several cans on
one job, so this is how revenue per container month and disposal cost per haul
(M21) know each can's share. A hire's own invoice names the haul on every line
it writes, so only the job's lines need naming.
`GET /v1/jobs/{jobId}/attribution` is where the job came from and needs
`adspend:read`, because that is a marketing question about a job rather than a
job question.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything |
| Office manager | Books, edits, completes, and reads cost and margin |
| Dispatcher | Reads and writes jobs, assigns and reschedules visits. No cost |
| CSR | Books work. Cannot dispatch |
| Technician | Their own jobs and visits, completes them, no cost or margin |
| Crew lead | The same, scoped to the crew rather than to themselves |
| Accountant | Reads jobs and their cost |

Completing is its own permission, `job:complete`, separate from `job:write`,
because a technician may finish work and may not re-describe it.

## API

| Call | Needs |
|---|---|
| `GET /v1/jobs` | `job:read` |
| `GET /v1/jobs/{id}` | `job:read` |
| `POST /v1/jobs` | `job:write` |
| `PATCH /v1/jobs/{id}` | `job:write`, and `visit:reschedule` with `cancelVisits` (and `cancelledBy`) |
| `GET /v1/jobs/{id}/lines` | `job:read` |
| `POST /v1/job-lines/{id}/billed-back` | `job:write` |
| `POST /v1/job-lines/{id}/haul` | `job:write` |
| `GET /v1/jobs/{id}/holds` | `job:read` |
| `POST /v1/jobs/{id}/holds` | `job:write`, and `po:read` to name a purchase order |
| `POST /v1/job-holds/{id}/released` | `job:write` |
| `POST /v1/jobs/{id}/visits` | `visit:write` |
| `POST /v1/visits/{id}/assign` | `visit:dispatch` |
| `POST /v1/jobs/{id}/dropped-skills` | `job:write`, `visit:assign_unqualified` |
| `POST /v1/jobs/{id}/dropped-skills/restore` | `job:write` |
| `POST /v1/visits/{id}/complete` | `job:complete` |
| `GET /v1/visits/{id}` | `visit:read` |
| `GET /v1/job-types` | `job:read` |
| `GET /v1/dispatch/board` | `visit:read` |
| `POST /v1/dispatch/route` | `visit:reschedule` |
| `GET /v1/dispatch/optimise` | `visit:read` |
| `GET /v1/dispatch/suggestions` | `visit:read` |

## Common questions

**Can a job have no visits?** Yes. A lead is a job before anybody has promised
to turn up.

**Who sees whose jobs?** A technician's job scope is `own` by default and a crew
lead's is `crew`. That is scoping, not permissions, and it is the filter that
stops a departing technician paging through the company's work.

**Why is on my way a message permission?** Because that is what it is. A
dispatcher who may not text customers should not be able to text them through a
button on a visit.

## What is not built

`job:delete` is in the catalogue and nothing checks it: a job is cancelled
rather than deleted, which keeps the visits, the labour and the obligations that
reference it explicable. Route optimisation is a proposal per technician that a
person applies (M09), not an automatic reorder. A job can add skills of its own
to its type's and drop one of its type's with a reason, one skill at a time, with or without a
last day: there is no "drop for every job of this type" (that is editing the type). The
public booking page's count of free slots reads the job type's skills only, because there is no
job yet to drop anything from. The work order PDF is printed from the job page
and is not an API route. It prints the signature drawn on the phone as a picture and
does not check it: a visit marked signed only by a link given to the API
(`signatureUrl`) with no picture kept here is not fetched and not printed, and
nothing signed on paper comes back into the job. A photograph is not printed on the
office copy until somebody marks it for the customer, which is deliberate, so a
photograph of a code is never handed over by accident, and there is no switch to print
every photograph on the office copy other than the portal's "show every photograph". Booking with a technician who
is refused has no override; book the visit unassigned and send them from the
board. Cancelling a job does not cancel its visits unless the office ticks
it; an API caller has to ask with `cancelVisits`, so an integration that
cancels jobs today keeps its behaviour, and one that does not send
`cancelledBy` leaves who asked not known. A visit somebody is already on the
way to is never cancelled with the job: the office rings them, or calls off
that visit from its own page.

A hold is placed by the office, never from the phone: a technician who needs a
part says so to whoever orders it, and that person names the order. A part
held for without an order in this product (bought over the counter, say) can
be held for "something else" with words, but it is not "held for a part
order", so the first time fix rate counts it. A hold names one order; a job
waiting on two orders names the one the work is waiting for. Nothing reminds
anybody about a job that has been on hold a long time, and the board does not
show the reason. A job's crew hour budget is typed by the office; it is not
taken from the estimate, whose lines carry quantities and prices and never say
which of them are hours. A supply is marked billed back by the office, one line
at a time, not from the phone and not by the customer or the price book item: a
pass through is the account's arrangement, and the same paper can be billed back
to one office and absorbed for another. The container a line bills is named by
the office, one line at a time; a line typed straight onto an invoice, rather
than on the job, names no container.
