---
title: Communications Infrastructure
module: M18
domain: Grow
phase: 6
status: partial
---

# Communications Infrastructure

> Module M18. Domain: Grow. Ships in phase 6.

## What it does

Sends and receives texts and email, logs calls, keeps a thread per customer, and
enforces consent, suppression and quiet hours on every send.

## The problem

Two failures, and the second one is the expensive one.

A product with two outbound paths has one suppression check, and the second path
written is always the one that forgets. That is not hypothetical here: the inbox
had a consent decision in front of every send and the on my way notice had none,
because the notice did not send anything at all. It wrote a row saying a text had
gone out and returned ok, while the technician's button read "Text the customer I
am on my way". A dispatcher reading that row stops phoning the customer, which is
the worst shape a defect can take: the record actively argues against anybody
noticing it.

The other failure is a consent table nothing writes. `communication_consent` was
read in three places and inserted by nothing, so every marketing message was
refused with no consent, permanently. Transactional messages went out, because
those are implied by the work itself, which is why nobody noticed: the on my way
text arrived and the campaign silently did not.

## Key concepts

**The check and the send are one function, so a caller cannot have the send
without the check.** Two purposes through one gate: transactional is a claim
about the message (a person is on their way to a property, and that is not
marketing), marketing is the other claim. What separates them is not the file,
it is three things the marketing gate adds: a granted consent row with nothing
implied, quiet hours, and a different number to send from.

**A blast goes out from a sending number, never from the one on the truck and
never from a tracking number.**

**A consent row is evidence, and evidence is not edited.** Granting or revoking
stamps the previous row as superseded and inserts a new one, so the history reads
as what was true when, which is the only form in which it answers the question
anybody asks of it: were you allowed to send that, on that day.

**Superseding happens before inserting.** The other order leaves two current rows
for a moment, and the gate takes the most recent unsuperseded row, so a
concurrent send in that window reads whichever one the index returned.

**A revocation is a consent row too.** "Stop texting me about my appointments"
said on the phone to a dispatcher had nowhere to go: the STOP keyword writes a
suppression, which is carrier level and channel wide, but a verbal withdrawal was
unrecordable, so the system would keep texting and its own audit trail would say
nothing was ever withdrawn.

**Email requires a granted consent row for marketing, which is stricter than US
law.** CAN-SPAM needs no prior opt in: it needs a working unsubscribe, a postal
address and honest headers. This product requires the opt in anyway, for three
reasons. Canada and the EU require it and a self hosted product cannot know which
regime its operator is under. Gmail and Yahoo's bulk sender rules effectively
enforce it through complaint rate whatever the statute says. And the alternative
is two consent models in one codebase where the SMS one is strict and the email
one is loose, and every future feature has to remember which channel it is on.

**Email registration is a weaker claim than SMS registration, and the difference
is stated rather than papered over.** For SMS, carrier approval is a fact the
carrier asserts and the product stores. Email has no such fact readable without
calling the provider, so the check answers two things only: is there a connected
provider with a From address, and if the operator declared which domains they
verified, is the From one of them. It does not prove SPF, DKIM or DMARC. An
operator who gets those wrong finds out from their bounce rate.

**One email provider per company wins deterministically.** A company with two
would be a company whose customers hear from two different From addresses at
random, so the oldest connected one wins.

**The outbox claims a row before calling the carrier.** The claim is a conditional
update, which is atomic, so two workers cannot both claim the same message and a
worker that dies after claiming leaves a row visibly stuck rather than one that
quietly goes out again. A naive read, send, mark sent loop sends the same
reminder three times the first time a process dies in the middle.

**The unsubscribe page is served here, and GET describes while POST acts.** One
click unsubscribe is a POST sent by the mailbox provider. A human clicking the
link in the body arrives with a GET, and so does every link prefetcher, corporate
mail scanner, security product that follows URLs in inbound mail, and chat client
rendering a preview. If GET unsubscribed, a company's whole list would be opted
out by software over a few months with no human having clicked anything. The
unsubscribe suppresses email marketing only and leaves transactional mail alone.

**The worker's authority is named rather than assumed.** The email sender's worker
holds exactly two permissions and every path goes through a guard, so removing
`message:send` from that list stops the sender, which is what an operator reading
it would expect it to mean.

## Setup

`/settings/integrations` connects Twilio or JustCall for SMS, and Resend or any
SMTP server for email, by the names of the company's own secrets
(`OTS_SECRET__<company>__<name>`), or with the database store by pasting each
one write only, never read back (`docs/self-hosting/secrets.md`). The same Twilio connection, with the same credential and the same
webhook token, answers calls to tracking numbers bought on `/settings` (M19):
it forwards, whispers the channel and campaign to whoever answers, routes by
business hours, takes voicemail, and records only when the caller presses 1 and
the recording check allows it. JustCall has no voice adapter. Other calls reach
this product as records, from a call tracking provider (CallRail, M19) or
logged through `POST /v1/calls`. `docs/self-hosting/voice.md` is the operator's
side of the calls. `/settings/phone` (Settings, Phone menus) builds the phone
menus and ring groups the company's own number answers with, and says which
phone each person answers on. `/settings` holds the phone numbers and the call recording
policy. A2P 10DLC brand and campaign registration is recorded through
`POST /v1/messaging/brands` and `POST /v1/messaging/campaigns`, and the setup
wizard flags it as needing somebody else's review queue.
`docs/self-hosting/messaging.md` is the operator's side of this.

