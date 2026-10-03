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

Three parts. The first answers the question an owner asks first: the Spring
AC tune up on Google Ads, with its own phone number, cost this much, so how
many people rang, how many booked, what did it bill, and what did each of
those cost? A company names its own channels and the tracking campaigns under
them, puts a tracking number on a campaign, and every call, click, lead,
booked job and dollar of revenue is credited back to the number, the campaign
and the channel on one funnel, where every figure opens into the rows behind
it.

The second is what that rests on: every touch a person made is kept as its own
row, credited under a model the reader chooses, and every piece of work the
company books, by whatever path, is credited to those touches.

The third sends to the list you already own: an audience selected from your
own customers, by text or by email, with consent checked on every recipient at
the moment of sending, now or at a time you set.

The fourth measures the company's own channels directly: tracking numbers
bought from its own Twilio account and answered by this product (whispered,
routed by business hours, recorded only when the caller agrees), a snippet for
its own website that records how visitors arrived and swaps a pool number onto
the page per visitor, hosted lead forms, and referral links its customers
share, with a reward when the person they sent pays for their first job.

## The story, end to end

1. **A channel and a tracking campaign.** `Marketing > Channels` starts as the
   lead source catalogue, one channel per key, and becomes the company's own:
   add Angi and Thumbtack under the marketplace key, rename the van, archive
   what you stopped buying. Each channel names the catalogue key it is a kind
   of, so every report still rolls up to the twenty one. `Marketing > Tracking
   campaigns` puts a campaign under a channel with its dates, its cost (what
   you record, one fixed price spread over its days, or a price per lead), a
   budget shown beside the cost and never added to it, and the utm tag its
   links carry.
2. **A tracking number on the campaign.** `Settings`, under phone numbers:
   "calls to it are credited to" a campaign or a channel. The campaign implies
   the channel and the channel implies the catalogue key, and all three are
   written together. Each tracking number shows its calls in the last ninety
   days.
3. **A call comes in.** On a number bought here, through the company's own
   Twilio account, or through the CallRail webhook. Both are recorded by the
   same function (`callTracking.record`), so the rest of this story is the
   same for either. The call is stored with
   the number's channel and campaign AT THE TIME (a number moved to next
   season's campaign does not drag last season's calls with it), whether this
   caller has rung before (CallRail's own answer when it sends one), and a
   touch carrying the caller's number in E.164.
4. **The caller becomes a customer and a CSR books a job.** From
   `/marketing/calls` with "Create customer and job from this call", or the
   ordinary new customer and new job forms. A new customer's phone, however it
   was typed, claims every call and touch made from that number; their lead
   source is filled from what they did, marked `derived`. The job is credited
   by `creditWork` (below) and, from the call log, linked to the call.
5. **The job is invoiced and paid**, through billing as usual.
6. **The funnel** at `/marketing`, by channel, tracking campaign or tracking
   number, over the dates and under the model the reader picks: spend, calls
   (answered, missed, first time), leads, booked jobs, booking rate, completed
   jobs, revenue, average ticket, cost per lead, cost per booked job, return
   and revenue per dollar. Every count and sum opens at `/marketing/rows` into
   the calls, people, jobs or spend lines behind it.

`marketing-funnel.integration.test.ts` and the browser spec `marketing.spec.ts`
both walk this story, through the paths the product uses.

## Tracking numbers this product answers

`Settings`, under phone numbers, with Twilio connected on `Settings >
Integrations`: give an area code or a town, pick a number, say what it is for
and what its calls are credited to, and buy it. It is bought from the company's
own account (`GET /v1/marketing/available-numbers`, then
`POST /v1/marketing/tracking-numbers`), with its voice and status webhooks
pointed at this installation as it is bought, so there is nothing to paste
into Twilio. Everything this product can refuse (a pool number with a campaign,
an after hours number nothing would use) is checked before the carrier is asked;
a purchase that cannot then be recorded is handed back at the carrier.

How a call to it is answered is four settings on the number
(`PATCH /v1/marketing/tracking-numbers/{id}/routing`, and the "Save how it rings"
row on the settings screen):

- **Ring.** The number calls are forwarded to.
- **Say where it came from.** A whisper to the person answering, before the
  caller is put through: "Call from Google Ads, Spring AC tune up." The caller
  hears nothing of it.
- **Ask to record.** The caller is asked to press 1 if the call may be
  recorded, and is connected either way. Recording is switched on in the dial
  only when `telephony.mayRecord`, under the company's own declared recording
  policies, says yes. A caller's location is never known (an area code says
  where a phone was sold), so a native call resolves to `unknown`: everybody
  must agree and the notice must have played. The caller pressing 1 is their
  agreement; the company switched recording on for its own line, and the
  person answering is told by the whisper. Pressing nothing records nothing,
  and the refusal is written on the call.
