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

**A permission is a string, and a role is a set of them.** There are 123
permissions, each one a resource and an action joined by a colon, and ten role presets over that
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
in a branch, gives anybody who goes out to jobs a place on the board, emails
them a link to choose a password, and shows the inviter a link of their own,
once), sending a new invite to somebody who has not signed in
(`POST /v1/invitations/{membershipId}/resend`), changing a role
(`POST /v1/memberships/{membershipId}/role`), moving somebody to another branch
or shop, and turning somebody off. `/settings/roles` makes a custom role for a
company whose shape the ten presets do not fit, and the same is on the API:
`GET` and `POST /v1/roles`, `PATCH /v1/roles/{id}`, `POST /v1/roles/{id}/remove`,
and `POST /v1/memberships/{membershipId}/custom-role` to give somebody one, which
takes `user:write` and is checked both ways as a preset change is. A role bigger
than its author (a permission they do not hold, or seeing further than they do)
is refused with a 403 carrying the sentence the screen shows and the
permissions or records it was about. A role made on the roles screen before "the whole
company" was saved as a scope names none, so its holders have been seeing their
own work only: `/settings/roles` lists those roles as ones to check and gives
one the whole company (`POST /v1/roles/{id}/whole-company`) when the owner ticks
that this is what it was for. Seeing the list needs `user:read`, inviting needs `user:invite`,
changing a role needs `user:write` and defining a custom role needs
`role:write`. Each of those is separate because they are four different
decisions, and the person who corrects a job title is not always the person who
may grant access to payroll.

## Using it

### Get the next person in

An invite is emailed through the same outbox as every other email, and the
inviter is shown a link of their own, once, for when it lands in spam. Both
work for seven days. The email's link is never in the outbox: everybody who
reads the inbox can read the outbox, and a link that chooses a new
colleague's password sitting in a dispatcher's inbox is a way into an
account they were never given. So the stored email says where the link goes,
and the outbox makes a fresh one at the moment it hands the email to the
provider (`app.issue_invite_email_token`, which refuses unless that invite's
email is being sent right then). With no email provider connected the invite
is still made and the team list says it was not emailed and why.

Somebody who has not signed in says on the team list whether their invite was
emailed and until when it works. One that ran out is sent again with "Send a
new invite", which retires every link the old one had.

### Decide what a role may do

The ten presets are starting points, documented by what they deliberately
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
(`POST /v1/memberships/{membershipId}/branch`).

The Branch manager preset is an office manager for one branch: the office
manager's permissions, with every scoped record limited to their branch. So
is a role made on `/settings/roles` with "their branch's work". Either sees
the jobs in its holder's branch and the customers, invoices, estimates,
conversations and reports (visits counted in a report included) that hang off
them, and nothing else: not in a list, not by opening a job's address, not in
a report grouped by branch, not in the records behind a number. The dispatch
board, the map and its suggestions and rebalance, service reports, timesheets
and the time off queue are theirs too: their branch's jobs' visits, their
branch's people, and somebody from another branch only on a visit of theirs.
They cannot be given that role without a branch, cannot have their branch
taken away while they hold it, can only put work in their own branch, invite
only into it, and cannot hand out a preset that sees the whole company.

Their people are their branch's too. The technicians screen
(`GET /v1/technicians`), crews (`GET /v1/crews`), routes
(`GET /v1/service-routes`), Team (`GET /v1/team`), People (`GET /v1/people`,
`GET /v1/roster`) and the phones list show the people whose branch is theirs,
the crews in their branch, and the routes those people and crews run. Another
branch's technician, crew, route or person opened or changed by its id reads as
not found, and putting one on a visit, a crew or a route is refused in the
words an id that is not there gets, so the refusal says nothing about who
works elsewhere. On the board and the map somebody from another branch covering
one of theirs is drawn for that visit only and marked as from another team;
nothing more can be dropped on their day, and "Suggest who", the rebalance of
one day or several and a proposed route offer only their own people and crews.
The dispatch side (technicians, crews, routes) reads the visit scope and a
person's record (Team, People, a person by id) the timesheet scope; every
preset and every role made on Settings, Roles sets both the same. A
connected app or a role written through the API that states scopes and names
none for those reads people at the narrowest scope it does state, so it sees
no more people than work; one that states none at all sees nobody. Moving a
person or a crew between branches is for somebody who sees the whole company.

