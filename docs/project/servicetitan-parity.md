# Covering what ServiceTitan covers

A checklist, not a claim. Nothing here says we have parity: most of it is not
built. What it says is that every part of ServiceTitan's surface has somewhere
to land in this plan, so the answer to "will it eventually do X" is a module
number rather than a shrug.

## Why this document exists

ServiceTitan is the most complete product in this category. A contractor
evaluating an alternative is not comparing features one at a time: they are
asking whether the thing they use on Tuesday afternoon has an answer here at
all. One missing surface they happen to depend on ends the evaluation,
regardless of how good the rest is.

The risk this document manages is not building the wrong thing. It is
finishing the roadmap and discovering a whole surface was never in it.

## How the list was built

Their published product pages and SKU list, plus the competitor research in
the website repository, which was compiled from their documentation, API
reference and terms. Their add-on SKUs are the most useful index of the
surface, because each one is a product area they decided was big enough to
sell separately: Marketing Pro, Contact Center, Phones Pro, Pricebook Pro,
Dispatch Pro, Scheduling Pro, Fleet Pro, Sales Pro, and the AI layer.

It is a moving target and this will go stale. It is dated by its commit rather
than pretending otherwise.

## The map

| Their surface | Here | State |
|---|---|---|
| Company setup, business units, tax, numbering | M02 | Built |
| Customer and location management | M03 CRM | Built |
| Equipment and service history | M04 | Part built |
| Scheduling, dispatch board, capacity, zones (Dispatch Pro) | M09 | Built |
| Jobs, job types, forms, checklists | M10 | Built |
| Mobile technician app | M11 | Built |
| Projects and construction (multi phase) | M12 | Planned |
| Price book, member pricing, kits (Pricebook Pro) | M06 | Built |
| Estimates, good better best, in home sales (Sales Pro) | M07 | Built |
| Memberships and service agreements | M08 | Part built |
| Invoicing, payments, card present, financing | M13 | Built |
| Accounting sync, GL, tax (QuickBooks, Intacct) | M14 | Part built |
| Job costing and profitability | M15 | Part built |
| Purchasing, vendors, inventory, truck stock | M16 | Part built |
| Payroll, timesheets, commissions, scorecards | M17 | Part built |
| Phones, IVR, call recording, softphone (Phones Pro, Contact Center) | M18 | Part built |
| Ads, attribution, call tracking, email (Marketing Pro) | M19 | Part built |
| Reviews and reputation | M20 | Planned |
| Reporting, dashboards, custom reports | M21 | Part built |
| Fleet and GPS (Fleet Pro) | M22 | Planned |
| Documents, licences, compliance, safety | M23 | Planned |
| People, certifications, skills | M24 | Planned |
| Integrations | M25 | Part built |
| Public API and webhooks | M26 | Part built |
| AI layer | M27 | Planned |
| Custom fields, custom objects, workflow builder | M29 | Part built |
| Data import and export | M30 | Part built |
| Customer portal and online booking (Scheduling Pro) | M05 | Built |
| Multi location and franchise roll up (Enterprise Hub) | M01, M21 | Part built |

M28, the developer and agent platform, has no ServiceTitan equivalent and is
listed under what is deliberately different below.

Four surfaces had nowhere to land when this was written, and now do.

| Gap | Now | Why it was missed |
|---|---|---|
| Commercial parties, authorisations, rate cards, AP portals | M31 | The schema modelled it in the first migrations; no module named it |
| Coverage: warranty, home warranty, insurance, goodwill | M32 | Same |
| Inspections and the deficiency backlog | M33 | Same |
| Tasks: the office work queue | M34 | Genuinely absent from both |

Three of those four already exist as schema. That is the inverse of this
project's usual failure: built and not named, rather than named and not built.
The consequence is the same either way, which is that a reader comparing
against ServiceTitan could not find them.

## What we do not intend to match

Saying this plainly is more useful than a silent gap.

- **Their reporting depth.** Dynamic reports with typed parameters, scheduled
  exports and a governed semantic layer are genuinely the best in the
  category. M21 aims at the dashboards an owner opens and direct SQL against a
  read-only schema, which is a different and smaller promise. A contractor who
  lives in report builders should weigh that.
- **Their implementation service.** A structured onboarding with a named
  consultant is a large part of what a ServiceTitan contract buys. We ship a
  migration toolkit and documentation.
- **Payment processing as a business.** Card processing is a core ServiceTitan
  revenue line. Here it is a provider you choose and can change.
- **Per-trade depth at the top of the market.** Their HVAC and plumbing
  configuration has a decade of edge cases in it that we will not have for
  years.

## Where the shape is deliberately different

Not gaps. Decisions, for reasons that are in the module pages.

- **Coverage is a first class concept** (M32). A zero dollar visit under an
  agreement and a zero dollar visit that is our own rework look identical on a
  revenue report and mean opposite things about the business.
- **A job has parties, not a customer** (M31). One customer who orders,
  approves, is billed and pays is true for residential service and false for
  roughly half the market.
- **Automation runs on an append only event log** (M29), shared with webhooks
  and agents rather than a private queue, so a customer can replace any
  consumer with their own.
- **Consent is checked at send time**, not at authoring time (M18), because a
  workflow written in March is still running in November.
- **M28: the whole product is addressable by an agent.** An MCP server over the
  same permission model a person gets, so a contractor can point their own
  tooling at their own data. ServiceTitan has an API; this is a different
  claim.
- **You own the database.** The whole schema is documented and exportable,
  which is the one thing a contract cannot give you back later.

## Keeping this honest

`apps/web` in the website repository carries the module list, and its content
test asserts that every module code named in this table exists there with a
status. A surface named here and missing there fails the build, which is the
only thing that stops this document becoming a wish list.
