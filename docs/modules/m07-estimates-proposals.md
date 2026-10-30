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
invoice never second guesses it. For an estimate on a job (`/estimates/new?job=...`,
from "Write an estimate for this job" on the job's page) whose visit was booked
outside the company's hours or on a holiday, the form offers the after hours or
holiday rate with why, and a button puts it on every option; nothing adds it by itself
(M02). `POST /v1/estimates/{id}/send` freezes it, issues the approval link and
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
are served only through that proposal. A line priced from a price book version that carries an uploaded
picture (M06) shows that picture beside it on all three, and in the PDF once per option
with the line's name under it; the customer's link serves it only because a line of that
estimate was priced from that version.

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

**The job's crew hour budget comes with it.** A line says its quantity is crew hours
(people times hours) when its price book item is marked that way, which the line copies
as it is written, or when whoever typed it said so (`quantityIsCrewHours` on a line of
`POST /v1/estimates`; the tick "The quantity is crew hours" on a hand typed line of the
composer at `/estimates/new`). Converting adds up those quantities over the lines the
customer took (a required line, or an optional one they ticked, never one left alone) and
budgets the job it makes with the sum: `budgetedHours` in the response, the job's "Crew
hours" on `/jobs/{id}` saying which estimate it was added up from, and the figure staying
editable until the first punch exactly as a typed budget does (M10). A job the estimate
was already written for takes the figure only if it has no budget and nobody has punched,
so a number the office typed is never overwritten. An estimate with no crew hour lines
leaves the job without a budget. Hours more than a job can be budgeted (100,000) leave
the job unbudgeted rather than refusing the conversion.

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

### Give the customer longer

"Can you hold that price until the end of the month?" On the estimate's page,
**Give them longer to answer** takes a new **good until** date and **Why**, and
**Move the date** moves it (`POST /v1/estimates/{id}/expiry`, `estimate:write`,
which the office and technicians hold and a dispatcher or CSR does not). Only
the date changes: the options, the lines, the prices, the tax and the terms
stay exactly as they were sent, and the document the customer approves is the
one they were sent with the later date on it.

Only an estimate the customer has and has not answered: sent, opened or
expired. A draft has not been sent, so its date has not started; an approved,
declined or converted one is answered; one with no date never runs out. The
new date must be later than the one it has, from today on, and within a year
(past that it is a new estimate with today's prices). The reason, both dates,
the status before and after and the link's end are in the audit log as
`estimate.expiry_extended`, with the person. The same date again is the change
already made.

An expired estimate is open again: opened if the customer had opened it, sent
if not, so it is back on the unsold list and can be financed, and the worker
marks it expired again when the new date passes. The link it was last sent with
works until the end of the new day where the company is, when it would have run
out sooner; a link that was withdrawn (by a later send, or a send nobody
received) or used up is never brought back, and the page says to send the
estimate again for a new one.

**The follow up starts again from the new date, unless the office says not to.**
On the form, "Leave the follow up alone" is a box that is not ticked. Left
unticked, the follow up counts from the day the customer was given longer, with
the same wait it had at the send, and the page says so ("The follow up counts
its days from today."). Ticked, nothing is sent to the customer about this
estimate until it is sent again ("The follow up was left alone."). Through the
API it is `restartFollowUp` on `POST /v1/estimates/{id}/expiry`, and there it is
off when left out: a program that moves a hundred dates must ask, or it would
text a hundred customers because it forgot a flag. Two things restart, both
through the runner and the sweep that already do the chasing:

- The company's recommended follow up (M29), if it is switched on, is started
  again by the extension itself, with its own wait, the way the send started it
  the first time. The run still waiting from the send stops at its question
  ("given longer by the office since it was sent") and the new one takes its
  place. Only that follow up is started: an automation of the company's own that
  begins at a send is not run again for a date that moved. The new run stops, too,
  if the date is moved again without asking for a restart ("given longer again
  since this follow up started"), or if the estimate is sent again, answered or
  expired. `estimate.follow_up_restarted` is raised for it; it is not offered as
  a trigger on the canvas.
- The "estimate nobody answered" sweep (M29) counts its days from the day it was
  started again (`follow_up_from` on the estimate) instead of the send, and
  chases once more however many times it chased before, once for each time the
  office asks for a restart. A date moved later without asking leaves the sweep
  stopped, as it always was.

A retry of the same change starts it once. The audit line for the change
(`estimate.expiry_extended`) says whether the follow up was restarted and how
many runs it started.

**Telling the customer is a tick, off unless the office ticks it.** The office
often says it on the phone, and a program moving a hundred dates must not
message a hundred customers. On the form, "Tell the customer." (with "Tell them
by": email, text, or email and text, email when the customer has an address and
text when they do not) sends the estimate again through the estimate's own send.
That needs `estimate:send` and `portal:grant` as well as `estimate:write`, and
the form shows the tick only to someone who holds them. Through the API it is
`tellCustomer` and `tellChannel` on `POST /v1/estimates/{id}/expiry`, and the
answer's `told` says what went:

- The message is the estimate's usual one, with a line of the company's words
  above the link naming the new date ("Good news: we are holding your price
  until June 5, 2027."), and a link that works through the end of the new day.
  The link it was last sent with is withdrawn, as by any send, so the customer
  has one working link. The words are the message templates
  `estimate_extended.sms` and `estimate_extended.email` (the email's subject
  too), which a company writes through the message templates API
  (`settings:write`) using `customer.firstName`, `company.name`,
  `estimate.number`, `estimate.title`, `estimate.expiresOn` and
  `estimate.previousExpiresOn`. Where it has written none, the product's own
  words are sent.
- It is held to what any send is: the customer's STOP or withdrawn consent, no
  address, no sender connected. In addition a **text is held in the company's
  quiet hours** (`organization.settings.quietHours`, 9pm to 8am where none is
  set), though an estimate itself may be texted at any hour. This is a courtesy
  the customer did not ask for, so it waits for the morning. Nothing is queued
  for later: the answer says it was not sent and why, and the office sends the
  estimate again after the quiet hours. The email beside a held text still
  goes.
- **A message that does not go does not undo the date.** The date has moved and
  the page says "The customer was not told." with the reason in words (they
  replied STOP, they have no mobile number, it is outside the hours we text
  people). By both at once, one that went and one that did not is a send that
  went, with the other said beside it.
- **The follow up and the message.** A send is what starts the follow up, so
  telling the customer while the office asked for the follow up to start again
  is the send's own start, not a second one. Telling them while "Leave the
  follow up alone" is ticked sends the message without starting it: the
  estimate's `sent_at` is kept and `estimate.sent` is not raised, so the sweep
  stays stopped. The audit line says it (`customerTold`, `toldBy`,
  `notToldBecause`).
- A retry of the same change is the change already made, and tells nobody a
  second time.

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
| `POST /v1/estimates/{id}/expiry` | `estimate:write` |
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
them prints as its base letter or "?". The PDF prints a PNG or JPEG logo; a WebP or
SVG chosen on `/settings` is turned into a PNG by the browser before it is sent
(see M02), but a WebP kept from before that, or a GIF or ICO logo, is still left
off it, and the screen says so. The server has no image library to decode a WebP
with: the only one in the dependency tree is the one Next carries for its own
image resizing, which the API and the worker (where the PDFs are made) cannot
reach without a new dependency of their own. A proposal layout
is a closed set of section kinds, one cover photograph and photographs per
option; there are no columns, fonts or per section colours, a layout cannot be
changed on an estimate once it has been sent. Sending by both channels at once goes only to the customer's
own email address and mobile number. The follow up is on from the start only for
a company created since it was; an older company still turns it on. Only the good
until date of a sent estimate can be changed, and only later: an estimate has no
other edit, so a different price or option is a new estimate. Giving longer tells
the customer only when the office ticks it (above): a text held in the quiet
hours is not kept for the morning (the office sends again), the "given longer"
words have no screen of their own (they are message templates written through
the API, and the product's own are sent where none is written), and it does not
bring back a link that was withdrawn or used up (telling the customer is a new
send with a new link). Starting the follow up again is
the company's recommended follow up and the sweep: an automation of the company's own that waits
from a send is not run again, and a company that deleted or switched off the recommended follow up
gets only the sweep's restart.
A draft
is never marked expired, so one written with a date in the past is not either until
it is sent.
