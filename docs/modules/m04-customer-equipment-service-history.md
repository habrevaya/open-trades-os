---
title: Customer Equipment and Service History
module: M04
domain: Customer
phase: 1
status: partial
---

# Customer Equipment and Service History

> Module M04. Domain: Customer. Ships in phase 1.

## What it does

Keeps a register of the equipment at an address, how old each unit is, whether
it is still covered, and what was done to it last time. For a service trade
those are the four questions every call starts with.

## The problem

`equipment` has been in the schema since the first migrations and nine other
tables point at it: a job names the unit it is about, an entitlement names the
unit a warranty covers, a deficiency names the unit that failed, a service
report names the unit it describes.

Two things touched it. The field app could record a unit found on site, and the
property read could count them. So the property screen said "twelve units here"
and there was no way in the product to see what they were. For a service trade
that is not a missing screen, it is the missing product.

## Key concepts

**The serial number is the identity.** It is the only identifier that survives
a customer moving out and the next owner calling. Matching on anything softer
produces a second record for the same furnace and splits ten years of history
down the middle.

**Warranty is derived from the dates and stored nowhere.** A boolean in a
column is a fact that was true on the day somebody wrote it, and the only
question anybody asks of a warranty is about today.

**Parts and labour expire separately.** They are two columns and two answers,
because a single "under warranty" is how somebody quotes a free repair whose
labour is not covered. That conversation is the reason for the second column.

**A unit that moves keeps its row.** A landlord moving a water heater between
two rentals, or a warranty swap, is a move with a reason: relocated, swapped
under warranty, replaced, removed or returned. Without that, a move produced
either a new record with no history, or an edit that silently rewrote where the
old work happened.

**Units nest.** A riser has valves; a rooftop unit has a compressor. The tree
is built with a depth cap, and a unit caught in a cycle is shown at the top
with its parent link intact rather than dropped, because a unit nobody can see
is worse than one in the wrong place, and the link is what somebody needs in
order to fix it.

**The warranty watch looks backwards as well as forwards.** A warranty that
lapsed last month is the call worth making, and a list that only looks forward
stops mentioning a unit at the exact moment it becomes interesting.

## Using it

### See what is at an address

`/properties/{id}` shows the register, nested, with each unit's age, its
warranty standing today and what was last done to it. Reading it needs
`equipment:read` and the page says so rather than hiding the section.

### Add or correct a unit

The same screen, with `equipment:write`. A category is required because the
register is read by category; everything else is optional, because a technician
standing in a crawl space often has a model number and no serial.

A serial is matched against the WHOLE company before the unit is added, on its
letters and digits alone ("ab-1234 x" and "AB1234X" are one plate), retired
units included. At the same address a live match is refused outright. Anywhere
else the add stops and the form lists each unit already carrying that serial,
where it is and whether it is still on a register, each linking to its page,
because the usual right answer is a move on the existing unit rather than a
second record that splits its history. Ticking "It is a different unit with the
same serial" adds it anyway, for the makers whose short serials repeat.
`GET /v1/equipment-serial-matches` is the same match, for an integration that
wants to ask before it adds; `POST /v1/equipment` refuses a match elsewhere
until `serialElsewhereConfirmed` is sent.

### Record a unit from the field app

The phone's visit screen has "Equipment here": what it is, make, model,
serial and where it is, saved on the phone like everything else and sent
when there is signal. The sync matches it with the office's rules, across
the company and on the plate's letters and digits: the same unit live at
this address is updated rather than added again; a serial on file at another
address, or taken off a register, is not added but held for the office on
the field conflicts list with the units it matches named, and the phone says
it was held, because only a person can say whether it is the same furnace
moved here; anything else is added. A phone can send
`serialElsewhereConfirmed` with the record when the technician knows it is a
different unit with the same plate.

### Move a unit

A move records where it went and why. Retiring a unit is a soft delete, so the
jobs that named it still resolve.

