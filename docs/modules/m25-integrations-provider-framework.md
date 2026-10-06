---
title: Integrations and Provider Framework
module: M25
domain: Platform
phase: 1
status: partial
---

# Integrations and Provider Framework

> Module M25. Domain: Platform. Ships in phase 1.

## What it does

Connects the outside systems a trades company already pays for, through one
framework rather than one bespoke path each: payments, accounting, messaging,
telephony, email, call tracking, lead sources and AI models.

## The problem

A catalogue that lists Google Ads beside a connected checkbox is a product telling
an owner their spend is being imported. If nothing is importing it, the report shows
a channel with leads and no cost, the owner reads it as a free channel, and they
move budget onto it. The failure is silent, it points the wrong way, and it is
exactly the defect class this codebase spends most of its time removing.

## Key concepts

**The catalogue is data, and every entry carries whether it is built.** Two values
only. Built means an adapter is registered and a connection will actually move data.
Declared means this is a thing the product intends to speak to and today does not. A
test asserts that every built entry has a registered adapter behind it, so the
catalogue cannot drift into optimism.

**What counts as built is deliberately narrow.** A parser with no transport is not a
connector. A connector is built when a company can set it up from the settings screen
and data arrives. Thirty seven entries are built today and one is declared.

**A capability is a seam, not a vendor.** Payments, email, accounting, messaging,
telephony, ads, lead source, reviews, maps, tax, payroll, financing, storage,
calendar, analytics and direct mail are members of one enum. A connector in a capability that
already has an interface and a working adapter is a few hundred lines; one that needs
a new seam is a module. That is most of what decides the build order in
`docs/integration-queue.md`.

**Credentials are secret NAMES, not secrets.** The settings screen takes the name of
an environment variable or a secret store entry, so a company's live keys are never
in this product's database and never in a form post. The screen says which names it
is looking for and shows the webhook address to paste into the vendor's dashboard,
because neither of those is something this product can do on a customer's behalf.

**A sign in is the one credential this product keeps.** An ad platform's access
is granted by a person on the platform's own consent screen, and what comes back
is handed to this product, not fetched by the operator from a vendor screen, so
something here has to keep it. It is sealed with AES-256-GCM under
`CREDENTIAL_SEALING_KEY`, a key the deployment holds in its environment and the
database never sees, bound to its connection so it cannot be moved onto another
one. An operator who would rather keep it in their own store names a token as
the connection's credential and never presses the button.

**One connection per provider per company.** A company with two is a company whose
customers hear from two different From addresses at random, so where it matters the
oldest connected one wins deterministically.

**A geocoder runs in the background, never in a request.** The `maps`
capability has two adapters: OpenStreetMap's Nominatim, public or self hosted,
which needs no key, and Mapbox on its permanent tier by secret name. The worker
looks addresses up a few at a time on its own time budget, so a slow geocoder
never holds up saving a customer and a backfill never holds up a text. Against
the public OpenStreetMap server it asks one address a second at most, says who
is asking in every request, and never asks twice about an address it already
answered or could not find. Every coordinate is kept with its precision and its
source, and a pin placed by hand on a property is never moved by it. Google is
deliberately not an adapter: its terms forbid keeping the coordinates and
drawing them on a map that is not Google's.

**A routing service answers how long the drive is, and failing is an answer.**
The `routing` capability has three adapters: OSRM on the company's own server
(no key, and no default address, because the project's demo server asks not to
be used for real traffic), Mapbox's Matrix API by secret name (connected as
`mapbox_directions`, separately from the Mapbox geocoder), and
OpenRouteService, hosted with a key or self hosted without. Each answers a
matrix of drive times; answers are kept in `travel_time` for as long as the
provider allows and asked again after, each request is recorded as an
`integration_event` before it goes, and the network is in no database
transaction. A provider that fails is put on the connection's last error, and
the drives it could not answer fall back to the straight line estimate, which
every screen says.

