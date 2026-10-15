---
title: Customer Portal and Online Booking
module: M05
domain: Customer
phase: 2
status: partial
---

# Customer Portal and Online Booking

> Module M05. Domain: Customer. Ships in phase 2.

## What it does

Lets a customer approve a quote, track a visit, pay an invoice, put down a
deposit and see their whole account, without creating an account. Lets a
customer who comes back sign in with a code sent to the email or mobile
number the company has for them (or a contact the office lets sign in as
them, with their own), save a card or a bank account, pay with it, and add a
tip for the technicians. Shows them the work itself, laid out the way their
trade's pack says: the service reports, the products used, readings over
time, the equipment at the house, the notes the office shared. And lets a
stranger on the company's website, or a returning customer asking for the
technician who came last time, book a slot somebody is actually free for.

## The problem

Identity. A homeowner will not create an account to approve a quote, and a
platform that insists on one loses the approval. Every other design in this
space either sends a PDF and asks for a reply, or builds a login nobody uses.

The second problem is availability. A booking widget that offers times the
company cannot actually serve is worse than no widget: every overbooked slot
costs a reschedule call and the trust that came with it.

## Key concepts

**A grant is a capability, not a session.** A single purpose, scoped, expiring
token that says what its bearer may do and to which record. It cannot be
widened, it cannot be enumerated, and it does not survive the thing it was
issued for. Six scopes and no seventh: one estimate, one job, one invoice, one
deposit, one booking request, or the whole customer view.

**Only the hash is stored.** The plaintext exists exactly once, in the link
that was sent, so a grant leaked from a database backup is useless. The same
treatment sessions and credentials get, for the same reason.

**A use cap exists because the failure mode differs by scope.** An approval
link forwarded to a whole family is fine. A payment link forwarded to a whole
family is not.

**The subject comes from the grant, never from the request.** There is no id in
any portal input that a caller could change to reach another record. That is
structural rather than a matter of remembering, which matters because none of
these endpoints has an actor to check a permission against.

**Resolution runs through a security definer function.** The lookup has to
happen before the organization is known, so it cannot go through row level
security. The function takes a 256 bit hash the caller must already hold and
returns one row or none, so it cannot enumerate anything. Everything after
resolution runs inside the tenant boundary as a synthetic actor scoped to the
resolved company, so a bug in a handler cannot reach across tenants even if it
tries.

