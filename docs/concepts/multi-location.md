# Multi location

A company with three branches is not three companies, and it is not one
company with a bigger customer list. It is one tenant with internal walls, and
almost every hard question about it is a question about where those walls run.

This document says what is built, what is not, and which decisions are still
open. It is written because the schema has carried the columns for a while and
that reads as more support than actually exists.

## Two different things, deliberately separate

**Business unit** is a P&L. HVAC and Plumbing inside one company, or Austin
and Houston as separate books. It is what revenue is reported under, what a
branch manager is measured on, and what the ledger tags every entry with.

**Location** is a building. A shop, a warehouse, a yard. It is where a truck
is parked overnight, where stock sits, and where a visit is dispatched from.

They are not the same and collapsing them costs you the first time a company
has two shops inside one P&L, or one shop serving two P&Ls. Both are real and
common.

A third, **territory**, is a geography: the area a route or a bookable service
covers. It is not an organizational wall and it is not in scope here.

## What is built

| | State |
|---|---|
| `business_unit` and `location` tables | Yes |
| `business_unit_id` on job, invoice, ledger entry, job type, crew, agreement plan, timeclock entry, business hours, on call rotation, bookable service | Yes |
| `location_id` on visit and membership | Yes |
| `Actor` carries `businessUnitId` and `locationId`, resolved with the session | Yes |
| Scope ladder includes `business_unit` and `location` | Yes |
| Job reads filter by branch or shop when the scope asks for it | Yes, `services/scope.ts`, the list and now a job opened by its id or edited |
| A screen to make branches and put people and work in them | Yes, Settings, Branches and Settings, Team |
| A role that USES the branch scope | Yes: the Branch manager preset, and a role made on Settings, Roles ("their branch's work") |
| A role that uses the shop (location) scope | Yes, made on Settings, Roles ("their shop's work"), with somebody's shop set on Settings, Team |
| Per-membership scope overrides | Yes, and they can only narrow |
| Scope applied to customer, invoice and estimate reads | Yes |
| Scope applied to the visits report dataset | Yes, through the visit's job |
| Scope applied to the dispatch board, the map, service reports, timesheets and time off | Yes |
| A branch filter on the job, customer, invoice and estimate lists and on reports | Yes, for people who see the whole company; it narrows and never widens |
| Reports grouped by branch | Yes, a Branch column on the jobs, invoices, estimates, visits and job profitability datasets |
| Numbering, sequences and documents per branch | One sequence per company, decided; a branch's code can be printed in front of new job and invoice numbers, as a company setting |
| Cross branch elimination | **No** |

## The bug this came out of

`jobs.list` resolved the scope and then only knew how to apply `own`. Every
other scope fell through to no filter at all, which meant the whole
organization.

Worse, `customers`, `billing` and `estimates` resolved no scope at all, while
the comment on the technician row in `core/access/scopes.ts` said customer
scope was "what stops a departing technician walking out with the customer
list". It was not stopping anything: a technician could page the entire
customer book, every invoice and every estimate.

None of that was hypothetical. `technician` and `crew_lead` are both shipped
roles. The permission tests all passed, because the permission was never the
problem.

The fix is in `services/scope.ts` and the rule it enforces is **fail closed**:
a scope that cannot be turned into a filter matches nothing. An account that
sees nothing raises a ticket within the hour. An account that sees everything
is found during an incident, if it is found.

## What was decided when the branch scope shipped

A branch on the screens is a business unit. The two answers below that
changed code are in `services/branches.ts` and the `app.default_job_branch`
trigger in `packages/db/sql/after.sql`.

**Where a job's branch comes from.** Whoever books it chooses, and if they do
not, it takes the branch of the person saving it, then the branch its job type
belongs to, and otherwise none. A trigger, because eight services insert jobs
and none of them chose a branch. A job with no branch belongs to nobody's
branch: only people who see the whole company see it, and Settings, Branches
counts those jobs and moves them in bulk. A branch scoped person can only put
work in their own branch; moving work between branches is for somebody who sees
the whole company, because a job moved out of your branch is one you can no
longer see.

**Numbers.** One sequence per company. Austin's invoices have gaps in them. A
company that wants to tell them apart at a glance turns on branch codes
(Settings, Branches): a new job or invoice in a branch is printed with its
code in front ("AUS-1042"), written onto it when it is made and never worked
out again, so nothing a customer already holds is renumbered.

**One job, two branches.** One job carries one branch. A Houston crew on an
Austin job puts the revenue in Austin and the labour on Houston's people.

**A technician at two locations.** Unchanged: a membership carries one branch
and one location.

**The price book by branch.** Company wide.

**Consolidated numbers.** A report is scoped like every read, so a branch
manager's reports are their branch's; somebody who sees the whole company
sees everything, and can narrow any report to one branch or group it by
branch.

**A customer's branch.** A customer has none of their own. They belong to the
branches that have done work for them, so a customer a branch manager has
just added does not appear in their customer list until a job is booked for
them (they can still open the customer they just made).

## The questions as they were asked

These were the open questions before any of the above was decided, kept
because each answer changes the data model or what a number means.

**Where does a job's business unit come from?** Today it is a nullable column
nobody sets. The candidates are the job type, the technician assigned, the
property's territory, or the booking channel. Whichever is chosen, an existing
job with a null branch has to mean something, and "belongs to no branch" is a
row that a branch scoped manager will never see.

**Are invoice and job numbers per branch or per company?** Per branch is what
most multi location companies expect and it means the sequence generator needs
a scope. Per company is simpler and means Austin's invoices have gaps in them,
which accountants ask about.

**Can one job be served by two branches?** A Houston crew covering an Austin
job on a busy week is normal. If the job carries one business unit, the
revenue lands in Austin and the labour cost lands in Houston, and somebody has
to decide whether that is correct or whether it needs a transfer.

**What does a technician at two locations look like?** `membership` carries one
`location_id`. A relief technician covering two shops either needs several
memberships or a different shape.

**Does the price book differ by branch?** Austin and Houston genuinely charge
differently. Price book items are org wide today. A per branch override is a
version dimension, and version dimensions multiply.

**Who sees consolidated numbers?** A branch manager sees their branch. An owner
sees the whole company. The reporting layer has no concept of either yet, so
this is a decision to make there rather than one to retrofit.

## The rule, whatever is decided

Scope is not permission. A permission answers whether an account may read jobs
at all, and it fails loudly in one place. A scope answers which jobs, and when
it is resolved and then not applied it returns everything while every
permission test still passes.

So any read that can be scoped resolves its scope through `scopeOf` and turns
it into a filter through `services/scope.ts`, and any scope that file cannot
satisfy matches nothing.

Everything in that file reduces to one predicate, `jobVisibility`, because
"which customers" and "which invoices" are both "which jobs did this person
actually work". Writing the reduction once is what stops the four filters
disagreeing about what `own` means, which is how this kind of code usually
rots: the job filter gets tightened and the invoice filter does not.

`visit`, `servicereport` and `timesheet` were declared scopable and read
unscoped for a while. They are applied now: the board, the map and its
suggestions read visits through `jobVisibility`, a service report through its
job, and a timesheet (and time off) through the person it belongs to
(`technicianScopeFilter`), because a timesheet is a person's rather than a
job's. People are scoped by where they belong: a branch, a shop (their day
starts there or their membership names it), a crew, or themselves. Somebody
from another branch appears on a branch's board only on that branch's visits.

A shop scope reads a visit as the shop's when it says so or when somebody or
a crew based at the shop is on it, because nothing writes a visit's own shop
yet, and a scope that matched only that would match nothing.
