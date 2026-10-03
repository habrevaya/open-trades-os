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
number the company has for them, save a card, pay with it, and add a tip for
the technicians. And lets a stranger on the company's website book a real
slot.

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

**A booking grant precedes its customer.** It is the one case where a grant has
no customer on it: somebody has asked for work and nobody has confirmed it yet.
They still want to see that something happened, and the gap before a human
looks at it is exactly when they want it most. Confirmation fills the customer
in.

**Offered availability is derived, never typed in.** What a company configures
is the shape of what it is willing to sell: which job types are bookable, in
which territories, how far ahead, how much notice, how many per window. The
engine intersects that with business hours, time off and what is already sold,
and re-checks the slot inside the transaction that writes the request.

**A resubmission inside a short window is the same submission.** Long enough to
cover a phone that lost signal mid-request and somebody who gave up and refilled
the form; short enough that the same household booking the same service for the
same window a season later is the second booking it actually is. Swallowing that
one would be worse than the duplicate, because nobody would find out the work
had been requested.

## Setup

`/booking` is where a company says what the public may book: the services, the
arrival windows it is willing to offer, and which days it is open. All three
need `booking:configure`. The public widget is served at `/book/{slug}`.

`/settings/portal` shows the address customers sign in at (`/portal/{slug}`),
turns tipping on and sets the suggested percentages, and chooses whether
customers see every job photograph or only the ones somebody chose. Reading
it needs `settings:read` and changing it `settings:write`. Both choices start
off. Signing in needs an email provider or a registered texting number
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
| Office manager | Decides requests, configures booking, issues and revokes links |
| Dispatcher, CSR | Reads and decides requests. Issues a link |
| Technician | Issues a link, so the customer approves on their own phone |
| Accountant | Neither |

A technician holds `portal:grant` and not `estimate:approve`, deliberately:
handing somebody a link to approve on their own phone is a different act from
approving on their behalf.

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
| `POST /v1/public/portal/{organizationSlug}/codes` | nothing: counted per address and network address |
| `POST /v1/public/portal/{organizationSlug}/sign-in` | nothing: the code is the authority |
| `POST /v1/portal/sign-out` | nothing: a sign in |
| `GET /v1/portal/account` | nothing: a sign in or the account link |
| `POST /v1/portal/account/open` | nothing: a sign in only |
| `GET /v1/portal/cards` | nothing: a sign in only |
| `POST /v1/portal/card-setup` | nothing: a sign in only |
| `POST /v1/portal/card-setup/confirm` | nothing: a sign in only |
| `POST /v1/portal/cards/{cardId}/remove` | nothing: a sign in only |
| `POST /v1/attachments/{id}/customer-sharing` | `servicereport:publish` |
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

**A customer says the code never arrived.** Check that their record has the
address they typed. A code goes only to the email or mobile number on the
customer record itself (not a contact's), and an address that replied STOP or
bounced is not written to. What happened to each request is kept in
`portal_sign_in`, including whether the message was queued and, if not, why;
there is no screen for it yet.

**Can somebody in the office see a sign in code?** The text or email it went
out in sits in the conversation log like any other message, so whoever may
read messages can read it while it is still good, for ten minutes. Whoever
may issue links (`portal:grant`) can already open the customer's account,
so this is not a wider door, and it is said here rather than hidden.

## What is not built

A customer signs in with a code and nothing else: there is no password and
no account creation, so somebody not already a customer cannot sign in, and a
customer with neither an email nor a mobile number on their record cannot be
sent a code. Contacts on a customer cannot sign in as that customer. The
office has no screen listing sign ins or sign in failures, and no way to end
a customer's sign in: it lasts its week or until the customer signs out. The sign in
page shows the company's name and not its logo or colour, because both are
served from a grant and there is none before signing in. Only cards are
saved, through Stripe; a bank account is not, and no other processor's
adapter holds cards. A saved card is used only with the customer on the page
pressing Pay: there is no charging a saved card from the office and no
automatic payment of an invoice when it is issued. A photograph is shown on
the job link and nowhere else on the account. The portal blocks a trade pack declares are data with nothing reading them yet,
so the customer view is the same shape for every trade. Rescheduling from the
portal is a request the office answers, deliberately: nothing a customer does
from a link moves a visit by itself. Windows are offered by the online booking
service for the job's type, so a company that takes no online bookings for that
work cannot offer moves for it. The office cannot propose a different time from
the request: a decline says why in words, and the customer replies or asks
again. Capacity is the per window limit online booking uses, not the
technicians' real days, which arrives with the dispatch board's own
availability. Agreeing to cancel a job's only visit cancels the visit and
leaves the job as it was; whether the work is off altogether is the office's
decision on the job.
