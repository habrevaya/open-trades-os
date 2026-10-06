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

**Stock is not in the ledger, except late freight.** Receiving and using stock
post nothing: job costing reads material from the job's lines, and what stock is
worth is the costing replay's, not an account's. The one thing that posts is a
freight or duty bill that arrived after its delivery, because it has to land on
parts already used on jobs, and a job's cost is read from the ledger. So the
inventory account (1300) holds exactly the late freight on parts still on a
shelf: each later use, loss or return to the vendor relieves the share its parts
carried, and a unit back off a job brings its share back. This is the
conservative reading of a decision nobody has made yet, which is whether this
product keeps a perpetual inventory in the books. It does not pretend to.

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
takes orders on paper, and as a PDF from "Download PDF". `GET /v1/purchase-orders/{id}`
is the same.

A draft can be changed before it goes: `PUT /v1/purchase-orders/{id}` (`po:write`)
replaces its lines through the same lookup, pack and price break rules, and
"Change the order" on its page does the same. Once the vendor has it, a change
is a phone call and a new order, and the edit is refused in words.

An order line is looked up, not typed. It names our item or a part number, and
the part number is matched against what this vendor calls our items, then
against our own item codes; the line is written with our item, the vendor's
number as it stands that day (copied, so renumbering the part later does not
change what the order said) and the vendor's price on record unless a price is
given. A line's quantity is always in our units. When the vendor sells the part
by the pack (a box of 25 wire nuts), the order goes in whole packs: 30 is
refused with "Order 25 or 50, not 30" rather than rounded up into money nobody
chose to spend, and the line keeps the pack, what they call it and their price
for it, copied like the part number. With no price given, the vendor's price is
taken at the highest price break the number of packs reaches, and our unit
price is that over the pack; the line's total is the packs at the pack price,
exactly. The order, its email, its PDF and the vendor's link all say it as the
vendor sells it ("10 box of 25") with our count beside it. A part nobody can find, or one with no price from this vendor and none
given, is refused in words. On `/purchasing`, "Order by part number" offers the
chosen vendor's known numbers as you type, and an order built from the reorder
suggestions takes the vendor's price for a line left blank.

### Know what each vendor calls a part

Each price book item's screen lists the vendors who sell it to us with their
own part number, their description, their price, and how they sell it (a box
of 25, and what one comes to) with their price breaks, and takes a new one or
replaces the existing one for a vendor. One number per item per vendor,
and one item per number per vendor: a number already given to another of our
items for that vendor is refused in words. `GET /v1/vendor-items`,
`PUT /v1/vendor-items` and `POST /v1/vendor-items/{id}/remove`; the PUT also
takes `packQuantity`, `purchaseUnit` and `priceBreaks` (their price for one of
their units at so many or more, replaced whole). A link is vendor data:
`vendor:read` to read, `vendor:write` to change.

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