On the unit's own page, `/equipment/{id}`, somebody who may write the register
(`equipment:write`) sees two folds below the facts. "Correct its details" is the
unit's category, tag, make, model, serial, place in the building, install date,
the two cover dates and whether we installed it, filled in with what is on file;
saving runs `PATCH /v1/equipment/{id}`'s own function, so a serial already on file
at this address is refused in the API's words, and a box left empty takes that
detail off. It does not offer the address. "Move it to another address" lists the
customer's other addresses and a search of every address by street, city or postal
code (needs `property:read` to draw), and records the move through
`POST /v1/equipment/{id}/move`'s own function: a reason that means it went somewhere
(moved to another address, swapped under warranty, returned), the day (today, in
the company's calendar, when left empty) and a note. Anything nested inside the unit
goes with it, and the move shows under "Where it has been". A unit that was replaced
or taken away is retired from its address's register instead. A unit taken off the
register shows neither form.

### Find out what happened to it

`/equipment/{id}` is the unit's own page: what it is, its serial, where it is
and who to ring, when it was installed and how old it is, what it is part of
and what is inside it, its warranty with parts and labour apart (and the
follow up button), its service history, the inspections that named it, the
faults found on it, the readings service reports took on it (newest first, out
of range ones marked), its photographs, and where it has been. Every link to a
unit (the register, the warranty list, a visit's units, a job about it, a
follow up task, a KPI's records) opens here rather than on its address.

The history read behind it gathers the jobs that named the unit, the visits
that recorded an outcome on it, the deficiencies raised against it, the
readings taken on it, the inspections whose answers named it, and the
photographs of it: the ones taken while answering a checkpoint about it, the
ones kept with a fault found on it, and anything filed against the unit. A
photograph of the whole visit is not a photograph of this unit and stays on
the visit.

### Watch warranties running out

`/customers/warranties` is the warranty watch on a screen: units whose parts or
labour cover ends in the next 30, 60 or 90 days, and units whose cover ended
in the last 90, grouped by customer and then by address, or any window by its
two dates ("Cover ending from ... to ..."; the API takes `from` and `to`). Each
unit says when each kind of cover ends or ended, links to the unit's page, its
address and the customer, and offers the two follow ups the list exists for: "Raise a
follow up task", which puts a task about the unit in the office queue (and is
not offered again while one is open), and "Estimate a replacement", which opens
a new estimate for that customer at that address.

The customer is the one linked to the address now, primary first and owners
before tenants, and `GET /v1/equipment-warranties` returns it on every unit
(`customer`, null for an address nobody is linked to). Reading the screen needs
`equipment:read`; it sits under Customers, so somebody who can see customers
and not equipment is told which permission the page needs rather than shown an
empty list.

### Raise the follow up automatically

"A unit's warranty about to run out" is something an automation can wait on
(Automations, wait on, how many days). It fires that many days BEFORE the
unit's next cover ends, parts or labour, whichever comes first and has not
passed, counted in the company's calendar, once per unit per end date: an
extended warranty is a new date and a new call. Retired units are left out.
The event carries the unit, the customer linked to its address and the date
(`{{ until }}` in a task's title), and the task a "Create a task" step raises is
about the unit, so it opens the unit's page.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything |
| Office manager, CSR, dispatcher | Read and write the register |
| Technician | Read and write, because the register is mostly built in the field |
| Accountant | Neither |

`equipment:read` and `equipment:write` are both on the technician preset
deliberately: a register nobody in the field can add to is a register that is
wrong within a month.

## API

| Call | Needs |
|---|---|
| `GET /v1/equipment` | `equipment:read` |
| `GET /v1/equipment/{id}` | `equipment:read` |
| `GET /v1/equipment/{id}/history` | `equipment:read` |
| `GET /v1/equipment-warranties` | `equipment:read` |
| `GET /v1/equipment-serial-matches` | `equipment:read` |
| `POST /v1/equipment` | `equipment:write` |
| `PATCH /v1/equipment/{id}` | `equipment:write` |
| `POST /v1/equipment/{id}/move` | `equipment:write` |
| `POST /v1/equipment/{id}/retire` | `equipment:write` |

The register comes back FLAT, in reading order, with a depth on every row, and
the screen's own read is a tree. That is not an inconsistency: a recursive
schema is a lazy one and the OpenAPI generator cannot describe it, so a tree
here would mean publishing a document that does not say what the response is.
Flattening loses nothing, because capping the depth and surfacing a unit caught
in a cycle at the top have already happened by the time it runs, and a client
renders the indentation straight off `depth`.

The warranty watch is at `/v1/equipment-warranties` rather than under
`/v1/equipment/`, because a literal segment at the same depth as
`/v1/equipment/{id}` is ambiguous and the route guard refuses it rather than
picking.

The API also carries the part the field app needs:
`PUT /v1/visits/{visitId}/units` plans which units a visit is about,
`GET /v1/visits/{visitId}/units` reads that plan back, and
`POST /v1/visits/{visitId}/units/{equipmentId}/outcome` records what happened to
one of them. All three are visit permissions rather than equipment ones, because
they are statements about a visit.

## Common questions

**What if there is no serial number?** The unit is recorded without one. The
cost is that the next technician may create a second row for it, which is why
the register is worth a minute on site.

**Why is the unit count on the property and the register behind a
permission?** The count is a property fact. What the units are is equipment,
and a company can give the field app less than the office.

**Does retiring a unit lose its history?** No. It is soft deleted and
everything naming it still resolves.

## What is not built

A job's coverage is read from its unit's parts and labour dates by M32
(`POST /v1/jobs/{id}/coverage/from-equipment`), on the day of the first visit,
and from nothing else about the warranty: the dates are all this register
keeps of it. The field app's sync
matches with the office's rules, across the company, but it cannot ask the
technician the office's question: a unit whose serial is on file at another
address, or taken off a register, is held for the office on the field
conflicts list with the match named, not added, until somebody records a
move or adds it. A serial with no letters or digits in it matches nothing,
and two units with no serial at all are never matched, which is the cost of
a register without serials.

The warranty automation is a trigger to build on rather than one that ships
turned on: there is no recommended automation for it, so a company that wants
the call raised by itself builds the two step automation on the canvas. A
unit's page cannot change what a unit is nested in or its free form attributes,
which `PATCH /v1/equipment/{id}` takes and the screen does not offer.