## Using it

### The inbox

`/inbox` is threads by customer, and the same thread is on the customer's page.
`GET /v1/conversations`, `GET /v1/conversations/{id}`,
`POST /v1/conversations` to text somebody first, and
`POST /v1/conversations/{id}/messages` to reply.

### Consent

`GET /v1/consent` is what a number has agreed to, shown beside the conversation.
`POST /v1/consent` grants and `POST /v1/consent/revoke` withdraws. Both need
`message:send`, because deciding what may be sent to somebody is part of sending.

### Email

`POST /v1/email/messages` queues one and `POST /v1/email/send-queued` hands it to
the provider. The worker does the same on its pass for every company that queued
something, the way it sends texts, so a report or a statement queued at seven in
the morning by the worker itself goes out without anybody pressing anything. An
email can carry files: a delivered report's CSV is kept beside its message and
handed to Resend or the SMTP server with it. `GET /v1/email/suppressions` is the list,
`POST /v1/email/suppressions` adds an address and
`DELETE /v1/email/suppressions/{address}` lifts one.

### Calls

`GET /v1/calls` and `GET /v1/calls/{id}` read the history,
`POST /v1/calls` logs one, and the recording has its own three calls:
`POST /v1/calls/{id}/recording-decision`,
`POST /v1/calls/{id}/recording` and
`DELETE /v1/calls/{id}/recording`.

A call to a number bought here runs the same two gates from the carrier's
webhook, through the same functions the routes call: the recording decision is
taken after the caller has been asked, with the operator's declared policies,
and a finished recording is attached only when that decision said yes. The
audio is fetched from the carrier, kept as a stored file (call audio is
accepted by the file store for this and for nothing a person uploads), and the
carrier's copy deleted, so deleting the recording here deletes the bytes. A
voicemail is kept the same way: it is a message the caller chose to leave
after being asked to, not a recording of a conversation. Both play on the call
screen for whoever holds `message:read`.

A call nobody answered emits `call.missed`, which the missed call text back
automation (M29) listens for. Its text goes through `sendTransactional`, the one
gate every conversational text takes: from the company's ordinary number,
never a tracking one, and never to somebody who replied STOP. Recording policy per jurisdiction is set with
`POST /v1/recording-policies` and read with `GET /v1/recording-policies`.

### Phone menus, ring groups and the on call week

`/settings/phone` builds a menu: what callers hear first, then each option
read out from its own label ("For Billing, press 2"), each ringing a person, a
ring group, voicemail, another menu, whoever is on call, or a number outside
the company. A caller who presses a wrong key is told so and hears it again;
one who presses nothing hears it three times and then goes where the menu says.
Outside the business hours online booking keeps, calls go where the menu's
after hours setting says, usually whoever is on call. Every save is checked
against what exists, so an option ringing a person with no number, a deleted
group or a number nobody can dial is refused with the option named, and a menu
or group that something still sends calls to cannot be deleted.

A ring group rings its phones all at once (the first to pick up gets the
caller) or one after another, then sends the caller where it says when nobody
picks up. People are rung on the number the company keeps for them
(`answering_phone`), read at the moment of the call, so somebody who has left
or lost their number is skipped and the reason written on the call.

A number already on the company's own Twilio account is answered here with
`POST /v1/phone-numbers/{id}/answer-here`: only its calls are pointed here, and
where they went before is written down. `POST /v1/phone-numbers/{id}/stop-answering`
puts them back, and releasing such a number never releases it at Twilio. The
menu that answers a number is set with
`PATCH /v1/marketing/tracking-numbers/{id}/routing` (`menuId`).

The routes: `GET /v1/phone-menus`, `POST /v1/phone-menus`,
`PUT /v1/phone-menus/{id}`, `DELETE /v1/phone-menus/{id}`, `GET /v1/ring-groups`,
`POST /v1/ring-groups`, `PUT /v1/ring-groups/{id}`, `DELETE /v1/ring-groups/{id}`,
`GET /v1/answering-phones` and `PUT /v1/answering-phones/{userId}`, all
`settings:read` to read and `settings:write` to change.

The on call rota is filled a week at a time on `/schedule/crews`, or with
`POST /v1/on-call/weeks` (`visit:dispatch`): people take a week each in turn,
the phone changing hands at the same time on the company's clock every week,
including the weeks the clocks change, and a fill that collides with somebody
already on call adds nothing.

On the call screen, "What they pressed" lists each menu choice in order and
"Where it went" says where the call ended up and why (nobody was on call, the
group had nobody left to ring).

### Transcripts

