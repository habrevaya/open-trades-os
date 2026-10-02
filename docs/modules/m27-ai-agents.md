---
title: AI Agents
module: M27
domain: Platform
phase: 8
status: partial
---

# AI Agents

> Module M27. Domain: Platform. Ships in phase 8.

## What it does

Lets a company connect the model account it already pays for, and offers that model
the product's own tool catalogue, filtered by the permissions of the person the call
runs as.

## The problem

An agent layer is where a product usually gives away two things it should not: its
customers' money, and its own authorization model.

The money goes through a platform account with a margin on it, which puts somebody
else's secret on infrastructure this project does not control and makes the product
the thing that stops working when a vendor changes their mind. The authorization
model goes when the agent layer executes tools itself, because a service that runs a
tool call becomes a second permission gate, and the second gate written is always the
one that forgets.

The third problem is a bill. A connected key plus a loop that does not terminate is a
bill, and the first anybody hears of it is the bill.

## Key concepts

**Bring your own model.** The company connects its own account, the key stays in its
secret store, and this product calls it on their behalf. No platform account, no
resale, no cut: the same decision the payments seam makes, for the same reason.

**The credential is a reference, not a value.** A row in this database is not a secret
store, and this is the capability where that matters most: a model key is bearer
authority over an account with a spending limit on it, usable from anywhere, with no
second factor and no per request signature a webhook could catch.

**How a secret is fetched is injected rather than imported.** A deployment keeps these
in Supabase Vault, a KMS, or a file the orchestrator mounted, and a service reading the
environment directly would work in exactly one of those. It also means no test in this
repository holds anything that looks like a key.

**Several connections at once, and an ambiguous call is refused rather than
resolved.** Unlike every other capability, a company genuinely does connect more than
one of these: the whole point is running the cheap model for a summary and the
expensive one for a decision. When more than one is connected and the caller did not
say which, the call is refused and names them. Picking would mean this product
choosing, silently and forever, which vendor a company is billed by, and on published
rates the spread across models a company might reasonably connect is more than
tenfold.

**A model is never told about a tool its operator could not use.** The tool catalogue
offered to the model is filtered by the permissions of the person the call runs as, so
the worst an agent can do is what its operator could already do by hand. That
filtering is what makes an agent safe to turn on.

**This service does not run the tools.** It returns the calls the model asked for, and
the caller runs them through the MCP server or the HTTP API it already holds a
credential for. A service that executed them would be a second permission gate, and it
would have to invent a credential, because a service context holds an actor and not a
token. Inventing a credential inside the thing that decides what an agent may do is
how an agent layer becomes a privilege escalation.

**The loop lives with the caller.** Ask, run the calls through the one gate, feed the
results back, ask again. Every turn is priced and recorded.

**The spend ceiling refuses, and what it promises is bounded rather than absolute.** It
is checked before the call, against spend already recorded, and the number of input
tokens a call will use is not knowable before it is made. So a call is refused unless
the ceiling has room for the worst case output of this call at the model's output rate,
which means the most a month can exceed its ceiling is one call's input cost. That is a
real guarantee, and it is not "spend never exceeds the limit", which nothing checking
beforehand can offer. Claiming the stronger one would be the defect this codebase
spends its time removing.

**A call that cannot be priced is refused when a ceiling is set.** A rate the
deployment does not hold means every call costs nothing, every month sums to zero, and
the ceiling is a setting that does nothing while an operator believes it is protecting
them. Refusing is rude and visible; the alternative is quiet and expensive.

## Setup

`/settings/integrations` connects a model provider by the name of the secret holding
its key. `PUT /v1/ai/spend-limit` sets the monthly ceiling, and setting one is what
turns the pricing refusals on.

## Using it

### Connect and test

`POST /v1/ai/connections` connects a provider,
`POST /v1/ai/connections/{provider}/test` proves the key works, and
`DELETE /v1/ai/connections/{provider}` disconnects it.
`GET /v1/ai/connections` is the state.

### Ask a model something

`POST /v1/ai/completions` runs one turn, optionally offering the tool catalogue.
`GET /v1/ai/tools` is what would be offered to the caller, which is the thing to read
before turning an agent loose: it is the honest list of what that agent can do.

### Watch the spend

`GET /v1/ai/usage` is tokens and estimated cost, which needs `integration:read` rather
than `agent:configure` because reading a bill is not configuring an agent.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Connects a model, runs completions, sets the ceiling |
| Everybody else | Nothing |

`agent:configure` is the permission, and it covers connecting, running and capping,
because those are one job today. Reading the usage is `integration:read`.

## API

| Call | Needs |
|---|---|
| `GET /v1/ai/connections` | `integration:read` |
| `POST /v1/ai/connections` | `agent:configure` |
| `POST /v1/ai/connections/{provider}/test` | `agent:configure` |
| `DELETE /v1/ai/connections/{provider}` | `agent:configure` |
| `POST /v1/ai/completions` | `agent:configure` |
| `GET /v1/ai/tools` | `agent:configure` |
| `PUT /v1/ai/spend-limit` | `agent:configure` |
| `GET /v1/ai/usage` | `integration:read` |

## Common questions

**Which providers are supported?** Whatever the connector catalogue says is built.
The settings screen shows each one's state, and a provider listed as declared has no
adapter.

**Why is this phase eight?** Deliberately late. An agent grounded in a half finished
price book, against a dispatch board that does not know real capacity, is a demo, and
this category has enough of those.

**Can an agent act on its own?** Only as somebody. An agent gets the same actor type a
person gets and the audit entry records both the credential and the agent id.

## What is not built

None of the agents themselves: no intake agent, no chat agent, no dispatch copilot, no
estimate drafter, no collections agent and no field assistant. What is built is the
seam they would all sit on, which is the part that has to be right before any of them
is safe to turn on. There is no embeddable surface and no voice path. Streaming is not
supported: a completion is one request and one response.
