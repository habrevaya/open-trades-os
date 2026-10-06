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
flow people abandon. So choosing a trade is step two of eleven rather than step
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
the trade, the KPIs an owner in that trade manages to, and recommended
automations offered on `/automations` to a company that applied it (M29).

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

Eleven steps, in this order. The ones marked essential are what stops a booking.

| Step | Essential | Needs |
|---|---|---|
| Company details | Yes | `settings:write` |
| Your trade | Yes | `settings:write` |
| Service area | Yes | `settings:write` |
| Hours and availability | Yes | `settings:write` |
| Your team | No | `user:invite` |
| Price book | Yes | `pricebook:write` |
| Sales tax | Yes | `pricebook:write`, and `settings:write` for the rates |
| After hours and holiday rates | No | `pricebook:write` |
| Payments | Yes, and start early | `integration:write` |
| Phone and email | No, and start early | `integration:write` |
| Accounting | No | `integration:write` |

The wizard lives at `/setup`, and every step has a page of its own that draws
the real settings form for it rather than a copy: `/setup/company` (the name,
the legal name, the phone, email and postal address customers reach the
company by, the time zone, the logo and colour), `/setup/trade`,
`/setup/service-area`, `/setup/hours` (opening hours, arrival windows, what
may be booked online and the holiday list), `/setup/team` (inviting people, who are emailed a link
to choose a password, and branches for a company with more than one shop), `/setup/pricebook` (every price, or one
shelf, moved up or down by a percentage, previewed first and undoable from
`/pricebook/changes`), `/setup/tax` (the sales tax rates the company charges and
its usual one, the same form as `/settings/tax`, and which items are taxed),
`/setup/rates` (the item charged after hours and the one charged on a holiday),
`/setup/payments`,
`/setup/communications` (texting and email providers, and the A2P 10DLC brand
and campaigns written down) and `/setup/integrations`. Each page says what is
already in place, read from the data, and where the same setting lives after
setup.

A step whose permission the signed in person does not hold is shown and not
clickable, rather than hidden, because an office manager needs to be able to
see that somebody else has to do the payments step.

**Done is said, not inferred.** Each step page ends with "This step is done",
which records it (`setup_step`), and the list ticks it off and offers "Carry
on" to the first step still outstanding that this person can do, so somebody
who closed the tab at step four comes back to step five. Most steps have no
answer in the data (a price book at national averages looks exactly like one
somebody checked line by line), so the facts sit beside the button instead of
behind it. Marking a step needs the step's own permission. Choosing a trade
marks its step done. `GET /v1/setup` reads the same list, and
`POST /v1/setup/steps/{key}` marks a step done or not done. The list stays
open after "Go to the app" (`POST /v1/setup/finish`), and Settings links back
to it.

Eight packs ship: HVAC, plumbing, electrical, lawn and landscape, pest control,
cleaning, dumpster rental and trash bin cleaning.

## Using it

### Change the trade later, and take a newer version of it

Applying a pack is additive against the price book and the job type list:
an item or job type whose code the company already has is skipped, never
overwritten, and the rest of the pack (the service report template,
inspection programmes, retention rules and portal layout) is seeded once, so
applying a pack again changes nothing. `/setup/trade` applies another pack
beside the first, and `POST /v1/trade-packs/{id}/apply` does the same.

Each application records what the pack seeded, item by item. When this
product ships a newer version of a pack a company is running, `/setup/trade`
shows exactly what it would change before anything is written
(`GET /v1/trade-packs/{id}/upgrade`), and one button applies it
(`POST /v1/trade-packs/{id}/upgrade`):

| The company's item | What the upgrade does |
|---|---|
| Not in the company's book | Added |
| Still exactly as the older version seeded it | A new version with the new values, so documents that quoted the old price still say it |
| Changed here since, by any route (one edit, a bulk re-price, an import) | Kept, and listed with what the new version would have changed |
| Made by the company, or another pack, under the same code | Kept |
| Dropped by the new version | Kept, because invoices point at it |
| A job type the company does not have | Added |

"Changed here" is decided against the recorded snapshot, field by field. A
company that applied its pack before snapshots were recorded is judged by
the item's version number instead: anything revised since the seed counts as
changed and is kept, which is the safe direction to be wrong in. The plan is
worked out again inside the write, so an item edited after the preview was
looked at is kept rather than overwritten. Costs in the preview are shown only
to somebody who may read them. `GET /v1/trade-packs` says which version of each
pack the company is on.

