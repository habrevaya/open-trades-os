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

### Move a unit

A move records where it went and why. Retiring a unit is a soft delete, so the
jobs that named it still resolve.

### Find out what happened to it

The history read gathers the jobs that named the unit, the visits that
inspected it and the deficiencies raised against it, newest first.

### Watch warranties running out

`/customers/warranties` is the warranty watch on a screen: units whose parts or
labour cover ends in the next 30, 60 or 90 days, and units whose cover ended
in the last 90, grouped by customer and then by address. Each unit says when
each kind of cover ends or ended, links to the address its register is on and
to the customer, and offers the two follow ups the list exists for: "Raise a
follow up task", which puts a task about the unit in the office queue (and is
not offered again while one is open), and "Estimate a replacement", which opens
a new estimate for that customer at that address.

The customer is the one linked to the address now, primary first and owners
before tenants, and `GET /v1/equipment-warranties` returns it on every unit
(`customer`, null for an address nobody is linked to). Reading the screen needs
`equipment:read`; it sits under Customers, so somebody who can see customers
and not equipment is told which permission the page needs rather than shown an
empty list.

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

Resolving coverage from an equipment warranty record is not wired to M32: the
dates are here and that module does not read them. Nothing matches an incoming
unit against the register by serial number on the office side, so a duplicate
row for one furnace is still possible when somebody types rather than scans.

The warranty screen's windows are fixed at 30, 60 and 90 days ahead and 90
behind; the API takes any window up to two years. A unit has no page of its
own, so its links go to the address its register is on. Nothing raises a
warranty follow up on its own: the task is a button, and an automation that
raised one per lapsing unit would need a trigger the workflow engine does not
have.
