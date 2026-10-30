---
title: Price Book
module: M06
domain: Sell
phase: 1
status: partial
---

# Price Book

> Module M06. Domain: Sell. Ships in phase 1.

## What it does

Holds what the company sells and what it charges, with a full history of every
price it has ever charged, so a document raised three years ago still says what
it said then.

## The problem

The obvious design is one row per item with a price on it, and editing the row
when the price changes. That quietly rewrites what a customer was charged, and
it is discovered during a dispute or an audit, which is the worst possible
moment to find out your records are not records.

## Key concepts

**Two tables and one rule.** An item is a stable identity: a code, a kind, a
category, and whether it is still sold. A version holds everything that can
change: the name, the description, the price, the cost, the tax class, the
labour minutes, the warranty and the days the maker allows to register the unit. Editing creates a new version and closes the old
one.

**Documents reference the version, never the item.** Raising the price of a
capacitor replacement from 218 to 240 leaves every invoice that already went out
saying 218, because each of them points at the row that said 218. It costs a
join on every read, which is the cheapest thing in the module.

**A revision can be dated ahead.** Giving a new version a future
`effectiveFrom` stages it: the current version closes at that instant and the
new one opens there. That is how a quarterly price change is prepared without
quoting it early.

**"Which price applies" is one exported predicate, not four copies.** Four
services asked it as "the version with no end date", which is the open ended row
rather than the current one. With a revision dated ahead, that picks the future
row: a price increase scheduled for next month applied today, and the price
actually in force became invisible in the list, the estimate builder, invoicing
and on the technician's tablet. The boundary is half open on purpose, because a
closed upper bound would make both rows match at the instant of the changeover
and the answer would depend on row order.

**Margin is derived and never stored.** A stored margin goes stale the moment
either side of it changes and nobody notices. It is also returned only to
somebody who may see cost at all, because a margin left beside a price recovers
the cost in one division.

**Cost redaction happens on the version.** That is where cost lives. Running it
on the merged item would ask the access map about an entity that does not exist,
and silently return everything.

## Setup

A trade pack seeds a real price book at setup, with national average pricing as
a starting point. The wizard's price book step points at `/pricebook`, where it
is re-priced for the company's own market.

## Using it

### Look something up

`GET /v1/pricebook/items` takes a search and a category, and `/pricebook` is the
same list. The search reads words the way every list does (M29): each word in
the name, the code or the description, in any order, and a typed `%` is the
character it is. The search box at the top of the menu finds items too, by the
same words or a letter off them, for whoever holds `pricebook:read`. Cost and margin appear only for a reader holding
`pricebook.cost:read`.

### Add or change an item

`/pricebook/items/new` adds one and every row on `/pricebook` opens its own
screen, `/pricebook/items/{id}`. There, "Change the price or wording" saves a
new version (the name, the customer's description, the price, the cost for
whoever may see it, labour minutes, warranty, the days the maker allows to register
the unit and tax class), in force now or
from a date ahead; every price the item has ever had is listed with when it
was in force and whether it is past, in force or scheduled, and a scheduled
one can be brought forward or called off there by whoever holds
`pricebook:publish`. "What it is" changes the kind, the code, the category
which fee it is (the diagnostic fee or the after hours rate, which a
membership plan can waive) and whether its quantity is crew hours, in place,
writing no version, because no document points at any of those. The item can be retired or sold again, and the
vendors who sell it to us are listed with their part numbers (M16).
`/pricebook` can include retired items.

**A picture and a commission rate**, in the same "Change the price or wording" form,
are versioned like everything else there (`imageUrl` and `commissionRate` on
`POST /v1/pricebook/items/{id}/revise`): left alone they carry forward through a price
change, a kit change and a bulk change, whoever makes it; empty takes the picture off or
puts the commission back to "no rate on this item". The picture is a web address that
starts with `https://` (at most 2,000 characters, no spaces); nothing else is taken, so
a stored address can never be a script or a file on somebody's phone if a screen ever
draws it. The commission is typed as a percent ("8.5") and kept as a share of the line
("0.085", never above 1). A commission rate is a pay term, so it is shown only to
somebody who may read commission (`commission:read`), and setting or clearing one needs
`commission:configure` as well as `pricebook:write`: an editor of the price book without
it can still raise a price, change the picture and revise everything else, and the form
does not show them the box. Both are in the audit line of the revision, before and after.
No screen draws an item's picture (see "What is not built"). The commission rate is paid by the company's
choice on `/payroll/commissions` (M17, `POST /v1/commissions/item-rule`): the plan only,
which is the default and pays nothing from the item's rate; the item's rate instead of
the plan on its line; whichever of the two comes to more; or the item's rate on top of
the plan. Commission reads the rate on the version an invoice line was priced from,
never the item's version today, so a rate changed here reaches only lines priced after
the change (the form says so and links to the choice).

