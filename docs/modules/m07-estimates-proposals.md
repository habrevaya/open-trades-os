---
title: Estimates and Proposals
module: M07
domain: Sell
phase: 2
status: partial
---

# Estimates and Proposals

> Module M07. Domain: Sell. Ships in phase 2.

## What it does

Builds a quote with good, better and best, sends it, lets the customer choose,
sign and approve on their own phone, and turns what they took into a job and an
invoice without re-pricing anything.

## The problem

Three things go wrong with quoting in this industry and all three are expensive.

A quote that is one number gets compared to the cheapest number somebody else
said. Options are how a contractor sells the right repair instead of the
cheapest one.

An approval nobody can tie to a document settles nothing. "They approved it" is
worth very little when the question is what they were looking at when they did.

An invoice that disagrees with the approved quote, even by a cent from a tax
rate that changed overnight, is the fastest way to lose a customer who was, a
moment ago, happy.

## Key concepts

**Options, with optional lines priced separately.** Good, better, best, and
within each of them the things a customer can tick or leave.

**Sending freezes the document.** Two things happen together or neither is worth
anything: what will be rendered is hashed, and the customer is issued a single
use grant to approve it. The plaintext token exists exactly once, in the return
value, so a leaked database backup contains no working links.

**The hash deliberately excludes anything the office can change afterwards
without the customer seeing it, and deliberately includes every figure they were
shown.** A disagreement later about what was agreed is answerable from that and
unanswerable from a picture of a name.

**The signature records the hash, the address and the moment.** Not an image on
its own.

**Conversion is a copy, not a re-price.** Every line carries its frozen price
book version and the tax rate as applied straight onto the invoice, and nothing
is looked up again. Only the lines the customer actually took are copied: an
optional line they left unticked was priced, shown and declined, and billing it
is the worst version of this mistake.

**Expiry is a nudge, not a cliff.** An expired estimate can still be decided
from, because a company that would happily honour a three week old quote should
not have to rebuild it because a timestamp passed on a Sunday. What expiry does
is stop it counting as open pipeline.

**The worker marks an estimate expired.** Once an estimate's "Good until" date has
passed in the company's own calendar (it is good through the end of that day where
the company is, not at seven in the evening because UTC rolled over), the worker's
pass sets its status to `expired`, writes `estimate.expired` to the audit log, and
goes on to the next. It looks only at estimates that are `sent` or `viewed`: a
customer has them and has not answered. A draft has not gone anywhere, so its date
has not started running, and an approved, declined or converted estimate is a
decision that a date on the paper does not undo, so none of those is selected or
touched, whatever their date says. It is idempotent: an estimate it has marked is
not selected again, so a pass repeated, or two workers at once, marks each one
once and writes one audit line. The pass goes round at most once a minute and asks
the database first which companies hold such an estimate at all
(`app.estimate_expiry_organizations`, which skips a suspended company).

What `expired` does is what the rest of the product already said it did, now that
something sets it. It leaves the unsold list (which reads the date itself as well,
so it is right between passes and when the worker is not running) and the
"estimate nobody answered" follow up stops chasing it. It shows as Expired on the
estimate, the estimate list and the customer's page, and the estimate's page says
it was good until the date and what that means. Financing is not offered on it
(the portal's pay over time and the office's both already refused an expired
estimate). It can still be approved, declined and sent: the customer's link, the
office's "record a yes", a deposit and the phone's sell on site all still work, and
an estimate sent after its date goes out as `expired`, not `sent`, so it is never
open for the minute before the worker takes it back out.

**A draft can be approved, for the sale that happens at the kitchen table.** A
technician builds the options on a tablet, turns it around, and the customer says
yes; nothing was ever sent, and requiring a send first would mean recording a
fake one. The portal cannot reach a draft in any case, because sending is what
issues the grant, so that only widens the office path.

**How the yes arrived is asked for, not inferred.** "The customer said yes on the
phone" and "the customer clicked approve" are different evidence, and a company
deserves to know which one it has.

**A discount has a ceiling, and the ceiling is a different permission from the
discount.** `estimate:discount` applies one; `estimate.discount.unlimited` goes
above the configured cap. The cap itself is declared with `settings:write`,
because holding the authority to apply a discount is not the authority to decide
how large a discount anybody may apply: letting those be one permission means
everybody who can discount can raise their own ceiling, which is the same as
having no ceiling.

