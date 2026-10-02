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
form. `POST /v1/estimates/{id}/send` freezes it and hands back the link, and
needs `estimate:send` with `portal:grant`, because it is both.

### Let the customer decide

They open `/e/{token}`, pick an option, tick or untick the optional lines, and
approve or decline. `POST /v1/portal/estimate/approve` is the same action from
the customer's side and takes no permission: the token is the authority.

### Record a yes that happened elsewhere

`POST /v1/estimates/{id}/approve` with `estimate:approve`, which is a narrower
permission than writing an estimate.

### Turn it into work

`POST /v1/estimates/{id}/convert` needs `estimate:write` and `job:write`. It
produces the job and the invoice as a copy, discounts included: the invoice
carries the option's discount total as well as its total, so a converted
estimate with a discount on it posts like any other invoice when it is issued.

### Chase the ones nobody answered

`/estimates` opens on the unsold ones: sent, not approved or declined, not
expired, oldest first or largest first, with how long each has been out and
whether the customer has opened it. The value is the recommended option, or the
largest, never every option added up. `GET /v1/unsold-estimates` is the same
list.

Following them up is a recommended automation on `/automations`, "Follow up an
estimate that has not been answered", turned on with how many days to wait. It
installs an ordinary automation the company can edit: some days after an
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

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything, including the ceiling |
| Office manager | Writes, sends, discounts within the cap, approves on a customer's behalf |
| Dispatcher | Neither |
| CSR | Reads, writes and sends |
| Technician | Reads, writes and sends, and hands over a link. Does not approve |
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
else's behalf is a decision about their money. Handing them a link is not.

## What is not built

An estimate's historical status is not accepted on import, so a migration brings
estimates in as current rather than as won or lost. There is no proposal
template or branded PDF: the customer reads the estimate as a web page.
Following up is an automation the company turns on rather than something
that happens unless switched off. Sending an estimate still only issues the
link: the office hands it over, and only the follow up sends one itself.
`estimate.approved` and `estimate.declined` are not emitted, so an automation
cannot start on a decision; the follow up asks again after its wait instead.
