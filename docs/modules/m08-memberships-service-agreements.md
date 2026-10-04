---
title: Memberships and Service Agreements
module: M08
domain: Sell
phase: 6
status: partial
---

# Memberships and Service Agreements

> Module M08. Domain: Sell. Ships in phase 6.

## What it does

Sells a customer recurring service: a price, a term, and a number of visits
the company owes them. The visits exist as rows from the moment the agreement
is sold, the billing runs on its own separate schedule, and the money sits as
a liability until a visit is actually delivered.

## Why it is the module worth getting right

Maintenance agreements are the single biggest lever on what a home services
company is worth. A shop with four hundred members on auto renew sells for a
different multiple than an identical shop doing the same revenue in one off
calls, because one has predictable revenue and a reason for the customer to
call them first, and the other has neither.

## Key concepts

**One concept, not two.** The industry says "membership" for residential and
"service agreement" for commercial, and at least one major platform models
them as two separate things, which means two of everything: two billing paths,
two visit generators, two renewal reports. They are the same object with
different marketing.

**The agreement generates its own visits.** A plan that includes two tune ups a
year and relies on somebody remembering to book them is a plan that quietly
does not get delivered, and the first anybody hears of it is at renewal when
the customer says they never saw us. So the visits are written down at the
moment of sale, and "who is owed a visit" is a query rather than an
investigation.

**Billing and delivery are separate schedules.** A customer can pay monthly and
be visited twice a year. Tying visit generation to billing is the obvious
shortcut and breaks the moment somebody prepays annually.

**Money billed is not money earned.** Twelve months collected up front is a
liability that unwinds as visits are delivered. Recognising it on receipt
shows a spectacular month followed by eleven months of servicing work with no
revenue attached to it. Billing an agreement credits deferred revenue, not
revenue; delivering a visit moves one slice across.

**The price is frozen at sale, and so is the discount.** Raising a plan's
price must not reprice four hundred existing members, cutting its discount
must not cut theirs mid term, and retiring a plan must not orphan them. Each
agreement keeps the price, the discount rate and the billing frequency it was
sold with, renewals included.

**An edit reaches who it says it reaches.** A plan can be edited, and what an
edit reaches differs by field on purpose: the price, the discount and how
often it bills reach new sales only; the term, the number of visits and their
months reach new sales and each member's next term when it renews (a term
already written owes what it owed); the perks (priority dispatch, the waived
diagnostic fee, the waived after hours rate, the benefit list) are the
company's standing promise and are read from the plan when used, so they
reach every member the moment they are saved. The plan screen says this
beside each part of the form, with how many members are on the plan.

**Amounts are allocated, never divided.** A term price split across twelve
instalments by dividing and rounding each one leaves cents unbilled, and those
cents sit in deferred revenue forever with nothing to release them. The same
argument applies to the recognition slices.

**Seasonal plans pin to months.** A heating tune up belongs in autumn
regardless of when the agreement was sold, so a plan can anchor its visits to
months rather than counting forward from the sale date.

**A renewal is a new term of the same agreement, and owes what a sale owes.**
Its visits, its instalments and the deferred revenue behind each are written
down when it renews, by the same code that writes a sale's. The new term starts
the day the old one ends, whenever the renewal happens, so a member renewed a
fortnight early keeps the fortnight they paid for. Earlier terms stand: a visit
owed last year and never had is still owed.

**The price survives a renewal too.** A renewal keeps the agreement's own
price unless a person types a new one, because a renewal that picked up the
plan's new price would be a price rise four hundred members never agreed to,
applied on one night by a worker.

**Both switches have to say yes.** A plan says whether it is sold as renewing;
each agreement says whether this member agreed to that, and cancelling turns
it off. The worker renews only when both do.

**The notice is owed once per term, and a refusal is a record.** A plan says
how many days before the end a member is told. The notice goes once, through
the same consent and suppression rules as every other message, and when it
cannot go (no number, or they replied STOP) the reason is kept on the
agreement and the office is handed a task to tell them another way. A sweep
that only recorded successes would try somebody who said STOP on every pass for
a month.

