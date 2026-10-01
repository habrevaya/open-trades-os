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

---

## Tier 1: build next

Self-serve credentials, a seam that already exists, and a data model that can
take it. Each of these is an adapter rather than a module.

### 1. CalDAV and ICS calendar feed (not a marketplace listing)
The `calendar` capability is in the enum with no provider. A read-only ICS feed
of a technician's visits is maybe eighty lines and works with Google Calendar,
Apple Calendar, Outlook and every phone, with no vendor relationship at all.
CalDAV two-way is the follow-up. This is first because it is the cheapest real
improvement to a technician's day in the whole list.

### 2. CallRail: call tracking
REST API v3, authenticated with `Authorization: Token token="..."`, keys
self-serve from the integrations screen on a paid plan, nine webhook event
types. Lands in the `telephony` and `ads` seams we already have, and attribution
per call is exactly what `marketing_touch` was built to hold.
*Caveat worth recording: a single long-lived key with no OAuth and no refresh,
so rotation is manual.*

### 3. CompanyCam: job photos
Bearer-token REST, a public developer portal with an OpenAPI spec and a Postman
collection, personal access tokens for testing and application keys for the
real thing, and no separate developer account needed. Photos attach to
`stored_file` and `visit`, both of which exist.

### 4. JustCall: phone and SMS
REST plus webhooks for calls, SMS, contacts and numbers, authenticated with an
API key and secret copied out of the account screen. Drops into the existing
messaging provider seam beside Twilio, which is the test of whether that seam
was drawn in the right place.

### 5. ClearPathGPS: fleet tracking
Open API on their Pro plan, real-time location and vehicle data. Needs the
`fleet` capability, which does not exist yet, but `M22` has 1,442 lines of asset
logic in core already waiting for a schema.

### 6. Avalara AvaTax: sales tax
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
| **Sage Intacct** | A Web Services developer licence from **$2,500 per year** with no support included, or partner membership at $2,500 plus $0.015 per API call. For an AGPL project with no revenue this is the decisive fact, not the API's difficulty. |
| **Oracle NetSuite** | SuiteTalk, gated behind a partner relationship and an account that costs more than most of our users' whole stack. |
| Viewpoint Spectrum / Vista | Reached through MindCloud, a middleware vendor, rather than directly. |
| Stuut, The Graphite Lab | AR and bookkeeping services layered on an accounting system rather than one. |

**Xero is the one to build and it is not on this list**, because Xero does not
pay ServiceTitan for placement. It has a free developer account, self-serve
OAuth 2.0 app registration and public docs, which makes it strictly easier than
every row in this table and comparable to QuickBooks. It belongs in tier 1 on
merit and is here only so the reasoning is visible.

---

## Tier 5: money, lending and compliance

Hard because of what they are, not because of their APIs.

- **Consumer financing**: GreenSky, Synchrony, Wells Fargo, Service Finance,
  Financeit, TURNS, Bluevine, Coral. Every one needs a contract, a dealer
  agreement and in most cases a lending licence held by the contractor. The
  integration is the smallest part.
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
| ICS calendar feed | calendar (new) | **90k** | Below the floor because there is no vendor, no auth and no failure mode: it is a formatter over data we hold. The cheapest real improvement in the list. |
| CallRail | telephony + ads | **180k** | Existing seams, one API key, documented webhooks. |
| CompanyCam | storage | **200k** | Existing file model, bearer auth, OpenAPI spec published. |
| JustCall | messaging | **160k** | The cheapest of the adapters, because it drops into the messaging seam beside Twilio. If it costs more than this the seam is in the wrong place, which is itself worth finding out. |
| Avalara AvaTax | tax (new) | **320k** | New seam. Tax is where a quiet wrong answer is most expensive, so the verification burden is high. |
| ClearPathGPS | fleet (new) | **380k** | New seam, and the fleet schema does not exist: `core/assets` has 1,442 lines of tested decision logic with no storage under it. |
| Xero | accounting | **200k** | Second adapter in a seam QuickBooks already paid for. |
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