**Taking the cap away puts the company back to nobody being authorised to
discount.** It is soft deleted rather than removed, so the previous limit stays
readable as the record of what was authorised when an old estimate was written.

## Using it

### Build and send

`POST /v1/estimates` with the options and lines. `/estimates/new` is the office
form. Its sales tax is the company's rate for the customer and address on the day
it is written (M13), on the taxable lines, unless a rate is typed on the form
(`taxRate`) or one of the company's rates chosen (`taxRateId`); a typed rate that
matches one of the company's is recorded as that rate. An estimate the field
assistant or an inspection's deficiency drafts takes the same rate. The rate on
each line goes onto the invoice it converts to as signed, and issuing that
invoice never second guesses it. `POST /v1/estimates/{id}/send` freezes it, issues the approval link and
puts it in front of the customer, and needs `estimate:send` with
`portal:grant`, because it is both.

Sending takes a channel. `email` composes an email in the company's colour
with the link and a line from whoever is sending, and `sms` a short text that
opens with the company's name; both go through the same consent, suppression
and sending number checks as every other message, and both land in the
customer's conversation in `/inbox`, so a reply arrives beside the estimate
it answers. `both` sends the email and the text at once, carrying one link, to
the customer's own address and number; it is refused with a typed address and
for a customer missing either. `link` only issues the link, for handing over
another way. A send
the transport refuses (they replied STOP, no consent, no email sender
connected) is recorded with the reason in words and changes nothing else: the
estimate keeps its status, the link the customer already holds still works,
no `estimate.sent` is emitted, and the screen says "not sent" in red. A send
that goes withdraws every earlier link. By email and text at once, a refused
text beside an email that went is a send that went, with the refusal on its
own row and said on the screen. Each attempt is a row with what
became of it (queued, sent, delivered, bounced, refused), read from the
message rather than stored: `GET /v1/estimates/{id}/deliveries`, and the
"Sent" list on the estimate's screen. The send form on `/estimates/{id}`
offers email, text, both at once (only when the customer has both, and then
as the default) and the link, and takes a different address or number for a
send by one channel.

### The proposal

Every estimate is a branded proposal the customer can read and print:
`/estimates/{id}/proposal` in the office and `/e/{token}/proposal` from the
customer's own link, both drawn from one function so they cannot disagree.
The company's logo, colour and name come from Branding, with its phone, email
and postal address under the name when the company has set them (M02); the
options sit side
by side, the recommended one first and edged in the company's colour; with two
or three options each is named Good, Better or Best by its price (never by
its position, and not at all when two cost the same or there are four or
more); each line says any member discount and the plan that gave it, and a
waived fee says it was waived; optional extras are listed under the option
with whether they were taken; the terms are printed below; and there is a
line to sign, or who signed and when once it is approved. Printing is
reading: the customer's copy peeks at the link rather than spending it. No
cost or margin can appear, because the document is built from what a
customer may see rather than by removing what they may not.
`GET /v1/estimates/{id}/proposal` is the same document, and it is a PDF file
too: `/estimates/{id}/pdf` from the office and `/e/{token}/pdf` from the
customer's link, laid out by the server rather than the browser, every option
with its lines and total.

### Lay the proposal out your way