- **By business hours.** Outside the hours the company keeps for online
  booking, calls go to the after hours number, or to voicemail when there is
  none. `telephony.route` decides, and its sentence ("Open hours matched
  because it is inside business hours") is kept on the call and shown on the
  call screen as "Where it went". A company with no hours declared is not
  closed all week: the clock is ignored until there are hours.

Every call to the number is recorded through the same function the CallRail
webhook uses, so the call, its touch, its channel and campaign at the time, and
the funnel are the same rows either way. A call nobody answers goes to
voicemail; the voicemail is fetched, kept as a stored file and played on the
call screen, and the carrier's copy is deleted. A permitted recording is kept
the same way, attached through the existing `attachRecording` gate, and the
carrier's copy deleted, so the recording lives in one place and
`DELETE /v1/calls/{id}/recording` really deletes it, bytes included. A
recording the carrier made for a call that was not allowed one is deleted at
the carrier and never kept. Recordings older than an active `call_recording`
retention policy that allows purging are deleted by the worker the same way.
Releasing a number bought here (`POST /v1/marketing/tracking-numbers/{id}/release`)
releases it at Twilio first; if Twilio refuses, nothing changes here.

`docs/self-hosting/voice.md` is the operator's side.

## Missed calls

A call nobody at the company picked up (no answer, busy, a forward that failed,
the caller hanging up while it rang, or a voicemail) emits `call.missed`, once
per call, from both the native path and the CallRail webhook (CallRail's only
when the call is over, so a pre-call delivery is not a missed call). The
caller's number rides on the event as `from`, because most missed callers are
not customers yet.

The recommended automation "Text back a missed call" (`Automations`, under
recommended) waits a couple of minutes, stops if anybody has spoken to the
caller since (they rang back and were answered, or somebody here rang them),
texts them from the company's ordinary texting number through the consent
checked sender, and raises a call back in the office queue. A tracking number
never sends it, by the existing sender rule, and somebody who replied STOP is
not texted; the call back task is raised either way.

## The website snippet and number insertion

`Settings > Website` (`/settings/website`) shows one line to paste into every
page of the company's own site:

```
<script src="https://your-installation/t.js?c=your-company" async></script>
```

It is the same small file for every visitor, cached for an hour, with no third
party code. On the company's own site it keeps a first party visitor id
(`ot_vid`, a random value, never a fingerprint), reads how the visitor arrived
(utm tags, the click ids gclid, gbraid, wbraid, fbclid and msclkid, a referral
code, the landing path and the referring site), and:

- posts one touch per arrival to `POST /v1/public/touches`, which keeps the
  attribution parameters and nothing else from the address bar, keeps the
  referring host and never the full referring URL, counts its callers per
  company, per address and per visitor and refuses past a ceiling, and
  recognises the same arrival from the same visitor within half an hour;
- adds the visitor id (`otv`) and the arrival to links to this product's
  booking page and hosted forms, and hidden fields to the site's own forms;
- asks `GET /v1/public/dni` for a number to show, and replaces the company's
  main and tracking numbers on the page with it, written the way the original
  was ("(512) 555-0100" stays in brackets, "512.555.0100" keeps its dots), in
  text and in `tel:` links.

The number is from the company's pool: numbers bought with the purpose
"Website pool". Each visitor holds one at a time (a database index makes two
visitors holding one number impossible), renewed while their page is open and
handed back after the company's idle time (thirty minutes by default, set on
the same screen). With every pool number held, the visitor is shown the tracking
number for their own source if the company has one, else the main number.

