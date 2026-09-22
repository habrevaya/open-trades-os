# Licensing, editions and hosting

The structure this project follows, why, and the two places it deliberately
departs from the model it is copying.

## What needs a decision before anything changes

Nothing in this document has been applied. Today every package is
`AGPL-3.0-only` and `LICENSE` is the stock AGPL text with no exception. Four
things below are license changes, and a license change is the owner's call
with counsel, not a refactor:

1. **Add an Application Exception under AGPL section 7.** Needed before any
   partner will build against the API, Neighbrium included. The wording is
   legal text and should be drafted or reviewed by a lawyer rather than
   written here.
2. **Relicense the trade packs, the SDK and the booking widget to MIT.** They
   are meant to be embedded and lifted; AGPL defeats that.
3. **Decide whether a commercial carve-out exists at all.** The recommendation
   is that it does not yet, and that if it ever does it never covers a safety
   property.
4. **Pick the hosted pricing unit.** Not per seat, for the reason below. The
   candidates are set out at the end.

Relicensing is one way only in practice: contributions accepted under AGPL
cannot be silently moved. Doing it early, while the contributor list is short,
is much cheaper than doing it later.

## What Twenty does

Twenty is the closest comparable: an AGPL CRM with a managed cloud, and the
structure is worth copying because it has already survived contact with real
self hosters.

1. **AGPL-3.0 for the product.** The whole application, self hostable with no
   feature gate and no user cap.
2. **A file level commercial carve-out.** Individual files carry
   `/* @license Enterprise */` at the top, and the commercial terms are
   appended to the same `LICENSE` file. SSO, SAML and row level permissions
   live there.
3. **MIT for the edges.** Development toolkits and component libraries are
   MIT via their own `package.json`, so somebody embedding a widget is not
   pulled into AGPL.
4. **An Application Exception under AGPL section 7.** Applications built
   against their published APIs and SDKs are not governed by AGPL, even when
   bundled with AGPL libraries at deploy time.
5. **Managed cloud, per seat.** Pro at nine dollars per user per month,
   Organization at nineteen, which adds SSO and priority support.

Point 4 is the one most summaries leave out and the one that matters most
here. See "Connected applications" below.

## What this project does

### The core is AGPL-3.0, and safety is never a tier

Same as Twenty, with one firm departure: **row level permissions stay in the
core.**

Twenty puts them behind the enterprise license. For a CRM that is a defensible
line. For this product it is not, and the reason is concrete rather than
philosophical. A technician's scope is what stops a departing employee walking
out with the customer list, and the gap that existed before
`services/scope.ts` let a technician read every customer, invoice and estimate
in the company. A self hoster who cannot afford a licence is exactly the two
truck shop most exposed to that.

So the rule is: **anything that prevents a self hoster from being harmed is in
the core.** Permissions, scopes, row level security, consent, the audit log,
tenant isolation, the ledger guards. None of it is ever a paid tier. A feature
gate on a safety property is a promise to sell somebody their own security
back, and this project's entire pitch is that you own the thing.

### What could sit behind a commercial licence

Nothing does today. If it ever does, the test is that a company which cannot
buy it is inconvenienced rather than exposed:

- SSO and SAML. A twelve person shop does not have an identity provider.
- Multi organization administration for franchises and roll-ups: one console
  over many tenants. A single company needs none of it.
- Long horizon audit export into a SIEM. The audit log itself stays in core;
  shipping it to Splunk on a schedule is an enterprise operations problem.

Each of those is a thing a large buyer has budget for and a small one has no
use for. None of them is a wall between an operator and running their business
safely.

### MIT for anything that has to be embedded

The API client, the SDK, the booking widget and the trade packs. Somebody
dropping a booking form on their own marketing site must not inherit AGPL,
and a trade pack is data a contributor should be able to lift into anything.

The migration toolkit is already Apache-2.0 in its own repository, for the
same reason stated there: getting your own data out of software you pay for
should not require anyone's permission, including ours.

### An Application Exception, under AGPL section 7

Without one, AGPL's network clause reaches anything that combines with this
product over a deployment. That is the correct default for a fork and the
wrong result for an integrator, and it is the difference between an ecosystem
and a moat pointed the wrong way.

So: **an application built against the published HTTP API, the SDK or the MCP
server is not governed by AGPL**, even where it is deployed alongside AGPL
components. Modify the product itself and AGPL applies as normal.

This is the mechanism that makes Neighbrium, or any other connected app,
possible without either relicensing this project or making the partner open
their own source.

## Hosting

Managed hosting, priced like the product is positioned.

**Not per seat.** Twenty charges per user and that is coherent for a CRM,
where a seat is a salesperson. It is incoherent here. The site says, on the
pricing page and the home page, that there is no per seat price and that self
hosting is unlimited users. Charging per user for the hosted version would
make the cheapest way to add a dispatcher "run it yourself", which is an
argument against our own hosting.

It also gets the unit wrong. A five truck shop with twelve part time helpers
is a smaller business than a five truck shop with five full timers, and per
seat charges the first one more.

The unit should be the thing that scales with the value delivered. Candidates,
in the order they seem defensible:

1. **Per active technician per month.** A technician is the revenue producing
   unit in this trade, office staff are free, and it matches how an owner
   already thinks about capacity.
2. **Percentage of processed payments,** for shops taking payment through the
   platform. Aligns exactly with value and is what several field service
   products already do through their payments margin.
3. **Flat per company band,** by revenue or truck count. Simplest to
   understand and the least fair at the edges.

That decision is not made. What is decided is that it will not be per seat,
because the positioning is already published and contradicting it is worse
than charging slightly wrong.

**Hosting includes what self hosting cannot easily do for itself:** carrier
registration for messaging, a managed number pool, provider credentials the
operator does not have to obtain, backups with a tested restore, and
upgrades. That is a real product rather than a licence key, which is the
point.

## Connected applications, and Neighbrium specifically

A connected app is an ordinary API consumer plus three things the product
does not have yet:

- An app registry, so an operator can see what is connected, what it may
  read, and revoke it in one click.
- Scoped tokens, so a partner gets exactly the permissions the operator
  granted and no more. The permission and scope work is already the right
  shape for this, because an app is just another actor.
- A published, versioned contract. That exists: sixty routes served over HTTP
  with a schema per route.

Neighbrium is the first case, and the thing it needs, sharing pricing and
availability, is a read against the price book plus a write into bookings.
Both are existing endpoints. What is missing is the grant model, not the API.

It gets its own document when it is scoped. The licensing answer for it is
settled here: the Application Exception means a partner integrating over the
API is not pulled into AGPL, and that has to be true before anybody will
build the integration.