**What a term owed and the member never took is earned when the term ends.**
A visit not taken by the end of a term is still paid for, and the company
stood ready to deliver it all year, so on the day the term ends the deferred
revenue behind it (breakage) moves to revenue. Never before the end: a visit
skipped in March can be put back in June, and revenue recognised in March for
it would need reversing against a closed month. This is an accounting
treatment chosen on purpose, the conservative one: at the end of the term,
whole slices, never pro rata and never on a guess about who will not call.
The visit itself stays owed, and doing it later earns nothing more.

**A discount can leave things out.** A plan that discounts labour and not
equipment names the price book categories (everything filed under them,
however deep) and single items its discount does not touch. What it leaves
out is part of the discount, so it is frozen on each agreement at sale like
the rate. A waived fee is still waived wherever it is filed, because that is
a separate promise the plan makes.

**A member discount is a per line discount, never a hidden one.** When a job
or an estimate is priced for a customer holding a running agreement whose plan
carries a discount, the rate comes off each eligible line as part of that
line's own discount, and the line records how much of its discount was the
plan and which agreement gave it. Per line rather than a separate discount
line because a line's discount is what every total, the conversion to an
invoice and the ledger already carry: it posts to the discounts account with
revenue at the full price, exactly as a discount somebody typed does. A
negative line would be a price below zero that reduces revenue instead of
showing the discount, and would have to be kept in step with the lines it was
worked out from on every edit.

## Setup

Define a plan on `/agreements/plans`: a name, a price, how often it bills, how
long the term is, and how many visits it includes. Seasonal plans tick the
months those visits belong in and may name a day of the month. Member
benefits, the reason anyone renews, sit on the plan: a discount on work (typed
as a percentage on the screen), priority dispatch, a waived diagnostic fee, a
waived after hours rate, and a list of anything else in the company's words.
Whether it renews on its own, and how many days' notice a member is owed
before the end of a term, sit there too. `POST /v1/agreement-plans` defines
one over the API, where a discount rate is a fraction: 0.15 is fifteen per
cent, and 15 is refused rather than guessed at.

Under "Not discounted" on the same form, tick the price book categories and
pick the single items the discount leaves out; over the API it is
`discountExclusions`, two lists of ids, each checked to be in this company's
price book. A plan that promises priority dispatch can hold its own share of
each booking window ("Share of each booking window held for these members",
`memberHoldPercent`); left blank, it holds the company's figure from
`/booking`.

Each plan opens at `/agreements/plans/{id}` to edit or retire.
`PATCH /v1/agreement-plans/{id}` edits one and
`POST /v1/agreement-plans/{id}/retire` retires one. A plan is retired rather
than deleted: existing members keep their price and their term, and it can be
put back on sale.

A waived fee comes off only the price book item the company has marked as
that fee: on the item's screen, "Fee a plan can waive" says which item is the
diagnostic fee and which is the after hours rate. Nothing is guessed from an
item's name.

## Using it

### Sell one

`/agreements/new`: find the customer, then pick a plan, the address it covers
(or them at any address), the day it starts and, when a different price was
agreed, that price. Everything the agreement owes is written down in the same
transaction: every included visit with the date it is due and what it is
worth, every billing instalment, and a deferred revenue entry per visit, and
the agreement's own screen opens with all of it on.

### Deliver one

`/agreements` opens on the visits the company owes and has not booked. Booking
one makes a job worth nothing, because the customer has already been billed
for it under the agreement and putting the plan price on the job would bill
them twice. Marking it delivered is what moves its slice from liability to
revenue. A member who does not want a visit has it skipped with a reason,
which recognises nothing, and it can be put back.

On the API: `GET /v1/owed-agreement-visits` is the owed list,
`POST /v1/agreement-visits/{id}/book`, `POST /v1/agreement-visits/{id}/deliver`,
`POST /v1/agreement-visits/{id}/skip` and
`POST /v1/agreement-visits/{id}/unskip`. Each is idempotent: a retry with the
same key gets the first answer back, so a lost response never books a second
job or recognises a slice twice.

### Bill one

An instalment becomes an invoice whose posting credits deferred revenue rather
than revenue. A plain invoice here is the single most common way this module
is got wrong in the products contractors already use.
`POST /v1/agreement-instalments/{id}/invoice` is the same over the API, and
needs `invoice:write`.

