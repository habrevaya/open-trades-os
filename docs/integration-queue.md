# The integration queue

What to build next, hardest at the bottom.

Derived from the ServiceTitan marketplace, which is the best public census of
what a trades company actually wires up: 175 listed partners, of which 145 are
software integrations and 30 are consultancies, coaching firms and accountants
with no software to connect to. Only the 145 are here.

**This is a plan, not a claim.** Nothing in this file says a connector exists.
What exists is in `packages/core/src/connectors/index.ts`, where every entry
carries a `state` of `built` or `declared` and a test refuses to let the first
be claimed without a registered adapter behind it. `test/integration-queue.test.ts`
checks this document against that catalogue, so a tier that goes stale after
something ships fails the build rather than quietly misleading whoever reads it
next.

## What makes an integration easy, here specifically

Not how famous the vendor is. Four things, in order of how much they decide:

1. **Can one person get credentials on a Tuesday afternoon?** A self-serve API
   key beats OAuth, OAuth beats an approval queue, and an approval queue beats a
   signed contract. For a project anybody can self-host this is close to
   decisive: an integration that requires a partner agreement is one that most
   of our users cannot use even after we write it, because the agreement is
   between the vendor and *them*.
2. **Does the capability seam already exist?** `payments`, `email`,
   `accounting`, `messaging`, `telephony`, `ads`, `lead_source`, `reviews`,
   `maps`, `tax`, `payroll`, `financing`, `storage`, `calendar` and
   `analytics` are already members of the `capability` enum. A connector in a
   capability that already has an interface and one working adapter is a few
   hundred lines. One that needs a new seam is a module.
3. **Is the data model already here?** A photo connector needs somewhere to put
   a photo. A pricebook feed needs a pricebook that can take a vendor's
   versioning. Where the table exists the work is an adapter; where it does not,
   the adapter is the easy half.
4. **Does it move data, or does it move money?** Anything touching card data,
   consumer lending or tax filing carries compliance scope that dwarfs the code.

A note on the source list, said once rather than repeated: the ServiceTitan
marketplace is a paid placement directory. It is an excellent map of what
contractors use and a poor map of what is open. Several of the most valuable
integrations for a self-hosted product are not on it at all, because there is
nobody to pay for a listing: SMTP, CalDAV, IMAP, a bank's OFX export, Home
Assistant. Those sit in tier 1 on merit and are marked as not being from the
marketplace.

---

## Tier 0: already built

Not queue items. Listed so this file and the catalogue cannot disagree.

| Connector | Capability | Note |
|---|---|---|
| `stripe` | payments | Operator's own restricted key, no Connect, no cut. |
| `quickbooks` | accounting | Change-data-capture, because Intuit meters reads. |
| `resend` | email | With delivery, bounce and complaint feedback. |
| `smtp` | email | Any mail server the company already pays for. |
| `lead_webhook` | lead_source | Signed, for anything that can POST JSON. |
| `spend_csv` | ads | A file every ad platform will export. |
| `anthropic` | ai_model | Claude, on the operator's own key and their own bill. |
| `openai` | ai_model | ChatGPT, same seam. |
| `google` | ai_model | Gemini, same seam. Key sent as a header, never in the URL. |
| `ics_feed` | calendar | A technician's visits as a subscribable feed. No vendor at all. Address in, phone number deliberately out. |
| `callrail` | telephony | Tracked calls into `call` and `marketing_touch`, signed webhook plus a backfill, because they do not resend. |
| `twilio` | messaging | The first adapter the product ever had. In this table only now, because it was missing from the catalogue entirely until a second carrier was added beside it. |
| `justcall` | messaging | The second carrier on the same seam. Their signature covers the URL, the type and a timestamp, and not the message, so the replay window is five minutes rather than a day. |
| `nominatim` | maps | OpenStreetMap's geocoder, public or self hosted. No key; one request a second against the public server, and a contact address on every request as its usage policy asks. |
| `mapbox` | maps | The commercial geocoder, always on the permanent tier because every answer is stored. Google is not offered: its terms forbid keeping the coordinates. |
| `whisper` | transcription | Speech to text for kept recordings and voicemails, over the Whisper API: OpenAI's, or a server the company runs itself so calls never leave the building. Card numbers are removed before the words are stored. |
| `xero` | accounting | The second adapter on the accounting seam. No change feed on their side, so inbound is a modified-since boundary; refresh tokens rotate with no grace period at all. |
| `google_ads` | ads | Spend per campaign per day pulled into the spend rows and mapped onto tracking campaigns; paid jobs uploaded as click conversions with the job's id as Google's order id. Needs the operator's own developer token. |
| `google_lsa` | ads | Local Services leads into the lead inbox and their spend under Local Services, through the Google Ads API with the same token and sign in. |
| `meta_ads` | ads | Spend per campaign per day, and booked and paid jobs through the Conversions API with hashed details only where consent allows. Meta's sign in lasts sixty days. |
| `ga4` | analytics | Leads and purchases through the Measurement Protocol, tied to the visit by the analytics id the website snippet reads. An API secret, no sign in. |
| `google_business_profile` | reviews | Reviews read hourly into the review work list, replies posted back, and who wrote one suggested rather than asserted. Needs Google's separate approval for the API. |
| `wisetack` | financing | Consumer financing: an application link for an invoice or estimate, the decision read back from Wisetack after every signed webhook, and the funded loan recorded as a payment with Wisetack's fee as an expense. Tested against a fake of its API; needs a Wisetack merchant account. |

