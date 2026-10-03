---
title: Core, Tenancy and Access
module: M01
domain: Foundation
phase: 0
status: partial
---

# Core, Tenancy and Access

> Module M01. Domain: Foundation. Ships in phase 0.

## What it does

Decides, for every single read and write in the product, which company the
data belongs to and whether the person asking is allowed to see it. Everything
else in this repository is built on the assumption that those two questions are
already answered, which is why this is module one.

## The problem

Two failures live here and they are not the same size.

A company seeing another company's customers is the end of the product. A
technician seeing their own company's margin is a bad afternoon. Collapsing
both into one permission system means the catastrophic failure is as easy to
cause as the annoying one, so they are two separate mechanisms:

| Mechanism | Guarantees | Where it lives |
|---|---|---|
| Row level security | The tenant boundary, unconditionally | Postgres, forced on every table carrying an organization |
| Permissions and scopes | Who, inside one company, sees what | `packages/core/src/access` |

The boundary one is enforced by the database and cannot be reasoned around by
application code that forgot a `where` clause. The other one is application
logic, and a bug in it is contained to one company.

## Key concepts

**One organization is one tenant.** Every table that holds company data
carries `organization_id`, row level security is `FORCE`d on it, and the policy
reads a session variable the request sets. A query written without a tenant
filter returns nothing rather than everything, because the database applies
the filter whether or not the developer did. `pgTAP` tests assert the policy
exists on every such table, off the catalogue, so a table added next year is
covered the day it is added rather than the day somebody remembers.

**An actor is not a user.** A signed in person, a connected application and an
AI agent are the same type. That is deliberate: an agent must never be able to
do something the credential behind it could not do on a screen, and the only
reliable way to guarantee that is to give it no separate path. The worker, the
scheduler, the outbox and a workflow run also act as somebody, and that
somebody is a named system actor rather than a literal nobody, because an event
row has a foreign key and the nil uuid is not a user.

**A permission is a string, and a role is a set of them.** There are 107
permissions, each one a resource and an action joined by a colon, and nine role presets over that
list. A role is never a parallel concept with its own special cases: it is a
named set, which keeps every authorization decision a set membership check.
A company can build a role nobody anticipated without this project shipping
code.

**A membership adds and removes rather than replaces.** Grants widen a preset,
revocations narrow it, and revocation always wins. That keeps a preset
meaningful after somebody customizes it: an office manager who also does
payroll is still an office manager.

**Field level permissions exist because of one universal requirement.** A
technician must be able to open a job and read the price, and must not be able
to read the cost or the margin. Every platform that treats permissions as
purely resource level ends up either leaking margin to the field or building a
second, worse interface for it. Nineteen named fields are redacted by rule:
cost and margin on an estimate option, `unitCost` on a job, invoice or estimate
line, a customer's balance and standing discount, a wage scale's rates and the
rates actually applied to a shift. A rule naming a field that does not exist
fails a test, in both directions.

**Scopes answer "which records", which is a different question.** Five values,
widening in this order: own, crew, location, business unit, all. Eight
resources are meaningfully scopable: jobs, visits, customers, estimates,
invoices, timesheets, service reports and conversations. A technician reads
their own work and the customers they have actually been sent to, which is what
stops a departing technician walking out with the customer list. A conversation
is scoped separately from a customer on purpose: it contains what somebody
said, which is more sensitive than their address, and a technician holds
`message:send` because they text from the field.

**Multiple roles widen, an override only narrows.** Roles combine first, then
an administrator's per resource override is applied as a ceiling. The order is
the whole security property: applying the override inside the combination would
let a second role widen back past it, so an administrator who restricted
somebody to their own jobs would find that adding a dispatcher role quietly
undid it.

## Setup

The sign up flow creates the user, the organization and the owner membership
together, then hands off to the wizard in M02. There is no step where a company
exists without an owner.

Afterwards, `/settings/team` is where people are managed: inviting somebody
(`POST /v1/invitations`, which makes the person with a preset role, puts them
in a branch, gives anybody who goes out to jobs a place on the board, and hands
back a one time link to choose a password), changing a role
(`POST /v1/memberships/{membershipId}/role`), moving somebody to another branch,
and turning somebody off. `/settings/roles` makes a custom role for a company
whose shape the nine presets do not fit. Seeing the list needs `user:read`, inviting needs `user:invite`,
changing a role needs `user:write` and defining a custom role needs
`role:write`. Each of those is separate because they are four different
decisions, and the person who corrects a job title is not always the person who
may grant access to payroll.

## Using it

### Decide what a role may do