`/estimates/templates` holds the company's proposal layouts: a cover with a
headline, a sentence and a photograph, then sections in the order it sells in,
chosen from about us, the options, the warranty, financing, what customers said
(the company's own reviews at or above a rating, with words in them), the terms and
sections of its own. `/estimates/templates/{id}` edits one: each section's kind,
heading, words and position, the cover and its photograph, whether each option shows
its photographs, which job type it starts estimates for, and whether it is the
default. The options must be in a layout, and once; every problem with a layout is
said at once when it is saved. Designing them needs `settings:write`, like the terms.

A new estimate starts in its job type's layout, or the default, or the plain one
(the options, then the terms), and it keeps a COPY, like the terms: editing a layout
changes the estimates it is applied to from then on, and none it was already on. The
"Proposal layout" panel on a draft estimate applies another or goes back to the
plain one, and puts photographs on each option. Both are refused once the estimate
has been sent, because sending froze what the customer reads. The office's proposal,
the customer's `/e/{token}/proposal` and the PDF all draw the same sections in the
same order, with the cover first; the PDF prints a JPEG or a plain PNG and says so
in a line where a photograph is a kind it cannot print. Each proposal's photographs
are served only through that proposal.

`GET /v1/proposal-templates`, `POST /v1/proposal-templates`,
`PATCH /v1/proposal-templates/{id}`, `DELETE /v1/proposal-templates/{id}` and
`POST /v1/proposal-templates/{id}/cover` are the same, and
`POST /v1/estimates/{id}/proposal-template`, `POST /v1/estimate-options/{id}/photos`
and `DELETE /v1/estimate-option-photos/{id}` act on a draft estimate.
`GET /v1/estimates/{id}/proposal` carries the layout.

### Terms

`/estimates/terms` holds the company's own small print, and every estimate
copies it when it is written, so changing it never changes what a customer
already signed; the approval hash covers the copy. The approval page shows
the terms beside the approve button. Reading them is `estimate:read`;
changing them is `settings:write`, like the discount limit.
`GET /v1/proposal-terms` and `PUT /v1/proposal-terms` are the same, and an
estimate written with `POST /v1/estimates` can carry its own terms or none.

### Let the customer decide

They open `/e/{token}`, pick an option, tick or untick the optional lines, and
approve or decline. `POST /v1/portal/estimate/approve` is the same action from
the customer's side and takes no permission: the token is the authority.

### On the technician's phone

A technician builds good, better and best on the phone or on `/my-day` from
the price book it carries, with the member's discount taken off as they
build, turns the screen to the customer, and the customer chooses, ticks the
extras they want and signs on the glass. It travels through the field queue
(M11), so it works with no signal: the estimate is written with the ids the
phone made and the price book versions it priced from, and the approval
names the option, the extras and the total the customer was shown. The
server works the option out again and records the approval only when the two
agree to the cent, through the same decision the customer's own link makes,
recorded as given in person, with the drawn signature's id and the moment it
was drawn. A no is recorded with the customer's reason.

Taking the customer's signature this way is `estimate:present`, which the
technician preset holds, and only for a visit on the technician's own day.
It records the customer's own yes, which is why it is not `estimate:approve`.

### Record a yes that happened elsewhere

`POST /v1/estimates/{id}/approve` with `estimate:approve`, which is a narrower
permission than writing an estimate.

### Start an automation on a decision

Approving emits `estimate.approved`, from the customer's link and from a yes
the office records alike, carrying the option chosen, the total approved and
`capturedVia` (the portal, in person, the phone). Declining emits
`estimate.declined` from either side, carrying the reason and which side said
no. Both are triggers on the `/automations` canvas and events a webhook can
subscribe to.

### Bring in history

`POST /v1/estimates` with an `outcome` records how an estimate from another
system ended: approved on a day with the option that won, declined on a day
with the reason, or expired on a day. It needs `data:import`, the date is
checked (not in the future, not before the estimate was written), and a win
must name its option. Nothing is emitted and no signature is recorded,
because loading history must not start automations or claim a signature
nobody gave. An imported win converts like any other.

### Turn it into work

`POST /v1/estimates/{id}/convert` needs `estimate:write` and `job:write`. It
produces the job and the invoice as a copy, discounts included: the invoice
carries the option's discount total as well as its total, so a converted
estimate with a discount on it posts like any other invoice when it is issued.

### Chase the ones nobody answered

`/estimates` opens on the unsold ones: sent, not approved or declined, not
expired (marked so, or past its date in the company's calendar and not yet marked), oldest first or largest first, with how long each has been out and
whether the customer has opened it. The value is the recommended option, or the
largest, never every option added up. `GET /v1/unsold-estimates` is the same
list.

Following them up is a recommended automation on `/automations`, "Follow up an
estimate that has not been answered". A new company starts with it installed
and on, waiting three days; one created before that, or one that deleted it,
turns it on there with how many days to wait. It is an ordinary automation the
company can edit or switch off from the same list: some days after an
estimate is sent, if it is still waiting for an answer, it texts the customer a
fresh link to it, emails one, and raises a call in the office queue. Sending an
estimate emits `estimate.sent`, which is what it waits from, and asking again
after the wait is what stops it when the customer approved on day two or the
office sent a revised one since. M29 has how the engine does it.

### Price it for a member

A customer holding a running agreement whose plan carries a discount is priced
as a member when the estimate is written: the plan's rate comes off each
eligible line, and each line says how much and which plan. The discount limit
below governs only what somebody types. M08 has the rules.

### Set the discount ceiling

`PUT /v1/estimates/discount-policy` declares it,
`GET /v1/estimate-discount-policy` reads it back, and
`POST /v1/estimate-discount-policy/clear` takes it away.

### Financing on an estimate

With a lender connected (M13), each option on the estimate, on the customer's
estimate link and on the printable proposal shows "as low as" a monthly figure,
always with the sentence saying it is subject to the lender's approval. The
customer applies from their link for the option they want, which does not use up
the link they approve with, or the office sends the link from the **Financing**
panel on `/estimates/{id}`, choosing the option. `GET /v1/estimates/{estimateId}/financing`
is the same over the API. A loan funded before there is an invoice is held on the
customer's account and applied when the work is invoiced.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything, including the ceiling |
| Office manager | Writes, sends, discounts within the cap, approves on a customer's behalf |
| Dispatcher | Neither |
| CSR | Reads, writes and sends |
| Technician | Reads, writes and sends, hands over a link, and has the customer choose and sign on their own screen (`estimate:present`). Does not approve on the customer's behalf |
| Accountant | Reads |

Cost and margin on an option are redacted by `job.cost:read`, which is the
reason that rule exists: a technician quotes in a driveway and the customer can
read their screen.

## API

| Call | Needs |
|---|---|
| `GET /v1/estimates` | `estimate:read` |
| `GET /v1/unsold-estimates` | `estimate:read` |
| `GET /v1/estimates/{id}` | `estimate:read` |
| `POST /v1/estimates` | `estimate:write` |
| `POST /v1/estimates/{id}/send` | `estimate:send`, `portal:grant` |
| `GET /v1/estimates/{id}/deliveries` | `estimate:read` |
| `GET /v1/estimates/{id}/proposal` | `estimate:read` |
| `GET /v1/proposal-terms` | `estimate:read` |
| `GET /v1/proposal-templates` | `estimate:read` |
| `POST /v1/proposal-templates` | `settings:write` |
| `PATCH /v1/proposal-templates/{id}` | `settings:write` |
| `DELETE /v1/proposal-templates/{id}` | `settings:write` |
| `POST /v1/proposal-templates/{id}/cover` | `settings:write` |
| `POST /v1/estimates/{id}/proposal-template` | `estimate:write` |
| `POST /v1/estimate-options/{id}/photos` | `estimate:write` |
| `DELETE /v1/estimate-option-photos/{id}` | `estimate:write` |
| `PUT /v1/proposal-terms` | `settings:write` |
| `POST /v1/estimates/{id}/approve` | `estimate:approve` |
| `POST /v1/estimates/{id}/decline` | `estimate:write` |
| `POST /v1/estimates/{id}/convert` | `estimate:write`, `job:write` |
| `GET /v1/estimate-discount-policy` | `estimate:read` |
| `PUT /v1/estimates/discount-policy` | `settings:write` |

## Common questions

**Can an estimate be edited after it is sent?** The totals are rewritten only
when the customer changes which optional lines they are taking, and nothing
recomputes on read, so the document keeps saying what it said. Changing the
substance means a new send and a new hash.

**What if the customer wants a deposit link?** An approved estimate that asks
for one hands back a `/pay/{token}` link, and a card taken there is held as a
liability until Stripe confirms it. M13 covers deposits.

**Why can a technician send but not approve?** Because approving on somebody
else's behalf is a decision about their money. Handing them a link is not,
and neither is turning the phone round so the customer chooses and signs for
themselves, which is what `estimate:present` allows.

## What is not built

The PDF's font covers Latin, Vietnamese, Greek and Cyrillic, so a letter outside
them prints as its base letter or "?", and a logo that is an SVG or a WebP is left
off it. A proposal layout
is a closed set of section kinds, one cover photograph and photographs per
option; there are no columns, fonts or per section colours, a layout cannot be
changed on an estimate once it has been sent. Sending by both channels at once goes only to the customer's
own email address and mobile number. The follow up is on from the start only for
a company created since it was; an older company still turns it on. An expired
estimate is not brought back by a later date: an estimate has no edit, so the date
it was written with is the date it expires on, and a customer who needs longer is
sent a new estimate or says yes late, which an expired estimate allows. A draft
is never marked expired, so one written with a date in the past is not either until
it is sent.
