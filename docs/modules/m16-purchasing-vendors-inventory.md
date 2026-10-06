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

### Track a part by serial number or lot

`PUT /v1/stock-tracking` says an item is tracked by serial number (every unit
its own number: a compressor, a furnace) or by lot (a batch shares one:
refrigerant, adhesive). From then on every receipt, transfer and issue of it
names its units in `units`, and a move that does not is refused in words. A
serial is one unit; a lot says how much of it moved. Where a serial is, and
what became of it, is folded from the movements that name it, like every
level here, and stored nowhere. Turning tracking on is refused while units
with no numbers are on hand, because they could never be moved; start before
the next delivery.

Issuing a serialised unit to a job can say which of the customer's units it
is (`equipmentId`), or record it as new equipment at the job's address with
its serial (`installAs`, which needs `equipment:write`). That is the trace:
`GET /v1/stock/units/{id}` reads back the order and vendor it came from, every
move between the warehouse and a truck, the job it went to and the customer's
equipment record it became, with cost only for a holder of
`pricebook.cost:read`. `GET /v1/stock/units` finds a number by any part of it.
A count of a tracked item is refused, because a count cannot say which units
are missing: `POST /v1/stock/write-offs` writes one off by number with the
reason. `/inventory` receives, moves and uses stock, with a box for the
numbers; `/inventory/serials` finds and traces them.

### Freight on a delivery: landed cost

`POST /v1/purchase-orders/{id}/receipts` takes the charges on the vendor's
bill for that delivery (`charges`: freight, a fuel surcharge) and spreads
them over the lines that arrived on it, by what each line cost or by how many
of each arrived (`basis`), allocated to the cent so the shares add back to
the charge exactly. Each line's share goes into its cost, so a part bought for
forty dollars with three dollars of freight on it is issued to a job at forty
three, and is kept beside it so the order says what was the goods and what
was the carrier. Only that delivery's lines carry that delivery's freight.

### Who approves an order

`POST /v1/purchase-approval-rules` declares a step: an order at or over an
amount needs somebody holding a named role to approve it. Steps are taken in
order, so "over a thousand, the office manager; over five thousand, the owner
as well" is two rows, and a six thousand dollar order needs both, the office
manager first. Nobody decides two steps of one order. A rejection needs a
reason and ends it: the order is cancelled and a corrected one raised. The
steps are company policy about who may commit money, so declaring them is
`settings:write`; `/purchasing/approvals` is the screen.

`POST /v1/purchase-orders/{id}/approvals` decides the step that is waiting,
with `po:approve` and the role the step names, read from the person's own
membership. An order a step applies to cannot go to the vendor until every
step has approved it, and then the buyer who wrote it may send it. An order no
step applies to goes out on its sender's own `po:approve`, as it always has.
Each order's page at `/purchasing/{id}` shows where it stands and takes the
decision.

### Email an order to the vendor

`POST /v1/purchase-orders/{id}/email` sends it through the company's own email
path to the vendor's address on file (an orders email on the vendor) or the
one given, with every line in the body and a link that opens the order
printable as the vendor reads it, with no sign in. Emailing a draft sends the
order: approval is checked first, and the order is marked sent only when the
email was queued. Every attempt is recorded on the order, including one the
mail path refused, which leaves a draft a draft and says why.
`GET /v1/purchase-orders/{id}/sends` lists them.

### Truck stock

`PUT /v1/truck-minimums` sets what a truck should carry of an item: a minimum
and a level to fill to. A truck is filled from the warehouse rather than
bought for, so `GET /v1/stock/restock-suggestions` proposes a move from the
warehouse holding the most, up to the fill level, compared against what the
truck can promise (on hand less reserved), and says how short the warehouse
is when it cannot cover it. Buying is still the warehouse reorder point's
decision. `POST /v1/stock/restocks` makes the move through the ordinary
transfer. `/inventory/trucks` is the screen.

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
| `POST /v1/purchase-orders/{id}/status` | `po:write`, and `po:approve` to submit an order no approval step applies to |
| `POST /v1/purchase-orders/{id}/receipts` | `po:write` |
| `PUT /v1/stock-tracking` | `inventory:adjust` |
| `GET /v1/stock/units` | `inventory:read` |
| `GET /v1/stock/units/{id}` | `inventory:read` |
| `POST /v1/stock/write-offs` | `inventory:adjust` |
| `PUT /v1/truck-minimums` | `inventory:adjust` |
| `GET /v1/stock/restock-suggestions` | `inventory:read` |
| `POST /v1/stock/restocks` | `inventory:adjust` |
| `GET /v1/purchase-approval-rules` | `po:read` |
| `POST /v1/purchase-approval-rules` | `settings:write` |
| `POST /v1/purchase-orders/{id}/approvals` | `po:approve`, and the role the waiting step names |
| `POST /v1/purchase-orders/{id}/email` | `po:write` |

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

Landed cost is spread when a delivery is received against an order, from the
charges typed at that moment. A freight bill that arrives a week later is not
reallocated onto stock already received, nor onto parts already used on jobs,
and stock received outside an order carries whatever total cost was typed.

Tracking by serial or lot starts with an empty shelf: there is no way to give
numbers to units already on hand. A serialised unit that comes back off a job
cannot be returned to stock by number yet, and receiving its number again is
refused. Returns to a vendor by number are not built either. Costing stays
first in, first out by location rather than the cost of the particular
serial. The trace lives on the inventory screens; the customer's equipment
page does not show it.

Approval steps are by order total and role only, not by vendor, category or
location, and nobody is told an order is waiting for them: the approver finds
it on the order or the purchasing list. An order cannot be edited, so an
approval is of the total it was given.

An emailed order carries a printable link, not a PDF attachment, and a
vendor's reply is not read back as an acknowledgement or a promise date.

Filling a truck is a move somebody makes from the suggestion; nothing fills
trucks on a clock, and a tracked part's restock needs its numbers typed.
