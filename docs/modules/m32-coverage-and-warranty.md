---
title: Coverage, Warranty and Who Is Actually Paying
module: M32
domain: Money
phase: 5
status: stub
---

# Coverage, Warranty and Who Is Actually Paying

> Module M32. Domain: Money. Ships in phase 5.

## The problem

The same physical visit can be free under a maintenance plan, free because it is our own callback, or cheap because a home warranty administrator pays a rate card and the homeowner pays a trade call fee.

## What it does

Every visit and every invoice line carries a RESOLVED COVERAGE SOURCE, chosen
from a fixed set: customer, agreement, parts warranty, labour warranty, our own
warranty, home warranty, insurance, goodwill, no charge callback.

Pricing, the field app script, invoicing and agreement profitability all read
that one value rather than each reconstructing it from circumstantial
evidence.

## Key concepts

**Resolved once, not inferred four times.** Without a stored coverage source,
pricing guesses from the agreement, the field script guesses from the job type,
invoicing guesses from the total and reporting guesses from all three. They
disagree, and the disagreement reaches a customer as an invoice they refuse.

**A zero dollar visit is not one thing.** Covered work under an agreement and
rework on our own mistake look identical on a revenue report and mean opposite
things about the business. One is the product working; the other is money
leaving.

**Goodwill is a category, not a discount.** Absorbing a cost to keep a customer
is sometimes the right call. Recorded as a discount it hides how often it
happens and who is making it, which is the part an owner needs.

## Setup

<!-- What an admin configures, in order, with the permissions required. -->

## Using it

<!-- Task-oriented. One heading per job to be done. -->

## Permissions

| Role | Access |
|---|---|
<!-- owner / admin / manager / dispatcher / csr / technician / accountant -->

## API

<!-- Link to the generated reference, plus the two or three calls that
     cover most real integrations. -->
