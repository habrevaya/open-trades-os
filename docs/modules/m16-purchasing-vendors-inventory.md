---
title: Purchasing, Vendors and Inventory
module: M16
domain: Money
phase: 5
status: partial
---

# Purchasing, Vendors and Inventory

> Module M16. Domain: Money. Ships in phase 5.

## What it does

Tracks what is on the shelf and in each van, what it cost, what is committed to a
job, what to buy, who to buy it from, and what arrived.

## The problem

"Is it in stock" has no single answer once a van is a location. Flattening it is
what produces the technician who was told yes and drives to a property without the
part.

The second problem is the one that costs money. A system that trusts a stored
stock level reorders the same part every night until twelve of them arrive, and a
receipt with no cost on it is stock that will be issued at nothing and quietly
overstate every job's margin.

## Key concepts

**There is no stock level, only a history.** Levels are folded from an append only
movement history, and nothing in the module writes a level. Reaching for an update
that sets what is on hand means the thing actually wanted is an adjustment movement
that says what changed and why.

**Every decision is pure and lives in core.** This module reads the history, hands
it to a decision, and writes what the decision returned. That division is the point
rather than tidiness: the arithmetic has to be identical whether it runs against a
database, in a test, or in a field app that has not seen the server for two hours.
A refusal therefore always carries the sentence core wrote for it rather than one
invented at the edge.

**Stock is reported per item per location.** Not per item, for the reason above.

**A count records the difference, not the count.** The counted number is written
nowhere; what is written is an adjustment with a reason, so the history still
explains every number it produces. A count that overwrote the level would be the
one write in the module that destroys evidence.

**An issue requires a job.** Stock leaving the shelf for nobody is a real thing
that happens and it is an adjustment rather than an issue. The difference is
whether anybody can be told later what the part was for.

**A receipt refuses nothing and must carry a cost.** Stock that has physically
arrived has arrived whatever the system thinks, and a receipt is the only movement
that establishes a cost layer.

**What is on order is derived from purchase order status, not trusted from a
column.** That one line is the whole of the bug where a system reorders the same
part every night.

**An empty reorder suggestion list is the correct answer when nobody has said what
they keep in stock.** What was missing was any way to say, which is what the
reorder policy is.

**A reorder point is a spending decision, so it is `po:write`.** Adjusting
inventory is a statement about what is physically on the shelf; deciding what to
keep is a decision about what to spend money on, and the person who may raise a
purchase order is the person who gets to make it. `settings:write` would have been
wrong in the other direction: this is per item and per location and changes weekly,
which is not what a settings screen is.

**Submitting a purchase order and writing one are separate permissions.** Guarding
the whole status transition on approval would stop a buyer doing their own work,
and guarding all of it on writing would let anybody who can raise an order approve
it, which is the thing approval exists to prevent.

**The sequence number is a total order per company, taken as max plus one under the
write.** Not a database sequence, because a sequence is not transactional: a rolled
back write would leave a gap, and a gap in the one column that orders a financial
history is a question nobody can answer later.

## Using it

### See what is where

`GET /v1/stock/levels` is a row per item per location, and
`GET /v1/stock/commitments` is who is holding what and for which job. `/inventory`
is the screen.

### Move stock

`POST /v1/stock/receipts` brings it in with its cost,
`POST /v1/stock/issues` puts it on a job,
`POST /v1/stock/reservations` and `POST /v1/stock/releases` hold and let go,
`POST /v1/stock/transfers` moves it between locations, and
`POST /v1/stock/counts` records a count as the correction it is.

### Decide what to keep

`PUT /v1/reorder-policies` declares the reorder point and target level per item
per location, `GET /v1/reorder-policies` reads them back, and
`POST /v1/reorder-policies/clear` removes one.
`GET /v1/stock/reorder-suggestions` is what to buy.

### Buy it

`POST /v1/vendors` names somebody to buy from, `GET /v1/vendors` lists them,
`POST /v1/purchase-orders` raises an order,
`POST /v1/purchase-orders/{id}/status` moves it (submitting needs approval),
and `POST /v1/purchase-orders/{id}/receipts` records what arrived.
`/purchasing` is the screen, and each order opens at `/purchasing/{id}`, line by
line with the vendor's part number first, printable for a counter that still
takes orders on paper. `GET /v1/purchase-orders/{id}` is the same.

An order line is looked up, not typed. It names our item or a part number, and
the part number is matched against what this vendor calls our items, then
against our own item codes; the line is written with our item, the vendor's
number as it stands that day (copied, so renumbering the part later does not
change what the order said) and the vendor's price on record unless a price is
given. A part nobody can find, or one with no price from this vendor and none
given, is refused in words. On `/purchasing`, "Order by part number" offers the
chosen vendor's known numbers as you type, and an order built from the reorder
suggestions takes the vendor's price for a line left blank.

