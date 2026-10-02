---
title: Setup, Configuration and Trade Packs
module: M02
domain: Foundation
phase: 0
status: partial
---

# Setup, Configuration and Trade Packs

> Module M02. Domain: Foundation. Ships in phase 0.

## What it does

Gets a company from a fresh sign up to taking real bookings, and holds
everything a company configures about itself afterwards: what it is called,
what it looks like, what time zone its day runs in, and which trade it is in.

## The problem

Every field service platform has a setup flow and most of them fail the same
two ways.

The first is a wall. Nine screens of required fields, one of which asks for an
EIN, and a contractor at nine in the evening who cannot find it is blocked from
booking a job tomorrow. So every step here is skippable, the wizard shows what
is still outstanding, and the steps that actually prevent a booking are the
only ones marked.

The second is an empty database. A setup flow that asks about tax classes and
margin targets before there is a single price book item to apply them to is a
flow people abandon. So choosing a trade is step two of ten rather than step
nine: it seeds a real price book, and every question after it is being asked
about something concrete.

Two steps carry somebody else's review queue. A2P 10DLC registration and Stripe
onboarding both involve a third party deciding, and a company that discovers
that on cutover day has lost a week, so both are flagged "start early" on the
list rather than mentioned in a help article.

## Key concepts

**A trade pack is versioned data, not code.** This is the lever that lets one
product serve twenty six trades without either a generic form builder nobody
configures, or twenty six forks. A pack carries a starting price book, the job
types that trade actually runs, the checklists a technician fills in, the
readings they capture, the equipment categories those readings hang off,
statutory inspection programmes, the submissions those produce, the retention
rules that govern the records, the customer portal blocks that make sense for
the trade, and the KPIs an owner in that trade manages to.

Anyone who has run a shop in a trade can contribute one, and that is the point.
The contributions this project most needs are not pull requests full of
TypeScript.

**Every pack is validated at import.** A malformed pack fails the build rather
than seeding a broken company at setup time, which is when a contractor would
otherwise find out, halfway through their first hour.

**A pack states what it does not cover, in the author's own words.** That field
is generously sized on purpose: the first cap on it was 500 characters and a
pack failed validation for being thorough about its own gaps, which is exactly
the behaviour it exists to encourage.

**The capacity model is a property of a job type, not of a trade.** There was
a capacity model on the pack, labelling each trade as dispatch, crew, route or
rental, and it is gone, because the claim it made was false. A lawn company
runs routes and sells installs. An electrician dispatches service and runs
crews on a rough in. Stamping one word on a trade tells an owner their business
is a category, and the ones who do two things are being told half of what they
do is not what this product is for. The per job type model stays, because that
one decides real behaviour and is set where the difference exists.

**A pack's pricing is a national average starting point, not a
recommendation.** It exists so hour one is useful. The wizard walks the owner
through re-margining it for their market, and says so on the screen.

**Retention almost never runs from when the row was created.** A pack declares
the clock start explicitly: calendar year end, work completed, report prepared,
employment ended, contract ended, equipment removed, or the next activity of a
kind. Getting that wrong means a purge destroys records a contractor still has
to hold.

**An inspection checkpoint that takes a reading has to carry a range.** A
number with nothing to judge it against goes into a report and nothing decides
whether it is a finding, so core refuses a reading checkpoint with no range.
A checkpoint also carries what its failure suggests selling, as a key into the
contractor's own price book and never a price, because the mapping from "the
backflow preventer failed" to "the part number we sell for that" is a decision
each contractor makes differently and has to be able to argue with.

## Setup

Ten steps, in this order. The four marked essential are what stops a booking.

| Step | Essential | Needs |
|---|---|---|
| Company details | Yes | `settings:write` |
| Your trade | Yes | `settings:write` |
| Service area | Yes | `settings:write` |
| Hours and availability | Yes | `settings:write` |
| Your team | No | `user:invite` |
| Price book | Yes | `pricebook:write` |
| Sales tax | Yes | `settings:write` |
| Payments | Yes, and start early | `integration:write` |
| Phone and email | No, and start early | `integration:write` |
| Accounting | No | `integration:write` |

The wizard lives at `/setup`, and the trade step at `/setup/trade`. A step
whose permission the signed in person does not hold is shown and not clickable,
rather than hidden, because an office manager needs to be able to see that
somebody else has to do the payments step.

Eight packs ship: HVAC, plumbing, electrical, lawn and landscape, pest control,
cleaning, dumpster rental and trash bin cleaning.

## Using it

### Change the trade later

Applying a pack is additive against the price book and the job type list. It is
a service call rather than a screen after setup, because re-applying a pack over
a company's edited price book is a merge nobody has designed a sensible screen
for yet.

### Configure the company

`Settings` holds the four things a company changes after setup: its time zone,
how it looks (a brand colour and a logo, which appear on the customer portal
and on documents), the phone numbers it sends from, and its call recording
policy. All four need `settings:write` to change and `settings:read` to see.

The time zone is not cosmetic. Every date boundary in the product is computed
in it: a container day in M22, quiet hours on a campaign in M19, a pay period
in M17. A company in the wrong zone gets a working day that starts in the
evening.

### Divide the company up

A company that runs out of more than one building can declare locations,
business units and territories: `GET /v1/locations`,
`GET /v1/business-units` and `GET /v1/territories` to read, with
`POST /v1/locations`, `POST /v1/business-units` and `POST /v1/territories` to
create. All of them are `settings:read` and `settings:write`.

## Permissions

| Role | Access |
|---|---|
| Owner | Everything, including the steps that connect money and messaging |
| Administrator | Everything in this module |
| Office manager | Reads settings. Does not change them |
| Dispatcher, CSR, technician | Neither |
| Accountant | Reads settings |

## Common questions

**Can a company skip the wizard entirely?** Yes. Nothing in it is enforced
later; it is a checklist, not a gate.

**Does the wizard remember which steps are done?** Not yet. Nothing is stored
as complete, so every step reads as outstanding each time the list is opened.
That is the honest state of it and the code says so where a reader would look.

**Where do trade specific KPIs show up?** `Reports > Trade scorecard`, which
is M21. A pack declares them; that module computes the ones it can and names
the missing datum for the ones it cannot.

## What is not built

Eight of the ten steps have no dedicated screen behind them: company details,
service area, hours, team, price book, tax, payments and communications are
configured elsewhere in the product or through the API, and the wizard links to
a step page that does not exist for most of them. The trade step is the one
that is built end to end. Step completion is not persisted, as above. Nothing
re-applies a newer version of a pack to a company already running on an older
one.