**Counted in crew hours** is a tick on "What it is" and on a new item
(`quantityIsCrewHours` on `POST /v1/pricebook/items` and `PATCH /v1/pricebook/items/{id}`,
audited before and after, needing `pricebook:write`). It says a line of the item counts its
quantity as crew hours, people times hours with the drive: "Install crew", 16. An estimate
line copies the mark the day it is written, so unticking the item later rewrites no estimate,
and converting an approved estimate adds up those lines as the job's budgeted hours (M07,
M10). The mark changes no price and writes no version.

**A chemical your technicians apply**, on the same screen for a material,
marks the item as a product applied on a visit, with the unit its cost is per
("gal", "oz") and the EPA registration number from its label (`chemical` on
`PATCH /v1/pricebook/items/{id}`, audited before and after; null takes the mark
off). Technicians then pick it by name when they record what they applied on the
phone and on `/my-day`, and the office does on the visit's page (M11), and the
item's name, EPA number and unit go onto the regulated record. Pest control's
chemical cost per stop (M21) values what was applied at the item's cost on the
stop's day. Only a material can be marked: a bait station, a trap or a monitor
is equipment placed at a site, which that figure leaves out, so marking one is
refused, and so is changing a marked item to another kind. Marking changes no
price and writes no version.

**Bought in one unit, used in another**, in the same "Change the price or wording"
form and on `/pricebook/items/new`: the unit it is bought in ("gal"), the unit it
is used in ("oz") and how many of one are in the other (128), all three or none
(`units` on `POST /v1/pricebook/items` and on the revise call; null takes them
off, left off they carry forward, and part of them is refused in words). Then the
version's cost is what one buy unit costs, the figure on the supplier's bill, and
its price, every line's quantity and every application are in the use unit. A
line takes its cost from the book per use unit (`costPerUse` on the item, the
cost over the ratio at four places), so a job line, an invoice line and an
estimate line for 16 ounces of a 40.00 gallon are costed at 0.3125 an ounce, and
job costing and the margin read that (M15). Pest control's chemical cost per stop
values an application recorded in either unit (M21), and the office's visit page
can record one in either. A supplier's file brought in with `updateItemCost`
gives the cost per our unit, the ounce, and the version keeps it per gallon. A
version with no units, which is every version written before this, is costed
exactly as before. Changing the units is a revision like a price, so a document
already written keeps the version it was priced from.

**What is in the kit**, on the same screen, lists a kit's parts by code with how
many of each, and saves a changed list as a new version, now or from a day ahead,
exactly like a price change (`components` on the revise call): an estimate already
written keeps the kit it was written with, and every later revision carries the
parts forward. A part is an item still sold, named once, and never the kit itself
or a kit that already contains it, however deep.

**Whether it is taxed.** An item says whether a sales tax rate is charged on it
(M13 has the rates). Which items are taxed is set on `/pricebook/tax`, item by item
or a whole shelf at once (`POST /v1/item-tax`, a new version of each item that
changes); setting a whole shelf also writes the answer on the shelf, and an item
added to that shelf later without saying takes it. An item created without saying,
on a shelf that says nothing, is taxed unless it is labour, because most states
that tax parts do not tax labour.

"Register with the maker within (days)" (`warrantyRegistrationDays`, 1 to 365) is empty
for every item until somebody fills it in, and means the item's maker asks for the unit
to be registered that many days after it is installed. It is read when a serialised unit
of the item is used on a job, which raises the registration deadline described in M32;
an item with nothing in it raises none. A trade pack sets none and its upgrades carry
it forward.