**A lead connector is a webhook somebody else posts to.** It has its own secret, a
field mapping onto real objects, a test call, and a rotation path for when the secret
leaks. Angi, Thumbtack and Yelp post to the same endpoint, each verified and read by
its own adapter on the marketplace seam (`packages/api/src/marketplaces`): a password
the company chose for Angi and Thumbtack, and for Yelp nothing believed from the post
at all, the lead being read back from Yelp with the company's token. A marketplace
whose API the company cannot get at is read from its lead emails instead, forwarded
to one address per company (M19).

**Sales tax is a seam with one provider, the company's own table.** The `tax`
capability's interface is core's `TaxProvider`: a question about one sale (the day,
the customer's exemption and named rate, the address and its named rate) and an
answer (a rate, which of the company's rates it is, and why). The registry is
`packages/api/src/tax`, in the shape of the other seams, and its only provider is
`table`, which answers from the rates the company set up (M13). No Avalara, TaxJar
or other commercial adapter is written: looking a rate up from an address is
deliberately not built (BUILD.md), and the seam is where one would register. Such
an adapter would be asked before the transaction that writes the document, as
every network seam here is; the table needs no network and is asked inside it.

**A mail house is a seam of one method.** Print this finished piece and post it,
under the piece's own id as the printer's idempotency key (`packages/api/src/direct-mail`,
with Lob). Who gets one, what it says and what it cost stay in the service.

## Setup

`/settings/integrations` connects, changes and disconnects every built integration,
shows each one's state and its webhook address, and takes secret names rather than
secrets. `/marketing/connectors` is the marketing half of the same list.

## Using it

### Connect something

`GET /v1/connectors` is the catalogue with each entry's state and this company's
connection. `POST /v1/connectors/{provider}` connects one and
`DELETE /v1/connectors/{provider}` disconnects it. An ad platform that signs in
waits as pending until somebody has: `POST /v1/connectors/{provider}/authorize`
returns the address of the platform's consent screen and
`POST /v1/oauth/finish` takes what it sends the person back with (M19).

### Take leads from somebody else's form

`POST /v1/lead-connectors` creates an endpoint,
`GET /v1/lead-connectors/fields` lists what a field can be mapped onto,
`POST /v1/lead-connectors/test` runs a mapping against a sample payload without
writing anything, and `POST /v1/lead-connectors/{id}/rotate` replaces the secret.
The endpoint somebody else posts to is `/api/webhooks/leads/{token}`.

### Put addresses on the map

Connect OpenStreetMap or Mapbox under "Maps and addresses" on
`/settings/integrations`. Every property and location without coordinates is
then looked up by the worker, oldest priority first, which is the backfill.
`GET /v1/geocoding` says how many are placed, how precisely, how many are
waiting, and which the geocoder could not find. `POST /v1/properties/{id}/pin`
places one by hand and `DELETE /v1/properties/{id}/pin` hands it back.

### Let customers pay over time

Connect Wisetack under "Customer financing" with the name of the secret holding
the API token, the merchant id, the name of the webhook signing secret, and the
plans on the agreement as months@APR. The webhook address the screen then shows
goes into Wisetack's dashboard, and is also handed to Wisetack on every
application. The seam is `financing` (`src/financing/provider.ts`): open an
application for an amount, read one back, verify and read a webhook. M13 says
what it does on an invoice and an estimate. The adapter is tested against a
fake of Wisetack's API, not a live account, and needs a Wisetack merchant
account.

### Connect a model

`POST /v1/ai/connections` connects an AI provider the company already pays for,
`GET /v1/ai/connections` is the state, and `PUT /v1/ai/spend-limit` caps it. M27
covers what a model may reach.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Connects and disconnects everything |
| Office manager | Neither: `integration:read` is not on the preset |
| Dispatcher, CSR, technician | Neither |
| Accountant | Neither, though `accounting:sync` covers the books sync itself |

`integration:write` guards connecting an app, issuing its token and revoking it,
because those are one decision. There is no separate API key permission, and the
catalogue says why.

## API

| Call | Needs |
|---|---|
| `GET /v1/connectors` | `integration:read` |
| `POST /v1/connectors/{provider}` | `integration:write` |
| `DELETE /v1/connectors/{provider}` | `integration:write` |
| `POST /v1/connectors/{provider}/authorize` | `integration:write` |
| `POST /v1/oauth/finish` | `integration:write` |
| `GET /v1/lead-connectors` | `integration:read` |
| `POST /v1/lead-connectors` | `integration:write` |
| `POST /v1/lead-connectors/test` | `integration:read` |
| `GET /v1/ai/connections` | `integration:read` |
| `GET /v1/geocoding` | `property:read` |
| `POST /v1/properties/{id}/pin` | `property:write` |

## Common questions

**Which integrations are built?** The catalogue answers it at runtime, and the
settings screen shows it. Stripe, Wisetack, QuickBooks Online, Xero, Twilio, JustCall, Resend,
SMTP, CallRail, the AI model providers, the OpenStreetMap and Mapbox geocoders,
the OSRM, Mapbox and OpenRouteService routing services,
Google Ads, Google Local Services, Meta Ads, Google Analytics, Google Business
Profile and Facebook Page reviews are the ones a company can set up and see data
arrive from. The last six are tested against fakes of each, not live accounts, and
five of them need the platform's own developer approval first: Google Ads (a
developer token), Local Services and Business Profile (Google's API access), Meta
Ads (app review for some permissions) and Facebook Page reviews (app review for
reading and answering a Page's ratings, without which nothing is read). Google Analytics needs only a Measurement Protocol secret
from the company's own data stream, which nobody has to approve.

**Where do the map's pictures come from?** Raster tiles from `MAP_TILE_URL`,
OpenStreetMap's own servers by default with their attribution on the map. That
is a deployment setting rather than a connector, because a tile is fetched by the
viewer's browser and not by this product; a company with a room of dispatchers
points it at a tile service it pays for, as OpenStreetMap's tile policy asks.

**Why is there a plan document as well as a catalogue?** Because the plan is a plan.
`docs/integration-queue.md` orders what to build next and a test checks the document
against the catalogue, so a tier that goes stale after something ships fails the
build rather than quietly misleading whoever reads it next.

**Can I write my own adapter?** Yes, against the capability seam. That is the point
of there being a seam rather than a vendor specific path.

**What does an accounting adapter have to do?** Push a customer, an invoice, a
payment with its allocations, a credit for a void or write off, a refund, and a
credit note, apply a credit note to an invoice, find any of those again by the key
written on it after a lost response, read a change feed from an opaque resume point,
and list the chart of accounts. Applying a credit note has a finder of its own,
because not every book can search an application by a key: a Xero allocation carries
no reference, so its adapter reads the credit note and matches the invoice, amount
and date. Taking a credit note back is not a method: the sync sends it as an invoice
and an application, which every adapter already supports.

## What is not built

One catalogue entry is declared and has no adapter (marketing email as its own
connector; campaigns send through the email connection already there), and the
catalogue names it rather than hiding it. Every marketplace, ad platform, analytics
read back and mail house built here is tested against a fake of its documented API,
not a live account, and each marketplace's API answers only a partner it has
approved (M19 says which). The geocoders' rate limit is per process, so a
deployment running several workers against the public OpenStreetMap server sends
that many requests a second; run one worker, or your own geocoder. There is no
batch geocoding endpoint: addresses are placed one at a time by the worker, and
`GET /v1/geocoding` says how many are waiting. A routing service answers drive
times by road without traffic, and with none connected drive time is the straight
line at an average speed (M09). There is no marketplace, no adapter plugin loading at
runtime and no per connector health dashboard beyond each one's state on the settings
screen. Secrets are read from the environment or a secret store by name, so a company
that wants them managed in the product does not get that, deliberately; the one
exception is an ad platform's sign in, which is sealed as described above.
Rotating `CREDENTIAL_SEALING_KEY` has no path but signing in to every platform
again.