With speech to text connected (`/settings/integrations`, Call transcripts:
OpenAI's Whisper API or a Whisper server the company runs itself), every call
recording the recording check allowed and every voicemail is written out by the
worker shortly after it is kept. The words go through the same gate as a
transcript sent by an integration: malformed output is refused, and card
numbers and security codes are removed before the first write. The call screen
shows the transcript with its times, what was removed, and a warning when the
speech to text was unsure; "Write it out now" (`POST /v1/calls/{id}/transcribe`,
`message:send`) sends one again. The call log (`/marketing/calls`) and
`GET /v1/calls` search what was said (`q`). Deleting a recording deletes its
transcript, and a call somebody asked not to be recorded never gets one.

### Replies by email

With a reply domain set on the Resend connection, every email this product
sends carries a reply address with its thread's token in it, and Resend posts
each reply to `/api/webhooks/email/{token}`, signed with the same secret as
delivery callbacks. The reply lands in the thread it answers whatever address
the customer replied from, with the quoted email cut off; somebody writing to
the reply address fresh starts a thread of their own, a retried delivery is
stored once, and an out of office is kept without announcing anything. An email
thread in the inbox is answered by email, under its own subject.

### Pictures

A picture texted in on Twilio is fetched with the account's credentials and
kept as a stored file, so the inbox shows it to somebody with no login at the
carrier; a video or a contact card is named in the thread and not kept. The
inbox sends pictures too (`POST /v1/conversations/{id}/messages` with
`pictures`): JPEG, PNG or GIF, three at most and five megabytes together, as a
picture message the carrier fetches from an unguessable address under the
messaging webhook that answers for a week. On an email thread they go as
attachments. Every picture send goes through the same consent gate as a text.

### Templates

`GET /v1/message-templates`, `POST /v1/message-templates` and
`POST /v1/message-templates/preview`. These are settings permissions, because a
template is a standing decision about what the company says.

## Permissions

| Role | Access |
|---|---|
| Owner, administrator | Everything |
| Office manager | Reads and sends, manages consent and suppression |
| Dispatcher | Reads and sends, so they can text a customer about the day |
| CSR | Reads and sends |
| Technician | Reads and sends, scoped to their own conversations |
| Accountant | Neither |

A conversation is scoped separately from a customer, deliberately: it contains
what somebody said, which is more sensitive than their address, and a technician
holds `message:send` because they text from the field. Without that scope,
`message:read` was the whole company's inbox.

## API

| Call | Needs |
|---|---|
| `GET /v1/conversations` | `message:read` |
| `POST /v1/conversations` | `message:send` |
| `GET /v1/consent` | `message:read` |
| `POST /v1/consent/revoke` | `message:send` |
| `POST /v1/email/messages` | `message:send` |
| `GET /v1/email/suppressions` | `message:read` |
| `GET /v1/calls` | `message:read` |
| `POST /v1/calls/{id}/transcribe` | `message:send` |
| `GET /v1/phone-menus` | `settings:read` |
| `POST /v1/phone-menus` | `settings:write` |
| `POST /v1/ring-groups` | `settings:write` |
| `PUT /v1/answering-phones/{userId}` | `settings:write` |
| `POST /v1/phone-numbers/{id}/answer-here` | `settings:write` |
| `GET /v1/public/unsubscribe/{token}` | nothing: the token is the authority |
| `POST /v1/public/unsubscribe/{token}` | nothing |

## Common questions

**Does a STOP text stop appointment reminders too?** A carrier level suppression
is channel wide, so yes. A revocation recorded for the marketing purpose only
stops marketing.

**Why do quiet hours apply to email?** Not because of the law: email is outside
the TCPA. A marketing email arriving at two in the morning lands at the top of an
inbox read at seven with eleven hours of other mail on top of it, or wakes a
phone. The window is the company's own, so a company that wants to send overnight
turns it off once.

**Can a technician's on my way text bypass a STOP?** No. It goes through the same
gate as everything else.

## What is not built

Nothing checks that the unsubscribe URL handed to the email sender points at the
page this product serves, so a caller can satisfy the gate with any string,
including a 404. Campaigns supply the real one; another caller might not.

Calls: nothing places a call from the browser, there is no waiting line with
hold music (a menu option cannot send callers to a queue, and saying so is
refused), no voice agent and no call deflection. A menu takes key presses only,
not spoken answers. Business hours come from online booking and have no holiday
list. JustCall has no voice adapter.

Transcripts do not tell voices apart: a recorded call reads as one stream of
words. Only the Whisper API is an adapter; Twilio's own transcription is not
used, because it gives no confidence and covers voicemails only. The worker
writes audio out on its passes for a company with new events, so a provider
that was down catches up on the company's next event or from "Write it out now".

Email replies need a provider that receives mail (Resend); a reply to mail sent
over plain SMTP still goes to the From mailbox. Files attached to a reply are
named in the thread and not kept, and the reply's HTML is not kept, only its
words.

Pictures: JustCall's are kept as the carrier's link only. The carrier keeps its
own copy of a picture texted in until it is deleted at Twilio.

The messaging registration records a carrier's decision and does not submit the
application.
