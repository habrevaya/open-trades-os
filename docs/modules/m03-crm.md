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

The account page also says what an invoice to them is charged in sales tax today
and why, and takes whether they are exempt, the exemption certificate's number and
last day, and a rate of their own (`PATCH /v1/customers/{id}`, `customer:write`).
After the certificate's last day they are taxed again. An address's own rate is
set on `/properties/{id}` (`PATCH /v1/properties/{id}`, `property:write`), and wins
over the customer's because the rate follows where the work is done (M13).

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

The page says how many pairs there are in all ("12 pairs to look at"), and the
API's `total` says the same on every page of the list, so a client does not have
to read to the end to know how long it is. The count leaves out the pairs set
aside, as the list does, and is taken from the same query as the page, so the two
cannot disagree.

**A mark can be taken off.** Under the list, "Marked as different people" shows
each pair set aside, newest first, with the reason somebody gave and the day, and
a "Put back in the list" button on each. `GET /v1/customer-duplicates/set-aside`
lists them and `POST /v1/customer-duplicates/restore` takes one off, from
either side as the mark was made; both need `customer:merge`. Taking off a mark
that is not there is not an error (the answer says `wasMarked: false`), which is
what makes a retry safe. A pair whose customer was merged or taken off the books
since is still listed with the name it had, so a mark can always be found. Putting
a pair back is written to the audit log as `customer.duplicate_restored`.

### Keep a customer's people

The customer's page adds a contact, edits one, takes one off and makes one
primary, and the API does the same through the same service functions, so the
rules are one set. "Edit" on a person's row opens their name, role, phone, email,
address and preferred channel, and saving runs `PATCH /v1/contacts/{id}`'s own
function: it is checked as the whole row it would become, so clearing the phone of
somebody who prefers texts is refused with the same sentence the API gives, and
the form stays open with what was typed. A box left empty clears that detail. The
screen cannot change who the person belongs to or make them primary, because the
route does not. The rules:
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

### Keep notes on a customer

The customer's page has a Notes section: what somebody learned on the phone
and the next person needs to know. Each note is dated and says who wrote it.
"Keep it at the top" pins it above the rest, and anybody who may write notes
may pin or unpin one, whoever wrote it. "Show it to the technician on their
visits" marks it for the field. The newest twenty five come first, then
"Older notes" pages back; the address bar carries the page.

**A note is added to, not rewritten.** Its writer can fix a note for 15
minutes after writing it ("Fix this note"), which changes the words and
whether the technician sees it, and says it was fixed. After that, and for
anybody else, the note offers "Add a correction", which writes a new note
that names the one it corrects. Nothing deletes a note. That is the
conservative reading of a customer file, chosen because "who told the
customer that" has to be answerable a year later; the window and the rule
are in `packages/core/src/customer-notes`.

**What the technician reads.** On the visit, on `/my-day` and on the phone
app, under "Notes from the office": the notes marked for the field, pinned first, at most twenty,
shipped with the day so they are there without signal, and a note marked
afterwards reaches the phone on its next poll. A technician and a crew lead
reading a customer's notes through the API get only those too, and the
answer says `fieldOnly: true`. A branch manager is office, and reads every
note of a customer in their branch.

**Scope.** A note is read and written through its customer, found under the
caller's customer scope first, so another company's customer, a customer
outside a branch manager's branch and a customer a technician was never sent
to are all "not found", on the list and on a note's own routes.

**The old notes box.** `customer.notes` was one box that no route or screen
read. The migration that made notes carried every box with something in it
into that customer's first note, dated when the customer was last changed
(the nearest the row holds to when it was written), marked "Carried over from
the old notes box" with no writer, and emptied the box. Nobody may change a
carried note. The column stays only so a copy taken before notes existed
still restores, and a restore carries its boxes across the same way.

**Notes from another system.** `POST /v1/customers/{id}/notes` takes
`notedAt`, under the history rules every back dated record follows (a week
back for anybody, earlier only with `data:import`, never ahead), and
`externalRef`, which marks the note as brought in, with no writer here, and
refuses the same reference twice. A note brought in is never changed.

`GET /v1/customers/{id}/notes` lists them (pinned in `pinned`, the rest a
page at a time in `data`), `POST /v1/customers/{id}/notes` adds one,
`PATCH /v1/customer-notes/{id}` is the writer's fix, and
`POST /v1/customer-notes/{id}/pin` pins or unpins. Reading needs
`customer:read`; the other three need `customer:write`. Every write is in the
audit log. A merge moves the duplicate's notes to the record kept.

### Correct an address

`PATCH /v1/properties/{id}`. Gate codes, access notes and the safety flags a
technician has to see before they get out of the truck live here, not on the
job, because they are true of the place rather than of one visit.

### Record the street an address is on

The street line holds the house number and the street together, and "12 Oak
Street" and "14 Oak St" are one street and two strings. The trash bin trade's
homes per served street (M21) counts distinct streets, so an address keeps its
street apart from the line, and the street is never read out of the line by a
pattern.