### Renew one

The agreement's own screen says whether it will renew on its own, whether its
notice has gone and what was said back, and renews it by hand with an optional
new price. `POST /v1/agreements/{id}/renew` is the same from the API. An active
or lapsed agreement can be renewed; a cancelled one cannot, because selling a
new one keeps the reason it was cancelled on the record.

The worker does the rest on each pass, in the company's own calendar: on the
end date it renews an agreement whose plan and member both said so, marks the
others lapsed (which is what the "their plan lapsed" campaign audience reads),
inside the notice window it sends the notice the plan owes, and for every term
that has ended it releases the breakage (below).

### Word the renewal notice and choose how it goes

`/agreements/renewals/notices` (linked from Ending soon as "Renewal notices")
holds the notice's words as four message templates: a term that renews on its
own and one that does not, each as a text and as an email with its subject.
A new company starts with the wording the product always sent, and a company
made before the templates existed sends that same wording until it saves its
own. The words may use `{{ customer.firstName }}`, `{{ company.name }}`,
`{{ plan.name }}`, `{{ plan.termMonths }}`, `{{ agreement.renewsOn }}`,
`{{ agreement.lastCoveredDay }}` and `{{ agreement.price }}`; anything else is
refused when it is saved. The same screen chooses how the notice goes: by text
first (email when they cannot be texted, which is what it always did), by
email first (text when they have no email), or both. Whichever goes first,
the other is tried when it cannot go, and when nothing can go the office gets
its task as before. `GET /v1/agreement-renewal-notices` and
`PUT /v1/agreement-renewal-notices` are the same, under `settings:read` and
`settings:write`, the permissions every message template is under.

### What happens when a term ends: breakage

On the day a term ends, whatever its visits never taken still hold deferred
(owed and never booked, booked and not delivered, or skipped, and for a plan
with no visits the whole term's price) is moved from deferred revenue (2400)
to agreement revenue (4100) in one balanced posting sourced to the term. It
happens when the worker renews an agreement on its end date, when a person
renews one on or after the end, and on the worker's pass for every other
term that has ended: lapsed ones, and the old term of one renewed early, on
its own end date. Each term is released once: it is claimed by its own row
before anything is posted, so two passes cannot post it twice, and a term
with nothing left (every visit taken, or a cancellation that already released
it) is marked done at nothing. The agreement's screen lists its terms under
"Terms" with what each released and when, and `GET /v1/agreements/{id}`
carries the same as `terms`. Delivering a visit whose term has been released
recognises nothing more, because it is already earned.

`/agreements/renewals` is what ends in the next 30, 60 or 90 days, soonest
first, with the ones that lapsed in the last month on top.
`GET /v1/agreement-renewals` is the same list.

### Price work for a member

Nothing to do. An estimate written with `POST /v1/estimates`, an invoice raised
with `POST /v1/invoices` and a draft saved again are priced for a member as
they are written: the customer's best running agreement at that address (or
one sold with no address) that carries a discount, at the rate frozen on the
agreement when it was sold, or whose plan waives a fee, applied to each line with
a positive price that is not itself a discount item, the membership's own
price or a manual adjustment. Taken off what is left after any discount
somebody typed, rounded to the cent on each line. Each line shows it, with the
plan's name, on the estimate and the invoice, and the composer says before the
save that the customer is a member. `GET /v1/customers/{id}/member-pricing` says
whether it would apply. A hand typed discount is still checked against the
company's discount limit; the member discount is not, because the company made
that decision when it set the plan's rate.

What the plan leaves out is left out everywhere the discount is taken: an
estimate, an invoice raised in the office or on a technician's phone (the
server sends the phone the excluded items as one list, because the phone
carries the price book without its categories), and the composer's note and
`GET /v1/customers/{id}/member-pricing` say it by name (`leavesOut`). The
customer's own account page says the discount and what it leaves out. A job
billed by payer (M31) takes the plan's discount off the customer's own part,
at our price, and nothing off a third party's part, which its own authority
prices; the preview shows it on the customer's part and the invoices, the
discount and the tax still add up to the job.

