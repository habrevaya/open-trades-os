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
labour minutes, the warranty. Editing creates a new version and closes the old
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
same list. Cost and margin appear only for a reader holding
`pricebook.cost:read`.

### Add or change an item

`/pricebook/items/new` adds one and every row on `/pricebook` opens its own
screen, `/pricebook/items/{id}`. There, "Change the price or wording" saves a
new version (the name, the customer's description, the price, the cost for
whoever may see it, labour minutes, warranty and tax class), in force now or
from a date ahead; every price the item has ever had is listed with when it
was in force and whether it is past, in force or scheduled, and a scheduled
one can be brought forward or called off there by whoever holds
`pricebook:publish`. "What it is" changes the kind, the code, the category
and which fee it is (the diagnostic fee or the after hours rate, which a
membership plan can waive) in place, writing no version, because no document
points at any of those. The item can be retired or sold again, and the
vendors who sell it to us are listed with their part numbers (M16).
`/pricebook` can include retired items.

`POST /v1/pricebook/items` creates one. `GET /v1/pricebook/items/{id}` is the
item with every version. `POST /v1/pricebook/items/{id}/revise` is how a price
changes: it writes a new version rather than editing the old one, and carries
the warranty and tax class forward unless they change.
`PATCH /v1/pricebook/items/{id}` changes what the item is, refusing a code
another item already has. `POST /v1/pricebook/items/{id}/active` stops an item
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

A bulk change takes effect when it is applied; it cannot be dated ahead the way
a single revision can, so a quarterly change across a category is staged item
by item or applied on the day. An item with a revision already scheduled is
left out of a bulk change rather than given a version beside it. A bulk change
reaches at most two thousand items at a time. The item screen does not edit a
kit's components, an image or a commission rate; those carry forward through a
revision unchanged. A revision dated ahead is staged from the start of that day
in the company's calendar; a time of day is an API call.