**A sign in is a customer scope grant held in a cookie.** No password, ever.
A customer types the email or mobile number on their record and gets a six
digit code through the company's own email or text sender; typing it back
opens a customer scope grant that names the code that opened it. Everything
true of the account link is true of it, because it is the same capability
resolved by the same function. What sets it apart is where it lives (an
HttpOnly cookie scoped to the company's portal pages, never a URL) and that
only it may save a card or open one of the customer's own records as a
narrower link: a link can be forwarded, and a code went to an address on the
customer's own record.

**A code says nothing to a stranger.** Asking for a code for an address
nobody has gets the same answer as asking for one on file. A wrong code, an
expired one, a spent one and one for an address nobody has all get the same
refusal. A code lives ten minutes, works once, dies after five wrong tries
and is ended by a newer one. Only a salted hash of it is stored, which stops
it being read off the table and does not stop six digits being worked out
from the hash: the expiry, the single use and the attempt limit are what make
it safe. Asking is counted per address (three in fifteen minutes, ten a day)
and per network address (ten an hour), and checking is counted per network
address, before anything is sent.

**A contact signs in as the customer, never as themselves.** The office
turns it on contact by contact (`contact.portal_access_at`), only for a
contact on the customer rather than at one address, because a tenant at
one door is not somebody who should see the landlord's bills. The code goes
to the contact's own email or mobile number; what they reach is the
customer's account, exactly as the customer would; and everything they do
there is recorded as them: the grant carries the contact
(`portal_grant.contact_id`), and every audit line written under it names
them (`audit_log.actor_contact_id`), including on a narrower link opened
from their sign in. Taking their access away ends their sign ins at once.

**The office sees sign ins and can end them.** Every code asked for is
kept with the customers the address was on at the time, so a failed try
shows on the customer it was aimed at, and what became of the message is
kept beside it. Ending a sign in revokes the grant, which is all a sign in
is, so the next page the customer opens asks for a code.

**A bank payment is on its way, not arrived.** A saved bank account is
debited through ACH: the processor accepts it at once and says days later
whether the money came. In between it is pending: the attempt is
`in_flight`, the invoice stays open with the payment shown as on its way on
both the office's screen and the customer's account, and the invoice cannot
be paid again by any path until the processor answers. Nothing is booked
until it says succeeded, and then it is booked as a bank payment (`ach`).
If it fails, nothing was booked, the customer's account says so with the
bank's reason, and the office queue gets a task saying what happened and
what to do. If a bank returns one after it was booked, the payment is
reversed through the refund path (the invoice reopened, the cash taken back
out of the books), marked failed, and the office is told the same way.

**What a customer sees is laid out by their trade.** A trade pack declares
its portal blocks; applying the pack seeds them as the company's portal
layout, and the account page draws whatever the layout says in its order:
a pest control customer sees what was applied first, a lawn customer the
season's visits. A few things every account shows whatever the trade (what
is coming, the service history, the bills, the plan and the equipment) are
added after the layout's own blocks when it leaves them out, unless the
office hid them on purpose; the bills are shown whatever. The office
arranges, hides and retitles the blocks from that start (see "Arrange what
the customer sees"), and a pack upgrade keeps what it did. What each
block shows is only what the company chose to show: published service
reports and their customer visible fields, never the technician's own notes;
a visit's notes only as the office shared a copy of them; photographs by the
same rule as the job link.

**A booking grant precedes its customer.** It is the one case where a grant has
no customer on it: somebody has asked for work and nobody has confirmed it yet.
They still want to see that something happened, and the gap before a human
looks at it is exactly when they want it most. Confirmation fills the customer
in.

**Offered availability is derived, never typed in.** What a company configures
is the shape of what it is willing to sell: which job types are bookable, in
which territories, how far ahead, how much notice, how many per window. The
engine intersects that with business hours (the week of the branch the
booked job lands in, or the company's for a branch that keeps none, M02; a
booking request for a weekday that week keeps closed is refused in words),
the company's holiday list
(no window on a date it is closed, and on a short day only the windows that
start and end inside that day's hours), and with the technicians' own
days, as the dispatch board has them: who is working, who has approved time
off touching the window, who is qualified for the job type's skills on each
day shown (the same check the board's drop makes, asked again from the day
after a certification expires), and how much of each person's window the
visits already on their day take up, each from when it is due to arrive for
its estimated length. Every kind of day counts: a crew's visit is on every
member's day, a route's stops are laid end to end in route order from the
start of the day with the route's declared drive between them (the drive
is busy time too), and a rental's drop or collection counts against
whoever drives it, or as work waiting for somebody when nobody does yet. Each person fits as many more of the job type's usual
length as their free time holds, and work already asked for and not yet on
anybody's day (unassigned visits, booking requests waiting to be booked,
customers' asks to move into the window) comes off the total first. The per
window limit stays as a ceiling: it is how many the company will sell
online, which can be fewer than it could staff. The slot is re-checked
inside the transaction that writes the request. A company with no
technicians recorded at all has no board to read, and then the limit is all
there is. A company whose plans promise priority dispatch can hold a share
of each window back for members until a set time before it opens (M08): the
public page is offered what is left, and a member booking from their own
account, or asking to move a visit from their link, is offered the held
share too when their plan covers the address. Each plan can hold its own
share, the company's figure being the default; a member is let into as much
of what is held as their own plan holds.

**A resubmission inside a short window is the same submission.** Long enough to
cover a phone that lost signal mid-request and somebody who gave up and refilled
the form; short enough that the same household booking the same service for the
same window a season later is the second booking it actually is. Swallowing that
one would be worse than the duplicate, because nobody would find out the work
had been requested.

## Setup

`/booking` is where a company says what the public may book: the services, the
arrival windows it is willing to offer, and which days it is open. All three
need `booking:configure`. The public widget is served at `/book/{slug}`. The
days it closes for a holiday, or opens shorter, are on `/settings/holidays`
(M02), changed with the same permission; a booking request for a date that has
since gone on the list is refused in words, as a full window is.

`/settings/portal` shows the address customers sign in at (`/portal/{slug}`),
turns tipping on and sets the suggested percentages, turns bank payments on,
and chooses whether customers see every job photograph or only the ones
somebody chose. Reading it needs `settings:read` and changing it
`settings:write`. Every choice starts off. Bank payments also need ACH
Direct Debit turned on in the company's own Stripe account.

What a customer's account shows comes from the company's trade pack, seeded
when the pack is applied (`/setup`), and the office arranges it at
`/settings/portal/layout`. Signing in needs an email provider or a registered texting number
connected, because that is how the code is sent.

## Using it

### Hand a customer a link

`POST /v1/portal/grants` issues one, with `portal:grant`.
`POST /v1/portal/grants/{id}/revoke` withdraws it, with `portal:revoke`, which
is a separate permission because a technician may hand out a link and may not
take one back.

Sending an estimate issues the grant as part of sending, so the normal path is
`POST /v1/estimates/{id}/send` rather than minting one by hand.

### What the customer opens

| Link | What it is |
|---|---|
| `/e/{token}` | One estimate, to read, approve or decline |
| `/j/{token}` | One job: status, arrival window, who is coming, and while they are on the way their ETA and a moving pin |
| `/i/{token}` | One invoice, with a card if the company has connected Stripe |
| `/pay/{token}` | One deposit, asked for by an approved estimate |
| `/b/{token}` | One booking request, before anybody has confirmed it |
| `/c/{token}` | The whole account: visits, documents, agreements, history |

### Sign in

`/portal/{slug}` is the sign in page. `POST /v1/public/portal/{organizationSlug}/codes`
sends the code and `POST /v1/public/portal/{organizationSlug}/sign-in` checks
it and returns the session token; the web page puts that in a cookie. An
address on more than one customer record is answered with the records by
name and first address, and the same code is sent again with the one chosen.
`POST /v1/portal/sign-out` ends the session everywhere.

`/portal/{slug}/account` is the signed in account: the same view the account
link draws (`GET /v1/portal/account`), with the customer's homes, their work,
what is coming, what is owed and paid, estimates, plans and the statement at
`/portal/{slug}/account/statement`. A visit is moved or cancelled from
`/portal/{slug}/account/change/{visitId}`, exactly as from the account link.
Each estimate, job and invoice opens on the page made for it (approve, track
with photographs, pay) through `POST /v1/portal/account/open`, which mints a
link for that one record for one day; an estimate's is spent by approving,
like one the office sends. Every link a customer was ever sent keeps working
without signing in.

### See who signed in, and end a sign in

`/settings/portal/sign-ins` lists every code asked for at an address on
somebody's record, newest first: who it was for, whether the message went
and if not why, whether it signed in, was typed wrong, was killed by five
wrong tries or was replaced by a newer one, and from which network address.
The customer's page (`/customers/{id}`) shows the same for them under
**Portal sign ins**, with who is signed in now (the customer, or which
contact), until when and from where, and **Sign them out**.
`GET /v1/portal-sign-ins` and `GET /v1/customers/{id}/portal-sessions` need
`portal:read`; `POST /v1/customers/{id}/portal-sessions/end` needs
`portal:revoke`.

### Let a contact sign in as the customer

On the customer's page, **People** offers **Let {name} sign in** for a
contact on the customer with an email or mobile number, and **Stop {name}
signing in**, which ends their sign ins too. It is
`POST /v1/contacts/{id}/portal-access` and needs `customer:write` and
`portal:revoke`. The contact signs in at the same `/portal/{slug}` with
their own address and sees "Signed in as" with their name.

### The sign in page shows the company's look

`/portal/{slug}` shows the company's logo and colour, served by its public
key: `GET /v1/public/portal/{organizationSlug}/branding` returns the name,
the colour, the colours readable on it and whether there is a logo, and
nothing else; `/portal/{slug}/logo` serves the logo.

Every page a customer opens from a link or their sign in (the estimate, the
job, the invoice, the account and its statement) carries the company's logo
and, under it, the phone, email and postal address the company set in
Settings (M02), the phone and email as links that ring and write. The sign in
page by slug does not carry them: it is the public face, and what it returns is
the name, the colour and the logo.

### Save a card and pay with it

From the signed in account only. `POST /v1/portal/card-setup` starts Stripe's
own setup flow, the browser collects the card in Stripe's element, and
`POST /v1/portal/card-setup/confirm` records it once the setup has been read
back from Stripe and found to have succeeded for the Stripe customer made for
this customer. The card number never reaches this server; the brand, the last
four digits and the expiry are all that is kept. `GET /v1/portal/cards` lists
them, `POST /v1/portal/cards/{cardId}/remove` tells Stripe to forget one and
then marks it removed, and `POST /v1/portal/cards/{cardId}/pay` pays one
invoice with it, confirmed on the spot. The invoice still changes only when
Stripe's signed webhook says the money moved. A card pays only invoices the
signed in customer is the one paying.

### Let the company charge a saved card, and pay bills automatically

Under each saved card or bank account, a signed in customer has **Let
{company} charge Visa ending 4242 for my bills**. It shows the exact words
they are agreeing to (the company may take what a bill says they owe without
them pressing Pay, they get a receipt each time, and they can stop it at any
time), a box to tick and **Agree**. The words go back with the yes
(`POST /v1/portal/cards/{cardId}/agreement`), are built again on the server
for that card and must match, and are kept with the time, the sign in, the
contact when a contact signed in as the customer, and where they agreed
from. A link is refused: only the customer's own sign in can agree.

Once agreed, **Pay my bills automatically with Visa ending 4242** offers its
own words in the same way (`POST /v1/portal/cards/{cardId}/autopay`). A
customer can keep agreements on several cards, and one of them pays
automatically: when another card already does, the button says **Pay my bills
automatically with Visa ending 5556 instead of Visa ending 4242**, the page
says the first card stops paying automatically and can still be charged as
agreed, and choosing it moves paying automatically to the new card in one
step. **Stop paying automatically** and **Stop
{company} charging Visa ending 4242** (`POST
/v1/portal/cards/{cardId}/agreement/withdraw`) end them at once. Removing the
card ends its agreement too. `GET /v1/portal/cards` says, for each card,
whether it is agreed and the words that would be agreed to. What the office
can then do, and what paying automatically does when a charge fails, is M13.

An agreement the office recorded for them (a phone call, or a signed form,
below) shows in the same place. Under the words it says how it was given, the
day, and the first name of the person who took it ("Agreed by phone on Oct 5,
2026, taken by Sam. You can stop this at any time."), and **Stop {company}
charging Visa ending 4242** ends it exactly as it ends their own. The
scanned form is the company's: the customer's page says a form is kept
(`hasForm`) and never serves or names the file. They can turn paying
automatically on over it, in its own words, as over their own.

### Record a card authorization for a customer

A customer who agrees on the phone, or on paper, to be charged on a card
they saved can have that recorded by the office, on their page under
**Cards on file** (`/customers/{id}`, for somebody who holds `payment:read`;
the forms only for somebody who holds `payment:charge_saved`, the permission
that charges the card: owner, administrator, office manager and accountant,
never a technician or a CSR). The card must already be saved, because only the
customer saves one, from their own account: a card number never reaches this
server and the office cannot type one in. A customer with no saved card
shows **They have not saved a card**.

Each saved card says whether it is agreed and, when it is, who gave it, how
(**Agreed by phone**, **Agreed on a signed form** or **Agreed in their
account**), the day, who took it, and the words. A card with none offers two
forms:

- **Record an agreement taken by phone** shows the product's phone script to
  read out, word for word ("{Company} would like to charge your Visa ending
  4242 for bills you owe them, without you pressing Pay each time ... Do you
  agree?"). The office ticks that they read it and the customer said yes, and
  gives the day.
- **Record an agreement on a signed form** shows the words the form must
  carry (the same words the customer would tick in their account), asks for
  the day they signed and the scan, and records it only with the scan. A form
  is a PDF or a photograph; anything else is refused where every upload is.

Both are `POST /v1/customers/{id}/card-agreements`, with the card, the way
(`phone` or `signed_form`), `agreedOn` (the company's day: not in the future
and not before the card was saved) and the words, which are built again on the
server and refused when they are not the product's for that card and way. The
company cannot edit the words, any more than the portal's. A signed form's scan
is sent with the call (`form`, base64) or is a file already uploaded to the
customer through `POST /v1/attachments` (`formAttachmentId`); it is kept as a
document on the customer and the agreement points at it, and one scan stands
behind one agreement. Without it, a paper agreement is refused by the service
and by a check on the table. A card that already has a live agreement is
refused: the customer's own stands, and the office cannot record a second one
over it.

The agreement is a row in the same `payment_agreement` records as the
customer's own, with `given_by` set to the office, the person who took it
(their name as it was, kept on the row), the day, and the form. It is what
the invoice's **Charge** button looks for, and it says on the invoice how it
was given. The audit log carries `card_agreement.recorded` with the person.
`GET /v1/customers/{id}/card-agreements` (`payment:read`) lists the cards and
their agreements with the words for each way.

When the customer rings to stop, **They asked us to stop** records it
(`POST /v1/customers/{id}/card-agreements/{agreementId}/withdraw`, also
`payment:charge_saved`): the agreement and paying automatically end at once, the
person who took the request is named in the audit log, and the agreement and
its form are kept. Withdrawing what is already withdrawn changes nothing.

### Pay from a bank account

When the company has turned bank payments on, a signed in customer's saved
cards offer **Save a bank account** too: Stripe's own window, where they
sign in to their bank to check the account (`POST /v1/portal/card-setup`
with `kind: "bank_account"`, then the same confirmation as a card). Only the
bank's name and the last four digits are kept. Paying from it is the same
`POST /v1/portal/cards/{cardId}/pay`, carries the customer's agreement to
that one debit (where they were and on what), and answers `processing`.
`GET /v1/bank-payments` (`payment:read`) is the office's read of what is on
its way and what failed this month; the invoice page shows the same, with
**Payment on its way** beside its status. The customer's invoice link
(`/i/{token}`) says "Payment on its way" with the amount and the day, and
offers no second way to pay until the bank answers. Reminders and the
collections agent leave the invoice alone meanwhile (M13).

### What the customer sees of the work

The account page (`/c/{token}` and `/portal/{slug}/account`) draws the
company's portal layout (or, for the members of a plan with a page of its own, the plan's), then the work, estimates, deposits and homes. The
blocks: what is coming, the service history (every past visit with the
technician's first name, the notes the office shared and the published
report), the latest reports with the products used and their EPA
registration numbers, readings over time for the keys the pack names, the
equipment at the house with its details (a filter size, a tonnage), the last
visit's checklist, photographs, documents, invoices, payments received, the
plan and its visits, what the technicians flagged, a referral link and who
to call. Readings are one series per reading per unit (the superheat on the
upstairs system and on the downstairs one are two), each drawn as a line over
time above the table of its values once it has two days of them; the line is
the reports' own chart (M21), drawn on the server. Photographs on the account are served through the same link at
`/c/{token}/photos/{id}` and `/portal/{slug}/account/photos/{id}`.

The company's own records about the customer (a permit, a warranty
registration) are a read only block per kind, after the layout's blocks,
only for a kind the office turned on for customers, and showing each record's
name and only the fields marked for the customer. Which records are about
them, and how a field is marked, is M29's.

### Documents the customer can open

The **documents** block (**Your documents** unless the office retitles it, in
the layout below) lists, read only: their statement; each **signed estimate**
as a PDF (one they approved, approved or since turned into a job, printed as the
proposal with who approved it and when; a waiting, declined or expired one has
no signed copy, and the route refuses it: `/c/{token}/estimates/{id}/pdf`,
`/portal/{slug}/account/estimates/{id}/pdf`); each **invoice** as a PDF (not a
draft, not a cancelled one: `/c/{token}/invoices/{id}/pdf`); the published
service reports; and the **files the office marked** for them.

On the job's page, under **Files**, the office adds a PDF or a picture to the job
(`document:write`, as `POST /v1/attachments` does) and chooses **Show the
customer** or **Stop showing the customer** on it: the same switch as a
photograph (`POST /v1/attachments/{id}/customer-sharing`, `servicereport:publish`).
Every file is private until it is marked, and, unlike photographs, the
company's setting to show every photograph never shows a file. Only a document
on a job or one of its visits can be marked; a signature and a file on
anything else are refused. A marked file is served at `/c/{token}/files/{id}`
and `/portal/{slug}/account/files/{id}`, under the type it was sniffed as when
stored, sandboxed and never cached; an unmarked file, a file on someone else's job,
a photograph asked for as a file, a file removed since and a made up id are all
the same 404. The block only carries files when the layout has it, and a
company that hides it sends none.

### Send the company a photo or a PDF

A signed in customer has **Send us a photo or a PDF about a job** under
**Your work**, which opens `/portal/{slug}/account/your-files`: a picture of
the broken unit before the visit, the warranty card. They choose the job, or
one of its visits still to come, and the file. `GET /v1/portal/files` is what
the page reads and `POST /v1/portal/files` sends one, from a sign in only:
an account link can be forwarded, and whoever it reaches should not be able
to put files on somebody else's job.

The job and the visit are checked against the customer the sign in names,
so another customer's job, another company's job and a made up id are the
same not found. A cancelled job, or a visit that was called off, is refused
in words. The file is held to the rules a reply by email is held to
(`files.checkCustomerUpload` in core): a program is refused by its name, its
claimed type or its bytes, so a program renamed `.jpg` is refused; it must be
a photo (JPEG, PNG, HEIC, WebP) or a PDF by its bytes; up to 5 MB a file, up
to 10 files and 25 MB on one job (the job and its visits together); and 20
an hour for one customer, counted before the file is looked at, so a refused
try counts too. A photo over 5 MB is made smaller in the browser before it is
sent. It is kept through `files.put` like every other file, as an attachment
of its own kind (`customer_file`) carrying the customer and, when a contact
signed in as them, the contact; the audit log has `attachment.customer_added`
under the sign in. The same bytes sent twice to the same place are one file.

The office sees it on the job's page under **Files**, **From the customer**,
with whether anybody has opened it yet. The technician sees it on the visit
on their day (`/my-day`, **From the customer**), and it comes to the phone
with the visit (`customerFiles` on each visit of `GET /v1/field/snapshot`)
for anybody who may read documents, as thumbnails that open full size and PDFs
that open in the phone's reader, read from `/files/{storageKey}` with the phone's
own sign in (M11). A customer's file is never shown back on
the job link or in the account's photographs or documents, and it cannot be
marked for the customer: they already have it.

The customer can take a file back (**Take it back**,
`POST /v1/portal/files/{id}/remove`) until somebody at the company has opened
it. Opening it from the job's page records who opened it and when
(`attachment.seen_at`, and `POST /v1/attachments/{id}/seen` with
`document:read` for anybody using the API); from then it stays with the job,
and the page says so. A file the office added is never theirs to remove, and
is the same not found as a file that does not exist.

### Chat with the company from the account

A signed in customer opens "Chat with us" on their account page
(`/portal/{slug}/account/chat`) and writes to the company. It is the same
conversation the office answers in the inbox: a chat on the customer's own
record (kept per customer, or per contact signed in as them, and carried on each
time they come back), with "Chat from their account" as its subject. Who is
writing is the sign in, never what is typed: nobody gives a name, and nothing is
matched by a phone number or guessed from the words. A reply written in the inbox
appears on the customer's open page, which asks again every few seconds.

The company's automated chat assistant answers here only when the company ticked
"Customers signed in to their account" on the chat assistant's settings (off
until somebody does, a separate decision from the website) and the assistant is
on with a person to act as, as on the website. It says it is automated first,
hands over on the website's rules, knows the customer from the sign in and never
asks their name or contact details, and takes a booking request only for them:
their name, phone and email come from their record whatever it was told, and the
address has to be one on their record. Once a person has the conversation the
assistant stays out of it. With the assistant off, every message waits for a
person: unread in the inbox, with a task ("Dana Cedar wrote from their account")
when the conversation goes from read to unread, so it is noticed once rather than
once a message. Twelve messages a minute and sixty an hour per customer.
`GET /v1/portal/chat` and `POST /v1/portal/chat/messages`, from a sign in only.

