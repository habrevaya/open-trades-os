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

### Say where they came from

The new customer form has a lead source picker: the company's own channels
(M19), each with its live tracking campaigns. `POST /v1/customers` takes
`leadSource` (a catalogue key, or anything the catalogue's alias list places),
`channelId` or `campaignId`, and a word nothing can place is refused rather than
stored, because three spellings of one channel are three rows on every report.
Left blank, the source is worked out from the calls and visits the person made
before they were a customer, which their phone number claims the moment the
customer is created, and the record says `leadSourceOrigin: derived` so a guess
is never read as somebody's answer. The account page lets the office change it,
which is recorded as a declared touch so the change reaches the marketing
reports. A customer arriving from another system (`externalRef`) keeps what its
old system said, marked `imported`.

### Find somebody

`GET /v1/customers` takes `q` and searches name, phone and email together.
`/customers` is the same list with the same search.

### See everything about one account

`/customers/{id}` is the account page: the properties, the contacts, the jobs,
the invoices, the balance for whoever may read it, and the message thread with
them. `GET /v1/customers/{id}` is the same data.

### Tag customers and find them by tag

A customer's page has its tags, each a link to the customer list filtered by
it, and a box that offers the tags the company already uses. `/customers`
filters by one or more tags, any of them or all of them, and the address bar
carries the filter so it is a link somebody can send. `/customers/tags` is
every tag in use with how many customers carry it, a rename per tag, and a
merge that folds several tags into one.

Tags are compared without capitals: "vip" and "VIP" are one tag, a new tag
typed on a customer takes the spelling the book already uses, and a filter for
"vip" finds the customers tagged "VIP". A rename onto a tag that already
exists is refused and says to merge instead, because two segments becoming one
is a decision the merge names out loud. Renaming and merging are one statement
across the book with one audit line naming every customer changed.

On the API: `GET /v1/customers` takes `tags` (repeat it) and `tagMatch`
(`any` or `all`), `GET /v1/customer-tags` is the list with counts,
`POST /v1/customers/{id}/tags` adds and takes off, and
`POST /v1/customer-tags/rename` and `POST /v1/customer-tags/merge` work across
the book. A campaign audience's tag rule (`tagged_any` in M19) compares the same
way, so an audience of "vip" reaches the customers tagged "VIP".

**A tag is a row as well as a word on the customer.** The customer's own list is
still the record of what they carry, in the order it was written, and what the
API returns. Beside it, `customer_tag` holds the same tags one per row with the
case blind key next to each, under an index on that key, and the database keeps
it equal to every live customer's list by a trigger, in the same statement as any
change to the list: an import, a restore, a rename across the book, a merge. The
filter, the counts and the campaign rule read the table, so finding the customers
tagged "VIP" in a book of a million is a walk of an index rather than a read of a
million lists. The migration that made the table carried every live customer's
tags across exactly, spelling, order and odd spaces included, and a test runs that
statement again and checks it against the lists.

### Find duplicates across the whole book

`/customers/duplicates` is the per record matcher run over every pair at once:
the same phone number, the same email address, or a name close enough by
trigram, strongest reason first, with the same threshold and the same words
the customer's own page uses. It is one query rather than one per customer:
equality joins for phone and email, and pg_trgm's `%` against the trigram index
on the name with the threshold set to the matcher's own. Paged by position, so
merging pairs off the first page does not skip the ones that slide up.

Each pair offers both directions of the merge, named for the record kept, and
"Not the same person", which is remembered (`customer_not_duplicate`, stored
once as an ordered pair) so the pair stops appearing here and on either
customer's page. `GET /v1/customer-duplicates` and
`POST /v1/customer-duplicates/dismiss`, both behind `customer:merge`, because
the sweep reads across every customer and exists to be acted on.

### Keep a customer's people

The customer's page adds a contact, takes one off and makes one primary, and the
API does the same through the same service functions, so the rules are one set:
a contact belongs to the customer in the path, sits at an address only when the
address is one of that customer's, needs a phone or an email and a preferred
channel they can be reached on, and is removed softly so the texts already sent
to them still say who they went to. One primary per customer and per address;
making a new one demotes the old. `GET /v1/customers/{id}/contacts` lists them in
the order the "on the way" text picks its recipient,
`POST /v1/customers/{id}/contacts` adds one, `PATCH /v1/contacts/{id}` changes
their details (not who they belong to, and not whether they are primary),
`POST /v1/contacts/{id}/primary` makes one the first told, and
`POST /v1/contacts/{id}/remove` takes one off. A technician reads the people at
the customers they have been sent to and no others.

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
| `GET /v1/customers/{id}/duplicates` | `customer:read` |
| `GET /v1/customers/{id}/deletability` | `customer:read` |
| `GET /v1/customers/{id}/merged-into` | `customer:read` |
| `POST /v1/customers/{keepId}/merge` | `customer:merge` |
| `POST /v1/customers/{id}/remove` | `customer:delete` |
| `GET /v1/customers/{id}/contacts` | `customer:read` |
| `POST /v1/customers/{id}/contacts` | `customer:write` |
| `PATCH /v1/contacts/{id}` | `customer:write` |
| `POST /v1/contacts/{id}/primary` | `customer:write` |
| `POST /v1/contacts/{id}/remove` | `customer:write` |
| `GET /v1/customer-tags` | `customer:read` |
| `POST /v1/customers/{id}/tags` | `customer:write` |
| `POST /v1/customer-tags/rename` | `customer:write` |
| `POST /v1/customer-tags/merge` | `customer:write` |
| `GET /v1/customer-duplicates` | `customer:merge` |
| `POST /v1/customer-duplicates/dismiss` | `customer:merge` |

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

### Join two records that are the same person

`GET /v1/customers/{id}/duplicates` is the records that look like this person,
with the reason on each: the same phone number, the same email address, or a
name close enough that somebody should look. There is deliberately no score,
because one would have to weigh a shared phone against a name similarity and
whatever weighting was chosen would be wrong for somebody.
`POST /v1/customers/{keepId}/merge` joins them, and the response says what
moved and which blank fields on the survivor were filled in from the duplicate.
`GET /v1/customers/{id}/merged-into` is where a merged record went, which is
what makes keeping it worth anything.

### Remove one

`GET /v1/customers/{id}/deletability` says whether it can go and what would go
with it, asked before anybody clicks because the answer decides which button a
screen should show. `POST /v1/customers/{id}/remove` is the removal, and it is
refused outright when money points at the customer: a hard delete would cascade
and take the invoices, a soft delete would leave a receivable nobody can
explain, and both are worse than refusing. The refusal names what is in the way,
which is also the case where merging is the right answer.

## What is not built

A contact cannot be edited on the customer's page, only added, removed and made
primary there; changing one's details is the API's `PATCH /v1/contacts/{id}`. A
contact attached to an address and no customer is reached through neither the
page nor these routes, which are about a customer's people. A customer's custom fields are stored, checked and read back,
and `/customers` and `GET /v1/customers` filter by one field holding one value
(`fieldKey` and `fieldValue`); nothing filters by two at once, and the report
builder does not filter by one (M29).

A merged or soft deleted customer keeps its tags on its own row and has none in
`customer_tag`, so it is in no tag count and no tag filter; that is deliberate,
and undoing a merge is not built anyway. The tag table is written only by the
database, so a restore that loads `customer_tag` rows from an export as well as
customers is loading them twice: the customers' own lists are what to restore.

A pair marked "not the same person" cannot be unmarked from a screen or the API
yet. The duplicate sweep has no count of how many pairs there are in total,
only the pages.
