---
title: CRM
module: M03
domain: Customer
phase: 1
status: partial
---

# CRM

> Module M03. Domain: Customer. Ships in phase 1.

## What it does

Holds the people and the places. A customer is who pays; a property is where
the work happens; a contact is a person you ring. All three are separate
records because in this industry they genuinely come apart.

## The problem

Most CRMs model a customer with one address, and field service breaks that on
the first commercial account.

A property management company is one customer with four hundred addresses. A
landlord is one customer whose tenant is the person who answers the door. A
married couple is one household with two phone numbers and one of them is the
only one who may authorise work. A duplex is one address with two customers.
Collapsing any of those into a single row means somebody retypes an address
every time, and the service history for a building is split across however many
customer records that building has had owners.

So: the billing address is on the customer, the service address is on the
property, and the two are linked by a join that can hold many of each.

## Key concepts

**A property is a place, not a possession.** It survives a change of
ownership. When a house sells, the next owner is a new customer linked to the
same property, and ten years of service history stays attached to the building
where the equipment actually is.

**A contact is a role, not a name field.** Who authorises work, who gets the
invoice, who is on site, and who to ring in an emergency are four different
answers and often four different people.

**The service address resolves a territory when it is saved.** That resolution
is what attaches a trip charge and lets a day be planned by area, and it is why
one postal code may belong to at most one territory. Declared at
`Settings > Service area`, which is `/settings/service-area`.

**Search is what a CSR types while somebody is on the phone.** Name, phone,
email, matched with trigrams against an index on each, because the thing
actually typed is half a surname and four digits of a phone number.

**Do not service is a flag with a reason.** A customer who threatened a
technician is a safety matter, and the reason has to travel with the flag or
somebody books them again next spring.

**A standing discount is a separate permission from editing a customer.** It
is a price change on every future invoice for that account, so
`customer.financials:write` is not included in `customer:write`. The person who
corrects a phone number is not always the person who may do that.

**A merged duplicate is kept, not deleted.** It is soft deleted with a pointer
to the survivor, because a link somebody emailed, an integration holding the
old id and every audit row naming it all have to keep resolving to an answer.
Following the pointer twice is how a chain of merges resolves to the record
that is current.

## Using it

### Take a customer and an address

`POST /v1/customers` then `POST /v1/properties`, or do both on one form at
`/customers/new`, which is what the office actually uses. A property can be
linked to another customer afterwards with
`POST /v1/properties/{id}/customers`.

### Find somebody

`GET /v1/customers` takes `q` and searches name, phone and email together.
`/customers` is the same list with the same search.

### See everything about one account

`/customers/{id}` is the account page: the properties, the contacts, the jobs,
the invoices, the balance for whoever may read it, and the message thread with
them. `GET /v1/customers/{id}` is the same data.

### Correct an address

`PATCH /v1/properties/{id}`. Gate codes, access notes and the safety flags a
technician has to see before they get out of the truck live here, not on the
job, because they are true of the place rather than of one visit.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything |
| Office manager | Read and write both, plus the balance, the standing discount and merging |
| Dispatcher | Reads customers and properties. Writes neither |
| CSR | Reads and writes both. No financial fields |
| Technician | Reads the customers they have been sent to, and the property. Never the balance |
| Accountant | Reads customers and their financial standing |

`customer.financials:read` covers the balance and the payment history, and is
on the sensitive list. The balance is computed from the open invoices on every
read rather than stored, so it is redacted as a field on the row rather than
attached afterwards, which would have sent it to everybody.

## API

| Call | Needs |
|---|---|
| `GET /v1/customers` | `customer:read` |
| `GET /v1/customers/{id}` | `customer:read` |
| `POST /v1/customers` | `customer:write` |
| `PATCH /v1/customers/{id}` | `customer:write` |
| `GET /v1/properties` | `property:read` |
| `POST /v1/properties` | `property:write` |
| `PATCH /v1/properties/{id}` | `property:write` |
| `POST /v1/properties/{id}/customers` | `property:write` |

Every create takes an `externalRef`, and every list can look one up, which is
what makes a migration and a two way integration idempotent. M30 covers it.

## Common questions

**Can one property have two customers?** Yes, and it is the normal case for a
duplex or a rental. The link table holds the relationship and which one is
primary.

**What happens to history when a house is sold?** It stays on the property.
The new owner is a new customer; nothing is copied and nothing is lost.

**Why is the balance not a column?** Because a stored balance is a number that
was right when it was written. It is computed from open invoices on read.

## What is not built

Deleting a customer and merging two that are the same person are written and
tested in `services/customer-lifecycle.ts`, and neither has a route or a
screen, so neither can be reached. Deletion is refused when anything financial
points at the customer, and the refusal names what; merge moves everything
except the ledger, which is append only and corrects by reversing entry rather
than by moving a row. Contacts have a service and no route either. Tags and
custom fields are stored and read back; nothing filters by a tag yet.