**Packs and price breaks.** A file can say how the supplier sells each part:
a pack column (how many of ours in one of theirs, "Case Qty", "Pack Size"), a
unit column ("UOM": box, case) and price breaks in pairs of columns ("Break 1
Qty" and "Break 1 Price", "Qty Break 2" and "Price Break 2"), the break
quantities in their packs. The cost on the row is then their price for the
pack, and the price book is costed and priced for one: a box of 25 at 112.50
sets an item's own cost to 4.50 and prices a new item from 4.50, never from the
box. A file with no pack column leaves a link's pack as it was. A pack or break
that is not a number skips the row with the reason.

### Track a part by serial number or lot

`PUT /v1/stock-tracking` says an item is tracked by serial number (every unit
its own number: a compressor, a furnace) or by lot (a batch shares one:
refrigerant, adhesive). From then on every receipt, transfer and issue of it
names its units in `units`, and a move that does not is refused in words. A
serial is one unit; a lot says how much of it moved. Where a serial is, and
what became of it, is folded from the movements that name it, like every
level here, and stored nowhere.

Units already on hand when tracking starts have no numbers, and the answer says
how many at each place. They are given numbers by a count by number for one
location: `POST /v1/stock/numbering` (`inventory:adjust`), or "Number what is on
the shelf" on `/inventory/serials`, with every label read off that shelf. A new
number takes one unit that had none (a lot takes the quantity said, "LOT-4471 x
10" on the screen); a number already on that shelf is counted again and changes
nothing. Nothing moves and nothing is bought, so the level and its value stay
as they were: the movement is `numbered`, which only the unit's own level
reads. Refused in words: a number already in stock somewhere else, used on a
job or gone; the same number read twice; and more new numbers than units with
none, because those extra units were never received and stock cannot appear
without a cost. Fewer is allowed and said, because a label that cannot be read
today is still a unit on the shelf. Changing an item from serial to lot or back
is refused while numbered units are on hand.

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

The customer's equipment page at `/equipment/{id}` shows the same trace under
"From our stock" for a unit installed from our shelf: the serial, the order and
vendor it arrived on, each move, and the job. `GET /v1/equipment/{id}/stock-trace`
is the same, under `inventory:read`, so somebody who may not read stock sees the
equipment without it.

### A unit back off a job

`POST /v1/stock/returns` (`inventory:adjust`), or "Back from a job" on
`/inventory/serials`, takes a serialised unit that was used on a job back onto a
shelf or truck by its number. The return names the use it undoes, so it comes
back at exactly the cost it left at, late freight included, as the same
receipt's part, and comes off the job's material cost
(`GET /v1/jobs/{jobId}/material-cost`). The ledger reverses what the use posted,
which here is only late freight a bill put on it: that comes off the job's cost
of goods sold and back into stock. The customer's equipment record it became
stays on their register, because only the office knows whether it came out;
the answer says so, and its link to our serial is cleared. A unit in stock, or
written off or sent back, is refused. Lots are not taken back by number: a lot
that comes back is received as found stock with its lot and cost.

### Return to a vendor

`POST /v1/vendor-returns` (`po:write` and `inventory:adjust`, because it is a
dealing with a vendor and a move off the shelf) sends serials or lots back to a
vendor from where they are, as `return_to_vendor` movements that name the
return. The return expects a credit of what the goods cost on the order they
came on, without the freight (a supplier credits the part, not the truck),
unless the buyer says another figure, and needs one when the units were
numbered on the shelf rather than received by number. A unit that arrived on
another vendor's order is refused for this one. `POST /v1/vendor-returns/{id}/credit`
records the credit memo beside what was expected, and `GET /v1/vendor-returns`
lists them, those waiting first. `/purchasing/returns` is the screen. Nothing
about the credit posts to the ledger, for the reason receiving stock does not;
late freight the units carried leaves the inventory account as for any loss.

### What the vendor said back

A vendor answers an order by email or a phone call, and somebody in the office
writes it down by hand: `POST /v1/purchase-orders/{id}/acknowledgement` (`po:write`)
takes the day they promised it by, their reference for the order and what else
they said, from the form on `/purchasing/{id}`. Nothing is read out of an email:
a date a program guessed is a date a buyer would trust and nobody wrote. The
first reply moves a sent order to acknowledged, which the reorder engine already
counted as on order; each later reply is kept with the promise it replaced, so a
date that moved twice says so. A draft (never sent) and an order received or
cancelled take no reply, a promise dated before the day the order was sent or
more than a year ahead is refused as a slip, and a reply after the first has to
say something new. The "Vendor confirmed" button on the list writes the same record
with no date, so it leaves the same trail.

The promise does not overwrite "wanted by", which is what the buyer asked for
and what the order's PDF says. The reorder suggestions read the promise when
there is one, due at the end of that day in the company's calendar, so
"overdue" there and "past its promise" on the purchasing list are one fact.

`/purchasing` lists "Orders to ring about" first: an order sent and not answered
for the company's number of days, and an order past its promise with something
still owed. The list rows and the order's page carry the same sentence. The
number of days is 1 to 30, three until somebody changes it
(`GET /v1/purchasing/settings` for `po:read`, `POST /v1/purchasing/settings` for
`po:write`), and applies from then on to every order.

### Freight on a delivery: landed cost

`POST /v1/purchase-orders/{id}/receipts` takes the charges on the vendor's
bill for that delivery (`charges`: freight, a fuel surcharge) and spreads
them over the lines that arrived on it, by what each line cost or by how many
of each arrived (`basis`), allocated to the cent so the shares add back to
the charge exactly. Each line's share goes into its cost, so a part bought for
forty dollars with three dollars of freight on it is issued to a job at forty
three, and is kept beside it so the order says what was the goods and what
was the carrier. Only that delivery's lines carry that delivery's freight.

**A bill that comes later.** The carrier's invoice, or the broker's duty bill,
often arrives a week after the truck. `POST /v1/purchase-order-receipts/{id}/late-charges`
(`po:write`), or "A freight or duty bill that came later" on the order's page,
spreads it over that delivery's lines the same way (by value or quantity, the
delivery's own basis unless another is given), and then each line's share
follows its parts by how many went where:

- onto the shelf or truck they are still on, raising what those parts are worth
  and what the next job that uses one is charged;
- onto each job that already used them, as that job's cost of goods sold, which
  job costing reads (M15) and the job's stock cost includes;
- onto stock already scrapped, counted short or sent back, as a cost with no job.

The arithmetic is core's (`inventory.planLateLandedCost`), allocated to the cent
twice with the leftover cents placed by a fixed rule (largest share first, then
the earlier entry, over entries in a fixed order), so the same bill on the same
history lands on the same cents; it has unit tests. Where each part went is the
costing replay's first in, first out answer, carried through every transfer.
It writes a `revaluation` movement per piece and one balanced ledger posting
through `ledger.postLateLandedCost`: the shelf share to inventory, each job's
share to cost of goods sold on that job, the rest to cost of goods sold, and the
whole bill to accounts payable (2000). A bill in fractions of a cent, a delivery
that does not exist, and a history that cannot account for every part that
arrived are refused. The order's page lists each late bill under its delivery
with where it went.

### Who approves an order

`POST /v1/purchase-approval-rules` declares a step: an order at or over an
amount needs somebody holding a named role to approve it. Steps are taken in
order, so "over a thousand, the office manager; over five thousand, the owner
as well" is two rows, and a six thousand dollar order needs both, the office
manager first. A step can be for some orders only: to one vendor, with any line
from one price book category, or delivering to one location, all that are given
holding. The amount is always the whole order's total, not the share in the
category, because asking for more approval is the safe mistake. Among steps for
every order a later step may not start below an earlier one; a scoped step is
not held to that order. Nobody decides two steps of one order. A rejection needs a
reason and ends it: the order is cancelled and a corrected one raised. The
steps are company policy about who may commit money, so declaring them is
`settings:write`; `/purchasing/approvals` is the screen.

Whoever a step waits for is told by email through the company's own email
path: everybody holding the step's role, except people who already decided a
step of the order, when an order is raised, when an approval leaves the next
step waiting, and when an edit asks again. Each attempt is listed on the order
under "Told by email", including one refused because no email is connected,
which is how a buyer knows the owner was never asked.

**An edit above what was approved asks again.** Each approval copied the total
it said yes to. An edit that takes the order above it sets that approval aside
(kept as the record) and the step waits again; an edit at or under every
approved total leaves them standing. A rejected order is cancelled and raised
again, not edited.

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
one given, with every line in the body, the order attached as a PDF (made with
core's pdf module and the same bundled Noto Sans, logo and contact lines as
the invoices) and a link that opens the order printable as the vendor reads
it, with no sign in. The PDF is also on the order's page. Emailing a draft sends the
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
| `PUT /v1/purchase-orders/{id}` | `po:write` |
| `POST /v1/stock/numbering` | `inventory:adjust` |
| `POST /v1/stock/returns` | `inventory:adjust` |
| `GET /v1/equipment/{id}/stock-trace` | `inventory:read` |
| `GET /v1/vendor-returns` | `po:read` |
| `POST /v1/vendor-returns` | `po:write`, `inventory:adjust` |
| `POST /v1/vendor-returns/{id}/credit` | `po:write` |
| `POST /v1/purchase-order-receipts/{id}/late-charges` | `po:write` |
| `POST /v1/purchase-orders/{id}/acknowledgement` | `po:write` |
| `GET /v1/purchasing/settings` | `po:read` |
| `POST /v1/purchasing/settings` | `po:write` |

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
EDI feed, and at most five thousand rows at a time. It does not create vendors:
one the file names that nobody has added is skipped. Packs are whole packs of
one unit of measure; a supplier selling the same part by the each and by the
box is two links, which one item per vendor cannot hold, so the box wins.

Stock received outside an order carries whatever total cost was typed, and a
late freight bill can only be spread onto a delivery received against an order.
Costing stays first in, first out by location rather than the cost of the
particular serial. Receiving and using stock post nothing to the ledger, so the
inventory account holds only late freight on parts still on a shelf (see Key
concepts): whether this product should keep a perpetual inventory in the books
is a decision not yet made, and the conservative answer was taken. A vendor's
credit for a return is recorded, not posted, for the same reason.

A unit back off a job is taken back by serial only; a lot coming back is
received as found stock. Sending counted stock back to a vendor is not built,
and the return screen sends serials (a lot goes back through the API, with its
quantity). The customer's equipment record a returned unit became is left on
their register for the office to retire.

An approval step's amount is the whole order's total, never the part of it in a
category or for a location. Approvers are told by email only, not by text or in
the app, and only when the company's email is connected.

A vendor's reply is written down by a person and never read out of an email, and
the promise date is the vendor's word, not a delivery tracked by a carrier.
Filling a truck is a move somebody makes from the suggestion; nothing fills
trucks on a clock, and a tracked part's restock needs its numbers typed.