---

## Tier 1: build next

Self-serve credentials, a seam that already exists, and a data model that can
take it. Each of these is an adapter rather than a module.

### 1. CalDAV two-way calendar sync (not a marketplace listing)
The read-only ICS feed is built and is in Tier 0. What it cannot do is take a
change back: a technician who moves an appointment in their own calendar has
moved their own copy, and the next refresh puts it back. CalDAV is the
follow-up, and it is a genuinely bigger piece of work than the feed was,
because accepting a write means conflict handling between a phone that was
offline and a dispatch board that has moved on.
*What is already known from building the feed: the framing rules, the stable
UID per visit, and the decision about what a feed may show of a customer's
address and phone number, all of which CalDAV inherits.*

### 2. ClearPathGPS: fleet tracking
Open API on their Pro plan, real-time location and vehicle data. `M22` has
shipped since this was written, so the asset register, the meter readings and
the service plans this would feed all exist now: what is left is the `fleet`
capability on the seam and an adapter that turns their position and odometer
reports into `asset_reading` rows.

### 3. Avalara AvaTax: sales tax
The `tax` capability is in the enum with no provider. REST v2, a sandbox at
`sandbox-rest.avatax.com`, a free trial obtainable through the
`RequestFreeTrial` API with no prior approval, and an API playground that needs
no signup at all. Rate lookup per invoice line is a clean fit.
*Caveat: a persistent sandbox is a separate paid subscription, so CI tests
against a recorded fixture rather than live.*

---

## Tier 2: worth building, with a gate

Real APIs, and something stands between a user and their credentials.

| Integration | What it gives | The gate |
|---|---|---|
| Birdeye | Reviews read and replied to | Partner onboarding; the `reviews` seam exists |
| Hover | Roof and exterior measurement | Approval queue |
| EagleView | Aerial measurement | Approval queue, per-report pricing |
| Miter, Lumber | Trades payroll | Modern APIs, sales-led onboarding |
| US Fleet Tracking, Vestige | Fleet | Needs the `fleet` seam first |
| Reserve with Google (booking) | Booking from search | Google Maps Booking partner onboarding, which is a programme rather than a form |
| Contractor Commerce, Dispatch | E-commerce storefront | Partner agreement |
| **CompanyCam** | Job photos | **Their own deprecation date.** It was tier 1 item 2 on the strength of a public developer portal with an OpenAPI spec, and that portal now opens with "These docs are for the legacy API that will be depreciating early 2027. We will not be adding new functionality and will provide very limited support." The replacement at `developers.companycam.com` is behind a sign-in, so its shape cannot be read, let alone verified. Building against the legacy API means shipping an adapter with a published death date inside its own first year; building against the new one means inventing endpoints from memory. Neither is acceptable here, so it waits until the new reference is public. |

---

## Tier 3: lead marketplaces

Grouped because they share one blocker and one shape. Every one of them pushes
leads at a URL, which the `lead_webhook` connector **already receives today**
with an HMAC signature. What none of them offers is self-serve credentials.

- **Angi** publishes no developer portal and no API reference. Leads arrive as
  JSON POSTed to a URL the contractor's CRM provides, authenticated with an
  `X-API-KEY` header, and onboarding is a manual email thread to
  `crmintegrations@angi.com` with no published SLA.
- **Thumbtack** runs an approval-gated Partner Platform. Docs and the API
  reference are behind a "Request Access" call to action, credentials are OAuth
  2.0 issued after review, and there is no public signup.
- Same shape: Modernize, Home Solutions, WinGen, SmartAC, Building36,
  ActiveProspect, The Home Depot, ServiceChannel, ResQ, FlowPath.

**So the honest sequencing is: do not build adapters for these.** Document how
to point each one at the generic lead webhook, and spend the effort on the
field-mapping screen that makes an unanticipated sender a settings change
rather than a release. One piece of work serves all sixteen.

---

## Tier 4: accounting beyond QuickBooks

