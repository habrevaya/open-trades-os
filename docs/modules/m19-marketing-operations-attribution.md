---
title: Marketing Operations and Attribution
module: M19
domain: Grow
phase: 6
status: partial
---

# Marketing Operations and Attribution

> Module M19. Domain: Grow. Ships in phase 6.

## What it does

Two halves. The first measures what somebody else's channel sent you: every
touch a visitor made is kept as its own row, credited under a model the reader
chooses, and set against what the channel cost per day. The second sends to the
list you already own: an audience selected from your own customers, by text or
by email, with consent checked on every recipient at the moment of sending.

For a long time only the first half existed, and `campaign:read` and
`campaign:write` sat on the owner's and the marketing manager's roles being
checked by nothing.

## Why a sequence of touches and not two columns

The usual shape is `first_source` and `last_source` on the customer, and it
cannot answer the question a contractor actually has. A homeowner sees a van,
searches the company name, reads a review, clicks an ad two weeks later and
rings the number on a fridge magnet. Two columns keep the van and the magnet
and lose the rest, and the ad account looks worthless.

Five rows keep all of it, and which of them gets the credit becomes a question
the reader picks a model for rather than one the schema decided years ago.
`attribute`, `creditRevenue` and `compareModels` in `packages/core/src/marketing`
all need a list, which is why none of them had a possible caller while the
product was keeping one word per lead.

## Key concepts

**A touch is anonymous first and stitched later.** Most touches happen before
anybody knows who the person is. `visitor_id` is a cookie or a device
identifier and is the only thing tying them together until a form is filled in,
at which point the customer id is written across the whole history at once.
Never a browser fingerprint: a value derived from a browser's characteristics
identifies somebody who took steps not to be identified.

**An unrecognised source is a worklist, not diagnostics.** Every row with
`unrecognised` set is a real campaign somebody is spending money on that no
report can group. Discarding it is how a company ends up with a quarter of its
leads under `unknown` and no way to find out what they were.

**Nothing on a spend row is a result.** Leads, jobs and revenue are counted
from the touches and the work, never written onto a spend row, for the same
reason a stock level is derived: a stored conversion count is a number somebody
can edit into agreement with a target.

**An audience is nine rules, not a query.** A general query builder is an
injection surface against a database where row level security is the only thing
between two companies' customer lists, an unbounded test matrix, and an audience
nobody can explain back to the person about to pay for it. The nine rules each
know how to describe themselves in a sentence, so the confirmation screen can
say "customers who were last served more than 730 days ago and have never held
an agreement" rather than printing a filter tree.

**The rules combine with AND, only.** Not because OR is hard. An owner building
"lapsed maintenance OR in these postcodes" has not asked for the union they
typed; they want the intersection, and the union is four times the send and
four times the bill.

**An audience with no rules is refused.** No rules means every customer, which
is the most expensive mistake available in this product: it is how a company's
one registered number gets flagged by a carrier and its domain blocked in one
afternoon. There is no accidental path to it. The refusal is in core, checked
when a campaign is written, checked again when it is changed, and the audience
query itself throws rather than emitting a WHERE with no clauses.

**The audience is rules; the recipients are history.** `preview` runs the rules
and counts. `send` runs them again and writes one row per person, and from that
moment who it went to is a fact. Recomputing the audience to answer "who did
this go to" would answer a different question every month and call it the same
report.

**A skipped recipient is written down, with the reason.** Filtering the
unreachable out before the list is stored is how a company comes to believe it
sent four thousand texts when it sent nine hundred: the gate refused the rest
for consent, and the refusals existed only in a log nobody reads. Stored with
its reason, the same list is the worklist for collecting the consent that would
make the next campaign twice the size.

**A blast does not go out from the number on the truck.** Carriers score a
sending number on complaint and opt out rate. A campaign to four thousand people
moves that score in one afternoon, and when it moves far enough the filtering
lands on every text that number sends, including the "we are on our way" a
customer is waiting for. A `sending` number is one bought to absorb exactly
that, so marketing prefers it and conversation prefers `main`. Neither will
ever send from a `tracking` number, which would credit a campaign with a lead
that is a reply to our own text.

## Setup

In order, with the permission each step needs:

1. **Lead sources and tracking numbers.** `settings:write`. A tracking number
   carries an `attributionSource` from core's lead source catalogue; without one
   every call from it resolves to `unknown`.
2. **Consent.** `message:send`. Marketing needs a granted consent row per
   address and implies nothing, ever. A company with no consent rows can send
   no marketing at all, which is correct and is the first thing to check when a
   campaign reports every recipient skipped.
3. **A sending number, registered.** `settings:write`. For SMS, register the
   A2P brand and campaign with the carrier and record the throughput and daily
   cap it assigned; the sender paces against them rather than letting the
   carrier reject the overflow.
4. **An email provider with a From address.** `settings:write`. Resend or any
   SMTP server. Marketing email is refused without a working unsubscribe URL,
   so `PUBLIC_BASE_URL` has to be set: it is what the one-click unsubscribe
   link is built from, and a relative URL in a `List-Unsubscribe` header is not
   a working one.
