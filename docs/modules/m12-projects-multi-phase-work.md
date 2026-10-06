---
title: Projects and Multi-Phase Work
module: M12
domain: Operate
phase: 7
status: partial
---

# Projects and Multi-Phase Work

> Module M12. Domain: Operate. Ships in phase 7.

## What it does

Holds work that runs for weeks: a bathroom refit, a system changeout, a
commercial fit out. Phases that wait for each other on a timeline with the
critical path marked, a schedule of values, change orders the customer signs,
billing as the work progresses (by draws, or by applications for payment with
retainage), notices and waivers against each payment, and the spend against the
budget the whole time.

## The problem

A job in this product is one piece of work at one address, usually a trip or
three. A fit out is not that, and the tempting shortcut is to model its phases as
child jobs.

That breaks two things that already exist. `job.parent_job_id` means "this job is
warranty rework on that one", and the review module counts rows by it and calls
the result the callback rate. Phases modelled as children would make every
project read as rework and suppress the review ask on the parent for the life of
the job. So a project is its own container.

## Key concepts

**The schedule of values cannot exceed the contract.** A fit out is applied for
against a schedule of values, and one that adds up to more than the contract is
rejected by whoever is certifying it. Refusing the phase that breaks it is the
only moment anybody is in a position to fix it cheaply.

**A contract value cannot be cut below what has been billed.** The draws raised
are invoices the customer has, and lowering the contract under them leaves a
project that has billed more than it is worth, which every number downstream reads
as an overbill. Nor below what the phases add up to, for the reason above.

**A phase waits for at most one other phase, in the same project, and never for
itself or anything downstream of itself.** The cycle check walks the chain rather
than looking one step back: A waits for B, B waits for C, and making C wait for A
is a project where nothing can ever start and nothing says so.

**A project is not complete while a phase is not.** "Completed" is read by whoever
is deciding to invoice the retention and to stop paying attention, and a project
marked complete with a phase still open is the version of that where somebody
stops looking.

**No money arithmetic lives here.** Budget against actual reads through the same
SQL objects the profitability reports are built from. A project margin and a per
job margin that disagree by six dollars is a meeting nobody recovers from.

**No invoices are created here.** A draw becomes an invoice through the billing
service, which knows about numbering, the price book, rate cards, tax and the
ledger posting. Raising a draw is idempotent across the transaction boundary
billing insists on.

**Materialising follows the same rule as the other two materialisers.** Recurring
schedules and service routes both turn a definition into jobs and both are
idempotent by reading what already exists for a stable identity and skipping it,
reporting a count rather than failing. This is the third, and it does not invent a
fourth answer to "has this already been created".

**A change order changes the contract only when it is signed, and then in the
same transaction as the signature.** Approving one adds its amount to the
contract value and to the phase it names (so the schedule of values still adds
up), and its cost to the budget; a budget nobody set stays unset. A change that
names no phase becomes its own line on the schedule of values. A credit has to
name the phase it comes out of, and one that would take the contract below what
has been billed, or a phase below what was billed against it, is refused, before
the customer is asked to sign it as well as when they do. The signature covers a
hash of the page as sent, so a change order cannot be edited once it is with the
customer: withdraw it and raise another.

**A change order is priced from the price book or the customer's rate card.** A
price book line takes the version in force; where the customer holds a contract
with a rate card that covers the item, the card's price governs, through the
same lookup invoices use. An item a card applies to and does not cover is
refused rather than priced at list, because somebody has to agree that price
with the client first; it can then be typed by hand.

**The critical path is computed against the planned dates.** Each phase's float
is how many days it can slip before the finish date moves, given everything that
waits for it; a phase with none is critical. A finished phase is never critical,
because it cannot slip. Dragging a phase moves everything waiting for it by the
same days and keeps their lengths, and a start on or before the day the phase it
waits for ends is refused with the earliest day it could start. Who is booked on
a phase is read from the visits on its jobs, never kept as a second list.

