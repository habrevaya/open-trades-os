---
title: Integrations and Provider Framework
module: M25
domain: Platform
phase: 1
status: partial
---

# Integrations and Provider Framework

> Module M25. Domain: Platform. Ships in phase 1.

## What it does

Connects the outside systems a trades company already pays for, through one
framework rather than one bespoke path each: payments, accounting, messaging,
telephony, email, call tracking, lead sources and AI models.

## The problem

A catalogue that lists Google Ads beside a connected checkbox is a product telling
an owner their spend is being imported. If nothing is importing it, the report shows
a channel with leads and no cost, the owner reads it as a free channel, and they
move budget onto it. The failure is silent, it points the wrong way, and it is
exactly the defect class this codebase spends most of its time removing.

## Key concepts

**The catalogue is data, and every entry carries whether it is built.** Two values
only. Built means an adapter is registered and a connection will actually move data.
Declared means this is a thing the product intends to speak to and today does not. A
test asserts that every built entry has a registered adapter behind it, so the
catalogue cannot drift into optimism.

**What counts as built is deliberately narrow.** A parser with no transport is not a
connector. A connector is built when a company can set it up from the settings screen
and data arrives. Fourteen entries are built today and ten are declared.

**A capability is a seam, not a vendor.** Payments, email, accounting, messaging,
telephony, ads, lead source, reviews, maps, tax, payroll, financing, storage,
calendar and analytics are members of one enum. A connector in a capability that
already has an interface and a working adapter is a few hundred lines; one that needs
a new seam is a module. That is most of what decides the build order in
`docs/integration-queue.md`.

**Credentials are secret NAMES, not secrets.** The settings screen takes the name of
an environment variable or a secret store entry, so a company's live keys are never
in this product's database and never in a form post. The screen says which names it
is looking for and shows the webhook address to paste into the vendor's dashboard,
because neither of those is something this product can do on a customer's behalf.

**One connection per provider per company.** A company with two is a company whose
customers hear from two different From addresses at random, so where it matters the
oldest connected one wins deterministically.

**A lead connector is a webhook somebody else posts to.** It has its own secret, a
field mapping onto real objects, a test call, and a rotation path for when the secret
leaks.

## Setup

`/settings/integrations` connects, changes and disconnects every built integration,
shows each one's state and its webhook address, and takes secret names rather than
secrets. `/marketing/connectors` is the marketing half of the same list.

## Using it

### Connect something

`GET /v1/connectors` is the catalogue with each entry's state and this company's
connection. `POST /v1/connectors/{provider}` connects one and
`DELETE /v1/connectors/{provider}` disconnects it.

### Take leads from somebody else's form

`POST /v1/lead-connectors` creates an endpoint,
`GET /v1/lead-connectors/fields` lists what a field can be mapped onto,
`POST /v1/lead-connectors/test` runs a mapping against a sample payload without
writing anything, and `POST /v1/lead-connectors/{id}/rotate` replaces the secret.
The endpoint somebody else posts to is `/api/webhooks/leads/{token}`.

### Connect a model

`POST /v1/ai/connections` connects an AI provider the company already pays for,
`GET /v1/ai/connections` is the state, and `PUT /v1/ai/spend-limit` caps it. M27
covers what a model may reach.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Connects and disconnects everything |
| Office manager | Neither: `integration:read` is not on the preset |
| Dispatcher, CSR, technician | Neither |
| Accountant | Neither, though `accounting:sync` covers the books sync itself |

`integration:write` guards connecting an app, issuing its token and revoking it,
because those are one decision. There is no separate API key permission, and the
catalogue says why.

## API

| Call | Needs |
|---|---|
| `GET /v1/connectors` | `integration:read` |
| `POST /v1/connectors/{provider}` | `integration:write` |
| `DELETE /v1/connectors/{provider}` | `integration:write` |
| `GET /v1/lead-connectors` | `integration:read` |
| `POST /v1/lead-connectors` | `integration:write` |
| `POST /v1/lead-connectors/test` | `integration:read` |
| `GET /v1/ai/connections` | `integration:read` |

## Common questions

**Which integrations are built?** The catalogue answers it at runtime, and the
settings screen shows it. Stripe, QuickBooks Online, Xero, Twilio, JustCall, Resend,
SMTP, CallRail and the AI model providers are the ones a company can set up and see
data arrive from.

**Why is there a plan document as well as a catalogue?** Because the plan is a plan.
`docs/integration-queue.md` orders what to build next and a test checks the document
against the catalogue, so a tier that goes stale after something ships fails the
build rather than quietly misleading whoever reads it next.

**Can I write my own adapter?** Yes, against the capability seam. That is the point
of there being a seam rather than a vendor specific path.

## What is not built

Ten catalogue entries are declared and have no adapter, and the catalogue names each
one rather than hiding them. There is no marketplace, no adapter plugin loading at
runtime and no per connector health dashboard beyond each one's state on the settings
screen. Secrets are read from the environment or a secret store by name, so a company
that wants them managed in the product does not get that, deliberately.
