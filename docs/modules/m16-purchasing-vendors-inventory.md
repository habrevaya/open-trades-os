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
`/purchasing` is the screen.

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

The declared permission on a route and the one its service checks are not always
the same string on this module: several purchasing routes were declared against
inventory permissions before the service was corrected to the vendor and purchase
order ones. Where they differ, the service is what refuses, so the vendor and
purchase order permissions above are the ones a role needs.

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

No supplier catalogue import and no link from a price book item to a vendor's part
number, so a purchase order line is typed rather than looked up. No landed cost
allocation: a receipt carries its unit cost and freight is not spread. No serial or
lot tracking on stock. Purchase order approval is a status transition rather than a
multi step approval chain.
