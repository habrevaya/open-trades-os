# Build Plan

> The execution plan. `docs/concepts/invariants.md` holds the rules; this holds
> the order. Strategy, market and module specification live in the planning
> repository.
>
> Status is updated as things land. If this document and the code disagree,
> the code is right and this is stale.

---

## Where we are

**Phases 0 through 3 are done. Phase 4 is in progress.**

| | State |
|---|---|
| Schema | 14 files. Residential through commercial, franchise, regulated inspection, commodity delivery |
| Domain logic | Access control, money, estimates, the ledger, the field operation model |
| API | Every declared route is served, over HTTP, at `/api/v1`. Booked-to-paid, the sell path, dispatch, field sync, properties, the price book and job editing |
| Web app | Dispatch board, a technician's day, the customer portal: proposal, tracking, booking |
| Mobile | The technician's day runs as a web page on the phone they already have. The Expo app is not built |
| Worker | Not started |
| Trade packs | 8 shipped: HVAC, plumbing, electrical, lawn and landscape, pest control, cleaning, dumpster rental, trash bin cleaning |
| Migration | Jobber and Housecall Pro read. Extract, profile and reconcile work. Nothing writes to a target yet |
| Demo | `pnpm db:seed` builds a company with a day of work in it, and the product screenshots come from it |
| Comms | Schema and the consent decision. Phone numbers, conversations, messages, calls, per-purpose consent, carrier registration. No provider adapter yet |
| Multi location | Tables, columns and scope filters exist. No shipped role uses a branch or shop scope yet, and scope is applied to job reads only. `docs/concepts/multi-location.md` |

A company cannot yet be run on this. The gap to Phase 4 done is not a feature
list, it is three design partners willing to put real jobs through it.

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

**Mostly done.** The offline model is built and tested: writes are named
intents rather than row diffs, ordered per device, clamped for clock drift and
reconciled per kind, so work done against a visit the office cancelled is
recorded AND flagged instead of silently winning or silently lost. The queue on
the client is its own package with an injected storage backend, so the app
being killed, the battery dying mid-write and a response truncated by a dropped
connection are all tested in a millisecond rather than staged on a device.

The technician's day runs in a browser, which is what a self hoster can deploy
today without an app store. The dispatch board, route ordering, assignment and
on-my-way are built. Every operation kind writes something outside the log, and
a test fails if one stops.

Not done, and named so nobody assumes otherwise: the Expo app, which adds
background sync, reliable camera capture and a home screen icon; photo and
signature bytes, which are recorded and queued but have no upload path yet; and
true offline page loads, which need a service worker. A technician with no
signal can record a day on a page already open; they cannot open the page.

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

---

## Reproducing the product screenshots

Every screenshot on the website is the running application against the seeded
demo company, and these three commands regenerate all of them.

```
TZ=America/Chicago pnpm db:seed | tee /tmp/seed.txt
TZ=America/Chicago pnpm --filter @opentradesos/web dev &
pnpm screenshots --seed-output /tmp/seed.txt --out ./shots
```

`TZ` is not a detail. The seed builds the demo day around the current hour and
the app renders every time in the company's own timezone, so running both in
that zone is what produces a working day rather than one starting at half past
six in the evening. `SEED_NOW` pins the clock if you want a specific hour.

The capture fails rather than writing a screenshot of an error page, and it
treats a redirect as a failure too: a stale session redirects to sign in, the
sign in page answers 200, and checking the status alone once captured a login
form and labelled it the dispatch board.
