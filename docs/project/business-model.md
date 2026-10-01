# How this gets funded without losing money

An open source product with a hosted tier has one failure mode that kills it,
and it is not failing to grow. It is growing while each new customer costs more
than they pay. This document exists to make that arithmetic explicit and
checkable rather than assumed.

## The constraint, stated first

**Every tier must cover its own marginal cost before anything else is true.**
Not on average across the base. Per tenant, because an average hides the
distribution, and in this category the distribution is the whole problem: a
two technician plumber and a forty truck mechanical contractor differ by more
than an order of magnitude in database size, message volume and support load,
and a per user price does not track any of it.

## A contradiction that has to be resolved before anything else

The pricing page has said, and until this week the plan has assumed, that one
of the funding lines is **a share of payment processing volume**, on the
reasoning that it is how Jobber and Housecall Pro actually make their money.

**The Stripe integration that now exists cannot produce that revenue, by
design.** It uses the operator's own restricted key against their own Stripe
account with no Connect and no platform account, which is Stripe's own guidance
for self hosted software and the only posture that survives this product
running on infrastructure we do not control. The money never passes through
anything we own. There is nothing to take a share of.

The two cannot both be true, so one of them has to go:

1. **Keep the architecture and drop the claim.** Payment revenue is not a
   funding line. This is the honest option and it is the one the code already
   took.
2. **Offer a managed payments option on Cloud only**, where we do control the
   deployment, using Connect for those tenants. Self hosters keep the
   restricted key path and pay nothing. This is defensible, it is a real
   revenue line, and it costs a Connect platform account plus the compliance
   that comes with it.
3. Take a cut from self hosted deployments. **Not possible and not desirable**:
   the key is theirs, and a product that inserted itself into a contractor's
   card payments would deserve the fork it would get.

Until somebody chooses, the site should not list it. The claim has been removed
from the pricing page for that reason: it was revenue the code cannot collect.

## What it actually costs to run one tenant

The figures below are the shape of the model, not quotes. Anywhere a number is
load bearing it is marked as needing a real measurement before it is trusted.

### Fixed per tenant, per month

| Line | Driver | Rough |
|---|---|---|
| Postgres | One database per tenant, which RLS makes optional but backups and restore make sane | $15 to $40 |
| Application and worker | Shared, amortised; the worker is the one that scales with event volume | $5 to $15 |
| Object storage | Photos are the whole of it: a field app that takes twenty photos a job is gigabytes a year | $2 to $20 |
| Backups and retention | Nightly, and the restore test that makes them real | $3 to $10 |
| Monitoring and logs | Flat until something goes wrong, then not | $2 to $5 |

**Call it $30 to $90 per tenant per month before anybody is paid and before a
single support ticket.**

### The lines that scale with use, and are therefore the dangerous ones

- **SMS.** Carrier fees per segment plus 10DLC registration. A company sending
  arrival notices on forty jobs a day is a real cost, and it is per message
  rather than per user. A per user price with unmetered SMS loses money on
  exactly the customers who are getting the most value.
- **Email.** Cheap per message and not free; the same shape.
- **AI.** The provider seam takes the operator's own key, which is the correct
  default and removes this risk entirely for them. Any tier where we supply the
  key is a tier where one runaway automation is a bill nobody capped. If we
  ever supply keys, the ceiling has to exist before the feature ships.
- **Support.** The largest and least linear. One migration from ServiceTitan
  can consume more hours than a year of subscription returns.

## Why per user pricing is wrong here, and what to do instead

The homepage already argues that per technician pricing punishes growth, and it
is right about the customer's side. It is also wrong about ours: a per user
price tracks none of the costs above. A ten user office with two trucks costs
less to run than a four user company texting every customer twice a day.

**The honest shape is a small platform fee plus metered pass through on the
things that are genuinely metered**, with the meter visible. Contractors
already understand this: it is how they bill. What they object to is not paying
for what they use, it is paying per seat for software whose cost does not vary
by seat.

What that means concretely:

- A base price per tenant covering the fixed lines, with generous but finite
  included volume.
- SMS and email passed through at cost plus a small margin, shown per month.
- AI on the customer's own key by default, so it is free to us and visible to
  them.
- No per user price at all, which also removes the incentive to share logins
  that every seat priced FSM creates.

## The revenue lines, in order of how much they can actually carry

1. **Managed hosting.** The main line. Viable only if the base price exceeds
   the fixed per tenant cost with room for support, which means **the floor is
   higher than the instinct to price it low**. A $29 tenant costing $60 to run
   is a company that grows itself to death.
2. **Enterprise.** SSO, SAML, multi brand, SLA, dedicated infrastructure. Small
   number of customers, large contracts, and the features are genuinely
   separable rather than crippleware. **M01 does not have SAML or OIDC today**,
   so this line is not sellable yet and the pricing page should not imply it is
   imminent.
3. **Migration as a paid service.** The single highest willingness to pay in
   this category, because the alternative is the contractor's own staff
   re-keying a year of history. It is labour rather than software, so it
   carries no fixed cost, and the migration toolkit is already Apache 2.0 and
   already works for Jobber and Housecall Pro.
4. **Managed payments on Cloud**, if option 2 above is chosen. Scales with the
   customer's success rather than their headcount, which is the property the
   original reasoning was after.
5. **Support contracts for self hosters.** Small, real, and the one line that
   monetises the free tier without touching the free tier.

## What AGPL does and does not protect

It stops a competitor running a modified hosted version without publishing
their changes. It does **not** stop them running an unmodified one, and that is
the realistic threat: somebody with better operations and a bigger ad budget
hosting this exact code. The defences are the ordinary ones, not the licence:
being the place the roadmap is decided, holding the migration tooling and the
operational knowledge, and shipping faster than a reseller can track.

A trademark on the name matters more here than most people expect, because it
is the thing that stops a hosted fork calling itself this product.

## The numbers to measure before any of this is a plan

Nothing above is worth acting on until these are real:

1. **Cost per tenant per month**, measured on ten real tenants of different
   sizes, not modelled.
2. **Support hours per tenant per month** in the first ninety days versus
   steady state. The first number is usually three to five times the second and
   it decides whether onboarding can be free.
3. **SMS and email volume per technician per month**, which converts the
   metered lines from a worry into a price.
4. **Conversion from self hosted to Cloud.** The whole strategy assumes the
   free tier feeds the paid one. If it does not, the free tier is a marketing
   cost and should be judged as one rather than as a funnel.
5. **Migration hours per competitor**, per source system. This decides whether
   migration is a product or a service.

## The decision that is actually urgent

Not pricing. **Whether Cloud exists at all in the next twelve months.**

Running managed infrastructure for other people's businesses is an operations
company, with on call, incident response, data retention obligations and the
liability that comes from holding somebody's receivables. It is a different
business from building the software, it starts costing money immediately, and
it is the thing that most often kills an open source project that was otherwise
doing fine.

The alternative worth considering seriously: **stay software only for now.**
Self hosting, paid migration, paid support, and a partner who does the hosting
under their own name. Revenue is smaller and so is the downside, and it leaves
the option open rather than closing it.