When a call arrives on a pool number, the visit that held it at that moment is
found and the call's touch is recorded with that visit's tags and click id,
through the same parser the landing page went through, under the visitor's id.
When the caller becomes a customer, their pages and their call are one history.
A call on a pool number with no visit to match reads as direct.

`/settings/website/test` loads the real snippet on a page carrying the
company's numbers, to see the swap before touching the website. The hosted
booking page takes the snippet's visitor id from `otv` and keeps it, so a
booking joins the visits made on the company's site.

## Hosted lead forms

`Marketing > Lead forms` (`/marketing/forms`) lists the forms and starts a new
one with the fields every trades lead form needs. The builder edits the fields
in order, the consent boxes with what each agrees to (texts or emails, about
offers or about their work), the spam trap, the "too fast to be a person" time,
and what happens after a good submission: the sentence the page shows, and an
optional confirmation text or email.

Each form has a hosted page at `/f/{key}`, a random key that is kept through
every edit, which works with no snippet anywhere (the arrival is read from the
page's own address) and with it (the visitor id arrives as `otv`). A
submission is throttled per address and per form; a filled spam trap or a
submission faster than a person can type is kept as spam and thanked like a
person, so a script learns nothing. A good one, in one transaction:

- matches the customer by phone, then email, or creates one, and stitches the
  visits and calls they made before;
- records consent only for a ticked box the form declared what for, with the
  box's own words as the proof, the page as the reference and the address it
  was given from;
- records the touch with its attribution;
- raises a call back in the office queue with what they wrote;
- sends the confirmation text through the consent checked sender, and the
  confirmation email after the lead is saved, so a refused email never loses
  the lead.

## Referrals

Every customer has a referral code, minted the first time anybody asks, and a
link: the company's booking page with `ref` on it. It is on their record in the
office (with "Record referrer" for a referral the office was told about on the
phone) and on their own account page. `ref` is read by every path that records
a touch (the booking page, hosted forms, the snippet), and a visit through it
is a touch credited to `referral_customer`, basis `declared`, naming the
referrer. When that visitor becomes a customer they learn who sent them
(`customer.referred_by_customer_id`), once: a second link a year later does not
move it.

`Marketing > Referrals` (`/marketing/referrals`) sets what a referral earns: a
credit note on the referrer's account, an amount recorded as owed, or nothing.
The worker grants it when the referred customer's first job has invoices and
all of them are paid, once per referred customer however many times it looks,
and the screen lists the referrers, who they sent and every reward, with "Mark
paid" for an owed one and "Withdraw".

## Crediting work, on every path

`marketing.creditWork` is the one function that credits a job. It used to live
inside booking confirmation and nowhere else, so a job booked online was
credited and a job a CSR typed in after a call on a tracking number was not,
which in this trade is most of the work. It is called by `jobs.create`, booking
confirmation, converting an estimate into a job, accepting a lead offer and
booking from a call. In one transaction it:

- **stitches** the browser and the phone number the customer used before
  anybody knew who they were (`identify`, `identifyCaller`);
- **declares** a lead source somebody chose on the form as a touch of basis
  `declared`, with the person who chose it, so a CSR's answer is evidence the
  models weigh rather than a column that overrides them;
- **tags** every touch of the customer not yet credited to earlier work with
  this job, which makes a job's touches a partition: each touch belongs to one
  job, so the funnel can add jobs up without counting a touch twice, and a
  repeat customer's second job does not take the credit for the click that won
  their first;
- **credits** the job under the company's model: its channel, tracking
  campaign and (when the credited touch carried an outbound campaign's utm tag)
  `job.campaign_id` are written, and `lead_source` is filled only when blank,
  marked `derived`. The customer's source is filled the same way.

A job loaded from another system (one carrying `externalRef`) keeps whatever
its old system said, marked `imported`, and is not credited to today's touches.

## A lead source on the screens

The new customer and new job forms have a lead source picker: the company's
channels, each with its live tracking campaigns. It is checked against the
channel list by the service, so a word nobody can place is refused, and an API
caller's `leadSource` is read through the catalogue's alias list ("Google Ads"
arrives as `google_ads`). Left blank, the job is credited from what the
customer already did. Both detail pages let the office change it, which writes
a declared touch so the change reaches the reports. A company can require a
source (`requireLeadSource`, set on `Marketing > Channels`); it is asked only
when nothing was recorded at all.

The job page has a "Where this job came from" panel: the job's own answer and
whether it was chosen or worked out, the touches credited to it oldest first
with their channel and campaign, and the credit every attribution model gives
them, with what each model is wrong about.

## One revenue for every marketing figure

Revenue is what the ledger recognised on the job: net of discounts and credit
notes, without sales tax, and with a voided invoice subtracting itself. It is
the same fragment the job costing reports read (`REVENUE_SQL`, from
`report-catalogue.ts`). The funnel, the older performance summary, an outbound
campaign's results and the offline conversion files all use it. Before, the
performance summary summed `invoice.total`, which counts the tax as income and
keeps a voided invoice's money, and campaign results summed `job.total`, a
figure somebody types. It is INVOICED revenue rather than collected cash,
because chasing a slow payer is not a marketing outcome.

## What each funnel column counts

For a range from F to T, whole days in the company's own timezone, so a call at
seven in the evening in Austin is that day's call:

- **Spend**: spend rows dated F to T, the part of each fixed price campaign
  that falls in the range (allocated to the cent across its days, so adjacent
  ranges add back to the price), and each per lead campaign's price times its
  leads. By tracking number, a campaign's cost is split evenly across its live
  numbers, by allocation.
- **Calls**: inbound calls that started in the range. Answered and missed are
  core's call outcome classifier's answer, so a four second answer is not an
  answered call and a voicemail is a missed one.
- **Leads**: people (the customer, else the number that rang, else the
  browser) with a touch in the range. New callers and form fills count before
  anybody makes them a customer. One person touching two channels is a lead for
  each and once in the total.
- **Booked jobs**: jobs created in the range and not cancelled, each split
  across its own touches under the model. A split model puts half a job on two
  rows and the halves add back to one. A job nothing was recorded for is on a
  row called "Not attributed", never on direct.
- **Completed and revenue**: of those jobs, the ones finished, and their
  revenue to date, split the same way.

Booked jobs are a cohort of the range and leads are an activity of the range,
so a booking rate on a short range can pass a hundred per cent, and is shown
rather than refused. Every ratio is empty, never zero, when its denominator is.

## Calls, lead offers, spend and conversions

- `Marketing > Calls` (`/marketing/calls`): date, caller, number, campaign,
  channel, what the call was (core's outcome), first time or existing caller,
  length, and the customer when matched, with "Create customer and job from
  this call".
- `Marketing > Lead offers` (`/marketing/leads`): offers from a connected lead
  source, with who to ring, accepted (a customer, a property and a job,
  credited to the marketplace that sold it) or declined with a reason from a
  list. `/marketing/leads/connectors` sets a lead source up: its name, the
  channel its leads are credited to (found from the name through the alias list
  when not chosen, and the marketplace channel when nothing places it), the
  field map, and the same dry run the API offers.
- `Marketing > Spend` (`/marketing/spend`): a day's spend by channel or
  tracking campaign, typed again to replace it, and an ads platform's CSV
  uploaded through the same import the API offers.
- `Marketing > Conversions` (`/marketing/conversions`): the Google Ads and Meta
  offline conversion files for a date range and a model.

The report builder has channel, tracking campaign and lead source dimensions on
the jobs and invoices datasets, and a calls dataset.

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

1. **Channels, tracking campaigns and tracking numbers.** `adspend:write` for
   the first two, `settings:write` for the numbers. A tracking number is
   credited to a campaign or a channel; without one every call from it
   resolves to `unknown`. To buy numbers here and have their calls answered,
   connect Twilio and set `PUBLIC_URL` (`docs/self-hosting/voice.md`).
2. **The website snippet and its pool.** `settings:write`. Paste the line from
   `Settings > Website` into the site, and buy pool numbers for it.
3. **Consent.** `message:send`. Marketing needs a granted consent row per
   address and implies nothing, ever. A company with no consent rows can send
   no marketing at all, which is correct and is the first thing to check when a
   campaign reports every recipient skipped.
4. **A sending number, registered.** `settings:write`. For SMS, register the
   A2P brand and campaign with the carrier and record the throughput and daily
   cap it assigned; the sender paces against them rather than letting the
   carrier reject the overflow.
5. **An email provider with a From address.** `settings:write`. Resend or any
   SMTP server. Marketing email is refused without a working unsubscribe URL,
   so `PUBLIC_BASE_URL` has to be set: it is what the one-click unsubscribe
   link is built from, and a relative URL in a `List-Unsubscribe` header is not
   a working one.
6. **Quiet hours, if the default is wrong.** `settings:write`. The default is
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
job and revenue figures join through `job.campaign_id`, which `creditWork`
writes when a job's credited touch carried the campaign's utm tag. For a long
time nothing wrote it and a test set it with SQL, so every campaign's results
read zero.

### Send it later, and call people by name

Give a campaign a time (`scheduledFor`, or "Send later" on the screen) and the
worker sends it then: a batch is the carrier's daily cap less what went in the
last twenty four hours, it waits through the company's quiet hours rather than
writing everybody skipped, and the campaign row is locked for the batch so a
person pressing send while the worker fires sends each person one message. A
scheduled send acts as the person who wrote the campaign, with what they hold
when it fires: somebody whose access was taken away does not send on Wednesday.

A body may say `{{ customer.firstName }}`, `{{ customer.name }}`,
`{{ company.name }}` and `{{ company.phone }}`, in the message templates' own
syntax, filled per recipient by the one renderer this product has. Anything
else is refused when the campaign is saved, because the renderer turns an
unknown field into nothing. A campaign can start from a message template
(`templateCode`), whose words are copied in. The preview shows the message as
the first person on the list will read it.

### What is deliberately not returned

**A conversion rate.** Every tool in this category prints one. Jobs divided by
recipients is a figure whose numerator is attributed under whichever model the
reader has not chosen, and quoting one here would make this answer differ from
the attribution report's answer for the same campaign. The counts and the
revenue are facts; what share of them the campaign caused is what
`compareModels` is for, with the model named.

## Permissions

| Role | `campaign:read` | `campaign:write` | `adspend:read` | `adspend:write` |
|---|---|---|---|---|
| owner | yes | yes | yes | yes |
| admin | yes | yes | yes | yes |
| office_manager | yes | no | no | no |
| dispatcher | no | no | no | no |
| csr | no | no | no | no |
| technician | no | no | no | no |
| crew_lead | no | no | no | no |
| accountant | no | no | yes | no |
| readonly | no | no | no | no |

`adspend:read` reads the funnel, its rows, the call log, spend, conversions,
lead forms and referrals; `adspend:write` manages channels, tracking campaigns,
spend and lead forms. Buying, routing and releasing numbers, the snippet's idle
time and what a referral earns are `settings:write`; reading the snippet's key
and pool is `settings:read`. A customer's referral code is `customer:read` and
recording who referred them is `customer:write`. Marking an owed reward paid or
withdrawing one is `invoice:credit`, because both are the company giving a
customer money. Hearing a call's recording or voicemail is `message:read`, the
permission that reads the call. Choosing a lead
source on a form needs neither: the channel picker is `job:read`
(`GET /v1/marketing/channel-options`), because the person booking a job is a
CSR who does not read the marketing report, and a channel's name is not a
secret. Accepting a lead offer needs `job:write` and `customer:write`; the
company's attribution model and the lead source requirement are
`settings:write`.

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

- `GET /v1/marketing/funnel` and `GET /v1/marketing/funnel/rows` for the
  funnel and the rows behind any cell.
- `GET /v1/marketing/calls` and `GET /v1/marketing/calls/{id}` for the call log.
- `GET /v1/marketing/channels`, `POST /v1/marketing/channels` and
  `PATCH /v1/marketing/channels/{id}`.
- `GET /v1/marketing/tracking-campaigns`, `POST /v1/marketing/tracking-campaigns`,
  `GET /v1/marketing/tracking-campaigns/{id}` and
  `PATCH /v1/marketing/tracking-campaigns/{id}`.
- `GET /v1/marketing/tracking-numbers` and `PATCH /v1/marketing/tracking-numbers/{id}`.
- `GET /v1/marketing/spend`, `POST /v1/marketing/spend`,
  `DELETE /v1/marketing/spend-rows/{id}` and `POST /v1/marketing/spend/file`.
- `GET /v1/lead-offers`, `POST /v1/lead-offers/{id}/accept` and
  `POST /v1/lead-offers/{id}/decline`.
- `GET /v1/marketing/settings` and `PATCH /v1/marketing/settings`.
- `GET /v1/jobs/{jobId}/attribution` for one job's touches and every model's credit.
- `GET /v1/marketing/touches` to read the touches for a customer, visitor or job.
  `POST /v1/public/touches` records one from a website, as the snippet does.
- `GET /v1/marketing/available-numbers`, `POST /v1/marketing/tracking-numbers`,
  `PATCH /v1/marketing/tracking-numbers/{id}/routing` and
  `POST /v1/marketing/tracking-numbers/{id}/release` for numbers bought here.
- `GET /v1/public/dni`, `GET /v1/marketing/website-tracking` and
  `PATCH /v1/marketing/website-tracking` for number insertion.
- `GET /v1/marketing/forms/{slug}/definition`, `PUT /v1/marketing/forms/{slug}`,
  `GET /v1/public/hosted-forms/{key}` and `POST /v1/public/forms/{formSlug}` for
  lead forms.
- `GET /v1/marketing/referrals`, `PUT /v1/marketing/referral-settings`,
  `POST /v1/marketing/referral-rewards/{id}/settle`,
  `GET /v1/customers/{id}/referral`, `PUT /v1/customers/{id}/referrer` and
  `GET /v1/portal/referral` for referrals.
- `GET /v1/marketing/conversions` for the offline conversion files.
- `POST /v1/campaigns/preview` before anything else, then `POST /v1/campaigns`
  and `POST /v1/campaigns/{id}/send`, and `GET /v1/campaigns/{id}/results`.

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

## The screens

`Marketing > Funnel`, `Calls`, `Lead offers`, `Tracking campaigns`, `Channels`,
`Spend`, `Conversions`, `Lead forms` and `Referrals`, and `Settings > Website`,
are described above. The call screen (`/marketing/calls/{id}`) plays a kept
recording and a voicemail, says why nothing was recorded when recording was
asked for and refused, and says where the call went. The send half is `Marketing >
Texts and emails`, at `/marketing/campaigns`. Previewing is `campaign:read`; creating and sending is
`campaign:write`, so a reader who holds only the first sees the campaigns and the
results and no buttons. That is the right shape for a screen whose buttons spend
money and risk a carrier registration.

**The nine rules are boxes, not a query builder.** Each one is written out with a
sentence a contractor recognises, and two of them take a number whose units are
part of the question ("days since the last job" against "years since install").
A form generated from `RULE_KINDS` would read as nine field names. A test asserts
the boxes cover every kind the union has in both directions, so a tenth rule
cannot ship without one.

**The sentence is the safety.** Before anything is sent the audience reads back as
"412 customers who were last served more than 540 days ago and have never held an
agreement", from the same core function the sender uses, so the screen cannot
describe one audience and send to another. The difference between two years and
two months is one character in a form and a factor of twelve in the bill.

There is no confirmation dialogue, deliberately. The confirmation is that
sentence, which is specific, and a modal saying "are you sure" is the thing
people learn to click through. The send is also safe to repeat: recipients
already written are not re-selected.

Three things the screen says that an owner cannot get from a total:

- **Queued and not sent are separate numbers, with the reasons under them.** A
  screen reporting nine hundred sent hides that four hundred of them were never
  asked for consent, which is a fact about the company's records rather than about
  the send.
- **A consent gap and somebody who replied STOP read differently.** One the office
  can fix by asking; the other they must not touch. A reason the wording has not
  caught up with shows the raw value rather than "skipped".
- **A carrier's cap is said in days.** "3 batches" does not say whether that is
  three minutes or three days, and under a 10DLC daily cap it is days. A cap of
  zero is called a registration problem rather than rendered as "0 a day", which
  would send somebody to rewrite rules that are fine.

An overflow is said out loud: an audience larger than one campaign will take
reaches the first twenty five thousand BY NAME ORDER, which is not a random
sample and therefore not a test of anything.

## What is not built

- **Ad platform API connectors.** No OAuth connection to Google Ads, Meta,
  LSA, Bing, GA4 or Search Console. Each needs vendor approval as well as code.
  Spend imports from the CSV the operator exports, and conversions go back as
  the file each platform accepts.
- **Direct mail.** Nothing sends or tracks a mailer beyond giving it its own
  tracking number or a referral code, which measure it today.
- **Voice beyond tracking numbers.** A number bought here forwards, whispers,
  routes by hours and takes voicemail. There is no IVR menu, ring group, queue,
  on call rota or call placed from the browser, though core's router models
  them. Only Twilio has a voice adapter. A number bought elsewhere and typed in
  is answered wherever its carrier sends it, and its calls arrive here only
  through CallRail.
- **Recording consent by keypress only.** A caller agrees by pressing 1. There
  is no spoken agreement, and no way to record a caller who says nothing, even
  where the operator believes one party consent applies, because a caller's
  location is never known.
- **Transcripts of native calls.** Recordings are kept; nothing transcribes
  them.
- **Number insertion's limits.** The snippet swaps numbers already on the page
  when it loads and when it renews; a number added to the page later by the
  site's own script is swapped at the next renewal, a few minutes on. One pool
  number is held per visitor, not per source, so a large site needs a pool as
  large as its concurrent visitors.
- **Hosted forms' limits.** No file upload field, no multi page form, no
  third party captcha (the spam trap, the timing check and the per address
  ceiling are what there is). A confirmation goes as written, with no
  placeholders.
- **Referral rewards' limits.** One reward per referred customer, on their
  first paid job. A reward paid as owed is marked paid by hand; nothing pays it.
  A credit note reward is not applied to an invoice until somebody applies it.
- **An outbound campaign's own phone number.** A text campaign's credit comes
  from a click on its utm tag, not from a reply to a dedicated number.
- **No A/B test.** Two campaigns to two audiences is the available answer.
- **Leads by first touch in the range.** A person is a lead in every channel
  they touched in the range; the funnel does not yet credit a lead under the
  attribution model the way it credits a job.
