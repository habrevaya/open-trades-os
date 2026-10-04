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

Lets a company connect the model account it already pays for, and runs seven
agents on it: intake (texts, emails, call transcripts and web forms into
booking drafts), a website and text chat, a phone assistant that answers calls
live, an estimate drafter, collections, a dispatch copilot, and a field assistant
that answers a technician's questions from the company's own records. Each acts as a person the company chose, never with more
access than that person, proposes rather than commits anything that moves money
or a customer's appointment unless the company lets it act on its own, and
writes down every proposal, decision and refusal.

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

And the fourth is trust. An agent that books a job at nine at night, quotes a price
or texts a customer about a bill is only something an owner turns on if they can see
exactly what it may do, stop it doing the parts that matter without a person, and
read afterwards what it did and who let it.

## Key concepts

**Bring your own model.** The company connects its own account, the key stays in its
secret store, and this product calls it on their behalf. No platform account, no
resale, no cut: the same decision the payments seam makes, for the same reason.

**The credential is a reference, not a value.** A row in this database is not a secret
store, and this is the capability where that matters most: a model key is bearer
authority over an account with a spending limit on it, usable from anywhere, with no
second factor and no per request signature a webhook could catch.

**Several connections at once, and an ambiguous call is refused rather than
resolved.** When more than one model provider is connected and the caller did not say
which, the call is refused and names them. Each agent's settings can name the one it
uses.

**An agent acts as somebody.** A run a person starts (asking the copilot about a day,
asking for estimate options, asking intake to read a thread) runs as that person. A
run nobody starts (a text at nine at night, a website visitor, the hourly collections
check) runs as the person chosen on the agent's settings, read from their membership
at that moment, so somebody removed from the company or narrowed since is what the
agent becomes too. The audit log records both the person and the agent's id. Whoever
chooses that person may only choose somebody whose access is no wider than their own.

**An agent is told about nothing its person could not do.** Each agent has a short
list of actions in `core/agents`, each needing the same permissions as the route that
applies it. Only the actions the person holds every permission for are offered to the
model, and an answer naming anything else (another agent's action, an MCP tool name, an
action its person may not take) is refused, logged as refused, and changes nothing.
The agents do not use the MCP catalogue: an agent running unattended on a stranger's
words is offered what its job needs and nothing more.

**An answer is checked against the company's records before anybody sees it.** The
schema the model was shown is the schema its answer is held to. Then: booking windows
must be open in online booking for the drafted service, a customer must be one of the
candidates the agent was shown, every estimate line must be a price book item and is
priced at the price book's price in force (the model never writes a price, and a draft
naming an item that is not in the book is refused whole), a chat reply naming any
amount the company has not published is not sent, a reminder naming any amount other
than what the invoice owes is not kept, and a copilot pick of anybody the board's own
skills and time off checks refuse is dropped and said.

**Propose, then decide.** Every answer becomes a proposal. A person approves it with
one click, through the same service their click would call by hand, or the company
sets an agent to act on its own, which applies it at once through that same service
as the agent's person. The dispatch copilot, the chat agent and the phone assistant
cannot be set to act on their own: putting people on a day stays with a dispatcher, and
a booking taken in a chat or on a call is always a request the office confirms.

**The spend ceiling refuses, and what it promises is bounded rather than absolute.** It
is checked before every call, agents included, against spend already recorded, and the
number of input tokens a call will use is not knowable before it is made. So a call is
refused unless the ceiling has room for the worst case output of this call, which means
the most a month can exceed its ceiling is one call's input cost. A call that cannot be
priced is refused when a ceiling is set. Each agent also has its own runs a day limit.

**One turn per run.** Every agent is shaped so that one answer is enough: the facts it
may choose from are in the message, so it never calls a tool to look something up. That
bounds what one run can cost to one call.

**No word of a prompt in the usage table.** `ai_usage` records tokens, cost, the agent
and a short purpose, never the conversation. A proposal does hold its draft, because it
is work for the office, read by the people who could read the message it came from.

## Setup

1. `/settings/integrations` connects a model provider by the name of the secret holding
   its key. `PUT /v1/ai/spend-limit` sets the monthly ceiling.