**The days a change order adds move the schedule only when a person applies them,
as they were shown.** An agreed change order with days has a proposal: the phase
it lands on ends later by those days (or sooner, for days taken off), everything
that waits for that phase moves by the same days and keeps its length, and the
finish date is said before and after. Looking at the proposal moves nothing.
Applying it takes the proposal's key back, works the proposal out again against
the schedule as it stands, and refuses if somebody has moved a phase since the
person looked, so "apply what I was shown" can never become "apply something
else". Only an agreed change order can move the schedule: a priced or sent one
may still be declined, and a plan pushed out for work nobody agreed to is a plan
the crews and the customer were told is wrong. A change order that names no phase
asks which one the days land on. A complete phase, or one with a complete phase
waiting for it, is refused in words (their dates are what happened), and so is a
credit of more days than the phase has. The days are applied once: the change
order keeps who applied them, when, and exactly what moved, and a retry or a
second person gets that back instead of pushing every later phase out again.
Visits already booked are not moved; the schedule flags anyone left booked twice.

**A person booked on two phases at once is flagged, never moved.** The schedule
marks it on the timeline (an amber strip under both bars across the days the two
phases overlap, the words "Booked twice" and the name on each bar) and says it in a
sentence under the chart: who, which two phases, and which days. The rule is two
phases planned to run on the same days and one technician or crew with a visit
still to come on each of them inside those days, read from the visits on the
phases' jobs on the company's calendar. A visit that is finished, cancelled or
missed, a visit with no day, a complete phase and a phase with no dates are not
counted. It is a flag because whether Ray can do both mornings is not something
the schedule knows; changing who is booked is the dispatch board's.

**An application for payment states the whole position every period.** The
schedule of values line by line, work from earlier applications, work this
period, materials stored and not yet installed, completed and stored to date,
retainage at its own rate on work and on stored materials, what earlier
applications certified, and the payment due now. Retainage is computed on the
totals and rounded once. It is released by lowering the rate or by an amount,
and releasing more than is held is refused. A schedule of values that does not
add up to the contract to date, a line billed past its value, and a line that
goes down from the last application are refused in words, every one at once.

**An application becomes one invoice that adds up to its payment due to the
cent.** One line per schedule of values line that moved, net of its share of the
retainage held this period, and a line for retainage released. Raised the same
idempotent way a draw is. Once invoiced, the application's figures are frozen,
because the next one reads its previous certificates from them.

**Retainage is a receivable of its own, and the work is revenue when it is
billed.** The retainage the customer holds back on an application is earned and
billed, and owed when the job is done. So when an application is invoiced, the
retainage it holds is posted to retainage receivable (account 1210) against
revenue, beside the invoice's own posting for what is due now: the work is
revenue in full in the period it was billed. Retainage receivable is not what the
customer owes yet, so it is on neither their statement nor the aging. When
retainage is released, the release line on that period's invoice puts it on what
they owe, and a posting takes it off retainage receivable and back off revenue,
because it was earned once already. Each application's posting is worked out
from what the project's applications already have on that receivable, and voiding
an application's invoice takes that application's retainage back off with it.
The application page says which way its project books retainage.

**Projects billed before retainage was booked are left as they were.** A project
with any application invoiced before this existed booked its retainage the old
way, as revenue when it was released and invoiced, and nothing is migrated: its
retainage held so far was never put on a receivable, and starting one halfway
through would take released retainage off a receivable it was never on. So such a
project keeps booking retainage the old way on every later application, and says
so on the application page. Every project whose first application is invoiced
since books it to the receivable.

**A project bills by draws or by applications, never both.** Two ways of billing
the same work is how it gets billed twice.

**Notices and waivers are records, never rules.** What was sent and received,
when, to or from whom, for how much, and against which payment, with the scanned
copy. The checklist per payment says only what is on file. No state's lien law is
encoded, and the screen says so where it is read.

**No permission is invented.** There is no project permission in the catalogue,
and a string that is not in the catalogue cannot be granted to anybody. Reads use
`job:read` and structural writes use `job:write`, because a project is a container
for work. The billing schedule uses `invoice:write`, because planning and raising
a draw is deciding what a customer is charged and when, and the dispatcher preset
that holds `job:write` very deliberately holds nothing that touches money.

