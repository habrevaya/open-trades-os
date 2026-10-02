---
title: Reviews and Reputation
module: M20
domain: Grow
phase: 6
status: partial
---

# Reviews and Reputation

> Module M20. Domain: Grow. Ships in phase 6.

## What it does

Decides which jobs to ask about, records what came back, and tells the company
which replies are owed and by when.

## The problem

For a local trades company the listing is worth more than the website. A homeowner
searching "AC repair near me" sees a rating and the reply under the worst review
before they see anything the company wrote about itself.

The second problem is the one this module is most careful about, because it is
trivially easy to build by accident.

## Key concepts

**The one thing this module must never learn how to do is ask only the customers
who will say something nice.** That is review gating, every major platform
prohibits it, and it is what gets a listing's reviews wiped. One predicted rating
and a filter on it and the product is doing it.

Core defends against that with a declared list of every fact the ask decision may
read, enforced by a test that proxies the input and fails if anything outside the
list is touched. This module defends against it by having nowhere to put such a
number: there is no column, and the function that builds the decision's input
builds it from exactly those fields. There is no satisfaction score to read even if
somebody wanted to.

**A withheld request is a row, and that is not bookkeeping.** A system that only
records what it sent cannot answer "why did this customer never get asked", and the
answer is almost always worth knowing: an open complaint nobody closed, a callback
still running, an opt out from three years ago.

**The service standard is refused rather than defaulted.** How soon after a visit,
how often at most, how late in the evening: every one of those is a decision about
how a company talks to its customers. A guessed default produces messages going out
at nine at night to somebody who had four jobs that week, and nothing on any screen
would say the product chose that.

**What a platform allows is declared by the operator, never shipped as a
constant.** A table of a platform's rules compiled into this product is somebody
else's rule, it goes stale without anybody noticing, and in a self hosted
deployment it can never be corrected in the field. An operator who read Google's
policy this quarter knows more than a constant written last year.

**The recovery clock is stored, on the way in.** It is the one derived value in the
module that is not computed on read, and the reason is that it is a commitment
rather than a calculation: "somebody will ring this customer today" is a promise
made at the moment the review landed, and recomputing it from a policy somebody
edited last week would quietly move a deadline that was already missed.

**The work list is ordered the way somebody should work it.** Overdue first, most
overdue at the top, then by deadline.

**Reviews are entered by hand, and that is not a placeholder.** No platform
connector is built, the catalogue says so, and a company with forty reviews and a
work list telling them which three are owed a reply is better off than one waiting
for an API.

## Setup

`PUT /v1/reviews/policy` declares the service standard and
`POST /v1/reviews/platforms` records what the operator says each platform allows.
Both need `settings:write`, because they are standing decisions rather than daily
work.

## Using it

### Ask

`POST /v1/reviews/requests` decides about one job and writes the answer either way.
`GET /v1/reviews/requests/due` is what to send,
`POST /v1/reviews/requests/{id}/sent` records that it went, and
`GET /v1/reviews/requests/withheld` is the other half, with the reason.

### Record and reply

`POST /v1/reviews` records a review that exists in the world.
`POST /v1/reviews/{id}/response` is the reply and
`POST /v1/reviews/{id}/recovered` records that somebody rang the customer and
sorted it out. `/reviews` is the screen.

### Read the standing

`GET /v1/reviews/rating` is the rating with what it is wrong about travelling
beside it, and `GET /v1/reviews/by-technician` is the same by person.
`GET /v1/reviews/work-list` is the queue.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything |
| Office manager | Nothing in this module by default |
| Dispatcher, CSR, technician | Neither |
| Accountant | Neither |

`review:respond` is the single operational permission and it covers asking,
recording, replying and reading the rating. A company that wants an office manager
doing this grants it.

## API

| Call | Needs |
|---|---|
| `GET /v1/reviews/work-list` | `review:respond` |
| `GET /v1/reviews/rating` | `review:respond` |
| `GET /v1/reviews/by-technician` | `review:respond` |
| `POST /v1/reviews` | `review:respond` |
| `POST /v1/reviews/{id}/response` | `review:respond` |
| `POST /v1/reviews/requests` | `review:respond` |
| `GET /v1/reviews/requests/withheld` | `review:respond` |
| `PUT /v1/reviews/policy` | `settings:write` |
| `GET /v1/reviews/platforms` | `settings:read` |

## Common questions

**Why is the rating shown with a caveat?** Because a rating from eleven reviews and
a rating from four hundred are different facts, and a bare number is the one that
gets quoted. The caveat travels with the number rather than sitting in a footnote
somebody can drop.

**Does the callback rate feed this?** Yes, and that is why phases of a project are
not child jobs: the callback count reads rows by parent job, and a project whose
phases were children would read as rework and suppress the review ask on the parent
for the life of the job.

**Can a request go out automatically?** Yes, once the company turns it on.
"Ask for a review after a paid job" is a recommended automation on
`/automations`: some hours after a job's invoice is paid in full it puts the job
to this module's own decision (the policy, the cooldown, an open complaint, a
callback, an opt out), waits if the decision says later, and sends the ask with
the link to the review site the company chose. A withheld request is recorded
with its reason exactly as one decided by hand is, and a request is never made
twice about one job. It cannot be turned on until the policy is set and a review
site has been declared with its link, and the screen says which is missing.

**Is the ask a marketing message?** It is sent as an account message, through
the same consent and suppression gate as every other text, and a customer who
withdrew marketing consent is withheld by the decision itself.

## What is not built

No connector to Google, Facebook or any other platform, in either direction: a
review is typed in and a reply is posted on the platform by hand. There is no
sentiment analysis and deliberately no predicted rating. The ask is scheduled
only by the recommended automation, which starts from a paid invoice: a job
that is never invoiced, or paid by a credit note, is never asked about unless
somebody asks by hand. The automation sends by text; an email ask is a change
on its canvas. Requests the policy queued for later from the office's own
`POST /v1/reviews/requests` are still sent by nobody unless an automation or a
person works the due list.
