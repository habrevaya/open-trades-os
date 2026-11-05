---
title: Coverage, Warranty and Who Is Actually Paying
module: M32
domain: Money
phase: 5
status: partial
---

# Coverage, Warranty and Who Is Actually Paying

> Module M32. Domain: Money. Ships in phase 5.

## What it does

Records who is paying for a job and why, at the moment somebody decides, and
refuses to invoice a customer for work their coverage says they do not pay
for.

## The problem

A technician turns up, does two hours of work, and the customer is charged
nothing. That happens for at least six different reasons and they mean
completely different things:

| Why it was free | What it means |
|---|---|
| Included in their maintenance plan | The plan is being delivered, which is why the company is worth what it is |
| The manufacturer covers the part | A receivable from somebody who is not the customer |
| The manufacturer covers the labour | The same, on the other half |
| Our own warranty | A cost, and a cause somebody could fix |
| Goodwill | A decision, and one worth reviewing at the end of a quarter |
| Rework on our own work | The most expensive of the six, and the one nobody measures |

Every one of them is a zero on a revenue report. Without a resolved coverage
source, invoicing, pricing, the field app script and agreement profitability
all reconstruct it later from circumstantial evidence, and all four get
rewritten when they cannot.

## Key concepts

**Resolved, not derived.** The row records what was decided at the time, and
nothing recomputes it on read. A warranty that expires next month did not
expire on the visit it covered, and a plan cancelled in June did not uncover a
visit delivered in March.

**One answer per job.** Two resolutions is two answers to "who is paying", and
every reader downstream would have to pick one.

**The two warranties are the pair people get backwards.** A parts warranty
covers the part and not the labour. A labour warranty is the other way round.
Getting them backwards bills a customer for something a manufacturer owed, so
the defaults are declared once and the office can override them when the
paperwork in front of them disagrees.

**A deductible is a property of the visit, not of a line.** Splitting line by
line and adding the excess to each is how a customer gets charged it four
times. It is also taken out of the covered amount rather than added on top: a
five hundred dollar job with a hundred dollar deductible costs the customer a
hundred, not six hundred.

**A cap hands the remainder back to the customer.** Anything else makes the
ceiling decorative.

**An unclassifiable line is the customer's, except when it is not.** Guessing
the other way loses revenue, so a line nobody could classify is billed. The
exception is a job whose coverage is total: a callback is a job where the
answer is already "nothing", and a badly named line is exactly how a customer
ends up invoiced for rework.

## Using it

### Say who is paying

Resolve a coverage source on the job. The defaults for that source fill
themselves in, and anything the paperwork says differently can be overridden,
along with a claim number, a percentage, a cap and a deductible.

An agreement resolves itself: booking an included visit writes the coverage
down without anybody remembering to. It never overrules a person, because the
office knowing this is a warranty callback beats the system knowing the
customer has a plan.

Or read it from the unit. A job about a unit with warranty dates can resolve
its coverage from them (`POST /v1/jobs/{id}/coverage/from-equipment`, or the
button under who is paying on the job): parts and labour each covered if
their warranty was in force on the day of the first visit, not today. Out of
warranty is said, and nothing is written, because the office may know of an
extension the dates do not.

The API sets coverage with `PUT /v1/jobs/{id}/coverage`, the job screen with
the source, the claim reference and the deductible.

### Register the unit with its maker

Many makers start the warranty only when the installer registers the unit, within a
number of days, and a company that misses the day has put in a furnace whose owner
finds it has no warranty. The days live on the price book item, beside the warranty
months (M06, "Register with the maker within (days)", `warrantyRegistrationDays`), and
are empty for every item until somebody fills them in: an item whose maker asks for
nothing raises nothing.

**Makers, each with its own days.** A company writes its makers down once at
`/pricebook/makers` (Price book, Makers; `GET /v1/warranty-makers`, `POST
/v1/warranty-makers`, `PATCH /v1/warranty-makers/{id}`, `POST
/v1/warranty-makers/{id}/retire`): a name, the days the maker gives to register a unit
(1 to 365, or empty), and a note on where to register. Reading needs `pricebook:read`;
changing needs `pricebook:write`, the permission the item's own days take. A name another
maker has is refused without regard to case, and every add, change and retirement is
audited. An item names its maker ("Maker it comes from" under "What it is" on the item,
`warrantyMakerId` in `PATCH /v1/pricebook/items/{id}`; it is on the item and not on a
version, so choosing one writes no version). When a serialised unit of the item goes
on a job, the days are the maker's when it has some; a maker with no days, or an item that
names no maker, leaves the item's own number as the only word, as it was before makers
existed, and an item with neither raises nothing. The deadline's sentence names the maker
from the list ("with Carrier Corporation") when there is one, and the make typed on the
unit otherwise. Changing a maker's days applies to units installed from then on: a
deadline already open keeps the last day it was given, because the office has read that
day and may have put it in a calendar. A maker cannot be taken off the list while an item
still sold names it (the refusal says how many), so no item quietly goes back to its own
days and stops raising deadlines. The sandbox copies makers with the price book (M29).

