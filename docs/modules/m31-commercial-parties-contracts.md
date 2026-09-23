---
title: Commercial Parties, Contracts and Third-Party Billing
module: M31
domain: Money
phase: 5
status: stub
---

# Commercial Parties, Contracts and Third-Party Billing

> Module M31. Domain: Money. Ships in phase 5.

## The problem

A facilities network orders the work, a store manager is on site, a regional client approves it against a spend ceiling, and a corporate accounts payable portal pays a contract rate that is not your price book.

## What it does

A job carries a SET OF PARTIES rather than a customer. Requester, site
contact, approver, bill to, payer, referrer, owner. Residential service is the
case where one person holds every role, written as one row, and nothing about
the simple case gets harder: that is the test a change like this has to pass.

On top of the party model sit authorisations with a not-to-exceed ceiling,
external work orders carrying the client's own reference number, service
contracts covering many sites, rate cards that override the price book, and
delivery of the invoice in whatever form the payer's accounts payable process
demands.

## Key concepts

**Party role is not customer type.** A company can be the approver on one job
and the payer on another, and frequently is both minus the site contact. Roles
live on a join between the job and a party, so asking "who approves this" and
"who pays for this" are two lookups rather than two optional columns that get
out of step.

**The ceiling is enforced where the spend happens.** A not-to-exceed amount
checked only at invoicing tells you about the problem after the work is done
and the client has refused the part above it. The running total is in the field
app, against the authorisation, before the technician commits.

**A rate card is priced work, not a discount.** Contract labour rates by trade
and time of day replace the price book for covered work rather than reducing
it, and the override is visible on the line so nobody has to work out why the
number differs.

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