| Integration | The gate |
|---|---|
| ~~Xero~~ | **BUILT.** See tier 0. |
| **Sage Intacct** | A Web Services developer licence from **$2,500 per year** with no support included, or partner membership at $2,500 plus $0.015 per API call. For an AGPL project with no revenue this is the decisive fact, not the API's difficulty. |
| **Oracle NetSuite** | SuiteTalk, gated behind a partner relationship and an account that costs more than most of our users' whole stack. |
| Viewpoint Spectrum / Vista | Reached through MindCloud, a middleware vendor, rather than directly. |
| Stuut, The Graphite Lab | AR and bookkeeping services layered on an accounting system rather than one. |

**Xero was the one to build and it is now built.** It was never on the
ServiceTitan marketplace, because Xero does not pay ServiceTitan for
placement, and this paragraph existed to say that the absence was about
placement rather than difficulty: free developer account, self-serve OAuth 2.0
app registration, public docs and a published OpenAPI spec.

That held. The estimate was 220k and the surprise was not the API, it was a
claim in our own code: `accounting/provider.ts` said "Both QuickBooks and Xero
expose [a change feed], which is why it is in the interface", and Xero does
not. It has `If-Modified-Since` and nothing else. The seam survived, because
what `changes()` actually needs is an opaque resume point rather than a
cursor, but the stated reason was false and the adapter is what found it.

---

## Tier 5: money, lending and compliance

Hard because of what they are, not because of their APIs.

- **Consumer financing**: GreenSky, Synchrony, Wells Fargo, Service Finance,
  Financeit, TURNS, Bluevine, Coral. Every one needs a contract, a dealer
  agreement and in most cases a lending licence held by the contractor. The
  integration is the smallest part, and since Wisetack shipped it is an
  adapter on the `financing` seam rather than a module: `src/financing/provider.ts`
  is the interface, and the estimate, invoice, portal and payment paths
  already speak it.
- **Permitting**: PermitFlow, iPermit. Jurisdiction by jurisdiction, with
  authority-specific forms. The code is easy and the coverage is the product.
- **Warranties**: JB Warranties. Registration flows tied to manufacturer
  programmes.

---

## Tier 6: suppliers, manufacturers and pricebooks

**Twenty-eight suppliers and manufacturers, and this is the hardest tier in the
list by a distance.** ABC Supply, Ferguson, Winsupply, Reece, Hajoca, Gensco,
Famous, R.E. Michel, SRS, QXO, APR, Coburn, Consolidated, Copperfield,
Robertson, Ply, and the manufacturer catalogues from Carrier, Trane, Lennox,
Goodman, Daikin, Rheem, Ruud, Amana, Bryant, American Standard, International
Comfort Products, Kinetico.

They share one blocker that no amount of engineering removes: there is no public
API. Access runs through punchout catalogues, EDI, or a distributor's partner
portal under a signed agreement, usually negotiated per branch. Live pricing in
particular is commercially sensitive and nobody publishes it.

**What is achievable, and what to build instead:** a price-file importer. Every
one of these vendors will send a contractor their own catalogue and their own
negotiated pricing as a file, because that already happens by email today. An
importer that takes a vendor price file into the price book with its versioning
intact serves all twenty-eight, needs no agreement with anybody, and is the same
reasoning that put `spend_csv` ahead of the ad platform APIs.

---

## Excluded, and why

**ServiceTitan's own products** are not integrations, they are the upsells that
make ServiceTitan expensive: Pricebook Pro, Marketing Pro, Dispatch Pro, Fleet
Pro, Phones Pro, Sales Pro, Scheduling Pro, Payments, AI Voice Agent. Each one
is a feature this product either has or has on its roadmap. They are in the
marketplace census and are deliberately not in this queue.

**Consultancies and coaching** (30 of the 175 listings): Nexstar, BDR, Baker
Tilly, Accordant, Powerhouse and the rest. Nothing to integrate with.

**Agencies reselling marketing services** rather than exposing an API: Scorpion,
LocaliQ, Darwill, Mail Shark, UpSwell, CAMP Digital, Relentless Digital, VIIRL,
Local Optics, To Your Success, Free Agency. Where one of these has a reporting
API it belongs with the ad connectors already in the catalogue, not as a
connector of its own.

---

## What each one costs to build, in tokens

Asked for, and worth stating the method before the numbers, because an
estimate with no method is a guess with a decimal point on it.

**These are calibrated against this repository's own builds, not against
intuition.** Every figure below is anchored on what comparable work actually
consumed, at this project's quality bar: a provider adapter, a service, a
contract surface, integration tests, and the deliberate-bug verification where
every guard is broken on purpose and confirmed to turn a named test red. That
last part is a large fraction of the cost and it is not optional here.

### The calibration data