When a serialised part of such an item is used on a job and becomes the customer's
unit, or goes into one of their units (`POST /v1/stock/issues` with `installAs` or
`equipmentId`, M16), a deadline of the kind `warranty.register_by` is raised for the
unit. Its last day is the install day plus the maker's days, counted in the company's
calendar, and registering on the last day is in time. The deadline falls due at the end
of that day. It reads "Register the Furnace (59SC5, serial FN-1) with Carrier by
2026-11-14. The warranty may not start until it is registered. It went in on job
AUS-1042." and is in the deadlines the office reads: `Deadlines` on `/tasks`, and
`/contracts/deadlines`, each linking to the unit.

A week before the last day (or the install day itself, when the maker allows a week
or less) the sweep that stamps the other deadlines puts a high priority task about the
unit in the task queue, titled with that first sentence, so it goes through the
company's own escalation rules like any late task. It is raised once.

The deadline is on the UNIT and not on the job: one job can put in a furnace, a coil and
a condenser, each registered on its own, and a deadline on the job could not say which
was done. The job is named in the sentence. A second part going into a unit that already
has a deadline open does not stack another on it; the earlier day stands. A unit
installed by being added to the register by hand (`POST /v1/equipment`) is not an
install on a job and raises nothing, and neither does an item that is not tracked by
serial number.

The unit's page, `/equipment/{id}`, has a "Warranty registration" section. It says
what is owed and by when (with "Past due" once the day has gone), or the day it was
registered and the maker's reference. "It has been registered" records the day (today
unless changed) and the reference, `POST /v1/equipment/{id}/warranty-registration`. That
closes the open deadline with the day it was done, as the thing that closed it, and
takes the queue task out with it. Registering after the last day closes it too, and
the record says it was met late rather than hiding that. A day that has not come, or
one before the unit went in, is refused. Saying it again corrects the day or the
reference the unit shows; a deadline already closed stays closed (unless the whole registration
is taken back, below). Taking the unit off
the register cancels an open deadline: it is cancelled rather than met, so a count of
deadlines met does not include it. `GET /v1/equipment/{id}` carries `warrantyRegistration`
(`registeredOn`, `reference`, `dueBy`, `overdue`).

### Take a registration back