The nine presets are starting points, documented by what they deliberately
exclude. An administrator gets everything except payroll, the ledger, billing
and bulk data movement, which have to be granted explicitly rather than
arriving with the job title. A dispatcher gets the board and nothing that
touches money. A technician gets their own work, their own time, and no cost or
margin.

### Restrict somebody to part of the company

Set a scope override on their membership. It can only take access away. The
column for this existed for a while with nothing reading it, which meant an
administrator who set one believed they had applied a restriction and had not;
that is now the behaviour the tests assert rather than a comment.

### Divide the company into branches

`/settings/branches` makes a branch (a business unit underneath), renames and
retires one, and moves the work that is in no branch into one, in bulk
(`POST /v1/branch-assignments`). A person is put in a branch on Team
(`POST /v1/memberships/{membershipId}/branch`). On `/settings/roles`, a role
made with "their branch's work" sees the jobs in its holder's branch and the
customers, invoices, estimates, conversations and reports (visits counted in a
report included) that hang off them, and nothing else: not in a list, not by opening a job's address, not
in a report grouped by branch, not in the records behind a number. A branch
manager cannot be given that role without a branch, cannot have their branch
taken away while they hold it, and can only put work in their own branch.

A job saved without a branch takes the branch of whoever saved it, then its
job type's, and otherwise none; a job in no branch is seen by the people who
see the whole company. The job, customer, invoice and estimate lists and every
report have a branch filter for those people (`GET /v1/branches` lists the
names); it narrows and never widens. `docs/concepts/multi-location.md` has the
decisions behind each of these.

### Find out who did something

`GET /v1/audit` reads the audit log and `GET /v1/audit/history` reads one
record's history. Both need `audit:read`. When an agent acted, its id is on the
entry beside the credential it acted as.

## Permissions

| Role | Access |
|---|---|
| Owner | Everything, including payroll, the ledger and the subscription |
| Administrator | Runs the system. Payroll, the ledger, billing, export and import are excluded and must be granted |
| Office manager | Customers, jobs, invoicing, purchasing, the schedule, and cost visibility |
| Dispatcher | The board. Assign, sequence, reschedule. Nothing that touches money |
| CSR | Books work and talks to customers. Cannot dispatch |
| Technician | Their own work, their own time, no cost or margin |
| Crew lead | A technician whose scope is the crew rather than themselves |
| Accountant | The ledger, payroll, reconciliation. No dispatch |
| Read only | Looks, touches nothing |

Eight permissions are grouped as sensitive, so a company building a custom role
can reason about the blast radius in one place: `pricebook.cost:read`,
`job.cost:read`, `customer.financials:read`, `payroll:read`,
`commission:read`, `ledger:read`, `report.financial:read` and `data:export`.

## API

Authentication and session handling are app routes rather than `/v1` surface,
because a browser session is not a thing an integration holds. What is on the
API is the administrative read side: `GET /v1/people` needs `user:read`,
`POST /v1/memberships/{membershipId}/active` needs `user:write`, and the
organizational shape a company is divided into (`GET /v1/locations`,
`GET /v1/business-units`, `GET /v1/territories`) is `settings:read` to read and
`settings:write` to change.

Every route in the product declares its own permission list in the contract
registry, and a guard test fails if a route is served without one. That is why
there is no table of "protected endpoints" here: there is no other kind.

## Common questions

**Can a company be moved between deployments?** Yes, through M30. Every table
carrying an organization is exportable, read off the database catalogue.

**What happens to a suspended company?** Its people land on a page that says
so, and the network roll up in `docs/concepts/networks.md` excludes it. The
data is untouched.

**Why is there no API key permission?** Because there are no bare API keys.
M26 issues a token to a connected application with its own permission list,
its own audit attribution and its own revocation, so "who may call us" is
answerable without anybody holding a string equivalent to a password that
belongs to nobody in particular. `integration:write` guards connecting an app,
issuing its token and revoking it, because those are one decision.

## What is not built

Multi location: branches, a branch scope on a custom role, and branch filters
are built (above). No preset role is branch scoped, so a branch manager is a
custom role. Job and invoice numbers are one sequence per company, the price
book is the same in every branch, a job carries one branch, a location (a
building) scope is still only reachable through the API, and the dispatch
board, service reports and timesheets are not yet narrowed by branch.
`docs/concepts/multi-location.md` lists what remains. An invite link is shown
to the inviter rather than emailed. `RoleEscalationError` from the custom roles
routes reaches an HTTP caller as a server error rather than a 403; the screens
put it in words.
`billing:manage` is declared and nothing checks it, because this product has no
subscription to manage; it exists for a hosted deployment that does.