A branch's short code can be printed in front of new job and invoice numbers
("HOU-1042"), turned on for jobs and invoices separately on Settings,
Branches (`GET` and `PUT /v1/branch-numbering`). Numbers stay one sequence for
the company; the code is written onto the job or invoice when it is made and
never worked out again, so numbers already given out keep what they were
printed with whatever changes later. A code of up to eight letters and digits
can be printed; the screen names the branches whose code cannot. It is printed
wherever the number is: the job and invoice screens and lists, the invoice PDF
and its file name, the statement's lines and open invoices on screen and in its
PDF, the invoice email's subject and body, a collection reminder, a message
template quoting `{{ job.number }}`, and the customer's account, invoice link,
job link and the payer's page on the portal.

### Limit somebody to a shop

A shop is a location: a building rather than a branch. Somebody's shop is set
on Team (`POST /v1/memberships/{membershipId}/location`), and a role made on
`/settings/roles` with "their shop's work" sees the jobs worked from it (a
visit by somebody based there, whose day starts there or whose shop it is, or
by a crew based there) and the people based there. Their shop cannot be taken
away while that role holds them to it.

A visit's own shop (`visit.location_id`) is written when it is booked with
somebody or assigned: the lead's start, otherwise the shop their membership
names, or the crew's base, otherwise its lead's. The job and visit pages say
where it goes out from, and the shop scope reads it once written, so a
technician who moves shops does not take the work they did with them. Visits
booked before it was written carry none and were not filled in; the shop scope
reads those through their people and crews, as before.

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
| Branch manager | The office manager's, for their own branch's work and people only |
| Dispatcher | The board. Assign, sequence, reschedule. Nothing that touches money |
| CSR | Books work and talks to customers. Cannot dispatch |
| Technician | Their own work, their own time, no cost or margin |
| Crew lead | A technician whose scope is the crew rather than themselves |
| Accountant | The ledger, payroll, reconciliation. No dispatch |
| Read only | Looks, touches nothing |

Everybody holds `profile:own` and `payroll:own`: their own staff record and
their own pay statements (M24 and M17), and nobody else's.

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

The company's own roles are `GET` and `POST /v1/roles`, `PATCH /v1/roles/{id}`,
`POST /v1/roles/{id}/remove` and `POST /v1/roles/{id}/whole-company`, all
`role:write`, and `POST /v1/memberships/{membershipId}/custom-role`, which needs
`user:write` and `membership:write`.

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

Multi location: branches, the Branch manager preset, a branch scope and a
shop scope on a custom role, branch filters, the people, crews and routes a
branch manager sees, a visit's own shop and branch codes on numbers are built
(above). Job and invoice numbers are one sequence per company and the price
book is the same in every branch: numbering per branch and a price book per
branch are product decisions nobody has made, so neither is built. A job
carries one branch. There is no job PDF to print a code on, and a proposal
shows only the estimate's own number, which carries no code; the payer's CSV
and XML files keep the bare invoice and job numbers in their columns, because
a payer's system matches on them. A role made on the roles screen before "the
whole company" was saved as a scope names none and shows its holders their
own work only until somebody gives it the whole company on Settings, Roles
(`POST /v1/roles/{id}/whole-company`); nothing is changed for anybody without
that click, because such a role cannot be told apart from one meant to show
only their own work. `roles.assign` underneath is guarded by
`membership:write`, the permission the presets give for selling service
agreements; every screen and route that gives somebody a custom role goes
through `assignCustomRole`, which adds `user:write` and the both ways check.
`docs/concepts/multi-location.md` lists what remains. `billing:manage` is
declared and nothing checks it, because this product has no subscription to
manage; it exists for a hosted deployment that does.