### Sell and read the book from the API

`POST /v1/agreements` sells one, writing down everything the first term owes.
`GET /v1/agreements` lists the book (by status or customer),
`GET /v1/agreements/{id}` is one agreement with every visit, every instalment
and what is still unearned, and `GET /v1/agreement-plans` and
`GET /v1/agreement-plans/{id}` read the plans.

### What a member gets besides the discount

A plan that waives the diagnostic fee takes the whole of the item marked as
the diagnostic fee off each estimate and invoice for a member, as that line's
member discount naming the plan; the after hours rate the same. A plan whose
only benefit is a waived fee still makes the customer a member for this. A
customer on two plans gets the better plan's benefits (the higher rate, then
the more waivers), never a mix of two. The proposal and the invoice say
"waived for members" on the line.

A plan that promises priority dispatch puts a member's unassigned work at the
top of the unassigned pile on `/schedule`, under the same cover rule as the
discount (running on the day, at the address it covers), with the plan named
on the card. Nothing is booked, moved or reassigned for them: the pile is what
a dispatcher works down, and their card is first. "Suggest who" places a
member's visit before anybody else's, so the cheapest gap on the day goes to
them, and names the plan; the rebalance places them first in the pile too.

It also reserves capacity. On `/booking`, under Held for members, a company
holds a share of each arrival window back from anybody who is not a member,
until a set number of hours before the window opens
(`GET /v1/booking/member-hold` and `PUT /v1/booking/member-hold`, with
`booking:configure` to change it). That figure is the default: each plan can
hold its own share instead, set on the plan, and the screen lists every plan
that promises priority with its share. A window keeps back the largest share
any live plan holds, and a member is let into as much of it as their own
plan holds, so a plan holding a third and one holding a tenth both mean what
they say. The share is of what the window holds with
nothing booked, rounded to whole jobs with a half rounded down, so a quarter
of a window two technicians could fill with eight one hour jobs keeps two
back. Members' own work in the window uses the held share first. The public
page never offers the held share; a member offers themselves it from their
own account (at an address their plan covers) and when they ask to move a
visit from their link. Nothing is held while no live plan promises priority,
and the screen says so.

The office is held to it too. Booking a job by hand on `/jobs/new`, or adding
a visit on a job, into an arrival window whose remaining room is held from
this customer (not a member there that day) is refused in words naming the
window, until the person booking ticks "Book anyway" (`bookAnyway` on
`POST /v1/jobs` and `POST /v1/jobs/{id}/visits`). Then it is booked and the
audit log records `visit.booked_into_member_hold` with their name, the day
and the window. A window already full for everybody is not the hold, and the
office stays free to overbook it as before; a job made from a booking request
was held to the share when the request was made and is not asked again.
"Rebalance several days" keeps it as well: a visit for somebody no plan lets
into the hold is moved into a window on another day only while that window
has room outside the hold, counting every visit the plan moves in.

The phone assistant, the chat on the website and by text, and the intake
agent (M27) know a member by how they reached the company: the number a call
or text comes from, or a number or email a website visitor writes in the
chat, matched to a customer holding a running plan that promises priority.
Such a member is offered their plan's share of what is held, as their own
account would offer it, and their booking request may go into it. A number
can be borrowed and an email typed by anybody, so nothing is said about it:
the assistant is never told there is a membership, a plan or an account, and
the caller hears nothing the existing intake flow did not already say. The
office is told, on the call's record of what the assistant did, in the chat
agent's log line for the booking, and on the intake draft.

### Cancel one

From the agreement's screen, or `POST /v1/agreements/{id}/cancel`. The reason
is required: a cancellation with none is indistinguishable from a
mistake, and the reason is the whole of a win-back campaign. Whatever has been
billed and not earned is released, either to revenue if the company keeps the
prepayment or back to the customer if it does not. Leaving it sitting in
deferred revenue forever, which is what doing nothing amounts to, is the one
answer that is wrong either way.

## Permissions

| Role | Access |
|---|---|
| owner, admin | Everything |
| office manager | Sell, book, deliver, cancel |
| accountant | Read, and the unearned balance |
| dispatcher, csr, technician | Not by default |