The geocoder fills it from its own address components where it gives one
(OpenStreetMap's road, Mapbox's street name), when it puts the address on the
map. An address the geocoder located before streets were kept is asked once
more, for its street alone, last in the worker's queue. A pin the office placed
by hand is never sent to the geocoder, so its street is typed.

Otherwise it is typed on the address's page (`/properties/{id}`, "Street"),
which offers the streets already recorded in the same town so one street is
picked rather than spelled a second way, or with `PUT /v1/properties/{id}/street`
(`property:write`, on the audit log). A typed street wins over the geocoder for
that address, as a placed pin does. Taking it off hands the address back to the
geocoder. A street answers for the address it was recorded against: an address
that changes has no street until one is recorded for it again. `GET
/v1/properties/{id}` says the street and who named it (`street`, `streetSource`).

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
| `PUT /v1/properties/{id}/street` | `property:write` |
| `POST /v1/properties/{id}/customers` | `property:write` |
| `GET /v1/customers/{id}/duplicates` | `customer:read` |
| `GET /v1/customers/{id}/deletability` | `customer:read` |
| `GET /v1/customers/{id}/merged-into` | `customer:read` |
| `POST /v1/customers/{keepId}/merge` | `customer:merge` |
| `GET /v1/customers/{id}/merges` | `customer:merge` |
| `POST /v1/customer-merges/{id}/undo` | `customer:merge` |
| `POST /v1/customers/{id}/remove` | `customer:delete` |
| `GET /v1/customers/{id}/contacts` | `customer:read` |
| `POST /v1/customers/{id}/contacts` | `customer:write` |
| `PATCH /v1/contacts/{id}` | `customer:write` |
| `POST /v1/contacts/{id}/primary` | `customer:write` |
| `POST /v1/contacts/{id}/remove` | `customer:write` |
| `GET /v1/customers/{id}/notes` | `customer:read` |
| `POST /v1/customers/{id}/notes` | `customer:write` |
| `PATCH /v1/customer-notes/{id}` | `customer:write` |
| `POST /v1/customer-notes/{id}/pin` | `customer:write` |
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

The duplicate's tags join the survivor's list after its own, each only when
the survivor has no tag that compares equal, because a merged record is in no
tag count and a "VIP" on it would otherwise drop out of every list kept by
tag.

### What a merge moves

Everything that names the duplicate: the jobs, estimates, projects,
invoices, payments, deposits, agreements, contracts, credit notes and their
payouts, card charges, financing applications, coverage claims they pay,
referral rewards, statements sent, saved cards, people, notes, addresses,
consent and advertising answers, conversations, calls, portal links and sign
ins, campaign sends and mail pieces, reviews, files and tasks filed on the
customer, custom records, container holds, and the customers they referred.
All of it inside the one company (every statement names the company as well
as the customer), in the one transaction, with both customer rows locked
first, and written to the audit log as `customer.merged`. The lists are in
`packages/api/src/services/customer-lifecycle.ts`, and a test reads every
foreign key to `customer` from the database and fails on one the merge does
not name, as moving or as staying with a reason, so a new table cannot be
missed quietly.

**A saved card moves as the processor's reference.** The card number never
reaches this product; the processor holds it under its own customer record,
and what moves is the reference, the brand and the last four digits, with the
customer's agreements to charge it. A charge reaches the processor through
the card's own processor record, so a moved card charges where it was saved.
The processor record itself moves when the survivor has none at that
processor account, and stays with the duplicate otherwise.

**What may not move stays, and is said.** Some things a customer may have
only one of, and when the survivor already has one, the duplicate's stays
with the duplicate: a statement for the same month, a piece in the same
mailing, a referral reward earned for the same person, a task the same
automation raised. A card that pays the duplicate's bills automatically stays
with its agreements when the survivor already pays automatically with a card
of its own, because one card pays each customer's bills automatically or
every bill is charged twice, and which one they meant is the customer's to
say; they can save it again on the survivor. Each of these is on the merge's
answer as `stayed`, with why in words, right after the merge on the page,
and under the merge on the kept record's list.

**A no to advertising wins.** When the duplicate's live answer about using
their details for advertising is no and the survivor's is yes, the yes is
superseded and the no becomes the person's answer. Joining two records must
not turn somebody's no into a yes; that is the conservative reading. An
undo makes the yes live again, unless a new answer was recorded since.

What stays where it was: the ledger, which is append only (below); the
merge's own record; a pair marked "not the same person", which is a judgement
about two records and says nothing about the survivor; and the tag table,
which the database keeps from the customer's own list.

### Take a merge back

Two people who share a phone number get merged, and somebody notices a week
later. A merge writes down exactly what it did (`customer_merge`): the id of
every row it moved, table by table (jobs, invoices, payments, deposits,
estimates, agreements, contacts, notes, address links, consent records,
conversations and calls, and the rest of the tables listed in
`customer-lifecycle.ts`), the address links it took out as doubles of one the
survivor already had (kept whole), the blank fields it filled and the tags it
added. Equipment belongs to an address, so it goes with the address links.