## Using it

### Set one up

`POST /v1/projects` with the customer, the property and the contract value.
`POST /v1/projects/{projectId}/phases` adds a phase with its share of the
schedule, and `POST /v1/project-phases/{id}/dependency` says which phase it waits
for. `/projects/new` is the office form.

### Run it

`POST /v1/projects/{id}/materialise` turns the phases into jobs, one per phase.
`POST /v1/project-phases/{id}/status` moves a phase.
`POST /v1/projects/{projectId}/jobs` attaches a job that already exists.
`/projects/{id}` is the screen.

### Bill it

`POST /v1/projects/{projectId}/draws` plans a draw and
`POST /v1/project-draws/{id}/raise` turns it into an invoice. Both need
`invoice:write`.

### Change the contract

`/projects/{id}/change-orders` is the change order log.
`POST /v1/projects/{projectId}/change-orders` logs a change the customer asked
for, `POST /v1/project-change-orders/{changeOrderId}/lines` prices a line,
`POST /v1/project-change-orders/{id}/send` mints the customer's approval link (and
emails it when asked), and the customer approves and signs at `/co/{token}`, or
`POST /v1/project-change-orders/{id}/decision` records an answer given in person.
`POST /v1/project-change-orders/{id}/withdraw` withdraws one nobody has agreed to.
Each change order prints at `/projects/{id}/change-orders/{changeOrderId}/document`.

### Plan it

`/projects/{id}/schedule` is the timeline. `GET /v1/projects/{projectId}/schedule`
reads it, `POST /v1/project-phases/{id}/move` drags a phase, and
`POST /v1/project-phases/{id}/dates` gives one its own dates. The same read
carries `clashes`, each person or crew booked on two phases at once with the days.
`GET /v1/project-change-orders/{id}/schedule-days` is the proposal for the days on
an agreed change order (pass `phaseId` when it names none), and
`POST /v1/project-change-orders/{id}/schedule-days` applies it with the proposal's
`key`. The change order's page, `/projects/{id}/change-orders/{changeOrderId}`, shows
the proposal under "The schedule", with what would move and the finish before and
after, and an "Apply to the schedule" button for whoever holds `job:write`.

### Apply for payment

`/projects/{id}/applications` lists them.
`POST /v1/projects/{projectId}/applications` starts the next,
`PATCH /v1/project-applications/{id}` fills in a draft, and
`POST /v1/project-applications/{id}/raise` raises its invoice. Each prints in the
two page shape at `/projects/{id}/applications/{applicationId}/document`.

### Keep the paper

`/projects/{id}/liens` holds notices and waivers.
`POST /v1/projects/{projectId}/lien-records` records one, with the copy, and
`GET /v1/projects/{projectId}/lien-records` returns them with the checklist per
payment.

### Watch the money

`GET /v1/projects/{id}/profitability` is budget against actual, and needs
`job.cost:read` with `report.financial:read`.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything |
| Office manager | Reads, builds the structure, plans and raises draws, prices, sends and records change orders, applications for payment, notices and waivers |
| Dispatcher | Reads and writes the structure and the schedule, and logs a change the customer asked for. Nothing that touches money: no applications, no waivers, no change order cost |
| CSR | Reads, applications and waivers included; logs, prices and sends change orders and records the customer's answer; moves the schedule |
| Technician | Reads their own jobs within it |
| Accountant | Reads the profitability |

## API

