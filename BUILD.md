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
| Web app | Dispatch board with a map beside it or instead of it, a technician's day, the customer portal (proposal, tracking, booking, invoice, deposit, and the customer's whole account at `/c/{token}`), and office screens for customers, projects (phases that wait for each other, a job per phase, draws raised as invoices, budget against actual), jobs (with cost against revenue on each job, for whoever may read both, and a job costing report beside the four margin reports; booked, assigned and completed from the office), invoices (raised, edited, issued, sent, voided, written off and credited, with credit notes that take money off one invoice's lines at the tax it charged or sit on the customer's account until used), customer statements over any period read from the ledger, printable and on the customer's own account link, and emailed as a link to it by hand or every month to each customer owing more than a set amount, payments (recorded, held, applied, refunded, and a card taken), estimates (options, a deposit, the approval link, and converting to a job), agreements, inventory, purchasing, the fleet (the register with who holds each thing, check out and in, meter readings, service due, and registration, inspection, insurance and calibration in the order to act on them), certifications (who holds what until when, whether the card was seen, what is due for renewal, suspend, revoke and reinstate, and the kinds that unlock skills), timesheets, payroll (pay periods, the register with a reason on every line and the people who cannot be paid named first, close and reopen, the CSV export and recording commissions paid, and the pay rules: the overtime rule, wage scales loaded, changed from a date and retired, and who is paid at which classification), reports and dashboards (every number on either opening the records behind it, which add up to it, and any report emailed on a schedule with a CSV of every row), compliance (documents on file and when each runs out, the lapsed ones marked needed for work, renewals, and the filing calendar the trade pack declares), automations, reviews and the inbox (threads by customer, on the customer's page too, texting a customer first, and what each number has agreed to beside the conversation; the same conversations and consent are in the API at `/v1/conversations` and `/v1/consent`). Settings → Integrations connects, changes and disconnects every built integration (Stripe, QuickBooks, Xero, Twilio, JustCall, Resend, SMTP, CallRail, the AI models and the OpenStreetMap and Mapbox geocoders), shows each one's state and webhook address, and takes secret names rather than secrets |
| Mobile | The Expo technician app in `apps/mobile`, against whatever server address the company types in: sign in with an email and password for a revocable device token, the day in route order from the phone's own SQLite even with no signal, on my way, arrived, working and done, the clock, notes, photos from the camera and a customer's signature sent through the hash checked upload path, a "waiting to send" line and problems in plain words, and sync after every tap, on a timer with backoff, when the signal returns and from the background task. Typechecked, unit tested and bundled for both platforms here; it has not been run on a device or simulator. The same day still runs as a web page at `/my-day`, which has no camera control. No push notifications, and the bytes are in Postgres rather than object storage. `apps/mobile/README.md` |
| Worker | Built. `pnpm --filter @opentradesos/api worker` drains the event log, fires schedules, resumes waiting runs, sweeps for things that did not happen, puts a few addresses on the map for companies that connected a geocoder, sends scheduled reports and monthly statements once per occurrence, raises recurring tasks and escalates late ones once each, and then sends the outbox (texts and, now, email), webhooks and accounting sync. On a host with no long running processes the same pass runs from `POST /api/internal/worker/tick`. `docs/self-hosting/worker.md` |
| Trade packs | 8 shipped: HVAC, plumbing, electrical, lawn and landscape, pest control, cleaning, dumpster rental, trash bin cleaning |
| Migration | The importer is the separate migration toolkit, which loads through `/api/v1` with an app token; nothing here imports from Jobber or Housecall Pro. The API takes history faithfully: back-dated invoices, payments, refunds and completions posted on their own dates (never into a closed period), tax as charged, invoice adjustments with a to-the-cent totals cross check, unapplied money, source document numbers, cancelled and untimed visits, `externalRef` provenance on every create with lookup on every list, people and job type lists, and file attachments. History needs the owner-only `data:import` permission. An estimate's historical status is not yet accepted. `docs/modules/m30-migration-data-portability.md` |
| Demo | `pnpm db:seed` builds a company with a day of work in it, and the product screenshots come from it. Its invoices and payments are raised and paid through the billing service, so the ledger behind them is real and seeded jobs show the revenue their invoices posted. The seed lives in `packages/api/src/seed` because of that |
| Automation | Event, schedule and "did not happen" triggers, conditions, waits that survive a deploy, versioned workflows, and the publish authority check, all run by the worker. Steps: send a message, raise a task, wait, only if, and run and email a report |
| The week | Crews, service routes, the on call rota and commission plans: four things that had services and no screens, which for the first three means a route business could not see the template its week runs on. A crew names its LEAD, because the lead is who the office rings, and a crew with people and no lead is called out rather than left looking complete. A production rate shows only with its unit, because "eight hundred a day" is square feet or linear feet or cubic yards and the three are different jobs. The route screen answers whether a day fits in THREE values and not two: null means the question cannot be settled from what the company has declared, which is a different thing from a day that fits, and a total with no declared drive time is reported as a floor rather than as a figure, because treating the drive as zero tells somebody a fifteen stop day fits. Nobody on call is said in words, because a blank where a name should be reads as fine. A commission plan carries what its basis is WRONG about beside the choice rather than behind a link, and there is no edit button because a plan is superseded: editing one reprices commissions already earned and, on a plan edited downward, already paid. None of the first three is on the dispatch board yet, and the docs say so. |
| The map | Addresses go on the map from the worker, never from the request that saved them: a geocoding seam with OpenStreetMap's Nominatim (no key, one request a second against the public server, named in every request) and Mapbox on its permanent tier by secret name. A generated address key makes a new address, an edited one and the whole backlog the same condition, so connecting a geocoder is the backfill; every coordinate carries its precision and source, and a pin placed by hand on the property page is never moved. The dispatch map at `/schedule?view=map` draws the day as pins in each technician's colour, unassigned work as outlines, late visits ringed and each day as a line, with the visits that are not on the map listed beside it rather than dropped, on a small slippy map component of our own (Web Mercator in core, raster tiles from `MAP_TILE_URL`) rather than a mapping library. "Optimise route" on a technician's column proposes an order that keeps arrival windows first and drive time second (nearest neighbour, then 2-opt and or-opt, deterministic, with any window it cannot keep named and whether any order could have kept it), and applying it is the ordinary reorder. "Suggest who" proposes a technician for each unassigned visit by added drive time, skills and window. Drive time is a straight line estimate at the company's average speed, or a route's own declared time. Not a road network, no traffic, no live positions. `docs/modules/m09-scheduling-dispatch.md` |
| Skills for one person | A job type's required skills were checked for a crew and never for a technician sent alone. Now the board's drop, the assignment API, booking with a technician named and the suggestions all ask the same check: a certification's standing per person first, the technician's recorded skills for a skill no certification grants, and a skill nobody in the company is recorded as doing is said to be unchecked rather than refused, because refusing on a list nothing had ever written would have stopped every assignment. Overriding needs `visit:assign_unqualified` and a reason, which the audit log keeps beside the refusal. `docs/modules/m24-people-certifications.md` |
| Duplicates | A value somebody types into a box collides, and a unique index refusing it raises `23505`, which is not a refusal class: it reaches the caller as a server error and a screen shows a stack trace instead of a sentence. Eight indexes were in that state, several reachable from screens that shipped (a container number, a van's plate, a saved report's name, a dashboard's name, an agreement plan's code, a vendor's name, a custom role's name, a campaign's UTM tag). `services/duplicates.ts` turns a NAMED index's violation into a refusal, named rather than any `23505` because an idempotency key or a generated document number colliding is a bug that has to keep looking like one. `duplicate-refusals.test.ts` is the census: every unique index in the schema is either refused in words, naming the service and the text that has to be there, or left to the database with a reason, and both directions fail. `docs/concepts/invariants.md` |
| Permissions | The permission a route PUBLISHES and the one its service enforces are now asserted to be the same. `route.permissions` is not enforcement: the service is, and the declaration feeds the OpenAPI document and the MCP tool filter, so a drift refuses a role built from the published docs AND hides a tool from the agent that could use it. Five purchasing routes were in that state, declaring inventory permissions against services checking vendor and purchase order ones, which `permissions-enforced.test.ts` had already found from the other side and fixed in the services only. One route declared `integration:read` and asserted nothing at all. `permission-declarations.test.ts` probes every session route with an actor holding nothing, reads the permission out of the refusal, and fails on a mismatch, on a route that answers without demanding anything, and on resolution collapsing so the first two cannot pass vacuously |
| Comms | SMS through Twilio, email through Resend or any SMTP server, inbound for both, per-purpose consent and suppression enforced on every send. `docs/self-hosting/messaging.md` |
| Trade scorecard | The numbers each trade pack has always declared. Sixty three KPIs across eight packs, forty seven distinct, each with a definition precise enough to name how that metric is usually got wrong, validated at import and read by nothing. Nineteen are answered now: fifteen computed and four by the fleet report, which is where they already live. Every figure carries its two halves, because a bare number cannot be checked, and an empty denominator reports nothing rather than zero. The twenty eight it cannot compute each name the single missing datum rather than saying not built, because most of these definitions turn on an exclusion and a KPI computed without its exclusions looks like the definition. The guard fails if a pack declares a KPI the catalogue does not account for, in either direction, and the computed set is a named list rather than a count. On a screen at `Reports > Trade scorecard`. `docs/modules/m21-reporting-business-intelligence.md` |
| External work orders | The last table in this schema that was described in detail and never touched. In five segments the contractor is a vendor in somebody else's software: a facilities network dispatches, a warranty administrator assigns a claim, a manufacturer sends a dealer a warranty job. The order is mirrored with their id as the key, their status verbatim, and a queue of what they have not been told. What we may do is narrower than what they may do: a contractor cannot declare that the client cancelled it. Some networks make acceptance final and some have no accept call at all, and both are flags on the row because they differ per network. When their system contradicts an unpushed change of ours, theirs wins AND ours is written down, because "we marked it complete on the 4th and their portal says it was still open on the 11th" is the dispute that decides who pays. No adapter for any of those networks: each is a vendor approval rather than code, and one written against documentation without a sandbox looks finished and has never run. On a screen at `Contracts > Work from other systems`, where two statuses sit on every row and are never reconciled into one, the buttons come from the service's own `weMayMoveTo` so a screen cannot offer a move the module would refuse, and each network's caveat is where the decision is made rather than in a help article: a warranty administrator's acceptance is final and a contractor needs to know that before they accept. `docs/modules/m31-commercial-parties-contracts.md` |
| Export | A whole company export, which the comparison pages have promised all along and which "it is your Postgres instance" only answered for somebody self hosting. Every table carrying an organization, read off the database CATALOGUE rather than off a list, so a table added tomorrow is exportable tomorrow. A row count per table, because an export without one is a file and a hope. Keyset pagination on the primary key, never an offset, so a company exporting while its office is still working does not quietly lose a row. Credentials do not leave and each held back column is named with the reason, because an export carrying live tokens is a breach in a file and one that silently drops them is a false claim of completeness. Every page writes an audit line. Owner only. On a screen at `Settings > Take a copy`, which shows the manifest and then streams the whole company as one newline delimited JSON file; a finished file ends with a terminator line and nothing else does, which is how a download that stopped part way is detectable from the file rather than from the browser. `docs/modules/m30-migration-data-portability.md` |
| Networks | A franchise or holding group: several companies, each a real tenant with its own customers, under one operator entitled to a roll up. The MEMBER consents, per aggregate, and revoking takes effect on the next call. Four aggregates and no fifth: job counts, revenue, a scorecard, and ledger totals by account CLASS. There is no customer list aggregate and there will not be one. Row level security is forced on every tenant table, so the read crosses the boundary in exactly one security definer function, which checks that the caller is the network's operator rather than a member of it, that the member granted that aggregate, and that the company is not suspended. The report names the members contributing nothing and says whether that is a missing consent or a quiet month. Membership is set from the operator API, because joining is what creates the relationship a member is then asked to consent to. On a screen at `Settings > Group`, which is the member's consent and the operator's roster in one page because a company can be on either side; shared and not shared are one list, because a list of only what is on is a list of facts and this has to be a list of choices. `docs/concepts/networks.md` |
| Rentals | The capacity model whose unit is a steel box rather than a person, which the dumpster trade pack has declared since it shipped and nothing could record. A fleet of containers with a number and a location, a hire with a delivery, a swap and a collection, and the scale ticket against the haul. A container day is any part of a calendar day in the company's timezone, which is how every operator and every competitor's invoice counts it. Billing runs on two meters that are never derived from each other: elapsed days against the included period, tonnage against the included tonnage. A missing rate is a refusal rather than a zero, because unbilled days are work already done. Utilisation counts the yard in the denominator and excludes only units tagged out for repair. Four of the pack's eight KPIs; the other four need figures this module does not hold and are absent rather than approximated. On a screen at `Fleet > Containers`, with the four figures above the board because this is the one trade whose daily question is a ratio rather than a list, and with the days column headed "Days so far" because on an open hire it moves at midnight and a column headed "Days" is the one somebody copies onto an invoice. `docs/modules/m22-fleet-tools-company-assets.md` |
| Campaigns | A send to the company's own customer list, by text or email. The audience is a closed set of nine rules combined with AND, read back as a sentence, and an audience with no rules is refused outright. Consent, suppression, quiet hours in the company's timezone and the carrier's declared daily cap are checked per recipient at send time; everybody selected gets a row including the ones it would not send to, with the reason. A blast goes out from a `sending` number rather than the one on the truck, never from a tracking number. Marketing email carries a one-click unsubscribe this product serves itself, which suppresses email marketing only and leaves transactional mail alone. On a screen at `Marketing > Texts and emails`, where the nine rules are boxes with sentences rather than a query builder, the audience reads back as a sentence from the same core function the sender uses, and the result is queued and not sent as two numbers with the reasons under them. A campaign can be given a time and the worker sends it then, a day of the carrier's cap at a time, waiting through quiet hours, as the person who wrote it; a body can call people by name with the message templates' merge fields, and the preview shows it as the first person will read it. `docs/modules/m19-marketing-operations-attribution.md` |
| Marketing attribution | Channel, tracking campaign and tracking number, through to a paid job. A company names its channels (seeded from the lead source catalogue, each mapped to one key so reports still roll up) and the tracking campaigns under them with their dates and cost (recorded, a fixed price spread over its days, or a price per lead); a tracking number is credited to a campaign. A call arriving through CallRail is stored with the number's campaign and channel at the time and whether the caller has rung before, and the caller's number, normalised, claims the call for the customer they become. Every path that creates work (a CSR booking a job, booking confirmation, an estimate converted, a lead offer accepted, a job booked from the call log) is credited by one function: it stitches, records a lead source somebody chose as a declared touch, tags the customer's uncredited touches with the job, and fills the job's source from the company's model, marked derived. One revenue for every marketing figure: the ledger's, net of discounts and credits, without tax. `/marketing` is the funnel by channel, campaign or number over chosen dates and model, from spend and calls through leads and booked jobs to revenue, cost per lead, cost per booked job and return, and every figure opens into the rows behind it, which add up to it. Screens for the call log (with "create customer and job from this call"), lead offers (accept or decline with a reason) and setting up a lead source, spend entry and CSV upload, the offline conversion files, channels, tracking campaigns, and the lead source on the customer and job forms and pages. Not built: buying numbers or routing calls, call recordings, a tracking snippet for the company's own website, hosted form pages, ad platform API connectors. `docs/modules/m19-marketing-operations-attribution.md` |
| Payments | Stripe, on the company's own account with a restricted key. A payment is recorded only from a verified webhook, and so is a refund: a card refund reported by Stripe reopens the invoices it paid and posts to the ledger exactly as a refund recorded by hand does, dated when it was made, booked once per Stripe refund id. The office takes a card from the invoice screen through the same Payment Element. The emailed invoice link opens the invoice at `/i/{token}` and takes a card through Stripe's Payment Element when the company has connected Stripe with a publishable key; with no processor connected the page shows the balance and tells the customer to reply to arrange payment, because there is no other way to pay from it. An approved estimate that asks for a deposit hands back a `/pay/{token}` link, and a card taken there is held as a deposit (a liability) when Stripe's webhook confirms it. A booking request carries no payment link, because there is no customer yet to hold a deposit for |
| Accounting | QuickBooks Online and Xero, both directions, against Intuit's metered read budget and Xero's call limits. Invoices, payments, voids and write-offs (credited by what was still owed), and refunds: one made before its payment reached the books is netted into it, one made after is sent on its own date, to QuickBooks as an expense from the bank categorised to Accounts Receivable and to Xero as an invoice for the amount plus Spend Money through the mapped customer deposits account, because Xero's receivable is a system account nothing else may touch. A refund sent this way is not watched for deletion over there. Credit notes go too: issued as a QuickBooks CreditMemo or a Xero ACCRECCREDIT credit note with their own lines mapped as an invoice's are, each use on an invoice on its own date (a zero payment linking the two in QuickBooks, an Allocation in Xero), and a void as an invoice reversing it on the day of the void, settled against it, because QuickBooks' API has no void for a credit memo and Xero's void rewrites the period it was issued in. Same claim, close, mapping and read budget rules as everything else. QuickBooks' "Automatically apply credits" has to be off. `docs/modules/m14-accounting-general-ledger.md` |
| Screens that outran the API | BUILD.md's third ordering rule is that the web app consumes the same surface a third party gets, and five capabilities had drifted the other way: the equipment register, removing and merging a customer, the task queue, workflows and inspections were on screens with no `/v1` routes, so a migration could load a company's whole history except the equipment at its addresses, and the MCP server offered no tool for the first question any agent asks. All five are on the API now: 28 routes, and 447 operations across 371 paths in total. `contracts.test.ts` fails on a handler nothing serves, which is the direction nothing was watching: the compiler catches a route with no handler, and a handler with no route is written, tested and unreachable. It found one on its first run, an email webhook wrapper nothing had ever called. Writing a workflow definition stays off the API on purpose: a condition group is a recursive shape the generator cannot describe, and the authority check on a publish is about a session rather than a payload. Filing an inspection sends answers and gets the verdict back, because accepting an outcome would let a half finished inspection be filed as a pass. The register comes back FLAT with a depth per row rather than nested, because a recursive schema is a lazy one and the OpenAPI generator cannot describe it, and publishing a document that does not say what the response is would be worse than a flatter shape that loses nothing. The warranty watch sits at `/v1/equipment-warranties` because a literal segment beside `/v1/equipment/{id}` is ambiguous and `http.test.ts` refuses it rather than picking |
| The automation canvas | `branch` was in the engine's permission table from the first commit with no executor and no shape anybody could author, so every automation was a straight line while the first thing a contractor asks for is "only if". The builder's step half was a set of checkboxes, one of each kind in a fixed order: no two messages, no ordering, no branching. It is a vertical flow now, with a branch opening two lanes that rejoin, nesting as indentation, and a step picker per lane. NOT a free graph with boxes and arrows, and the reason is not that one is hard to draw: a free graph expresses a cycle and a dangling node, and this engine runs a list that only goes forwards, so an editor that can draw what the runner cannot run is an editor whose every save is a possible refusal. Branching is a FLAT list with arm counts rather than a tree, because the runner records one integer index per step and parks a waiting run on another, so a tree means a path, a new resume model, a new unique index and a migration, to express what the flat form expresses exactly. Nesting falls out of it as bracket matching, checked at the save. The arm not taken is written down as skipped rows, which is what lets a branch and a wait compose: a run that parks inside an arm resumes without re-deciding, and "the condition did not hold" is a different record from "nothing happened". One translation between the tree a person draws and the list the engine runs, in core, used by the screen AND the server, because the second implementation would be the one that decides what runs. A branch reads nothing, so its answer cannot change between being taken and the run resuming |
| Renewals and member pricing | An agreement renews by hand from its own screen, or on its end date by the worker when the plan AND the member both said so, and the new term owes everything a sale owes (visits, instalments, deferred revenue), written by the same code. The price is the agreement's unless a person types a new one, because a renewal that picked up the plan's new price would be a price rise four hundred members never agreed to. An agreement past its end that is not renewing is marked lapsed, which is the status the "their plan lapsed" campaign audience had always read and nothing set. The notice a plan owes goes once per term through the consent gate, by text or by email, and when it cannot go the reason is kept on the agreement and the office gets a task. `/agreements/renewals` is what ends in the next 30, 60 or 90 days. A member's plan discount comes off each eligible line of an estimate or invoice as part of that line's own discount, recording how much and which agreement, so it posts to the discounts account through the code that already posts every discount; each line says so on the screen. Converting a discounted estimate used to leave the invoice's discount at zero, which made the draft impossible to issue; it carries it now. `docs/modules/m08-memberships-service-agreements.md` |
| Recommended automations | Following up an unanswered estimate and asking for a review after a paid job are templates a company turns on from `/automations`, each installing an ordinary workflow it then edits on the canvas. Four step kinds were added for them: `stop_unless` (ask the database one declared question after a wait, and end the run quietly when the answer changed, because a branch only reads the event), `send_estimate`, `request_review` and `send_review_request`, the last two going through the reviews module's own decision rather than a copy of it. Sending an estimate emits `estimate.sent`, which the catalogue had marked as owed. The estimates screen opens on the unsold ones, oldest or largest first. `docs/modules/m29-custom-fields-objects-workflow-builder.md` |
| Moving a visit from the link | A customer asks to move or cancel a coming visit from their job or account link, choosing from exactly the windows online booking would offer that work, from the same function. It is a request and never a move: it lands in the office queue and on the job, and the office agrees or declines, which moves or cancels the visit (taking it off the technician's day) and tells the customer. `docs/modules/m05-customer-portal-online-booking.md` |
| Duplicate customers | Merging needed two ids and the screen offered the first fifty customers as the second one, whoever they happened to be. The real duplicate is usually not among them and a dropdown of fifty unrelated people is one somebody picks wrong from, which for an operation that is irreversible in practice is the one mistake the control must not make easy. It matches instead: the same phone number, the same email, or a name close enough by trigram that a person should look, each candidate carrying WHY rather than a score, because a single number would have to weigh a shared phone against a name similarity and whatever weighting was chosen would be wrong for somebody. Nothing matching is said in words rather than left as a missing button, which reads as a permission somebody does not have |
| Tags and duplicates | Customer tags were stored and read back and nothing acted on one. Now a customer's page puts tags on and takes them off, the customer list filters by one or more (any or all, compared without capitals, in the address so a filtered list is a link), and `/customers/tags` lists every tag with its count and renames and merges across the book in one statement. A new tag takes the spelling the company already uses, so the book converges on one spelling rather than five. `/customers/duplicates` is the per record matcher run over every pair in one query (equality joins for phone and email, pg_trgm's `%` on the trigram index for names, at the matcher's own threshold), paged by position, with merge in either direction and a remembered "not the same person" that also stops the pair appearing on either customer's page. Tags are a list on the row rather than a table, so the filter reads each list rather than an index, and the doc says where that stops being fine. `docs/modules/m03-crm.md` |
| Price book shelves and bulk changes | `/pricebook/categories` reorganises the categories a trade pack seeded: nested three deep, reordered, renamed, removed when empty, items moved between them (an edit to the item, because no document points at a category). `/pricebook/changes` re-prices a selection by a percentage, an amount, a margin over cost or a rounding up to a price ending, shows every before and after (with margin for whoever may see cost) before anything is written, writes a new version per item through the same code a single revision uses, and records each change so Undo puts each old price back as another new version and names any item changed since. The arithmetic is `core/repricing`, with no floats. A bulk change takes effect when applied and cannot be dated ahead. `docs/modules/m06-price-book.md` |
| Warranties | The warranty watch had a route and no screen. `/customers/warranties` lists cover ending in 30, 60 or 90 days or ended in the last 90, by customer and address, with a follow up task about the unit and an estimate for a replacement one click away. The route now names the customer to ring on every unit. `docs/modules/m04-customer-equipment-service-history.md` |
| The office queue's own rules | A late task told nobody, work that recurs had to be typed in each time, and "open the shop" was one line. Escalation rules (hours late, a priority floor, tell the manager, a role or a person, optionally hand it over) are applied by the worker once per task per rule, with the record inserted before anybody is told; the notice is a task in their queue and an email through the outbox, and with no manager recorded the owners are told and the task says why. Recurring templates raise one task per company day, never twice, under a unique index the worker inserts against. A task carries a checklist its assignee can tick with `task:read`, and closing as done with items unticked needs a reason kept apart from the outcome. `/tasks/recurring`, `/tasks/escalation` and `/tasks/{id}`. `docs/modules/m34-tasks-and-the-office-queue.md` |
| Connected apps | A third party acting against one company, with the company in control. The service could install one, change its grant, revoke it, issue a credential and revoke one, all guarded and all tested, and had no route and no screen, so the module `docs/concepts/connected-apps.md` describes as the way a third party integrates was unreachable: an owner could not approve an app, see which held a credential, or turn one off. Six routes and a screen at `Settings > Applications`. The grant offered is the installer's OWN permission list, because the service refuses a grant wider than what the caller holds and a form offering the whole catalogue makes that refusal a surprise. The list says CONNECTED rather than active, which is a different fact: an app with no credential, or whose only credential lapsed overnight, is approved and unreachable, and a screen reading the status alone calls that connected on the morning somebody's nightly sync stopped. A token is shown once, as selectable text and never as a link, because an href carrying a credential puts it in the browser's history and in the `Referer` of whatever it is clicked through to. Installing is idempotent on a retry and so is revoking, in both directions; issuing is not and the contract says why, since only the hash is stored and a replay has nothing to hand back |
| Webhooks | Signed, ordered delivery per endpoint, and now its history: every attempt with the receiver's status, the start of its body, how long it took and any error, kept thirty days and a thousand attempts per endpoint. One delivery, one event or a range from a point in the log is sent again on request, queued, re-signed, with the original delivery header so the receiver's own deduplication holds, without moving the live position. The worker visits a company owing a replay or a retry even when it produced no event. Settings > Webhooks registers endpoints and shows the history with a filter and a send again button. `docs/modules/m26-public-api-webhooks-sdks.md` |
| Custom fields | Declared fields bind the customer, property and job writes on the API and the screens: a value contradicting its type or options and a required field left empty are refused, one sentence per field at `customFields.<key>`. Only what a write changed is checked, so a record from before a field became required still saves. The new customer, book a job, customer, property and job screens draw the company's fields. There is no screen for declaring one yet. `docs/modules/m29-custom-fields-objects-workflow-builder.md` |
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
today without an app store. The dispatch board, the dispatch map, route
ordering with a proposed order per technician, assignment with a skill check for
one person, and on-my-way are built. Every operation kind writes something outside the log, and
a test fails if one stops.

Photo and signature bytes land. The device declares a hash, the server
refuses bytes that do not match it as a corrupted file rather than storing
them, stores what does under a content addressed key so a phone retrying four
times in a car park does not leave four copies, attaches it to the record it
was taken for, and serves it at `/files/{key}` scoped by the caller's own
company rather than by the key. An upload that cannot be stored is counted and
then abandoned with the error on the row, because a queue with no attempt count
retries forever and a photograph nobody knew had failed is the worse outcome.
The phone app is what uploads to it: a photograph or a signature is copied
into the app's own storage, hashed, recorded as an operation, and its bytes
sent once the server lists them as owed. `/my-day` in a browser still has no
camera control.

The Expo app is built in `apps/mobile`. It signs in against a server address
the company types, with an email and password, for a device token that is a
session underneath (so deactivating the person ends it) and is bound to the
device it registered (so the office can take a lost phone away with
`POST /v1/field/devices/{id}/revoke`). Everything it writes goes through the
same queue the web page uses, kept in SQLite on the phone, and the sync it runs
after every tap is the same function its background task runs. Building it
found three faults in the shared queue and the sync route, all fixed: a
request that got no answer was counted as a failed try, so a phone three
minutes without signal stopped sending its day; two writes at once could take
the same sequence number and one overwrote the other; and an operation held
behind a gap was held for ever, including behind a number the phone had
handed out and then lost in a crash. The app is typechecked, its logic is
unit tested and it bundles for Android and iOS; nobody has run it on a device.

Not done, and named so nobody assumes otherwise: running the app on a real
phone, and a store listing; push notifications for a new or changed visit;
object storage,
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
call tracking, attribution through to invoiced revenue (built: channels,
tracking campaigns and numbers, every path crediting its work, and the funnel
from spend to return; not built: buying numbers, voice, a website snippet and
ad platform connectors). Reviews.

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