### Know what each vendor calls a part

Each price book item's screen lists the vendors who sell it to us with their
own part number, their description and their price for one, and takes a new
one or replaces the existing one for a vendor. One number per item per vendor,
and one item per number per vendor: a number already given to another of our
items for that vendor is refused in words. `GET /v1/vendor-items`,
`PUT /v1/vendor-items` and `POST /v1/vendor-items/{id}/remove`. A link is
vendor data: `vendor:read` to read, `vendor:write` to change.

### Import a supplier's catalogue

`/purchasing/catalogue` reads the spreadsheet a supply house sends: a header
line, then a part number, a description, a cost and the vendor on each row
(the common spellings of each header are understood, and the vendor can be
chosen for a file without that column). Nothing is written until the preview
has said what each row would do: update the link that part number already
names, link one of our items whose code is the part number, create a new
material priced at the margin given (rounded up to a price ending if asked),
change nothing, or be skipped with the reason (an unknown vendor, a cost that
is not an amount, a part twice in the file, a new part with no margin to price
it at, so nothing is ever sold at cost by accident). Untick a row to leave it
alone, then apply. Applying works the plan out again from the same file inside
the write. When asked, a matched item's own cost (the one job costing reads)
follows the vendor's as a new version, so every document already priced keeps
its cost, and an item with a price change already scheduled is left alone and
said so. `POST /v1/vendor-catalogue/preview` and
`POST /v1/vendor-catalogue/apply` are the same, and need `vendor:write` and
`pricebook:write`, because an import writes both; an item's own cost is shown
beside the vendor's only to whoever holds `pricebook.cost:read`.

### Commodity delivery

`POST /v1/deliveries` records a delivered quantity and
`GET /v1/deliveries/consumption` is what was used. These are an invoicing
permission rather than an inventory one, because a delivery is a billable event.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything |
| Office manager | Vendors, purchase orders, inventory adjustment |
| Dispatcher | Reads inventory |
| CSR | Neither |
| Technician | Reads inventory, so they know whether the part is on the van |
| Accountant | Reads vendors and purchase orders |

## API

| Call | Needs |
|---|---|
| `GET /v1/stock/levels` | `inventory:read` |
| `POST /v1/stock/issues` | `inventory:adjust` |
| `POST /v1/stock/counts` | `inventory:adjust` |
| `GET /v1/stock/reorder-suggestions` | `inventory:read` |
| `PUT /v1/reorder-policies` | `po:write` |
| `GET /v1/purchase-orders` | `po:read` |
| `GET /v1/vendors` | `vendor:read` |
| `POST /v1/vendors` | `vendor:write` |
| `POST /v1/purchase-orders` | `po:write` |
| `GET /v1/purchase-orders/{id}` | `po:read` |
| `GET /v1/vendor-items` | `vendor:read` |
| `PUT /v1/vendor-items` | `vendor:write` |
| `POST /v1/vendor-items/{id}/remove` | `vendor:write` |
| `POST /v1/vendor-catalogue/preview` | `vendor:write`, `pricebook:write` |
| `POST /v1/vendor-catalogue/apply` | `vendor:write`, `pricebook:write` |
| `POST /v1/purchase-orders/{id}/status` | `po:write`, and `po:approve` to submit |

Five of these routes declared inventory permissions while their services checked
vendor and purchase order ones, so the published list was a promise the service
refused. They agree now, and `permission-declarations.test.ts` probes every route
with an actor holding nothing and asserts the permission it demands is one the
route declares, so the two cannot drift again in silence.

## Common questions

**Can a technician issue stock from their van?** Yes, with
`inventory:adjust`, which the technician preset does not hold by default. A
company that wants it grants it.

**What happens if two people count the same shelf?** Both counts are
adjustments, and the second one corrects the first. Nothing is overwritten.

**Why is a delivery not an inventory movement?** Because the thing being
delivered is usually bought to be delivered rather than stocked, and the
question about it is what to bill.

## What is not built

A catalogue import reads a CSV, not a spreadsheet file or a supplier's API or
EDI feed, and at most five thousand rows at a time; it records the vendor's
cost and does not track their price breaks, pack sizes or units of measure. It
does not create vendors: one the file names that nobody has added is skipped.
No landed cost allocation: a receipt carries its unit cost and freight is not
spread. No serial or lot tracking on stock. Purchase order approval is a status
transition rather than a multi step approval chain, and an order is printed or
read to the vendor rather than sent to them by email.
