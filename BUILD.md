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
| Schema | 22 files. Residential through commercial, franchise, regulated inspection, commodity delivery, communications, marketing, reviews, inventory |
| Domain logic | Access control, money, estimates, the ledger, the field operation model, recurrence, automation, inspection, labor, coverage, reporting |
| API | Every declared route is served, over HTTP, at `/api/v1`. Booked-to-paid, the sell path, dispatch, field sync, properties, the price book, job editing, inventory, purchasing, time, reviews, forms, webhooks |
| Web app | Dispatch board, a technician's day, the customer portal (proposal, tracking, booking, invoice, deposit, and the customer's whole account at `/c/{token}`), and office screens for customers, projects (phases that wait for each other, a job per phase, draws raised as invoices, budget against actual), jobs (with cost against revenue on each job, for whoever may read both, and a job costing report beside the four margin reports), invoices, agreements, inventory, purchasing, certifications (who holds what until when, whether the card was seen, what is due for renewal, suspend, revoke and reinstate, and the kinds that unlock skills), timesheets, payroll (pay periods, the register with a reason on every line and the people who cannot be paid named first, close and reopen, the CSV export and recording commissions paid), reports, dashboards, automations, reviews and the inbox (threads by customer, on the customer's page too, texting a customer first, and what each number has agreed to beside the conversation; the same conversations and consent are in the API at `/v1/conversations` and `/v1/consent`). Settings → Integrations connects, changes and disconnects every built integration (Stripe, QuickBooks, Xero, Twilio, JustCall, Resend, SMTP, CallRail and the AI models), shows each one's state and webhook address, and takes secret names rather than secrets |
| Mobile | The technician's day runs as a web page on the phone they already have. The Expo app is not built |
| Worker | Built. `pnpm --filter @opentradesos/api worker` drains the event log, fires schedules, resumes waiting runs, sweeps for things that did not happen, and then sends the outbox, webhooks and accounting sync. On a host with no long running processes the same pass runs from `POST /api/internal/worker/tick`. `docs/self-hosting/worker.md` |
| Trade packs | 8 shipped: HVAC, plumbing, electrical, lawn and landscape, pest control, cleaning, dumpster rental, trash bin cleaning |
| Migration | The importer is the separate migration toolkit, which loads through `/api/v1` with an app token; nothing here imports from Jobber or Housecall Pro. The API takes history faithfully: back-dated invoices, payments, refunds and completions posted on their own dates (never into a closed period), tax as charged, invoice adjustments with a to-the-cent totals cross check, unapplied money, source document numbers, cancelled and untimed visits, `externalRef` provenance on every create with lookup on every list, people and job type lists, and file attachments. History needs the owner-only `data:import` permission. An estimate's historical status is not yet accepted. `docs/modules/m30-migration-data-portability.md` |
| Demo | `pnpm db:seed` builds a company with a day of work in it, and the product screenshots come from it |
| Automation | Event, schedule and "did not happen" triggers, conditions, waits that survive a deploy, versioned workflows, and the publish authority check, all run by the worker |
| Comms | SMS through Twilio, email through Resend or any SMTP server, inbound for both, per-purpose consent and suppression enforced on every send. `docs/self-hosting/messaging.md` |
| Payments | Stripe, on the company's own account with a restricted key. A payment is recorded only from a verified webhook, and so is a refund: a card refund reported by Stripe reopens the invoices it paid and posts to the ledger exactly as a refund recorded by hand does, dated when it was made, booked once per Stripe refund id. The emailed invoice link opens the invoice at `/i/{token}` and takes a card through Stripe's Payment Element when the company has connected Stripe with a publishable key; with no processor connected the page shows the balance and tells the customer to reply to arrange payment, because there is no other way to pay from it. An approved estimate that asks for a deposit hands back a `/pay/{token}` link, and a card taken there is held as a deposit (a liability) when Stripe's webhook confirms it. A booking request carries no payment link, because there is no customer yet to hold a deposit for |
| Accounting | QuickBooks Online and Xero, both directions, against Intuit's metered read budget and Xero's call limits. Invoices, payments, voids and write-offs (credited by what was still owed), and refunds: one made before its payment reached the books is netted into it, one made after is sent on its own date, to QuickBooks as an expense from the bank categorised to Accounts Receivable and to Xero as an invoice for the amount plus Spend Money through the mapped customer deposits account, because Xero's receivable is a system account nothing else may touch. A refund sent this way is not watched for deletion over there |
| MCP | Every signed in, non internal route is offered as a tool, filtered by what the caller holds, at `/api/mcp` and over stdio. `docs/modules/m28-developer-agent-platform.md` |
| Operator API | Create, read, meter, suspend and resume a company, for a deployment that runs several. Off unless `OPERATOR_TOKEN` is set. `docs/self-hosting/operator-api.md` |
| Deployment | Docker Compose for everything on one machine (`deploy/docker`). A Netlify template for the web app and the worker tick, with Postgres on Supabase or Neon (`deploy/templates/netlify`). The Netlify template is not deployed by CI |
| Multi location | Tables, columns and scope filters exist. A branch or shop scope narrows jobs and everything read through a job: customers, invoices, estimates, conversations and reports. No shipped role uses either yet. `docs/concepts/multi-location.md` |

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
| Generated migrations from the schema | Done |
| Seed data and a first trade pack | Done |
| `packages/api`: contracts, OpenAPI, service layer | Done |
| Auth, sessions, tenant context in a request | Done |
| `packages/ui`: design system in code | Done |
| `apps/web`: shell, navigation, auth screens | Done |
| Company setup wizard | Done |

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