| Call | Needs |
|---|---|
| `GET /v1/projects` | `job:read` |
| `POST /v1/projects` | `job:write` |
| `POST /v1/projects/{projectId}/phases` | `job:write` |
| `POST /v1/project-phases/{id}/dependency` | `job:write` |
| `POST /v1/projects/{id}/materialise` | `job:write` |
| `POST /v1/projects/{projectId}/draws` | `invoice:write` |
| `POST /v1/project-draws/{id}/raise` | `invoice:write` |
| `GET /v1/projects/{id}/profitability` | `job.cost:read`, `report.financial:read` |
| `GET /v1/projects/{projectId}/change-orders` | `job:read` |
| `POST /v1/projects/{projectId}/change-orders` | `job:write` |
| `GET /v1/project-change-orders/{id}` | `job:read` |
| `PATCH /v1/project-change-orders/{id}` | `estimate:write` |
| `POST /v1/project-change-orders/{changeOrderId}/lines` | `estimate:write` |
| `DELETE /v1/project-change-orders/{changeOrderId}/lines/{lineId}` | `estimate:write` |
| `POST /v1/project-change-orders/{id}/send` | `estimate:send`, `portal:grant` |
| `POST /v1/project-change-orders/{id}/decision` | `estimate:approve` |
| `POST /v1/project-change-orders/{id}/withdraw` | `estimate:write` |
| `GET /v1/portal/change-order` | The link |
| `POST /v1/portal/change-order/approve` | The link |
| `POST /v1/portal/change-order/decline` | The link |
| `GET /v1/projects/{projectId}/schedule` | `job:read` |
| `POST /v1/project-phases/{id}/move` | `job:write` |
| `POST /v1/project-phases/{id}/dates` | `job:write` |
| `GET /v1/project-change-orders/{id}/schedule-days` | `job:read` |
| `POST /v1/project-change-orders/{id}/schedule-days` | `job:write` |
| `GET /v1/projects/{projectId}/applications` | `invoice:read` |
| `POST /v1/projects/{projectId}/applications` | `invoice:write` |
| `GET /v1/project-applications/{id}` | `invoice:read` |
| `PATCH /v1/project-applications/{id}` | `invoice:write` |
| `DELETE /v1/project-applications/{id}` | `invoice:write` |
| `POST /v1/project-applications/{id}/raise` | `invoice:write` |
| `GET /v1/projects/{projectId}/lien-records` | `invoice:read` |
| `POST /v1/projects/{projectId}/lien-records` | `invoice:write` |
| `DELETE /v1/project-lien-records/{id}` | `invoice:write` |

## Common questions

**Can a phase wait for two others?** No. One dependency per phase, which covers
the sequences that actually occur and keeps the cycle check answerable.

**What happens to a draw if the contract is revised down?** The revision is
refused if it would go below what has been billed. Revising upward is fine.

**Is retention modelled?** On applications for payment, yes: a rate on work and on
stored materials, held on every application and released by lowering the rate or
by an amount. On a project billed by draws, no: a retention draw is a draw like
any other, held back until somebody raises it.

**Can a change order be changed after it is sent?** No. The customer's signature
covers the page as sent. Withdraw it and raise another.

**Does a change order's extra days move the schedule?** Only when a person applies
them. They print on the change order, and once it is agreed the change order's page
proposes what would move; a person looks and presses apply. Nothing moves on its own.

**Does the schedule move people who are booked twice?** No. It flags them and says
who and when. Moving somebody is a decision on the dispatch board.

**Is the application the AIA form?** No. It is the common two page shape that
certifiers read (a summary and a continuation sheet), in our own words, with no
association's form, numbering or name.

## What is not built

Resource levelling: the schedule shows who is booked on each phase and flags a person
booked on two phases that run at once, and does not move anybody to resolve it. The days
a change order adds are applied by a person from a proposal, for an agreed change order
only, and move the phase and what waits for it; they do not move visits already booked,
and a change order that names no phase asks which one. A clash is a phase to phase
reading: it does not count a person who is booked on two visits at the same hour, which is
the dispatch board's check, and it does not read a crew's members. A project billed before retainage was booked to a
receivable stays on the old way for good; there is no switch that moves it across
with a catching up posting. Retainage receivable is not sent to QuickBooks or Xero:
the books there carry an application's invoice as billed, net (M14). An
application whose invoice is voided stays invoiced; the correction is a credit
note and the next application. No association's form or name is reproduced. No
lien rules of any state are encoded: notices and waivers are records with dates
and amounts, and BUILD.md is explicit that this project records the dates and
does not author the rules.
