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

### Find out what to charge

`quote` splits the job between the customer and whoever is covering it,
applying the percentage, the cap and the deductible in that order.

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

### Find out what free work cost

`bySource` counts jobs and value by coverage source, and separates work the
company absorbed from work somebody else is paying for. That is the only way
"we did too much free work last quarter" becomes a sentence with a cause
attached to it.

## Permissions

Resolving coverage needs `job:write`, because it is a decision about the job.
Quoting needs `invoice:read`. The coverage report needs
`report.financial:read`, because it is a revenue number.

## Not built

The customer's share is computed by `quote` and not yet subtracted
automatically at invoicing: a percentage, a cap or a deductible is recorded
and applied by the person writing the invoice. Billing the third party, which
is where a home warranty rate card and a manufacturer claim actually get paid,
belongs to M31 and is not built. Neither is resolving coverage from an
equipment warranty record, which would need the warranty dates the schema has
and nothing writes.