A registration recorded against the wrong unit, or recorded and never finished, closes a
deadline that should have stayed open, and saying it again only changes the day. "It was
not registered after all" on the unit's page (`POST
/v1/equipment/{id}/warranty-registration/correct`) takes the day and the reference off
the unit and **reopens the deadline the record closed**, with its original last day: one
whose day has gone comes back past due, and the reminder returns to the task queue on
the next sweep. A reason is required, and the correction is audited
(`equipment.warranty_registration_corrected`) with the day and reference that were taken
off, the reason, and whether a deadline came back.

The conservative choices, which the product owner has not ruled on. It needs `equipment:write`
and also `task:write`: recording is the technician's, but putting a deadline back into the
office's queue is the office's, so a technician sees the button's absence and asks the
office. Only a deadline the registration itself closed is reopened, never one that was waived
or cancelled, and not when another is already open for the unit (the earlier day stands, as
an install does); then the registration is taken back and the page says there was no deadline
to reopen. It is refused when nothing is recorded. Sent again with the same idempotency key
it answers with the first answer. Recording the registration again closes the same deadline.

### Find out what to charge

`quote` splits the job between the customer and whoever is covering it,
applying the percentage, the cap and the deductible in that order.

**And the invoice applies it.** An invoice raised to the job's own customer
takes the coverage's share off automatically, by the same arithmetic: each
line the coverage touches carries the customer's part and a sentence saying
what the coverage took ("Parts warranty covers 699.00 of 749.00"). A line
that names its own source is left alone, as before.

### Invoice it

An invoice for a job that is our own warranty, goodwill or a callback is
refused if it bills the customer for anything that coverage covers, with the
reason in the refusal, because whoever is invoicing usually did not make the
decision. A line that names its own coverage source is an explicit decision
and goes through: a callback can have one chargeable extra on it, and
refusing that would make the guard something people work around rather than
with.

Every line carries the coverage source on the way out, which the API contract
has promised since it was written.

### Bill whoever covers it

Billing the job by payer (M31, `POST /v1/jobs/{id}/billing`) sends the
covered work, priced by the third party's own schedule, less the deductible,
to the third party named under Pays, and the rest to the customer, as two
invoices that add up to the work.

### Claim on them

The invoice to the third party is the receivable. The claim is its own
document (`POST /v1/claims`), filed from that invoice with their reference,
and it meets the claim deadline the contract set. Its status follows what
they do:

- **submitted**, when it is filed;
- **approved**, for what was claimed or less, never more
  (`POST /v1/claims/{id}/decision`);
- **paid**, when what they agreed has arrived, or **short paid** when less
  has (`POST /v1/claims/{id}/payments`, which records a real payment from
  them on the invoice);
- **denied**, with their reason, which is final: an appeal is a new claim.

A shortfall stays on the invoice, to chase or write off there.
`Invoices > Claims` (`/invoices/claims`) lists them, waiting first, and each has
its own page, `/invoices/claims/{id}`.

### Bill the rest to the customer

When the warranty company paid less than was claimed, or denied the claim, the
office can ask the homeowner for the rest. On the claim's page, "Bill the rest to
the customer" (`POST /v1/claims/{id}/bill-rest`, `invoice:write`) makes a **draft**
invoice to the job's own customer for what was claimed less what the payer paid,
with one line saying what it is ("Not paid by Shield Home Warranty": "A home
warranty administrator, Shield Home Warranty (their reference SHW-7001), was
claimed $290.00 for job 1042 and paid $260.00. This is the rest."), and opens it.
Nothing is sent or posted until somebody issues it, so the office reads it after
talking to the customer, changes it if the conversation went another way, and
issues it or deletes it. The claim then shows the invoice it made under "Billed to
the customer", and `GET /v1/claims/{id}` carries it as `billedInvoice`, with
`billOn` saying whether the rest can be billed now and for how much, or why not.
It is audited as `claim.billed_on` with the amount.

**Explicit and per claim, never automatic.** Whether a homeowner owes what their
warranty would not pay is a conversation, so nothing bills it by itself and there
is no button for several claims at once. It is refused, in core's words
(`claims.billOn`, with unit tests):

- while the payer has not finished with the claim: it has to be paid (what they
  agreed, which may be less than was claimed), short paid or denied;
- while the payer's own invoice still shows the money owing: credit it or write it
  off on their invoice first (a credit when their schedule never covered it, a
  write off when they simply will not pay), so the same money is never owed by two
  people, and never counted as revenue twice once the homeowner's invoice is issued;
- when the claim has already been billed on;
- when there is nothing left: they paid everything that was claimed.

A draft deleted, or an invoice voided, no longer stands, and the claim can be billed
on again. Sent again with the same idempotency key, it answers with the claim as it
was billed rather than making a second draft.

**Two judgements the product owner has not made, and the conservative reading
taken.** The payer's invoice has to be settled first rather than the shortfall
being moved off it by this button, because how it leaves (a credit or bad debt) is
an accounting decision the office makes on that invoice. And the line is not
taxable and names the customer as who pays it: what was claimed already carried the
tax charged on the work, and the job's coverage must not take its share off again.
Both can be changed on the draft.

### Find out what free work cost

`bySource` counts jobs and value by coverage source, and separates work the
company absorbed from work somebody else is paying for. That is the only way
"we did too much free work last quarter" becomes a sentence with a cause
attached to it.

## Permissions

Resolving coverage needs `job:write`, because it is a decision about the job. Recording that a unit was registered with its maker needs `equipment:write`, not the task permissions, because the person who registers a unit is usually the technician who installed it, and the register is theirs to write (M04); it closes only that unit's registration deadline. Taking a registration back needs `equipment:write` and `task:write`. Reading the makers needs `pricebook:read`; adding, changing and retiring one needs `pricebook:write`.
Quoting needs `invoice:read`. The coverage report needs
`report.financial:read`, because it is a revenue number. Filing a claim,
recording its decision and billing the rest to the customer need `invoice:write`;
recording their payment needs `payment:collect`.

## Not built

No claim is submitted to anybody's system: filing records that the claim was
made, with their reference, and the submission itself happens in the warranty
company's or manufacturer's portal. What a payer did not pay is billed on
to the customer only when somebody presses "Bill the rest to the customer" on one
claim, as a draft: never automatically and never for several claims at once, because
whether the homeowner owes it is a conversation. The shortfall stays on the third
party's invoice until somebody credits it or writes it off there, and the button
waits for that rather than moving it, because how it leaves that invoice is an
accounting decision. The line it makes is untaxed whatever the work was; the office
changes that on the draft when the customer's part should carry tax.
Coverage read from a unit covers what the dates say and nothing about why: a
warranty voided by an unlicensed install is not something the dates know.

The maker's days are one number per maker: a maker who gives different days for different
models still needs a maker row for each (or the item's own days on the exceptions, which a
maker with no days leaves to the item). A maker with no days is read as "ask the item", never
as "this maker asks for nothing". The deadline asks for a day and a reference and nothing more:
no registration is sent to the maker's portal, and the product cannot tell whether the
registration was real. The deadline starts from the day a serialised part was used on a job,
which is not necessarily the day the unit was switched on, and a unit added to the register by
hand or an item not tracked by serial raises none. A maker's days changed later move no
deadline that is open. Taking a registration back reopens only the deadline that the
registration closed, and not a waived or cancelled one: a unit whose deadline was waived and
then registered by mistake is corrected to unregistered with no deadline, which the office
raises by hand if it wants one.