2. `/settings/agents` turns each agent on, chooses who it acts as, whether it waits for
   a person or acts on its own, its tone, its limits (runs a day, longest answer, and
   for chat the replies in one chat before a person takes over), and the model account.
   Intake chooses what it reads (texts, emails, call transcripts, web forms). The chat
   agent takes a greeting, the company's own questions and answers, and the price book
   items whose price it may say out loud. Collections takes up to six steps by days past
   the due date, each with how it should sound and whether it goes by email or text. The
   phone assistant takes what it says after its disclosure, its own questions and answers
   and published prices, the most replies on one call, and the ring group it puts callers
   through to (or voicemail).
3. For the website chat, nothing else to paste: the website snippet from
   `/settings/website` shows the chat button once the chat agent is on.
4. For the phone assistant, run the voice relay beside the web app and set
   `VOICE_RELAY_URL` (`docs/self-hosting/voice.md`), then send calls to it from a phone
   menu on `/settings/phone`.

## Using it

### Intake

New texts, emails, call transcripts and web forms that arrive after intake is turned on
are read by the worker a few at a time, and each becomes a booking draft: the customer
matched or new, the address, the problem in a sentence, the service, how soon, and up
to three open windows from online booking. The office books it with one click on
`/inbox/drafts` or on the conversation itself, which makes the booking request the
booking page would make, confirms it the way the office confirms one, and puts a visit
in the window. "Draft a booking from this" on a conversation asks for one by hand. A
message that is not asking for work is set aside and not read again.

### Website and text chat

The widget says it is an automated assistant before anything else, answers from the
company's facts (services and their online booking prices, published price book items,
service area, hours, its own questions and answers), offers the windows online booking
would, and takes a booking request, which waits on `/inbox/drafts` for the office to book
with one click into a job with its visit in the window the visitor chose. It hands the
chat to a person when asked (decided in code, before the model is asked), when unsure,
when it would have quoted an unpublished price, or when it reaches its reply limit;
the conversation is marked unread in the inbox and a task goes on the queue. Answering
the chat from the inbox reaches the visitor's open chat and stops the assistant. By
text it answers only conversations nobody in the office has written in for twelve
hours, never in quiet hours, and through the same consent gate as every text.

### Phone assistant

A call a phone menu, after hours, a ring group nobody answered or a waiting line sends to
it is held by Twilio's ConversationRelay, which turns the caller's speech into text and
sends it over a WebSocket to the voice relay, a small process beside the web app
(`pnpm --filter @opentradesos/api voice-relay`). The relay checks the carrier's signature
on the connection before it accepts it, and hands each thing the caller says to the
assistant, one at a time.

Before anything else, in words no model wrote and that the caller cannot talk over, it
says it is an automated assistant, not a person, that the call is written down, and that
saying "person" puts them through. Then, for each thing the caller says, one model turn:
it answers from the chat's facts (services and their online booking prices, published
price book items, service area, hours, its own questions and answers), with the caller's
number and the customers it matches; it can look the caller up by a name or number they
give (one extra turn, at most once each time they speak), offer the windows online booking
would and take a booking request through the booking page's own service, take a message
for the office (a task on the queue, on the customer when there is one), say goodbye, or
put the caller through. It puts them through, decided in code before the model is asked,
when they ask for a person or press 0, after it has used its replies on one call, when it
has heard nothing three times, when its person can no longer do what it needs, when the
spend ceiling or its runs a day stop it, when the model fails, and when an answer would
have said a price the company has not published, which is never said. A caller put
through goes to the ring group on its settings, or voicemail.

Card numbers and security codes the caller reads out are removed before their words are
written down or shown to the model. On the call screen it shows everything it heard and
said, in order, and one line for each thing it did; the words become the call's
transcript unless the call already has one, and the call log marks the call.
`GET /v1/calls/{id}/assistant` is the same, for `message:read`. It runs as the person on
its settings, who must hold `message:read`, `message:send`, `customer:read` and
`booking:read`.

### Members