**Pictures.** A customer adds up to three photos to a message (**Add photos**
on the chat page, or `pictures` on `POST /v1/portal/chat/messages`), with words
or alone. They are held to the rules a file added to a job is held to: a photo
(JPEG, PNG, HEIC or WebP) by its bytes, never a program by name, claimed type or
bytes, five megabytes in all in a message, a day's total of 25 MB, and the
same twenty an hour, counted before anything is looked at, that a file added to a
job counts against. Any picture refused refuses the whole message and nothing is
written. A message with a picture always goes to a person, with the task and the
unread mark, because the assistant cannot see a picture and does not answer one.
The office sees the picture in the thread (the inbox's own picture route), and
answers with pictures of its own from the same reply box (JPEG, PNG or GIF,
three at most and five megabytes together, the same as a picture text). A website
chat still takes words only. The customer's page draws a picture a browser can
draw (HEIC is kept and offered as **Open the photo**), served at
`/portal/{slug}/account/chat/pictures/{message}/{position}` from the sign in
cookie and `GET /v1/portal/chat/pictures/{messageId}/{index}`: asked for by message
and position, never by the file's storage key, and only for a message in the
customer's own conversation, so another customer's, a position with nothing kept
and a made up id are the same not found.

**Telling the customer the office answered.** When somebody in the office
answers a chat from a customer's account, the customer is told by email or text
(the way their main contact prefers, text first when that is "text", the other as
the fallback) with a link to `/portal/{slug}/account/chat`. The message names
the company and carries none of the answer. It goes through the gates every
message goes through: a text through the consent decision and the STOP list and
never inside the company's quiet hours (the email goes instead when there is one),
an email through the company's email connection. A contact who signed in as
themselves is told at their own address or number and never the customer's. It is
sent once until the customer has read it: opening the chat page, or writing in
it, marks it read (`ai_chat_session.customer_read_at`), and nobody is told again
until that is later than the last notice. A customer who had the chat open in
the last half minute is not told, because the page asks every five seconds and
already shows them. What happened is written on the chat ("Told by text.", "Told
by email (Not texted: they replied STOP...)", or why nobody could be told) and
shown above the thread in the inbox and as `customerNotice` on
`GET /v1/conversations/{id}`. It is never an error for the person replying: the
reply is sent whatever happens to the notice.

**A notice held by quiet hours goes when they end.** When the only way to tell
the customer was a text (they have no email address, or the email could not go
either) and the company's quiet hours stopped it, the notice is kept
(`ai_chat_session.customer_notice_held_at`), and the chat says "Waiting for your
quiet hours to end" with the rest of the reason. The worker looks every minute
and, once the hours have ended, asks everything again as it stands that morning:
the number and consent, the STOP list, the setting, whether the customer read the
chat. It is then sent exactly like any notice, once, and "Told by text." replaces
the waiting line. It is not sent when the customer opened the chat meanwhile
(**Not told: they read the chat before your quiet hours ended.**), when the
company turned the notice off, when a STOP or a missing number now stops it, or
when it has waited more than two days because the worker was down or the window
was long (an answer that old is not news). Any of those is written on the chat
and the notice is not tried again by itself. Several answers in one night are one
notice, and it is still once until they read it. Only a text stopped by the hours
is kept: a number that replied STOP, or no number or address at all, is the same
tomorrow, and is written on the chat as before. A customer who taps the link without being signed
in goes to the sign in page (`/portal/{slug}?next=chat`) and, once in, to the chat
itself; nothing but that one name is read from the address. The customer's account page marks
what is waiting: **Chat with us (1 new answer)** and a line saying the company
answered, from `GET /v1/portal/chat/unread` (asking does not mark anything read).
The notice is on for every company until somebody turns it off at **Chat
answers** on `/settings/portal` (`chatReplyNotice` on `PATCH /v1/portal-settings`,
`settings:write`).

**Closing the chat.** **Close this chat** on the chat page (`POST /v1/portal/chat/close`,
from a sign in only) ends the conversation the customer has open, whoever has it, the
assistant or a person. The customer's page shows "You closed your last chat. Write below
to start a new one." and an empty thread; the next message they write opens a new
conversation, with the assistant's greeting again when the assistant answers, and the
closed one is left exactly as it was. In the inbox the conversation is closed, the
thread says "The customer closed this chat on {day and time}. If they write again, it
opens a new one." (`customerClosedAt` on `GET /v1/conversations/{id}`), the list marks it
**Closed by the customer** (`closedByCustomer` on `GET /v1/conversations`, which also
answers `status=closed`), and a reply into it is refused in words, because a reply would
have nowhere to go. Closing hides nothing from the office: what the customer wrote stays
unread, and its task stays open, until a person opens the conversation, so a customer who
writes "the furnace is out" and closes the page is not lost. Closing marks the chat read,
drops a notice that quiet hours were holding for it, and writes `portal.chat_closed` on the
audit log naming the sign in (and the contact, when a contact signed in as the customer).
Closing a chat that is closed, or before there was one, changes nothing. Twelve a minute
per customer, like writing.

### Readings in a narrow band

A reading is drawn from zero unless the trade says otherwise. A trade pack can
name, in the readings block's `narrow` setting, the readings that live in a
band (a water pressure between 55 and 65 psi, a soil pH, a supply voltage):
those are drawn on a scale that starts at the data, with a break in the axis,
"Scale starts at 50, not zero" on the chart, the same in its description for a
screen reader, and a line of words under it. It is the trade's call per
reading and not the customer's or the company's: an amount, or a reading nobody
named, is drawn from zero, and the table under the chart has the exact values
either way. The plumbing, lawn and landscape and electrical packs name their
pressure, temperature, pH and voltage readings; a company whose layout was seeded
before this has the setting only after it applies the pack's newer layout. The
same chart is the one the office's reports draw, where a line of a plain number
offers **Around the data** (M21).

### Share a visit's notes with the customer

On the job's page, each visit with notes offers **Show the customer these
notes**: a copy of the technician's notes, edited if they need to be, which
is what the customer reads; it does not change when the phone adds to the
notes later. `POST /v1/visits/{id}/customer-notes`, with
`servicereport:publish`, the same decision as publishing a report.

### Arrange what the customer sees

`/settings/portal/layout` (**Arrange what customers see on their account** on
`/settings/portal`) lists every block the account page could show, in the
order it draws them: the ones the trade pack seeded first, then the rest,
hidden. The office moves a block up or down, unticks **Show**, and types a
heading of its own; **Save layout** is `PUT /v1/portal-layout`
(`settings:write`), and `GET /v1/portal-layout` (`settings:read`) is the read.
Every block is named on save, so what is saved is the whole page. The bills
cannot be hidden, because customers need to see what they owe; they can be
moved and renamed. A heading left as the usual words is stored as none.

It is saved on the layout the page reads first: the one the company's
primary trade pack seeded, or, for a company with no pack, a layout of the
company's own, which a pack applied later does not push aside. A trade pack
upgrade (M02) never writes over it: the layout no longer says what the pack
set up, so the upgrade keeps it and lists it as the company's, and only a
company that changed nothing takes the pack's new layout.

### A page of their own for the members of a plan

A company can give the members of one agreement plan a different account page
from everyone else's. On `/settings/portal/layout`, a line under the heading
lists **Everyone** and each plan's **members** (with **(own page)** beside the
ones that have one); choosing a plan opens the same editor
(`/settings/portal/layout?plan={planId}`). A plan with no page of its own shows
the company's, and the first **Save layout** gives it one, starting from the
company's as it stands (the readings a trend block shows come with it) and
saved whole: every block named, in order, shown or not, with a heading or none.
The bills still cannot be hidden. **Use the company's page for this plan**
takes it away, and its members see the company's page again from their next
visit.

Who sees it: a customer with an active or past due agreement on the plan. A
pending agreement has not started, and a paused, lapsed or cancelled one is no
longer a membership, so those customers see the company's page. A customer
on several plans that have a page of their own lands on the page of the plan of
their oldest active agreement, so the page does not change from one visit to
the next, and is offered the others: a line under their name, **Your plans**,
lists each plan by name (one entry for a plan however many agreements they hold on
it, oldest agreement first) with the one they are on marked, and choosing another
opens that plan's page with its own blocks, order and headings
(`/c/{token}?plan={planId}`, `/portal/{slug}/account?plan={planId}`, and `plan` on
`GET /v1/portal/account`, which also gives `extras.pages` and `extras.page`).
Which page they last looked at is not remembered: the next visit lands on the
oldest agreement's again. They are offered the line only when there is a choice,
that is two or more plans of theirs with a page; a second plan with no page of
its own is the company's page, which they are not offered, since it is not a
plan's. The plan in the address only chooses among their own pages: another
company's plan, a plan they are not a member of, a plan whose page was taken away
and a made up id all draw the page they would have had, and say nothing about it,
so the address cannot be used to read a plan's page they are not a member of.
Everything else on the account that is not a block (the plans' visits, the
agreements, the invoices) is the customer's whole account on every page. Everyone
else sees the company's layout, and a customer's page is
drawn the same way at `/c/{token}`, `/portal/{slug}/account` and in
`GET /v1/portal/account`. A plan's page is never the company's default and
never a trade pack's, so a pack upgrade never reads or writes it and the
company's page is read without it.

`GET`, `PUT /v1/agreement-plans/{id}/portal-layout` and
`POST /v1/agreement-plans/{id}/portal-layout/remove` do it (`settings:read`,
`settings:write`, `settings:write`), and `GET /v1/portal-layout/plans` lists the
plans with whether each has a page of its own and how many members it has now.
Another company's plan is not found. The audit log carries
`portal.plan_layout_changed` and `portal.plan_layout_removed` with the person.

### Book from the account, with the technician who came before

A signed in customer has **Book a visit** at
`/portal/{slug}/account/book`: a service, one of their own addresses, and
optionally one of the technicians who have been to them before, by first
name. Asking for somebody shows only that person's free time.
`GET /v1/portal/booking`, `GET /v1/portal/booking/availability` and
`POST /v1/portal/booking`, from a sign in only. What it writes is a booking
request already carrying the customer, the property and the technician
asked for; booking it with its visit puts that technician on it when they
are still free and qualified on the day, and on the board for anybody
otherwise. The account shows it under **Visits you asked for** until then.

### Tip the technicians

When the company has turned tipping on, paying an invoice from the portal
(the invoice link, the account link or the signed in account) offers the
suggested percentages of the balance and a box for any amount, for the
technicians named by first name. M13 says what a tip is on the books.

### See the job's photographs

While the technician is on the way, after they texted that they are, the job
link shows their first name, their photo when the office set one (served
through the link at `/j/{token}/technician-photo`), how long until they
arrive, and a pin where they are, read every twenty seconds from
`/j/{token}/live` (`GET /v1/portal/job/live`). Only positions taken for this
visit since the text, and none at all once they have arrived. See M09 and the
location section of M11.

The job link (`/j/{token}`) shows the job's photographs the company chose to
show, or every one when it shows them all, served through the same link at
`/j/{token}/photos/{id}`. Never a signature, never another job's, never a
private one by guessing its id. A photograph is chosen on the job's page with
**Show the customer**, which is `POST /v1/attachments/{id}/customer-sharing`
and needs `servicereport:publish`, because showing a customer what a
technician recorded is the same decision as publishing their report.

### Ask to move or cancel a visit

From a job link or the account link, a customer looking at a visit still to come
can ask to move it or to cancel it. `/j/{token}/change` is the job link's next
visit and `/c/{token}/change/{visitId}` is one visit on the account.

It is a request, never a move. A visit on the board has a technician and a route
the customer cannot see, so asking writes a request, raises it in the office
queue with the customer's reason, and changes nothing about the visit. A move is
chosen from exactly the windows online booking would offer for that kind of
work, from the same function: the company's notice period, open days, per window
limit and service area. A window a customer has asked for counts against that
limit for the next person, as a booking request does. A job whose type is not
bookable online cannot be moved from the link, and the page says to reply
instead; it can still be cancelled. A cancellation needs a reason. One request
per visit at a time.

`GET /v1/portal/visit-change` is what the page reads and
`POST /v1/portal/visit-change` is the request, both reached by the link.

The office answers from the job or from the queue. `GET /v1/visit-change-requests`
is the list, and `POST /v1/visit-change-requests/{id}/approve` and
`POST /v1/visit-change-requests/{id}/decline` are the two answers, behind
`visit:reschedule`. Agreeing to a move checks the window is still open, moves
the visit, takes it off the technician's day and puts it back on the board for
the new day; agreeing to a cancellation cancels it. Either way the customer is
told, by text where they can be texted and by email otherwise, and the request
records whether they were.

### Offer a different time

Answering a request to move, the office can offer another time instead of
the one asked for, chosen from the same windows online booking would offer
for that work. `GET /v1/visit-change-requests/{id}/times` lists them
(`visit:read`) and `POST /v1/visit-change-requests/{id}/propose` sends one
(`visit:reschedule`), with words of the office's own. Nothing moves. The
customer is sent the time and a link to the visit's change page, and the
request is `proposed`: the time is held against its window while they
decide, the request's task is closed because the office has answered, and
no new request can be made about the visit until they reply. They answer
from the same link, or from the link the offer came with, or signed in:
`POST /v1/portal/visit-change/answer`. Yes (`accepted`) moves the visit to
that time exactly as agreeing to their own request would, off whoever had
it and back on the board, and raises a task for the office to put somebody
on it. No (`turned_down`) leaves the visit where it was and raises a high
task to talk to them. A yes is taken without checking the window again,
because the company made the offer; it is refused only when the visit has
started or the time has passed. On the job's page and in the queue, the
request shows "Offer this time instead" beside the two answers.

### Take an offer back, or offer another

While the customer has not answered, the job's page shows the time offered
with **Take this time back** and a box for what to tell them
(`POST /v1/visit-change-requests/{id}/withdraw`, `visit:reschedule`). The
visit stays where it was, as it did all along; the time stops being held
against its window; the customer is told, by text where they can be texted
and by email otherwise, with the office's words; and the request is
`withdrawn`. Their link then says the company took the time back and the
visit stays where it was, and a yes sent to it is refused in words. Taking
back one already taken back changes nothing. An offer the customer already
took is refused, because the visit has moved: moving it again is done on the
board, which tells them. One they turned down has nothing to take back.

After the customer turns an offer down, or the office takes one back, the
job's page shows the request again with **Offer this time**, from the same
windows (`GET /v1/visit-change-requests/{id}/times` lists them for such a
request too, and `POST /v1/visit-change-requests/{id}/propose` sends it). It
is the same request offering again: the customer is sent the new time with
the link, the high task to talk to them is closed with what was offered,
their earlier answer is cleared from the request and kept in the audit log
(`visit_change.proposed_again`, with the request as it was), and they answer
it as they answered the first. An old request is not offered on once the
customer has asked something new about the visit: the new request is the one
to answer.

### Take a booking from the website

`GET /v1/public/services` and `GET /v1/public/availability` are read by a
stranger, so they resolve the company from its slug rather than from a session
and return nothing about anybody. `POST /v1/public/bookings` writes the request.
Those three, the portal reads and M19's website and lead form routes are the
only routes in the product with no permission.

The booking page keeps a visitor id in the browser so the visit and the booking
are one history. When the link came from the company's own website carrying the
snippet (M19), the snippet's visitor id arrives as `otv` and the page keeps that
one, so the visits on the company's site and the booking join. A link carrying
a customer's referral code (`ref`) credits the booking to that customer's
referral, and confirming it records who referred the new customer.

### A customer's referral link

The account page (`/c/{token}`) shows the customer their own referral link and
code, what the company gives for a referral when it gives something, and the
first names of the people they have sent. `GET /v1/portal/referral` is what it
reads, by the account link and nothing else.

### Decide a request

`GET /v1/bookings` is the queue, at `/booking`.
`POST /v1/bookings/{id}/confirm` turns it into a job and needs both
`booking:decide` and `job:write`, because it is both decisions.
`POST /v1/bookings/{id}/decline` is the other half.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything, including what the public may book |
| Office manager | Decides requests, configures booking, issues and revokes links, sees and ends sign ins, chooses which contacts may sign in, and charges a saved card the customer agreed may be charged |
| CSR | Reads and decides requests. Issues a link. Sees sign ins and failed codes |
| Dispatcher | Reads and decides requests |
| Technician | Issues a link, so the customer approves on their own phone |
| Accountant | Neither |

A technician holds `portal:grant` and not `estimate:approve`, deliberately:
handing somebody a link to approve on their own phone is a different act from
approving on their behalf. Nor `portal:read`: which addresses a customer signs
in from, and which codes failed, are the office's business.

## API

| Call | Needs |
|---|---|
| `GET /v1/portal/session` | nothing: the token is the authority |
| `GET /v1/portal/estimate` | nothing |
| `POST /v1/portal/estimate/approve` | nothing |
| `POST /v1/portal/invoice/pay` | nothing |
| `POST /v1/portal/grants` | `portal:grant` |
| `POST /v1/portal/grants/{id}/revoke` | `portal:revoke` |
| `GET /v1/public/availability` | nothing |
| `POST /v1/public/bookings` | nothing |
| `GET /v1/portal/visit-change` | nothing |
| `GET /v1/portal/referral` | nothing: the account link is the authority |
| `POST /v1/portal/visit-change` | nothing |
| `GET /v1/visit-change-requests` | `visit:read` |
| `POST /v1/visit-change-requests/{id}/approve` | `visit:reschedule` |
| `POST /v1/visit-change-requests/{id}/decline` | `visit:reschedule` |
| `GET /v1/visit-change-requests/{id}/times` | `visit:read` |
| `POST /v1/visit-change-requests/{id}/propose` | `visit:reschedule` |
| `POST /v1/visit-change-requests/{id}/withdraw` | `visit:reschedule` |
| `POST /v1/portal/visit-change/answer` | nothing: the link or a sign in is the authority |
| `POST /v1/public/portal/{organizationSlug}/codes` | nothing: counted per address and network address |
| `POST /v1/public/portal/{organizationSlug}/sign-in` | nothing: the code is the authority |
| `POST /v1/portal/sign-out` | nothing: a sign in |
| `GET /v1/portal/account` | nothing: a sign in or the account link |
| `POST /v1/portal/account/open` | nothing: a sign in only |
| `GET /v1/portal/cards` | nothing: a sign in only |
| `POST /v1/portal/card-setup` | nothing: a sign in only |
| `POST /v1/portal/card-setup/confirm` | nothing: a sign in only |
| `POST /v1/portal/cards/{cardId}/remove` | nothing: a sign in only |
| `POST /v1/portal/cards/{cardId}/agreement` | nothing: a sign in only |
| `POST /v1/portal/cards/{cardId}/autopay` | nothing: a sign in only |
| `POST /v1/portal/cards/{cardId}/agreement/withdraw` | nothing: a sign in only |
| `GET /v1/customers/{id}/card-agreements` | `payment:read` |
| `POST /v1/customers/{id}/card-agreements` | `payment:charge_saved` |
| `POST /v1/customers/{id}/card-agreements/{agreementId}/withdraw` | `payment:charge_saved` |
| `GET /v1/portal-layout` | `settings:read` |
| `PUT /v1/portal-layout` | `settings:write` |
| `GET /v1/portal-layout/plans` | `settings:read` |
| `GET /v1/agreement-plans/{id}/portal-layout` | `settings:read` |
| `PUT /v1/agreement-plans/{id}/portal-layout` | `settings:write` |
| `POST /v1/agreement-plans/{id}/portal-layout/remove` | `settings:write` |
| `POST /v1/attachments/{id}/customer-sharing` | `servicereport:publish` (a photograph, or a file for the documents block) |
| `GET /v1/portal/files` | nothing: a sign in only |
| `POST /v1/portal/files` | nothing: a sign in only, counted per customer |
| `POST /v1/portal/files/{id}/remove` | nothing: a sign in only |
| `GET /v1/portal/chat` | nothing: a sign in only (asking marks the chat read) |
| `POST /v1/portal/chat/messages` | nothing: a sign in only, counted per customer |
| `POST /v1/portal/chat/close` | nothing: a sign in only, counted per customer |
| `GET /v1/portal/chat/unread` | nothing: a sign in only |
| `GET /v1/portal/chat/pictures/{messageId}/{index}` | nothing: a sign in only, a message in the customer's own chat |
| `POST /v1/attachments/{id}/seen` | `document:read` |
| `GET /v1/portal-sign-ins` | `portal:read` |
| `GET /v1/customers/{id}/portal-sessions` | `portal:read` |
| `POST /v1/customers/{id}/portal-sessions/end` | `portal:revoke` |
| `POST /v1/contacts/{id}/portal-access` | `customer:write`, `portal:revoke` |
| `GET /v1/public/portal/{organizationSlug}/branding` | nothing: the public mark only |
| `POST /v1/visits/{id}/customer-notes` | `servicereport:publish` |
| `GET /v1/bank-payments` | `payment:read` |
| `GET /v1/portal/booking` | nothing: a sign in only |
| `GET /v1/portal/booking/availability` | nothing: a sign in only |
| `POST /v1/portal/booking` | nothing: a sign in only |
| `GET /v1/portal-settings` | `settings:read` |
| `PATCH /v1/portal-settings` | `settings:write` |
| `GET /v1/bookings` | `booking:read` |
| `POST /v1/bookings/{id}/confirm` | `booking:decide`, `job:write` |
| `PUT /v1/booking/hours` | `booking:configure` |

## Common questions

**What happens when a link expires?** The page says so and offers nothing. A
new one has to be issued, which is the point: a link that outlives its purpose
is a standing credential.

**Can a customer pay without Stripe connected?** No. The invoice page shows the
balance and tells them to reply to arrange payment, because there is no other
way to pay from it and pretending otherwise wastes their time.

**Does a booking request hold a deposit?** No. There is no customer yet to hold
one for.

**A customer says the code never arrived.** Open them and look under
**Portal sign ins**, or `/settings/portal/sign-ins`: each code asked for says
whether the message went and, if not, why. A code goes only to the email or
mobile number on the customer record, or on a contact the office lets sign
in, and an address that replied STOP or bounced is not written to.

**A bank payment failed. What now?** The invoice is still open, nothing was
booked, the customer's account says it did not go through and why, and the
office queue has a task naming the customer, the amount, the invoice and the
bank's reason. Ask them for another way to pay.

**Can somebody in the office see a sign in code?** The text or email it went
out in sits in the conversation log like any other message, so whoever may
read messages can read it while it is still good, for ten minutes. Whoever
may issue links (`portal:grant`) can already open the customer's account,
so this is not a wider door, and it is said here rather than hidden.

## What is not built

A customer signs in with a code and nothing else: there is no password and
no account creation, so somebody not already a customer cannot sign in, and a
customer with neither an email nor a mobile number on their record (or on a
contact the office lets sign in) cannot be sent a code. Ending a sign in
leaves the one day links a customer opened from it working until they run
out. Cards and bank accounts are saved through Stripe only; no other
processor's adapter holds either, and a bank account is verified only by the
customer signing in to their bank, never by micro deposits. A customer saves a card only from
their own sign in, so the office can record an agreement to be charged on file
(phone or signed form) only for a card the customer has already saved, and
cannot record one for a card that does not exist. The product prints no form of
its own: the company's paper form has to carry the words the screen shows, and
the office confirms that it does. One scan stands behind one card. The words,
for the phone script and for the form, are the product's and the company
cannot edit them. A layout is the company's, or a plan's for its
members: it cannot differ by customer or by address, a plan's page has no schedule or start date, a customer's choice of plan page is not remembered and the company's own page is not one of the choices, a block's
settings (which readings a trend shows) are not changed on the screen, and
there is no button to go back to the pack's layout. The documents block lists the statement, signed estimates and invoices as PDFs, the published service reports and the files the office marked, and no product labels; a file is only on a job or a visit, one at a time, and the customer cannot change or remove one the office added. A customer adds a file only from their own sign in, only a photo or a PDF, and only to a job or to a visit still to come; they cannot add one to an estimate, an invoice or their account as a whole, cannot rename one, and cannot see one again once sent except by its name in their list. Adding one raises no task and sends nobody a notice: the office sees it when it opens the job and the technician on the visit. "Opened" means somebody opened it from the job's page or through the API; looking at the technician's day does not count, on the web or on the phone (the phone reads a file with its own sign in, which is not opening it from the job's page, so it never marks it seen). The readings chart starts its scale at zero unless the trade pack names the reading as one that moves in a narrow band; a company cannot change that on a screen, and a reading no pack named (a pool's pH, with no pool pack) draws as a nearly flat line; the table under it has the values. A reading
taken more than once on one day is drawn as the later one. Rescheduling
from the portal is a request the office answers, deliberately: nothing a
customer does from a link moves a visit by itself. Windows are offered by the
online booking service for the job's type, so a company that takes no online
bookings for that work cannot offer moves for it. The office can offer a
different time only for a request to move and only from the windows online
booking offers. Taking an offer back and offering again are done from the
job's page, not from the office queue, whose task after a no points at the
visit; a customer who turns an offer down is not offered another by the
product on its own, the office chooses it. Only one offer waits at a time,
and an offer the customer took cannot be taken back, only the visit moved
again on the board. Capacity lays a route's stops end to end from the start
of the day, so a route that starts later is counted as starting then; a
crew's time is counted for every member whether or not they all go.
Booking from the account asks for a technician; the office still books it,
and nothing puts it on the board until somebody does. The chat from the account
takes photos (not PDFs, which go through "Send us a photo or a PDF"), and the
customer cannot clear a chat or take a picture back, and cannot read a chat they
closed again (the office keeps it; their page starts empty). Only the customer closes
a chat: the office has no button for it, and a chat nobody closes stays open for good.
The automated assistant, once a person has answered, does not take the conversation back, and
never answers a message with a picture. The notice that the office answered is
sent once and, apart from the one quiet hours held (above), not retried on its
own: when it cannot go (a number that replied STOP and no email address, no email
or mobile number on the record, or no email connection), the reason is on the
chat in the inbox, nothing is sent later, and the next answer tries again; the
mark on the account page is the only other sign. A held notice is sent only by a
running worker: with none running, it waits. The notice does not carry
the answer, only a link. The mark is a count, not the answers; a
customer of a company that turned the notice off sees the mark and is told
nothing. It is the customer's main contact's preference that decides text or
email, not a choice the customer makes about chat alone.
Agreeing to cancel a
job's only visit cancels the visit and leaves the job as it was; whether the
work is off altogether is the office's decision on the job.
