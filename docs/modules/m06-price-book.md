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

`POST /v1/pricebook/items` creates one. `POST /v1/pricebook/items/{id}/revise`
is how a price changes: it writes a new version rather than editing the old one.
`POST /v1/pricebook/items/{id}/active` stops an item being sold without
removing it, because documents point at its versions.

### Prepare a price change for next quarter

Revise with a future `effectiveFrom`. `GET /v1/pricebook/scheduled` lists every
revision waiting, with what it will become beside what it is until then.
`POST /v1/pricebook/scheduled/{versionId}/publish` brings one forward and
`POST /v1/pricebook/scheduled/{versionId}/discard` calls it off. Both need
`pricebook:publish`, which is a different decision from writing an item and is
held by fewer people.

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
| `POST /v1/pricebook/items/{id}/revise` | `pricebook:write` |
| `POST /v1/pricebook/items/{id}/active` | `pricebook:write` |
| `GET /v1/pricebook/scheduled` | `pricebook:read` |
| `POST /v1/pricebook/scheduled/{versionId}/publish` | `pricebook:publish` |
| `POST /v1/pricebook/scheduled/{versionId}/discard` | `pricebook:publish` |

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

Categories are a column and a seed, with no screen for reorganising them.
Nothing bulk edits or bulk re-margins, so re-pricing a seeded book is item by
item. There is no supplier catalogue import, and no link from a price book item
to a vendor's part number, which is where M16 would meet this.