`membership:read` sees the book and the ending soon list. `membership:write`
defines plans, sells, renews and cancels. The renewal notice's words and how
it goes are company settings: `settings:read` to see them on
`/agreements/renewals/notices`, `settings:write` to change them. Invoicing an instalment additionally
needs `invoice:write`. Whether work is priced as member work is readable with
`customer:read`, because the technician quoting at the kitchen table needs to
know the customer is a member and does not need the agreement book to find out.

## API

| Call | Needs |
|---|---|
| `POST /v1/agreement-plans` | `membership:write` |
| `GET /v1/agreement-plans` | `membership:read` |
| `GET /v1/agreement-plans/{id}` | `membership:read` |
| `PATCH /v1/agreement-plans/{id}` | `membership:write` |
| `POST /v1/agreement-plans/{id}/retire` | `membership:write` |
| `POST /v1/agreements` | `membership:write` |
| `GET /v1/agreements` | `membership:read` |
| `GET /v1/agreements/{id}` | `membership:read` |
| `POST /v1/agreements/{id}/renew` | `membership:write` |
| `POST /v1/agreements/{id}/cancel` | `membership:write` |
| `GET /v1/owed-agreement-visits` | `membership:read` |
| `POST /v1/agreement-visits/{id}/book` | `membership:write` |
| `POST /v1/agreement-visits/{id}/deliver` | `membership:write` |
| `POST /v1/agreement-visits/{id}/skip` | `membership:write` |
| `POST /v1/agreement-visits/{id}/unskip` | `membership:write` |
| `POST /v1/agreement-instalments/{id}/invoice` | `invoice:write` |
| `GET /v1/agreement-renewals` | `membership:read` |
| `GET /v1/customers/{id}/member-pricing` | `customer:read` |
| `GET /v1/agreement-renewal-notices` | `settings:read` |
| `PUT /v1/agreement-renewal-notices` | `settings:write` |

The book's unearned total across every agreement is on the `/agreements`
screen and not on the API; one agreement's is on `GET /v1/agreements/{id}`.

## Common questions

**Why is the job worth nothing?** Because the customer already paid for it
under the agreement. Anything extra the technician sells on that visit goes on
the job as normal.

**What happens on the last visit of a term?** The deferred balance reaches
zero, which is how you know the allocation was right. The next term, when it
renews, has its own visits and its own deferred revenue.

**Does a renewal charge anybody?** Not by itself. It writes the new term's
instalments, and an instalment is billed the way every instalment is, which
posts to deferred revenue rather than revenue.

**Why did a member not get their notice?** The agreement says, in words, and
there is a task in the office queue for it: no number or email on the
customer, or they replied STOP. A notice that went the second way says so
("Sent by email. Not texted: ...").

**Why did revenue go up the day a plan ended?** That is breakage: the money
for visits the member never took, counted as earned on the last day of the
term, on the agreement's Terms list. If they ring later, the visit is still
owed and can be done; it adds nothing more to the books.

**Can a member pay annually and be visited monthly?** Yes. That is the whole
reason the two schedules are separate.

## What is not built

A member discount is taken off a contract rate card price as well as off the
price book. The waived fees are applied only to a price book item marked as
that fee; a fee typed onto a line by hand is charged, and a line typed by hand
is never left out of the discount, because nothing says what it is. What the
discount leaves out is chosen from every category and the first two hundred
items still sold on the plan screen; a bigger book is left out by category.
The perks are read from the plan when they are used rather than frozen on the
agreement, so turning one off takes it from existing members at once; the
screen says so, and freezing them is a decision nobody has made. Moving a
visit to another time by dragging it on the board is not held to the share
kept for members; booking a job or adding a visit is, and so is the several
day rebalance. The assistants know a member only by the number they ring or
text from or a number or email written in the chat, never by a name they say,
and that match proves nothing about who is asking: it changes which windows
are offered and nothing else. A breakage release is reached by the worker's
pass or by a renewal; a term is not released by any screen. Terms of an
agreement sold before terms were recorded, other than its current one, have
no end date written down and are never released. Prorating a cancellation to
the day, rather than releasing whole undelivered slices, is a decision nobody
has made.