The rest of the pack is upgraded by the same rule, and the preview lists it under
its own heading: the service report template, each inspection programme, each
retention rule and the portal layout. Each is compared as a whole against what the
company's current version set up, which each application records beside the price
book: a template's name and readings, a programme's name, standard, audience,
frequency and checkpoints, a rule's records, clock, months and basis, a layout's
name and sections. What the company decides for itself (whether a rule may purge,
whether a template or rule is in force, which layouts show) is never compared and
never touched.

| The company's piece | What the upgrade does |
|---|---|
| Not set up yet | Set up |
| Still as the older version set it up | Takes the new version; a template's readings and a programme's checkpoints get a new version number, as an edit by hand does, so a report or inspection done under the old ones still says which it answered |
| Changed here since | Kept, and listed with the parts the new version would have changed |
| Taken out here | Kept out: the record says it was there, and putting it back would undo a decision |
| Made here under the same name (a programme) or for the same records (a rule) | Kept |
| A retention rule with purging switched on, which the new version would keep for less time | Kept, because a shorter period on a rule that deletes is records gone sooner than anybody agreed to; the owner can change it on the retention screen |
| Dropped by the new version | Kept as it is |

A company whose pack was applied before the rest of it was recorded is judged by
the rows themselves: a template or programme still on version one and not saved
since it was made, and a rule or layout not saved since it was made, counts as
untouched; anything else is kept.

### Configure the company

`Settings` holds what a company changes about itself after setup: its name,
legal name and contact details, its time zone, how it looks (a brand colour
and a logo, which appear on the customer portal and on documents), the phone
numbers it sends from, and its call recording policy. All of these need
`settings:write` to change and `settings:read` to see. The name, legal name,
phone, email and postal address are changed on `/settings` and
`/setup/company` (one form, drawn on both) or with `PATCH /v1/company`.

The phone, email and address are printed under the company's name on the
proposal, the statement, the invoice, proposal and statement PDFs, and the
header of every page a customer opens from a link. Each is optional and
printed only when set. The phone is kept in E.164 however it was typed, an
email address that is not one is refused, and an address needs at least a
street and a town; a field left out of `PATCH /v1/company` keeps what it had
and an empty one clears it. The sales tax rates the company charges, its usual
one, and whether it charges any are set on `/settings/tax` (M13). Which items are
taxed is set on `/pricebook/tax` (`POST /v1/item-tax`, a new version of each item
that changes, so old invoices keep what they charged), and who works here on
`/settings/team`.

The time zone is not cosmetic. Every date boundary in the product is computed
in it: a container day in M22, quiet hours on a campaign in M19, a pay period
in M17, the days and months every report and KPI counts in M21. A company in the wrong zone gets a working day that starts in the
evening.

### Holidays

`/settings/holidays` keeps the company's own list of days it is closed, or open
with hours of its own (Christmas Eve until noon), by date. A day can repeat every
year, which is what a fixed date holiday is; one that moves (the fourth Thursday
of November) is added for the year it falls in. The list starts empty and holds
only what the company adds: no calendar of public holidays is shipped, because
which days a business closes is its own decision. The same list is drawn on the
setup wizard's hours step.

On a date in the list, its hours replace the week's, and everything that reads the
company's hours reads it:

| Reader | On a closed date | On a short day |
|---|---|---|
| Online booking (`/book/{slug}`, a customer's own account, a request to move a visit) | No window is offered, and a booking request for it is refused in words | Only the windows that start and end inside its hours |
| The phones (a number's hours, a phone menu's after hours option) | A call goes where an after hours call goes | Its own hours decide |
| The phone and chat assistants | Told about it, among the hours they quote | Told its hours |
| The reviews reply clock (M20) | Does not run | Runs for its hours |
| The multi day rebalance (M09) | Nothing is moved onto it | As any open day |
| A recurring task set to skip holidays (M34) | Raises nothing, and is not raised the day after instead | Raised as usual |
| After hours and holiday rates, below | The holiday rate is offered | The holiday rate is offered |

A date entered for one year beats a yearly one on the same day, so "this year we
open Christmas morning" is said on top of "we close every Christmas". A second
entry for the same date is refused in words, and so is a yearly one on the 29th of
February, which three years in four has no date. `GET /v1/holidays` reads the
list (`settings:read`), and `POST /v1/holidays`, `PATCH /v1/holidays/{id}` and
`DELETE /v1/holidays/{id}` change it with `booking:configure`, the permission the
week's hours are set with.

### After hours and holiday rates

The same page, and the `/setup/rates` step, choose which price book item is
charged for work booked outside the company's hours and which on a holiday. Both
are items marked as the after hours rate, the mark a membership plan reads when it
waives that rate (M08), and choosing an item that is not marked yet marks it, as
its own page would, so a member whose plan waives the after hours rate is not
charged it on a holiday by an unmarked item. The two can be the same item; the
diagnostic fee and a retired item are refused. `GET /v1/after-hours-rates` reads
the choice with `pricebook:read` and `PUT /v1/after-hours-rates` sets it with
`pricebook:write`.

The rate is offered, never added. When a job's visit was booked (by the start of
the window it was booked into) on a date in the holiday list, or outside the hours
kept that day, the new invoice for that job and the draft being edited show the
item, how many visits it is for, and one sentence per visit ("2026-10-06 at 19:00,
after the 17:00 close"), with a button that puts it on as a line from the price
book. `GET /v1/jobs/{id}/rate-offers` is the same offer. An item already on
another of the job's invoices that was not voided is not offered again.

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
| Office manager | Reads settings and does not change them. Invites office staff and marks the team step done |
| Dispatcher, CSR, technician | Neither |
| Accountant | Reads settings |

## Common questions

**Can a company skip the wizard entirely?** Yes. Nothing in it is enforced
later; it is a checklist, not a gate.

**Does the wizard remember which steps are done?** Yes. A step is done when
somebody who may do it says so on its page, and stays done until somebody
says otherwise; the list resumes at the first step still outstanding.

**Can an office manager invite a technician?** No. Inviting gives the person
a preset role, and nobody hands out a role carrying permissions they do not
hold themselves. The technician role carries field permissions (syncing a
phone, clocking in) the office manager does not, so an owner or an
administrator invites technicians. An office manager invites office staff.
A branch manager invites into their own branch only, and only another branch
manager: every other preset sees the whole company, which is more than they
do. A company that wants a branch's own CSRs makes a branch scoped role for
them on `/settings/roles`.

**What happens when an invite runs out?** The team list says so beside the
person, and "Send a new invite" sends another, good for seven more days, and
stops every link the old one had.

**Why was my invite refused for an address?** It already has an account with
another company. Adding an existing account would hand this company to
whoever controls it, and nothing proves that is the person the address
belongs to, so an account is only ever added to the company that created it.

**Where do trade specific KPIs show up?** `Reports > Trade scorecard`, which
is M21. A pack declares them; that module computes the ones it can and names
the missing datum for the ones it cannot.

## What is not built

An invite is emailed only when the company has an email provider connected;
without one the team list says it was not emailed, and the link shown once to
the person inviting is the way in. A deployment with no `PUBLIC_URL` makes no
link at all and says so. An invite's link lasts seven days, which a company
cannot change. An address with an account at another company cannot be
invited.

A trade pack upgrade does not touch checklists, KPIs, filing calendars or the
other parts of a pack nothing in a company's rows records as the pack's. An
inspection programme is known across versions by its name, so a newer version
that renames one sets up a new programme and leaves the old one as it was. A
company whose pack was applied before the template, programmes, rules and layout
were recorded cannot be told it removed one of them, so one it took out is set up
again by an upgrade. An item's description or cost that a newer
version removes is left as it was, because a price book version cannot clear
either. Every pack ships at version one today, so no company has an upgrade
waiting yet.

The 10DLC step records a registration made in the carrier's portal; it does
not submit one to a carrier. Company licences are compliance documents rather
than a setup step.

Holidays are one list for the whole company: a branch cannot keep its own, and
the week's hours a branch has (`business_hours` carries a business unit) are not
read per branch by the holiday list's readers either. A holiday that moves is
entered each year; nothing works out the fourth Thursday of November. The route
density figures (M09) read the week's hours for a weekday, not a date, so a
holiday does not change them. Task escalation counts hours, not working hours
(M34), so a holiday does not pause it.

The after hours rate is offered on the office's invoice screens only: an invoice
raised on the phone from the visit's work (M11) does not offer it, and neither does
an estimate. Whether a visit was after hours is read from the window it was booked
into, not from when the technician arrived or punched in, because the arrival
window is what the customer was promised. A holiday rate on an item not marked as
the after hours rate cannot be chosen, deliberately: a plan that waives the after
hours rate then waives the holiday rate too, which is the conservative reading of
what a member was told, and a company that wants members to pay a holiday rate has
no way to say so.
