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

The equipment register has no `/v1` surface yet. What the API does carry is the
part the field app needs: `PUT /v1/visits/{visitId}/units` plans which units a
visit is about, `GET /v1/visits/{visitId}/units` reads that plan back, and
`POST /v1/visits/{visitId}/units/{equipmentId}/outcome` records what happened
to one of them. All three are visit permissions rather than equipment ones,
because they are statements about a visit.

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

No `/v1` routes for the register, the moves or the warranty watch, so an
integration cannot read or write equipment at all. That is the one place in the
product where a screen has something the API does not, and it is against
BUILD.md's own ordering rule. Resolving coverage from an equipment warranty
record is not wired to M32 either: the dates are here and that module does not
read them.