| What was built | Tokens | Shape |
|---|---|---|
| Custom field definitions | 171k | Service in an existing seam, no new vendor |
| Outbound webhooks | 206k | New subsystem, no vendor, delivery semantics |
| Email: Resend and SMTP | 267k | New seam, two adapters, one vendor protocol |
| Invoice delivery | 285k | Composer over two existing services |
| Crews, routes and on-call | 321k | Five dormant tables, no vendor |
| Job costing and profitability | 324k | Read-only, heavy correctness burden |
| QuickBooks accounting bridge | 355k | New seam, OAuth, metered reads, idempotency |

Two patterns fall out, and they are the whole estimate:

- **An adapter in a seam that already exists costs 150k to 250k.** The
  interface is decided, the tests have a pattern to follow, and the work is one
  vendor's wire format plus its failure modes.
- **A new capability seam costs 300k to 400k**, because the first adapter has
  to pay for the interface, and the interface is where the thinking is.

Add roughly **40k to 60k for integration**: wiring the registries, regenerating
the OpenAPI document, reconciling against the other work in flight, and the
full gate.

### The estimates

| Integration | Seam | Estimate | Why |
|---|---|---|---|
| ICS calendar feed | calendar (new) | **90k**, BUILT | The reasoning behind the estimate was the part that was wrong: "no failure mode" is not true of a file format. There is no vendor and no auth, and the work is the framing. Folding at 75 octets, escaping, a stable UID and a DTSTAMP that does not move on every poll are each a way for the feed to look fine and be wrong, and breaking every one of them on purpose to confirm a named test goes red is a large share of the cost rather than a rounding error on it. |
| CallRail | telephony + ads | **180k**, BUILT | Existing seams, one API key, documented webhooks, and one fact the plan had wrong: they DO sign, with HMAC-SHA1 over the raw body, and publish a worked example to test against. |
| CompanyCam | storage | **200k**, BLOCKED | The estimate is probably right and cannot be spent yet: their public API is the legacy one and deprecates early 2027, and the replacement is behind a sign-in. See tier 2. A second, separate decision is waiting behind it: `stored_file.bytes` is `not null`, so this product holds the files it knows about, and a photo connector either copies thousands of JPEGs a year into Postgres or invents an external-reference column that `attachment.storage_key` has no way to resolve. That is a schema decision, not an adapter. |
| JustCall | messaging | **160k**, BUILT | The estimate held, and the thing it was really measuring came out the way it was meant to: the seam needed nothing. The adapter is one file and the only change outside it is one import line in the barrel, which is the result that makes the next carrier cheap too. What the estimate did not price was the finding: their webhook signature covers the secret, the URL, the event type and a timestamp, and not one byte of the message, so a valid signature does not prove the body. That is a paragraph in the adapter, a tighter replay window, a line in the catalogue and a line on the website, none of which was in the plan. |
| Avalara AvaTax | tax (new) | **320k** | New seam. Tax is where a quiet wrong answer is most expensive, so the verification burden is high. |
| ClearPathGPS | fleet (new) | **380k** | New seam, and the fleet schema does not exist: `core/assets` has 1,442 lines of tested decision logic with no storage under it. |
| Xero | accounting | **200k**, BUILT | Second adapter in a seam QuickBooks already paid for. The estimate held. What it did not price: finding that this codebase's own seam comment about Xero's change feed was wrong, and that a Xero payment references exactly one invoice while ours carries allocations across several, which is why every payment becomes a batch payment. |
| Lead marketplace field mapping | lead_source | **120k** | Not an adapter. The setup screen and mapping validator, which serves all sixteen senders at once. |
| Vendor price file importer | pricebook | **260k** | Not an adapter either. One importer serving twenty-eight suppliers, with price book versioning as the hard part. |
| Birdeye | reviews | **190k** | Existing seam; the gate is commercial, not technical. |
| Hover or EagleView | measurement (new) | **350k** | New seam, and file handling for the report artefacts. |
| Miter or Lumber | payroll | **240k** | The payroll seam exists now; these are adapters on it. |

### What these numbers are not

They are build estimates for a first working version that passes this
project's gate. They do not include the vendor's own onboarding, which for
anything in tier 3 and below is measured in weeks of email rather than tokens,
and which no amount of spending here shortens. For most of the hard tiers the
token cost is the small number.

---

## Sources

- [ServiceTitan Marketplace partner directory](https://marketplace.servicetitan.com/partner) (175 listings, read via its own page data rather than the paginated view)
- [CallRail API v3](https://apidocs.callrail.com/)
- [CompanyCam developer portal](https://docs.companycam.com/docs/oauth)
- [JustCall API authentication](https://developer.justcall.io/reference/authentication)
- [Avalara developer portal](https://developer.avalara.com/)
- [Thumbtack Partner Platform](https://developers.thumbtack.com/)
- [Sage Intacct Web Services](https://developer.intacct.com/web-services/)