`POST /v1/pricebook/items` creates one. `GET /v1/pricebook/items/{id}` is the
item with every version. `POST /v1/pricebook/items/{id}/revise` is how a price
changes: it writes a new version rather than editing the old one, and carries
the warranty, the registration days and tax class forward unless they change.
`PATCH /v1/pricebook/items/{id}` changes what the item is, refusing a code
another item already has, marks or unmarks a material as a chemical, and says whether its quantity is crew hours. `POST /v1/pricebook/items/{id}/active` stops an item
being sold without removing it, because documents point at its versions.

### Prepare a price change for next quarter

Revise with a future `effectiveFrom`. `GET /v1/pricebook/scheduled` lists every
revision waiting, with what it will become beside what it is until then.
`POST /v1/pricebook/scheduled/{versionId}/publish` brings one forward and
`POST /v1/pricebook/scheduled/{versionId}/discard` calls it off. Both need
`pricebook:publish`, which is a different decision from writing an item and is
held by fewer people.

### Reorganise the shelves

`/pricebook/categories` is the category manager: the categories in the order
the tablet shows them, nested up to three levels ("Plumbing, Water heaters,
Tankless"), each with how many items sit on it. Add one, rename it, move it
under another or to the top, move it up or down among its siblings, and
remove one that is empty; a category holding items or other categories is
refused with how many. Two categories with one name under one parent are
refused in words, compared without capitals. Below the list are the items on
the chosen shelf (or on none), ticked and moved to another.

Moving an item between categories changes the item rather than writing a
version, because no document points at a category: it changes nothing anybody
was charged. Applying a trade pack again reuses a category of the same name
rather than adding a second one.

On the API: `GET /v1/pricebook/categories` (flat, in reading order, with a
depth on each row), `POST /v1/pricebook/categories`,
`PATCH /v1/pricebook/categories/{id}`,
`POST /v1/pricebook/categories/{id}/place` (a position among siblings, so a
retry lands where the first call did), `POST /v1/pricebook/categories/{id}/remove`
and `POST /v1/pricebook/item-categories`.

### Change many prices at once

`/pricebook/changes` chooses items by category (with the ones inside it) and
by a search, and a change: up or down by a percentage, up or down by an
amount, priced to a margin over cost, or only rounded up to a price ending
(.00, .95, .99, .49), with a change and a rounding together allowed. Preview
shows every item's price now and after, and for whoever holds
`pricebook.cost:read` its cost and margin now and after; an item that will not
change says why (no cost recorded for a margin rule, a change that would
price it at nothing, a revision already scheduled). Untick anything to leave
alone, then apply.

A change can be dated ahead with **Takes effect** (`effectiveOn` on the API): each
item's new version then waits as a scheduled revision from the start of that day in
the company's calendar, exactly as a single revision dated ahead does, the prices
in force stay until then, and the list of changes says it is waiting. Undo before
that day calls the waiting versions off, and the prices that were in force simply
carry on; after it, Undo puts prices back as new versions as for any change.

Applying writes a NEW VERSION per item through the same code a single
revision uses, so no version is edited in place and every document already
raised keeps its price. The prices are recomputed inside the write rather
than taken from a preview that may be a minute old. Each change is recorded
with the version it closed and the version it wrote per item, listed below the
form, and has an Undo: each price goes back to what it was, as another new
version, recorded as a change of its own that points at the one it undoes.
Undo is the old prices, not the opposite rule, because five per cent up and
five per cent down lands at 99.75 rather than 100. An item somebody has
changed again since is left alone and named.

The arithmetic is `core/repricing`: no floats, cents half up after a change,
rounding to an ending always UP so it never takes money off a price, and a
margin rule rounding up so the margin is at least what was asked. A rule that
is a typo (a thousand per cent, a margin of 45 rather than 0.45, nought) is
refused before anything is shown.

On the API: `GET /v1/pricebook/price-change-preview`,
`POST /v1/pricebook/price-changes`, `GET /v1/pricebook/price-changes`,
`GET /v1/pricebook/price-changes/{id}` and
`POST /v1/pricebook/price-changes/{id}/reverse`. Previewing and applying need
`pricebook:write`; a margin rule also needs `pricebook.cost:read`, because a
price computed from cost and shown beside the rule gives the cost back.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything, including publishing a staged revision |
| Office manager | Reads the book and reads cost and margin |
| Dispatcher, CSR | Reads the book. No cost |
| Technician | Reads the book, to quote in the driveway. No cost, ever |
| Accountant | Reads the book and cost |

`pricebook.cost:read` is on the sensitive list. The technician preset holds
`pricebook:read` and not it, and that pair is the reason field level permissions
exist at all: a technician quotes on site with the customer able to read their
screen.

## API

| Call | Needs |
|---|---|
| `GET /v1/pricebook/items` | `pricebook:read` |
| `POST /v1/pricebook/items` | `pricebook:write` |
| `GET /v1/pricebook/items/{id}` | `pricebook:read` |
| `PATCH /v1/pricebook/items/{id}` | `pricebook:write` |
| `POST /v1/pricebook/items/{id}/revise` | `pricebook:write` |
| `POST /v1/pricebook/items/{id}/active` | `pricebook:write` |
| `GET /v1/pricebook/scheduled` | `pricebook:read` |
| `POST /v1/pricebook/scheduled/{versionId}/publish` | `pricebook:publish` |
| `POST /v1/pricebook/scheduled/{versionId}/discard` | `pricebook:publish` |
| `GET /v1/pricebook/categories` | `pricebook:read` |
| `POST /v1/pricebook/categories` | `pricebook:write` |
| `PATCH /v1/pricebook/categories/{id}` | `pricebook:write` |
| `POST /v1/pricebook/categories/{id}/place` | `pricebook:write` |
| `POST /v1/pricebook/categories/{id}/remove` | `pricebook:write` |
| `POST /v1/pricebook/item-categories` | `pricebook:write` |
| `GET /v1/pricebook/price-change-preview` | `pricebook:write` |
| `POST /v1/pricebook/price-changes` | `pricebook:write` |
| `GET /v1/pricebook/price-changes` | `pricebook:read` |
| `GET /v1/pricebook/price-changes/{id}` | `pricebook:read` |
| `POST /v1/pricebook/price-changes/{id}/reverse` | `pricebook:write` |

## Common questions

**Can I just correct a typo in a name?** It writes a new version, same as a
price change. That is deliberate: the version is what a document points at, and
a document should keep saying what it said.

**Does a discount live here?** No. A discount is on the line of the document it
was given on, and who may give one is M07's business: `estimate:discount` with
`estimate.discount.unlimited` above the configured cap.

**Where does a commercial client's own rate card fit?** M31. A contract's rate
card becomes the price authority for that client, which is why editing one is a
different permission from editing the book.

## What is not built

An item with a revision already scheduled is left out of a bulk change, dated
ahead or not, rather than given a version beside it. A bulk change reaches at most
two thousand items at a time. Nothing draws an item's picture, on purpose, and it is not a small step. The picture is a web address a person typed
(`imageUrl`, always `https://`), not a file in the company's store, so there is no file read path or permission to draw it
through: showing it on the item page, in the composer, on the customer's proposal or in its PDF would make the browser
(and, for the PDF, this server) fetch whatever address a staff member pasted, and hand a customer's address to that host.
Drawing it needs the picture uploaded and kept as a stored file the way proposal photographs are (a storage key on the
item's version, carried forward by a revision, drawn through `/files/{key}` for staff and a token route and the PDF's image
step for the customer), which is not built; the address is still stored and offered on the API and the item screen. An item's commission rate is
paid only on an invoice line priced from the item: a line typed by hand, or a kit's
parts inside a kit line, pays the plan, and a kit pays its own rate, not its parts'.
The choice of how it works with the plan is one for the whole company (M17): there is
no choice per item, per plan or per person. A kit's price is
its own and is not worked out from its parts. Whether an item is taxed is a yes or
a no: an item taxed at a reduced rate has that rate chosen on the line by the office. A revision dated ahead is staged from the start of that day
in the company's calendar; a time of day is an API call. A chemical's cost is
the item's own cost on its version: the price paid for a particular drum on a
purchase order is not read. An item bought in one unit and used in another
converts between those two only, at the ratio its version states: a third unit
(a quart of a gallon product) is not converted, and a line's quantity is always
in the use unit, so ordering by the gallon is still purchasing's pack, not the
version's units (M16). The cost per use unit is kept to four decimal places on a
line, so a cost that does not divide evenly is a hundredth of a cent out per
unit. The phone records a chosen product in the chemical's own unit and cannot
pick the other.
