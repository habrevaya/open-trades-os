---
title: Documents, Compliance and Safety
module: M23
domain: Company
phase: 7
status: partial
---

# Documents, Compliance and Safety

> Module M23. Domain: Company. Ships in phase 7.

## What it does

Holds the documents a company has to keep current, the filings it owes an
authority, and the published figures its work depends on. It tells somebody what
has expired and what is about to, and it never tells them they are compliant.

## The problem

Three tables were in the first compliance migration with comments describing a
working feature, and only one of them was ever written by anything.
`document:write` was in the permission catalogue, on every office role, and
asserted nowhere, which means an owner who withheld it withheld nothing.

## Key concepts

**This module must never tell a contractor they are compliant, and the reason is
not caution.** The sentence is unsupportable by anything in this database.

"You are compliant" is a claim about a set: that the documents, filings and figures
a business is required to hold are all present and all current. The software holds
the numerator, which is the rows somebody put here. It does not hold the
denominator and cannot: which documents a given business must hold depends on the
trade, the jurisdiction, the licence classes it works under, the contracts it has
signed, what its insurer requires, and what all of those said this year rather than
last.

A green tick assembled from an unknown denominator is not an optimistic summary, it
is an assertion about law made by a system with no access to the facts the
assertion depends on. And it is the single most dangerous artefact this module could
produce, because that screenshot goes to a general contractor, to an insurer, into a
bid package, and everyone downstream believes it.

**So every read returns facts about rows, each of which the code can defend.** This
document expired on this date, that many days ago. This document expires on this
date and the operator said it needs this many days' notice. This submission was
acknowledged with this reference. This submission was rejected, and here is what the
authority said. This figure's published window ended and no later one exists.

**There is no rollup, no score and no boolean.** The summary returns counts rather
than a verdict, and the counts are statements about the register: "four documents on
file have expired" is true of the rows. "You have no expired documents" would be
true of the rows too, and it is deliberately not phrased as "you are covered",
because a register with nothing in it produces the same zero.

**Everywhere this looks like a compliance judgement, it is holding the operator to
something they declared.** Whether a document is required for work is their flag on
their document. The notice period is their estimate of their own renewal lead time.
A submission's due date is a date they supplied rather than one computed from a
statute. The posture is copied from the call recording policy, which holds a claim
the operator made and not a statement of law: the software's job is to hold them to
it consistently and to refuse to record when their own declaration does not cover
the call.

**A renewal deadline is an obligation, not a second queue.** The obligation table
exists so that "what is about to breach" is one question across SLA clocks,
acknowledgements and now expiries. A second queue on a compliance screen is how a
licence lapses in a product that knew the date.

**The bytes are a stored file pointed at by an attachment.** This module writes no
storage key of its own, which keeps the reference count honest.

**The submission programme is the trade pack's own list and is not copied into a
table.** Two representations of one programme is a defect this codebase has already
produced twice. A declared kind takes its authority, jurisdiction and route from the
pack, and an input that would state them a second time is refused.

**A person's own credential is not here.** M24 holds what an individual holds, and
the renewal lead time belongs on the certification type rather than on a scan of a
card. A technician's licence recorded in both places is two expiry dates for one
credential, and the first time they disagree nothing can say which is right. What
this register holds is a document the company holds: its contractor licence, its
liability cover, a permit on a job, a safety data sheet.

## Using it

### The register

`GET /v1/compliance/documents` is what is on file and when each runs out.
`GET /v1/compliance/documents/blocking` is the lapsed ones the operator marked as
needed for work, and `GET /v1/compliance/documents/summary` is the counts.
`/compliance` is the screen.

### Keep it current

`POST /v1/compliance/documents` registers one,
`POST /v1/compliance/documents/{id}/renew` renews it, and
`POST /v1/compliance/documents/{id}/withdraw` takes one out of the register.

### Filings

`GET /v1/compliance/submissions/declared` is what the trade pack says this trade
owes and to whom. `POST /v1/compliance/submissions` opens one,
`POST /v1/compliance/submissions/{id}/state` advances it, and
`POST /v1/compliance/submissions/{id}/resubmit` sends it again after a rejection.
`GET /v1/compliance/submissions` is the history.

### Published figures

`GET /v1/compliance/constants` reads a figure for a date,
`POST /v1/compliance/constants` publishes one with its window, and
`GET /v1/compliance/constants/stale` is the ones whose window has ended with no
later one.

### Attachments

`POST /v1/attachments` uploads one against a record and
`GET /v1/attachments` lists them. These are the document permissions rather than
the compliance ones, because an attachment is a file on a record.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything |
| Office manager | Reads documents. Writing them is granted, not inherited |
| Dispatcher, CSR, technician | Reads documents |
| Accountant | Neither |

Two permission pairs, and they are different questions. `document:read` and
`document:write` are the register of files. `compliance:read` and
`compliance:write` are the filings, the figures and, in M24, the certifications.

## API

| Call | Needs |
|---|---|
| `GET /v1/compliance/documents` | `document:read` |
| `POST /v1/compliance/documents` | `document:write` |
| `GET /v1/compliance/documents/blocking` | `document:read` |
| `GET /v1/compliance/submissions` | `compliance:read` |
| `POST /v1/compliance/submissions` | `compliance:write` |
| `GET /v1/compliance/constants` | `compliance:read` |
| `POST /v1/attachments` | `document:write` |

## Common questions

**Why is there no compliance score?** Because the denominator is unknowable from
this database, and a number assembled from an unknown denominator ends up in a bid
package.

**What makes a document block work?** The operator's own flag on it. Nothing in the
product decides that a licence is required.

**Where do retention rules come from?** The trade pack declares them, with the
clock start stated explicitly, because retention almost never runs from when the row
was created. Nothing purges on them yet.

## What is not built

Nothing acts on a retention policy: the rules are seeded and read and no purge
exists. There is no safety meeting, incident or toolbox talk record, despite the
module's name: what is here is documents, filings and figures. A submission is
tracked and not transmitted, because there is no per authority formatter, and the
trade pack is explicit that a submission seed describes what the software must
produce and to whom, never what the business is legally required to do.