5. **Quiet hours, if the default is wrong.** `settings:write`. The default is
   9pm to 8am in the company's own timezone, which is the TCPA window rather
   than a guess at good manners. `organization.settings.quietHours` set to
   `null` turns it off, which a B2B contractor texting facilities managers may
   legitimately want.

## Using it

### Check an audience before you commit to it

`POST /v1/campaigns/preview` takes a channel and a list of rules, or a saved
campaign's id, and returns the count, the rules as one sentence, the pacing a
daily cap would impose, and a sample of names. The names are the point: a count
is only checkable against an expectation you already have, and "why is my
commercial account in a homeowner tune up offer" is a question somebody can only
ask if they can see who is in the list.

### Send it

`POST /v1/campaigns/{id}/send` hands one batch to the outbox and is safe to
repeat. Under a carrier's daily cap it sends that many and leaves the rest
pending, staying in the `sending` state; the next call takes the next batch.
Nothing here claims a message was sent: the row says `queued` until a provider
has accepted it.

### Read what happened

`GET /v1/campaigns/{id}/recipients` lists everybody, filterable by state. The
skipped half is the useful one, and each row carries the refusal as a sentence
as well as an identifier.

`GET /v1/campaigns/{id}/results` gives replies, opt outs, jobs and revenue. The
job and revenue figures join through `job.campaign_id`.

### What is deliberately not returned

**A conversion rate.** Every tool in this category prints one. Jobs divided by
recipients is a figure whose numerator is attributed under whichever model the
reader has not chosen, and quoting one here would make this answer differ from
the attribution report's answer for the same campaign. The counts and the
revenue are facts; what share of them the campaign caused is what
`compareModels` is for, with the model named.

## Permissions

| Role | `campaign:read` | `campaign:write` |
|---|---|---|
| owner | yes | yes |
| admin | yes | yes |
| office_manager | yes | no |
| dispatcher | no | no |
| csr | no | no |
| technician | no | no |
| crew_lead | no | no |
| accountant | no | no |
| readonly | no | no |

The two are separate because the office manager is the person who gets asked
why a customer received a text, and answering that needs the campaign and its
recipient list. It is not the same as being able to text four thousand
customers, which is why `campaign:write` stops at the administrator.

A role that holds neither still cannot see a campaign through any other route:
there is no unguarded read of `marketing_campaign` or `campaign_recipient`.

`campaign:read` and `campaign:write` were granted to roles and checked by
nothing until the send half existed. The guard test in
`packages/api/test/permissions-enforced.test.ts` excused them by name, with the
reason, and fails now if either goes back to being unenforced.

The two unsubscribe routes hold no permissions and need no session, which they
cannot: a recipient pressing the unsubscribe control in Gmail has no account,
and the mailbox provider making the RFC 8058 POST on their behalf is a server
with no credential of any kind.

## API

The generated reference is `packages/api/openapi.json`. The calls that cover
most real use:

- `POST /v1/campaigns/preview` before anything else.
- `POST /v1/campaigns` then `POST /v1/campaigns/{id}/send`.
- `GET /v1/campaigns/{id}/results`.
- `POST /v1/marketing/touches` to record a touch from your own front end.

## Common questions

**Every recipient came back skipped with `no_consent`. Why?**
Marketing requires a granted consent row for the address and implies nothing.
Record consent through `POST /v1/consent` with the wording that was
presented, or ask at the next visit. The skipped list is the worklist.

**Why did the whole campaign skip with `quiet_hours`?**
It ran outside the company's quiet hours window. The window is the company's
timezone, not the recipient's, and that limitation is deliberate: the right
hour is where the phone is, and a number's area code stopped predicting
location when porting became free. The company's own zone is the closest honest
answer and is right for most of a trades company's list, because they drive
to it.

**Can I unsubscribe somebody from everything?**
Not through the unsubscribe link, which writes a suppression for email
marketing only. Somebody who stops wanting promotions has not stopped wanting
their invoice, their appointment confirmation or their receipt. The blanket case
is the STOP keyword on SMS, and that is blanket because the carrier has already
stopped delivering.

**Does clicking the link in the email body unsubscribe somebody?**
No. A GET describes and writes nothing; the POST acts. Every link prefetcher,
corporate mail scanner, security product that follows URLs in inbound mail and
chat client rendering a preview sends a GET, and if a GET unsubscribed, a
company's whole list would be opted out by software over a few months with no
human having clicked anything.

**Can I edit a campaign after it has gone out?**
No. The body of a sent campaign is what is in four thousand inboxes, and a
record of it that somebody can edit afterwards is not a record of anything.
Copy it into a new campaign.

## What is not built

- **No screens.** A campaign is written and sent through the API.
- **No scheduler.** `scheduledFor` is stored and nothing fires on it, so a
  staged send is one call per batch rather than something that continues
  overnight on its own.
- **No per-recipient personalisation.** The body is sent as written. Message
  templates with placeholders exist in M18 and are not wired to a campaign yet.
- **No A/B test.** Two campaigns to two audiences is the available answer.
- **No OAuth connectors** to Google Ads, Meta, LSA, Bing, GA4 or Search
  Console. Each needs vendor approval as well as code. Spend imports from a CSV
  the operator exports themselves.
- **No voice.** CallRail reports calls; nothing places one.