All three know a member by how they reached the company (M08): the number a
call or a text comes from, the number or email a text, email or form came
from for the intake agent, or a number or email a website visitor writes in
the chat, matched to a customer holding a running plan that promises
priority dispatch. Never by a name they say. A member is offered their plan's
share of the windows held for members, as their own account would be, and
their booking request may go into it. Who the number belongs to is not
proof of who is asking, so nothing about it reaches the model or the person:
the prompt carries no membership, plan or account, only the longer list of
windows, and nothing is said beyond what the intake flow already said. The
office is told: the call's assistant record says it knew the number as a
member's, the chat agent's log line for the booking says so, and an intake
draft says "This came from a member's number or email". When the office
books an intake draft, the customer chosen (or the draft's number and email)
decides again whether a held window may be used.

### Estimate drafter

On a job, "Draft options from the notes" reads the job's notes, photo captions,
findings and equipment and drafts up to three options from the price book. "Make the
estimate" writes a draft estimate to edit and send from the estimate screen.

### Collections

When an invoice reaches one of the company's steps, the agent drafts a reminder in the
company's tone for exactly what is owed. `/invoices/reminders` sends it as written or
edited, or sets it aside (a step set aside is not drafted again). By email it is the
invoice sent again with the reminder above the payment button; by text, the reminder and
the payment link. Checked hourly by the worker, or now with "Check for overdue invoices
now".

### Dispatch copilot

`/schedule/copilot` asks the copilot about a day. It reads the board's own route
optimiser answer and skills and time off checks, picks only among the people the board
allows, and explains each pick in a sentence. The dispatcher ticks what to apply, and
each assignment is the board's own, with the qualification check run again.

### Field assistant

On the phone (M11) and on `/my-day`, a technician asks in plain words: when
this unit was last serviced, what the last technician wrote here, what the
company charges for a part, how the company does a job. It answers only from
the company's records and its own how-to notes, chosen in plain code before
the model is asked and each kind only when the person asking may read it:
the equipment at the visit's address and its history (`equipment:read`), the
notes on this visit and earlier ones there (`visit:read`), price book prices
and never a cost (`pricebook:read`), and the how-to notes. The visit has to be
on their own day. The answer has to cite the records it came from, and may
state a price only as one of those records states it; an answer that does
not is not shown, and the refusal is in the log. A question nothing in the
records matches is answered "nothing in your company's records matches"
without asking the model at all. It runs as the person asking, one call, on
the same spend ceiling and runs a day as every agent, and the log says that
it answered and from how many records, never what was asked.
`POST /v1/ai/field-assistant` is the same, and a retry with the same
idempotency key answers from the record rather than asking twice.

The how-to notes are written on `/settings/agents/notes`
(`knowledge:write`, which the office manager preset holds), each a job with
its steps and the words somebody might ask with; read by anybody who reads
jobs. `GET /v1/knowledge-notes`, `POST /v1/knowledge-notes`,
`PATCH /v1/knowledge-notes/{id}` and `DELETE /v1/knowledge-notes/{id}`, which
takes a note out of use and keeps it, so an earlier answer can still be traced
to what it said.

### The log

`/settings/agents` lists everything the agents did: drafted, applied (by whom, or on
its own), dismissed, refused (with the reason), failed, answered, handed over and
skipped. `GET /v1/ai/activity` is the same list.

### Asking a model directly

`POST /v1/ai/completions` runs one turn for a caller running their own loop, optionally
offering the tool catalogue that caller may use. `GET /v1/ai/tools` is that catalogue.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Connects a model, sets the ceiling, configures agents, reads the log |
| Anybody else | Uses an agent's drafts with the permission the underlying action takes |
| Technician | Asks the field assistant (`field:sync`), which tells them nothing they could not read themselves |
| Office manager | Writes the how-to notes (`knowledge:write`) |

`agent:configure` connects models, runs completions, sets the ceiling and saves agent
settings. Reading the agents and their log is `integration:read`. Booking an intake
draft takes `booking:decide` and `visit:write`; making a drafted estimate takes
`estimate:write`; sending a reminder takes `invoice:send` (and `message:send` by text);
applying the copilot's plan takes `visit:dispatch`. Asking intake to read a thread takes
`message:read`, asking for estimate options `estimate:write`, asking the copilot
`visit:read`.

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
| `GET /v1/ai/agents` | `integration:read` |
| `PUT /v1/ai/agents/{agent}` | `agent:configure` |
| `GET /v1/ai/activity` | `integration:read` |
| `GET /v1/calls/{id}/assistant` | `message:read` |
| `GET /v1/ai/intake/drafts` | `booking:read` |
| `POST /v1/ai/intake/drafts` | `message:read` |
| `POST /v1/ai/intake/drafts/{id}/approve` | `booking:decide`, `visit:write` |
| `POST /v1/ai/intake/drafts/{id}/dismiss` | `booking:decide` |
| `POST /v1/ai/intake/requests/{id}/book` | `booking:decide`, `visit:write` |
| `GET /v1/ai/estimate-drafts` | `estimate:read` |
| `POST /v1/ai/estimate-drafts` | `estimate:write` |
| `POST /v1/ai/estimate-drafts/{id}/accept` | `estimate:write` |
| `POST /v1/ai/estimate-drafts/{id}/dismiss` | `estimate:write` |
| `GET /v1/ai/collections/reminders` | `invoice:read` |
| `POST /v1/ai/collections/run` | `invoice:send` |
| `POST /v1/ai/collections/reminders/{id}/send` | `invoice:send` |
| `POST /v1/ai/collections/reminders/{id}/dismiss` | `invoice:send` |
| `GET /v1/ai/dispatch/plans` | `visit:read` |
| `POST /v1/ai/dispatch/plans` | `visit:read` |
| `POST /v1/ai/dispatch/plans/{id}/apply` | `visit:dispatch` |
| `POST /v1/ai/dispatch/plans/{id}/dismiss` | `visit:dispatch` |
| `POST /v1/ai/field-assistant` | `field:sync` |
| `GET /v1/knowledge-notes` | `job:read` |
| `POST /v1/knowledge-notes` | `knowledge:write` |
| `PATCH /v1/knowledge-notes/{id}` | `knowledge:write` |
| `DELETE /v1/knowledge-notes/{id}` | `knowledge:write` |
| `GET /v1/public/chat` | Public: whether the chat is on |
| `POST /v1/public/chat/sessions` | Public: opens a chat, returns its token once |
| `POST /v1/public/chat/messages` | Public, with the chat's token |
| `POST /v1/public/chat/transcript` | Public, with the chat's token |

Nothing under `/v1/ai/` is ever offered to a model as a tool, so an agent cannot drive
an agent.

## Common questions

**Which providers are supported?** Whatever the connector catalogue says is built.
The settings screen shows each one's state.

**Can an agent act on its own?** Only as somebody, and only where the company chose it:
intake can book, collections can send and the estimate drafter can write the draft
estimate on their own. The copilot, the chat and the phone assistant never decide for a
person. Everything
done on its own says so in the log and on the proposal.

**What stops a message written to trick the agent?** Not the prompt, though the prompt
tells the model that a customer's words are information and not instructions. What
stops it is that every answer is one of a few proposals, checked against the company's
records and the person's permissions before anything happens.

**Why is this phase eight?** Deliberately late. An agent grounded in a half finished
price book, against a dispatch board that does not know real capacity, is a demo, and
this category has enough of those.

## What is not built

The phone assistant has not been tried on a live phone line. It is built from Twilio's
ConversationRelay documentation and tested against a WebSocket client playing the
carrier's part, so the carrier's real timing, speech recognition and signature on the
handshake are untested. It needs the voice relay deployed as its own process; with no
relay, calls sent to it are put through instead, and a relay restarted mid call puts that
caller through. Each answer is one whole model call with no streaming, so the caller hears
nothing until the answer is complete, and it speaks and hears English only. It keeps what
the caller said on the strength of the disclosure it opens with, not on a press 1 yes
like a recording; a company whose advice says that is not enough for its callers should
not send calls to it. Its part of the call is never recorded as audio. It cannot move a
caller to a waiting line or another menu itself, only to its one ring group or voicemail,
and it takes one booking request a call. There is no LiveKit path. The field assistant finds what to give the
model by matching the words of the question against the records and notes, not by
meaning, so a question in words no note uses finds nothing and says so; it reads the
equipment and notes of one address and the price book, not the photographs, the
manufacturer's literature or another customer's history, and it needs a signal. No
streaming: every model call is one request and one response, so the chat answers a
message at a time. The intake agent books through online booking's services and
windows only; a company with none set up gets the summary and books by hand, and an
intake booking's visit goes on the board unassigned rather than onto a technician's
day. The chat widget is reached through the website snippet or its own script tag;
there is no chat inside the customer portal, and a visitor who leaves before a person
replies sees the reply only when they come back to the site in the same browser. The
estimate drafter does not look at the photographs themselves, only their captions, and
offers at most three hundred price book items to the model. Reminder emails keep the
invoice's own subject line. The agents' prompts are in English only.
