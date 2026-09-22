# Build Plan

> The execution plan. `docs/concepts/invariants.md` holds the rules; this holds
> the order. Strategy, market and module specification live in the planning
> repository.
>
> Status is updated as things land. If this document and the code disagree,
> the code is right and this is stale.

---

## Where we are

| | State |
|---|---|
| Schema | 14 files. Residential through commercial, franchise, regulated inspection, commodity delivery |
| Domain logic | Access control, money |
| API | Not started |
| Web app | Not started |
| Mobile | Not started |
| Worker | Not started |

The foundation is broad and nothing runs. The next milestone is deliberately
narrow: one slice, end to end, through a real API and a real UI.

---

## Ordering rules

Three rules decide what gets built when, and they have already been paid for
once each.

1. **Anything that changes the shape of a record comes before anything that
   reads it.** Every schema decision that arrived through research went in
   before `apps/web` existed, because the alternative was rewriting invoicing,
   communications and the portal. That window closes the moment the app reads
   the schema.
2. **A vertical slice beats a horizontal layer.** Ten half-built modules
   demonstrate nothing and cannot be tested against a real business. One
   complete path from booking to payment can.
3. **The API comes first, always.** The web app consumes the same surface a
   third party gets. Every embed, agent and integration depends on that being
   true from the start rather than retrofitted.

---

## Phase 0: Foundations

**Goal:** a contributor clones the repository and reaches a working login.

| Item | State |
|---|---|
| Monorepo, pnpm and Turborepo, strict TypeScript | Done |
| Schema, 14 files, typechecked | Done |
| Row level security off the catalog, with a coverage assertion | Done |
| Ledger append only and balance triggers | Done |
| pgTAP tenant isolation tests | Done |
| Access control: 90 permissions, 9 roles, scoping, field redaction | Done |
| Money: exact decimals, allocation that reconciles | Done |
| Docker Compose: Postgres, Redis, MinIO | Done |
| CI: lint, typecheck, test, RLS suite | Done |
| Generated migrations from the schema | Not started |
| Seed data and a first trade pack | Not started |
| `packages/api`: contracts, OpenAPI, service layer | Not started |
| Auth, sessions, tenant context in a request | Not started |
| `packages/ui`: design system in code | Not started |
| `apps/web`: shell, navigation, auth screens | Not started |
| Company setup wizard | Not started |

**Done means:** `docker compose up`, sign up, create a company through the
wizard, land in an app shell with a seeded price book.

---

## Phase 1: The first slice

**Goal:** a real job goes from booked to paid, in the product, by a person.

Customers and properties. Contacts. The price book. A job with visits. A
calendar that is honest about being basic. An invoice. A Stripe payment. The
ledger entries behind it reconciling.

Nothing else. No dispatch board, no mobile app, no estimates, no memberships.
Those are the next phases and they will be tempting.

**Done means:** a person who has never seen the code can create a customer,
book a job, complete it, invoice it, take a card payment, and see the money in
a report that agrees with the ledger to the cent.

---

## Phase 2: Sell and self serve

Estimates with good, better, best. E-signature. Deposits. The customer portal
with the visit timeline. The public booking widget against real availability.

**Done means:** a customer approves an estimate and books a job without anyone
in the office touching it.

**Done.** The sell path runs end to end against Postgres. A company publishes
what it will let the public book and on what terms; the widget offers only
windows derived from business hours, time off and what is already sold, and
re-checks the slot inside the transaction that writes the request. An estimate
carries good, better and best with optional lines priced separately; sending
it freezes the document by hashing it and issues a single use grant; the
customer chooses, signs and the signature records the hash, the address and
the moment. Approval converts to a job and an invoice as a copy, never a
re-price. Deposits are a liability from arrival and post distinctly on receipt,
application, refund and forfeiture.

Not in this phase, and named so nobody assumes otherwise: the technician's
view of a job, the dispatch board, and the office UI for estimates. The
service layer and the customer-facing pages are built; the internal pages that
sit on top of them are Phase 3, which is where the board they belong on
arrives.

---

## Phase 3: The field

The Expo technician app. Offline first, with writes as named intent operations.
Timeclock with classification captured at the punch. Photos, signatures,
service reports. The dispatch board. Route ordering. On my way notifications.

**Done means:** a technician runs a full day from a phone with no signal in a
basement, and everything they did is in the system when they surface.

---

## Phase 4: Alpha

Hardening. Trade packs for the first six trades. The Jobber and Housecall Pro
migration adapters. Three design partners running real jobs.

**Done means:** three companies are running their actual business on it.

This is the real go or no go. If three partners will not run real jobs on it,
the problem is the product.

---

## Phase 5: Finance depth

Job costing. Purchase orders, vendors, inventory and truck stock. Two way
QuickBooks and Xero sync, change data capture based. Commissions and payroll
export. The reporting layer and custom report builder.

**Done means:** a company closes a month in it.

---

## Phase 6: Growth engine

Memberships and agreements. Communications infrastructure: voice, SMS, email,
with 10DLC walked through in setup. Marketing operations, ad spend ingestion,
call tracking, attribution through to collected revenue. Reviews.

**Done means:** recurring revenue and marketing attribution work end to end.

---

## Phase 7: Commercial and platform

The commercial spine the schema already anticipates: contracts and rate cards,
SLA clocks, authorisations, external work order sync starting with the best
documented facilities network. Projects. Inspections and the deficiency
backlog. Multi location and multi brand. The public API, webhooks, SDKs, the
MCP server, custom objects and the workflow builder.

**Done means:** a third party builds on it without asking us, and a commercial
contractor can run facilities work through it.

---

## Phase 8: Agents

The intake agent on LiveKit. The chat agent. Embeddable surfaces. Then the
dispatch copilot, estimate drafter, collections and field assistant.

Deliberately late. An agent grounded in a half finished price book, against a
dispatch board that does not know real capacity, is a demo, and this category
has enough of those.

**Done means:** the agent answers at 9pm and the job is on the board by 9:03pm.

---

## Phase 9: v1.0

The remaining trade packs. The ServiceTitan import path. Self host polish.
Documentation completed. Public launch.

---

## What is deliberately not being built

Saying this out loud is cheaper than discovering it in a pull request.

| Not building | Instead |
|---|---|
| Payroll processing | Export to Gusto, ADP, Paychex, QuickBooks Payroll |
| Insurance estimating | Import an estimate produced elsewhere |
| Construction ERP, heavy civil | Stay in service, install and light construction |
| A lead marketplace | Connect to the ones that exist |
| State by state lien law determinations | Record the dates, do not author the rules |
| Tax rate determination | Pluggable, with a commercial provider as an option |
| Being a bank | Stripe |
