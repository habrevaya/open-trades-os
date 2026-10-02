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
| Web app | Dispatch board, a technician's day, the customer portal (proposal, tracking, booking, invoice, deposit, and the customer's whole account at `/c/{token}`), and office screens for customers, projects (phases that wait for each other, a job per phase, draws raised as invoices, budget against actual), jobs (with cost against revenue on each job, for whoever may read both, and a job costing report beside the four margin reports; booked, assigned and completed from the office), invoices (raised, edited, issued, sent, voided and written off), payments (recorded, held, applied, refunded, and a card taken), estimates (options, a deposit, the approval link, and converting to a job), agreements, inventory, purchasing, the fleet (the register with who holds each thing, check out and in, meter readings, service due, and registration, inspection, insurance and calibration in the order to act on them), certifications (who holds what until when, whether the card was seen, what is due for renewal, suspend, revoke and reinstate, and the kinds that unlock skills), timesheets, payroll (pay periods, the register with a reason on every line and the people who cannot be paid named first, close and reopen, the CSV export and recording commissions paid), reports, dashboards, compliance (documents on file and when each runs out, the lapsed ones marked needed for work, renewals, and the filing calendar the trade pack declares), automations, reviews and the inbox (threads by customer, on the customer's page too, texting a customer first, and what each number has agreed to beside the conversation; the same conversations and consent are in the API at `/v1/conversations` and `/v1/consent`). Settings → Integrations connects, changes and disconnects every built integration (Stripe, QuickBooks, Xero, Twilio, JustCall, Resend, SMTP, CallRail and the AI models), shows each one's state and webhook address, and takes secret names rather than secrets |
| Mobile | The technician's day runs as a web page on the phone they already have. The server takes photo and signature bytes, hash checked, deduplicated by content and served back at `/files/{key}`, and the phone page has no camera control to send any. The Expo app is not built, and the bytes are in Postgres rather than object storage |
| Worker | Built. `pnpm --filter @opentradesos/api worker` drains the event log, fires schedules, resumes waiting runs, sweeps for things that did not happen, and then sends the outbox, webhooks and accounting sync. On a host with no long running processes the same pass runs from `POST /api/internal/worker/tick`. `docs/self-hosting/worker.md` |
| Trade packs | 8 shipped: HVAC, plumbing, electrical, lawn and landscape, pest control, cleaning, dumpster rental, trash bin cleaning |
| Migration | The importer is the separate migration toolkit, which loads through `/api/v1` with an app token; nothing here imports from Jobber or Housecall Pro. The API takes history faithfully: back-dated invoices, payments, refunds and completions posted on their own dates (never into a closed period), tax as charged, invoice adjustments with a to-the-cent totals cross check, unapplied money, source document numbers, cancelled and untimed visits, `externalRef` provenance on every create with lookup on every list, people and job type lists, and file attachments. History needs the owner-only `data:import` permission. An estimate's historical status is not yet accepted. `docs/modules/m30-migration-data-portability.md` |
| Demo | `pnpm db:seed` builds a company with a day of work in it, and the product screenshots come from it. Its invoices and payments are raised and paid through the billing service, so the ledger behind them is real and seeded jobs show the revenue their invoices posted. The seed lives in `packages/api/src/seed` because of that |
| Automation | Event, schedule and "did not happen" triggers, conditions, waits that survive a deploy, versioned workflows, and the publish authority check, all run by the worker |
| The week | Crews, service routes, the on call rota and commission plans: four things that had services and no screens, which for the first three means a route business could not see the template its week runs on. A crew names its LEAD, because the lead is who the office rings, and a crew with people and no lead is called out rather than left looking complete. A production rate shows only with its unit, because "eight hundred a day" is square feet or linear feet or cubic yards and the three are different jobs. The route screen answers whether a day fits in THREE values and not two: null means the question cannot be settled from what the company has declared, which is a different thing from a day that fits, and a total with no declared drive time is reported as a floor rather than as a figure, because treating the drive as zero tells somebody a fifteen stop day fits. Nobody on call is said in words, because a blank where a name should be reads as fine. A commission plan carries what its basis is WRONG about beside the choice rather than behind a link, and there is no edit button because a plan is superseded: editing one reprices commissions already earned and, on a plan edited downward, already paid. None of the first three is on the dispatch board yet, and the docs say so. |
| Duplicates | A value somebody types into a box collides, and a unique index refusing it raises `23505`, which is not a refusal class: it reaches the caller as a server error and a screen shows a stack trace instead of a sentence. Eight indexes were in that state, several reachable from screens that shipped (a container number, a van's plate, a saved report's name, a dashboard's name, an agreement plan's code, a vendor's name, a custom role's name, a campaign's UTM tag). `services/duplicates.ts` turns a NAMED index's violation into a refusal, named rather than any `23505` because an idempotency key or a generated document number colliding is a bug that has to keep looking like one. `duplicate-refusals.test.ts` is the census: every unique index in the schema is either refused in words, naming the service and the text that has to be there, or left to the database with a reason, and both directions fail. `docs/concepts/invariants.md` |
| Permissions | The permission a route PUBLISHES and the one its service enforces are now asserted to be the same. `route.permissions` is not enforcement: the service is, and the declaration feeds the OpenAPI document and the MCP tool filter, so a drift refuses a role built from the published docs AND hides a tool from the agent that could use it. Five purchasing routes were in that state, declaring inventory permissions against services checking vendor and purchase order ones, which `permissions-enforced.test.ts` had already found from the other side and fixed in the services only. One route declared `integration:read` and asserted nothing at all. `permission-declarations.test.ts` probes every session route with an actor holding nothing, reads the permission out of the refusal, and fails on a mismatch, on a route that answers without demanding anything, and on resolution collapsing so the first two cannot pass vacuously |
| Comms | SMS through Twilio, email through Resend or any SMTP server, inbound for both, per-purpose consent and suppression enforced on every send. `docs/self-hosting/messaging.md` |
| Trade scorecard | The numbers each trade pack has always declared. Sixty three KPIs across eight packs, forty seven distinct, each with a definition precise enough to name how that metric is usually got wrong, validated at import and read by nothing. Nineteen are answered now: fifteen computed and four by the fleet report, which is where they already live. Every figure carries its two halves, because a bare number cannot be checked, and an empty denominator reports nothing rather than zero. The twenty eight it cannot compute each name the single missing datum rather than saying not built, because most of these definitions turn on an exclusion and a KPI computed without its exclusions looks like the definition. The guard fails if a pack declares a KPI the catalogue does not account for, in either direction, and the computed set is a named list rather than a count. On a screen at `Reports > Trade scorecard`. `docs/modules/m21-reporting-business-intelligence.md` |
| External work orders | The last table in this schema that was described in detail and never touched. In five segments the contractor is a vendor in somebody else's software: a facilities network dispatches, a warranty administrator assigns a claim, a manufacturer sends a dealer a warranty job. The order is mirrored with their id as the key, their status verbatim, and a queue of what they have not been told. What we may do is narrower than what they may do: a contractor cannot declare that the client cancelled it. Some networks make acceptance final and some have no accept call at all, and both are flags on the row because they differ per network. When their system contradicts an unpushed change of ours, theirs wins AND ours is written down, because "we marked it complete on the 4th and their portal says it was still open on the 11th" is the dispute that decides who pays. No adapter for any of those networks: each is a vendor approval rather than code, and one written against documentation without a sandbox looks finished and has never run. On a screen at `Contracts > Work from other systems`, where two statuses sit on every row and are never reconciled into one, the buttons come from the service's own `weMayMoveTo` so a screen cannot offer a move the module would refuse, and each network's caveat is where the decision is made rather than in a help article: a warranty administrator's acceptance is final and a contractor needs to know that before they accept. `docs/modules/m31-commercial-parties-contracts.md` |
| Export | A whole company export, which the comparison pages have promised all along and which "it is your Postgres instance" only answered for somebody self hosting. Every table carrying an organization, read off the database CATALOGUE rather than off a list, so a table added tomorrow is exportable tomorrow. A row count per table, because an export without one is a file and a hope. Keyset pagination on the primary key, never an offset, so a company exporting while its office is still working does not quietly lose a row. Credentials do not leave and each held back column is named with the reason, because an export carrying live tokens is a breach in a file and one that silently drops them is a false claim of completeness. Every page writes an audit line. Owner only. On a screen at `Settings > Take a copy`, which shows the manifest and then streams the whole company as one newline delimited JSON file; a finished file ends with a terminator line and nothing else does, which is how a download that stopped part way is detectable from the file rather than from the browser. `docs/modules/m30-migration-data-portability.md` |
| Networks | A franchise or holding group: several companies, each a real tenant with its own customers, under one operator entitled to a roll up. The MEMBER consents, per aggregate, and revoking takes effect on the next call. Four aggregates and no fifth: job counts, revenue, a scorecard, and ledger totals by account CLASS. There is no customer list aggregate and there will not be one. Row level security is forced on every tenant table, so the read crosses the boundary in exactly one security definer function, which checks that the caller is the network's operator rather than a member of it, that the member granted that aggregate, and that the company is not suspended. The report names the members contributing nothing and says whether that is a missing consent or a quiet month. Membership is set from the operator API, because joining is what creates the relationship a member is then asked to consent to. On a screen at `Settings > Group`, which is the member's consent and the operator's roster in one page because a company can be on either side; shared and not shared are one list, because a list of only what is on is a list of facts and this has to be a list of choices. `docs/concepts/networks.md` |
| Rentals | The capacity model whose unit is a steel box rather than a person, which the dumpster trade pack has declared since it shipped and nothing could record. A fleet of containers with a number and a location, a hire with a delivery, a swap and a collection, and the scale ticket against the haul. A container day is any part of a calendar day in the company's timezone, which is how every operator and every competitor's invoice counts it. Billing runs on two meters that are never derived from each other: elapsed days against the included period, tonnage against the included tonnage. A missing rate is a refusal rather than a zero, because unbilled days are work already done. Utilisation counts the yard in the denominator and excludes only units tagged out for repair. Four of the pack's eight KPIs; the other four need figures this module does not hold and are absent rather than approximated. On a screen at `Fleet > Containers`, with the four figures above the board because this is the one trade whose daily question is a ratio rather than a list, and with the days column headed "Days so far" because on an open hire it moves at midnight and a column headed "Days" is the one somebody copies onto an invoice. `docs/modules/m22-fleet-tools-company-assets.md` |
| Campaigns | A send to the company's own customer list, by text or email. The audience is a closed set of nine rules combined with AND, read back as a sentence, and an audience with no rules is refused outright. Consent, suppression, quiet hours in the company's timezone and the carrier's declared daily cap are checked per recipient at send time; everybody selected gets a row including the ones it would not send to, with the reason. A blast goes out from a `sending` number rather than the one on the truck, never from a tracking number. Marketing email carries a one-click unsubscribe this product serves itself, which suppresses email marketing only and leaves transactional mail alone. On a screen at `Marketing > Campaigns`, where the nine rules are boxes with sentences rather than a query builder, the audience reads back as a sentence from the same core function the sender uses, and the result is queued and not sent as two numbers with the reasons under them. Still no scheduler: a staged send is one press per batch, and the screen says so. `docs/modules/m19-marketing-operations-attribution.md` |
| Payments | Stripe, on the company's own account with a restricted key. A payment is recorded only from a verified webhook, and so is a refund: a card refund reported by Stripe reopens the invoices it paid and posts to the ledger exactly as a refund recorded by hand does, dated when it was made, booked once per Stripe refund id. The office takes a card from the invoice screen through the same Payment Element. The emailed invoice link opens the invoice at `/i/{token}` and takes a card through Stripe's Payment Element when the company has connected Stripe with a publishable key; with no processor connected the page shows the balance and tells the customer to reply to arrange payment, because there is no other way to pay from it. An approved estimate that asks for a deposit hands back a `/pay/{token}` link, and a card taken there is held as a deposit (a liability) when Stripe's webhook confirms it. A booking request carries no payment link, because there is no customer yet to hold a deposit for |
| Accounting | QuickBooks Online and Xero, both directions, against Intuit's metered read budget and Xero's call limits. Invoices, payments, voids and write-offs (credited by what was still owed), and refunds: one made before its payment reached the books is netted into it, one made after is sent on its own date, to QuickBooks as an expense from the bank categorised to Accounts Receivable and to Xero as an invoice for the amount plus Spend Money through the mapped customer deposits account, because Xero's receivable is a system account nothing else may touch. A refund sent this way is not watched for deletion over there |
| Connected apps | A third party acting against one company, with the company in control. The service could install one, change its grant, revoke it, issue a credential and revoke one, all guarded and all tested, and had no route and no screen, so the module `docs/concepts/connected-apps.md` describes as the way a third party integrates was unreachable: an owner could not approve an app, see which held a credential, or turn one off. Six routes and a screen at `Settings > Applications`. The grant offered is the installer's OWN permission list, because the service refuses a grant wider than what the caller holds and a form offering the whole catalogue makes that refusal a surprise. The list says CONNECTED rather than active, which is a different fact: an app with no credential, or whose only credential lapsed overnight, is approved and unreachable, and a screen reading the status alone calls that connected on the morning somebody's nightly sync stopped. A token is shown once, as selectable text and never as a link, because an href carrying a credential puts it in the browser's history and in the `Referer` of whatever it is clicked through to. Installing is idempotent on a retry and so is revoking, in both directions; issuing is not and the contract says why, since only the hash is stored and a replay has nothing to hand back |
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
| CI: a browser driving real form submits against a production build | Done |
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

**Done, through the screens, with one honest caveat about the card.** Every
step has an office screen and the browser suite walks it without calling the
API (`apps/web/e2e/booked-to-paid.spec.ts`): a new customer and address on the
customer form, the job booked from that address with its first visit, the
visit completed from the office, the invoice raised from the job, its link
handed over and opened by a stranger, part of it recorded as a cheque, Stripe
connected in Settings, Integrations by the names of its secrets, the rest taken
by card from the invoice through the Payment Element, the invoice shown paid
only once the signed webhook arrives, and the job and the job costing report
showing revenue, read from the ledger, equal to the invoice total to the cent.

The caveat: the card step is proven against a fake Stripe at its three edges
(the payment intent request, Stripe.js in the browser, the signed webhook),
because a real charge needs a real Stripe account. Everything between those
edges runs for real. A company taking real cards also has to put its two Stripe
secrets in the server's environment and paste the webhook address Settings
shows into its Stripe dashboard; neither is something this product can do on
its screens, and both are named on the Settings screen.

The rest of the office path that used to need the API (raising, editing,
sending, voiding and writing off invoices, recording, holding, applying and
refunding payments, writing, pricing and sending estimates, and booking and
assigning) has screens too, and every office form keeps what was typed when it
is refused.

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

Photo and signature bytes land. The device declares a hash, the server
refuses bytes that do not match it as a corrupted file rather than storing
them, stores what does under a content addressed key so a phone retrying four
times in a car park does not leave four copies, attaches it to the record it
was taken for, and serves it at `/files/{key}` scoped by the caller's own
company rather than by the key. An upload that cannot be stored is counted and
then abandoned with the error on the row, because a queue with no attempt count
retries forever and a photograph nobody knew had failed is the worse outcome.
This paragraph used to say those bytes had no upload path, which stopped being
true at the server end and stayed written down. It is still true at the other
end: `/my-day` has no camera control and the client queue carries operations
rather than files, so the upload path is a server with nobody uploading to it.
That is the right order to have built it in, because the half that has to be
idempotent, hash checked and tenant scoped is the half that is hard to change
later.

Not done, and named so nobody assumes otherwise: the Expo app, which adds
background sync, reliable camera capture and a home screen icon; object storage,
because the bytes are columns in Postgres, which is correct for a self hoster
with a few gigabytes of photographs and not for a company with a terabyte; the
customer portal reading a job photograph, which needs a token path rather than
the session one; and true offline page loads, which need a service worker. A
technician with no signal can record a day on a page already open; they cannot
open the page.

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
