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
`Invoices > Claims` (`/invoices/claims`) lists them, waiting first.

### Find out what free work cost

`bySource` counts jobs and value by coverage source, and separates work the
company absorbed from work somebody else is paying for. That is the only way
"we did too much free work last quarter" becomes a sentence with a cause
attached to it.

## Permissions

Resolving coverage needs `job:write`, because it is a decision about the job.
Quoting needs `invoice:read`. The coverage report needs
`report.financial:read`, because it is a revenue number. Filing a claim and
recording its decision need `invoice:write`; recording their payment needs
`payment:collect`.

## Not built

No claim is submitted to anybody's system: filing records that the claim was
made, with their reference, and the submission itself happens in the warranty
company's or manufacturer's portal. A short payment is not billed on to the
customer automatically; whether the homeowner owes it is a conversation, and
the shortfall stays on the third party's invoice until somebody decides.
Coverage read from a unit covers what the dates say and nothing about why: a
warranty voided by an unlicensed install is not something the dates know.