The kept record's page lists "Merged into this record": who merged what, when,
what it brought, what stayed with the duplicate and why, and "Undo this
merge" with a box for why. Undoing moves those rows back and no others, puts the doubled address links back as they were,
clears a field the merge filled unless somebody has changed it since (then it
is left, and the answer says so), takes off the tags it added, and makes the
duplicate a customer with its own page again. Anything written to the
survivor since the merge (a note, a new person, a job at its own address)
stays with the survivor, which is who it was written to.

**When it is refused.** Every reason is said at once, in words, on the page
before anybody clicks and again at the click:

- the merge is more than 30 days old, or already undone;
- money was written to the survivor since: an invoice, an invoice they pay
  for, a payment, a deposit, a ledger posting (a payment, a void or a refund
  on an invoice the merge moved posts one), an agreement, a contract, a credit
  note, a credit payout, a card charge, a financing application, a coverage
  claim they pay, a referral reward, or an agreement to charge a saved card
  (which would stay with the survivor while the card it names went back). Money
  cannot be split back between two customers by a guess, so the merge stands.
  That is the conservative choice, made because a payment on the wrong
  person's account is worse than a merge somebody has to untangle by hand;
- a row the merge moved is no longer the survivor's (a person moved to
  another customer, a link taken off an address);
- a job or an estimate was booked for the survivor since at an address that
  would go back with the duplicate;
- either record has since been merged into another or taken off the books.

`GET /v1/customers/{id}/merges` lists the merges into a customer with
`canUndo` and `blockedBy`, and `POST /v1/customer-merges/{id}/undo` takes one
back. Both need `customer:merge`, the permission the merge needs, because
taking a merge back is the same decision made the other way. The undo is in
the audit log as `customer.merge_undone`, and the merge's record keeps who
undid it, when and why. The merge's answer carries `mergeRecordId`, the id the
undo names, and a retry of either with the same idempotency key returns the
first answer.

### Remove one

`GET /v1/customers/{id}/deletability` says whether it can go and what would go
with it, asked before anybody clicks because the answer decides which button a
screen should show. `POST /v1/customers/{id}/remove` is the removal, and it is
refused outright when money points at the customer (an invoice, a payment, a
deposit, a ledger entry, an agreement, a contract, a credit note or its
payout, a card charge, a financing application, a coverage claim they pay or
a referral reward): a hard delete would cascade
and take the invoices, a soft delete would leave a receivable nobody can
explain, and both are worse than refusing. The refusal names what is in the way,
which is also the case where merging is the right answer.

## What is not built

An address's street is the geocoder's or a person's, and two spellings of one
street typed by hand ("Oak St" and "Oak Street") are two streets: nothing
expands an abbreviation, which would be reading the words by a pattern. The
screen offers the town's streets to pick from instead. The phone does not
record a street; addresses are the office's.

A contact attached to an address and no customer is reached through neither the
customer's page nor the customer's contact routes, which are about a customer's
people. A customer's custom
fields filter `/customers` and `GET /v1/customers` several at once, every one of
them or any one of them (M29 says how), and reach the report builder on every dataset
that hangs off a customer; "any" is one choice for every field applied, not a mix of
"and" and "or".

A customer note is never deleted and, after its writer's 15 minutes, never
changed: a wrong note stays, with its correction beside it. Notes are not
searched by the customer search box. The phone app shows the notes marked
for the field and cannot add, pin or fix one; that is the office's. A
note is on a customer, not on an address or a job.

A merged or soft deleted customer keeps its tags on its own row and has none in
`customer_tag`, so it is in no tag count and no tag filter; that is deliberate,
and an undone merge puts the duplicate's own list back in both.

A merge older than 30 days, or one with money written to the survivor since,
cannot be undone here: what belongs to the duplicate is moved by hand. A merge
moves every table with a foreign key to a customer, and the files and tasks
filed on one, but not what names a customer some other way: the audit log,
the event and integration logs, a document or an obligation filed by kind and
id under another name, and the accounting system's link to its own customer,
which stays with the duplicate so the accountant joins the two there. What
stays because the survivor already has one (a statement for the month, a card
that pays automatically) is not joined to the survivor's: the office or the
customer does that. Undoing does not mark the two as different people, so they can show as
a possible duplicate again until somebody says so on the duplicates screen. A
merge done before merges were recorded has no record and cannot be undone. The tag table is written only by the
database, so a restore that loads `customer_tag` rows from an export as well as
customers is loading them twice: the customers' own lists are what to restore.

The duplicate sweep's total counts the pairs the matcher finds right now, so it
moves as customers are added, edited and merged; it is not a fixed list that a
person is working down. A pair marked "not the same person" is unmarked by
putting it back, which says nothing about the two being the same person: it only
lets the matcher show them again if they still look alike.
