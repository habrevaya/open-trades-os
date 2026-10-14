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

Sends and receives texts and email, answers and logs calls (phone menus, ring
groups, waiting lines, the phone assistant, and calls made and taken in the
browser), keeps a thread per customer, and enforces consent, suppression and
quiet hours on every send.

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

**A marketing email's unsubscribe link has to be this product's own.** The sender
refuses marketing with no link, and it also refuses a link it did not make: the
URL has to be `PUBLIC_BASE_URL` followed by the unsubscribe page's path and a
token, with nothing after it, the token has to be one this company issued, and it
has to have been issued for the address the mail is going to. A 404, a page on
another system that cannot write a suppression here, another company's link and a
link for somebody else are all refused, because each one is a button that leaves
the reader on the list. Campaigns make their own links; `POST /v1/email/messages`
makes one for the address when the caller leaves `unsubscribeUrl` out, and takes
it back if the send is then refused.

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
menus, ring groups and waiting lines the company's own number answers with,
says which phone each person answers on, and sets up calling from the
browser. The phone assistant is switched on and set up on `/settings/agents`
(M27), and its conversations need the voice relay running beside the web app
(`VOICE_RELAY_URL`, `docs/self-hosting/voice.md`). `/settings` holds the phone numbers and the call recording
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
ring group, voicemail, another menu, whoever is on call, a number outside
the company, a waiting line, or the phone assistant. A caller who presses a wrong key is told so and hears it again;
one who presses nothing hears it three times and then goes where the menu says.
Outside the business hours online booking keeps, calls go where the menu's
after hours setting says, usually whoever is on call. The company's holiday list
(`/settings/holidays`, M02) is read with them: on a closed holiday a call goes
where an after hours call goes whatever the weekday, and on a short day the
day's own hours decide. Every save is checked
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

### Waiting lines

"All our team are on other calls." A waiting line, made on `/settings/phone`,
holds a caller with hold music (the carrier's own, or an MP3 the company
names) and, unless switched off, tells them their place in line each time the
music comes round. While they wait, the people in the line's ring group are
rung: all of them each round when the group rings all at once, the next person
each round when it rings one after another, and in the browser for anybody
taking calls there. A round is given the group's ring time and ten seconds
before the next. Whoever picks up hears which line the caller is waiting on
and is put through to the caller at the front; somebody who picks up a moment
after a colleague is told the caller has been answered. After the longest wait
the line allows (thirty seconds to thirty minutes) the caller goes where it
overflows to, voicemail unless the owner chose otherwise, and the call says how
long they waited. A caller who hangs up while waiting is a missed call.

Somebody already on a call is left out of each round: the next person in turn
who is free, or everybody free at once. This product knows a person is on a
call when it saw them pick up (in the browser, from a waiting line, a
callback, or on a number that whispers) or place one from the browser, until
the carrier says the call is over; somebody who answered a plain forwarded call
on their own phone is not seen picking up, so they are still rung. A call the
carrier never reported the end of stops counting after three hours. The first
round's call says who was left out ("Not rung, already on a call").

**Saying how long.** With "Tell callers how long callers have lately waited"
on, a caller is told once, as they join, "Most callers lately have been
answered within about 3 minutes": the longer end of the waits of the last
twenty callers this line put through in the past three hours (three in four of
them were answered within it), rounded up to whole minutes. With fewer than
five answered lately nothing is said at all, and it is said as what happened
lately, never as a promise about this call. Off on lines made before it; on by
default on the form for a new line.

**Being called back.** With "Let callers press 1 to be called back" on (off
unless the owner turns it on), every turn of the music offers it, and the
caller can press 1 at any moment of the music. They are told "We will call you
back on" their own number, read back a digit at a time, and hang up. Only the
number they called from is rung, and a caller whose number was withheld is
never offered it. They keep their place: the next person free in the line's
ring group (and anybody already on a call is not rung) is given whichever of
the callers still on hold and the callers waiting to be called back joined
the line first, and a caller on hold behind a callback hears that there is a
caller ahead of them. That person is rung first; when they pick up they hear
"A Service line caller asked to be called back. Calling them now." and the
caller is rung from the company's number with them already on the line. The
callback is logged as a call the office placed, by that person, and is never
recorded, because nobody on it was asked. Two people picking up at once
cannot both ring the same caller: the callback is claimed first. A caller who
does not pick up is tried once more five minutes later; after that, or if
nobody in the group was free within an hour of asking, it becomes a high
priority task on the office's queue ("Call back +1 512 ..."), on the customer
when there is one, and only then is the caller's call a missed call, which is
what the missed call text back listens for. Deleting a line turns its waiting
callbacks into tasks the same way. The caller's own call says, under "Where it
went", when they asked, who rang them back and whether they picked up.

When nobody is on hold, the group is rung for the callback at the front of
each line by the carrier's own reports: a call ending anywhere at the company
(somebody perhaps coming free), and the last call of a round ending (the next
round's cue). The worker does the same on its passes, and hands to the office
the callbacks that have waited an hour.

`GET /v1/call-queues`, `POST /v1/call-queues`, `PUT /v1/call-queues/{id}` and
`DELETE /v1/call-queues/{id}`, `settings:read` to read and `settings:write` to
change, the same as menus; `offerCallback` and `announceWait` are the two
settings above. A line, and the group it rings, cannot be deleted
while something still sends callers to it.

### The phone assistant

A menu option, after hours, a ring group nobody answers or a waiting line's
overflow can send a call to the phone assistant: the company's own AI model
answering the call, through Twilio's ConversationRelay, which turns speech into
text and back. It says first, in words no model wrote and that cannot be talked
over, that it is an automated assistant and that the call is written down. What
it may do, who it acts as and the log of what it did are M27's; on the call
screen it shows what it heard, what it said and what it did. It says its
replies a sentence at a time as the model writes them. When it puts a caller
through, they go to the ring group chosen on its settings, or voicemail, or to
one of the waiting lines and menus the owner allowed it when that fits better.
When it is switched off, or this installation runs no relay, a call sent to it
goes there too, with the reason under "Where it went".

### Calling from the browser

`/phone` (Phone) is a phone in the office app: ring a customer from the
company's number, with the keypad for a menu at the other end, mute and hang
up; and, with "Take calls here" on, be rung there instead of on your own phone
by any ring group you are in. The page says while it is taking calls once a
minute, and a browser that stops saying so is rung on the person's phone again
within two and a half minutes. Each call is logged with who placed it or picked
it up. A call placed from the browser on a number that records calls asks the
person called to press 1 before anything is recorded, the same question a
caller is asked on the way in, and recording starts only on their yes.

**Hold and passing a caller on.** While somebody has a caller they picked up
in the browser (or that was passed to them), `/phone` shows "Your call" with
"Put on hold" and "Pass the caller on". On hold, the caller hears "Please
hold." and music, and the person's own call ends; "Take them back" on the
phone rings the caller's hold from the browser and picks them up again. A
caller can be passed to a colleague (rung in the browser when they are taking
calls there, on their phone otherwise), a ring group or a waiting line,
straight away, in which case the person's call ends and the caller goes there
as a menu option would send them (to voicemail if nobody picks up), or, to a
colleague only, after talking to them first: the caller is held, "Ring" calls
the colleague from the browser, who is told who is passing them a caller and
from which number, and "Hand over the caller" joins the colleague to the
caller and ends the person's call; "Do not pass them on" ends the colleague's
call and keeps the caller on hold. A caller left on hold fifteen minutes goes
to voicemail and the office gets a high priority task to call them back. Only
the person who has the caller now can hold or pass them, whatever their role,
and the caller's call says under "Where it went" who passed them on, to where,
and who they were handed to. Whoever has the caller now is who a waiting line
counts as busy.

`GET /v1/softphone/call` (the call you have now),
`GET /v1/softphone/transfer-targets` (colleagues who can be rung, and the ring
groups and waiting lines by name), `POST /v1/calls/{id}/hold`,
`POST /v1/calls/{id}/transfer`, `POST /v1/call-transfers/{id}/complete` and
`POST /v1/call-transfers/{id}/cancel`, all `call:place`. On the carrier, the
caller's leg is moved with Twilio's REST API: to a queue of its own for hold,
or to where they are passed; "Hand over" moves the colleague's leg to the
caller's queue.

An owner sets it up once on `/settings/phone`: an API key made in the Twilio
console (its SID, and the name of the secret in this installation's secret
store that holds its secret) and the number calls show, which must be one
answered here. This product then makes the application on the company's own
Twilio account that browser calls go through. `PUT /v1/softphone` sets it up
(`settings:write`); `GET /v1/softphone`, `POST /v1/softphone/token` (a pass
for the person's own browser, good for an hour) and
`PUT /v1/softphone/presence` need `call:place`, which the office manager,
dispatcher and customer service roles hold and technicians do not. Every call
a browser places is checked again when it is made: the person is still a
member who may, the number is one a phone can dial, and it is not an emergency
number, which a browser cannot be located for.

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

Files that come with a reply are kept. Before the reply is written, each file
Resend names is described by its received emails API and downloaded from the
address it gives (HTTPS only, read no further than the limit), and the ones
that pass are kept in the company's own file store, in Postgres or the bucket
(`FILE_STORAGE`), attached to the message as an `email_attachment` with the
name it came with. What passes is decided by core's `files` module and checked
again when the message is written: the types every upload here is held to,
decided from the bytes (pictures and PDF); never a program or a script, refused
by its name or claimed type before a byte is downloaded (`.exe`, `.js`, `.bat`,
`.html`, `.svg` and the rest) and by its bytes whatever it was called (a
Windows, Linux or Mac program, or a script starting `#!`); ten megabytes a
file, twenty five on one email, and the first ten files. Every file that was
not kept is named in the thread with the reason, and so is one that could not
be fetched: the customer's words are kept either way, and the file is still in
the email at the provider. In the thread a kept picture is shown and a kept PDF
is "Download" and its name, both through `/inbox/{id}/media/...`, which serves
a file only to somebody who may read that conversation (`message:read` and the
conversation scope) and only when a message in that thread points at it; with
`?download=1` it is saved under its own name with the extension of what the
bytes are. `GET /v1/conversations/{id}` gives each file's `name`.

The reply's HTML is kept only as text (`htmlText` on the message): its tags,
scripts, styles and comments are dropped and its entities read as characters,
and the HTML itself is never stored. The thread shows that text under "The
email as it was laid out, as text" when it says more than the plain part, and
draws it as text, so markup in it is shown as characters and never runs.

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
| Office manager | Reads and sends, manages consent and suppression, calls from the browser, holds and passes on their own callers |
| Dispatcher | Reads and sends, so they can text a customer about the day, calls from the browser, holds and passes on their own callers |
| CSR | Reads and sends, calls from the browser, holds and passes on their own callers |
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
| `GET /v1/call-queues` | `settings:read` |
| `POST /v1/call-queues` | `settings:write` |
| `PUT /v1/softphone` | `settings:write` |
| `GET /v1/softphone` | `call:place` |
| `POST /v1/softphone/token` | `call:place` |
| `PUT /v1/softphone/presence` | `call:place` |
| `GET /v1/softphone/call` | `call:place` |
| `GET /v1/softphone/transfer-targets` | `call:place` |
| `POST /v1/calls/{id}/hold` | `call:place` |
| `POST /v1/calls/{id}/transfer` | `call:place` |
| `POST /v1/call-transfers/{id}/complete` | `call:place` |
| `POST /v1/call-transfers/{id}/cancel` | `call:place` |
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

Calls: none of the waiting line, the phone assistant or the browser phone has
been tried on a live phone line. Each is built from Twilio's documentation and
tested against a fake carrier: signed webhooks, a WebSocket client playing
ConversationRelay's part, and a fake REST API. A menu takes key presses only,
not spoken answers. Business hours come from online booking and the holiday
list from Settings, one of each for the whole company: a number cannot keep
hours or holidays of its own. JustCall has no voice adapter.

Waiting lines: the longest wait and the caller's place are checked each time
the hold music finishes, so a long track lets a caller wait past the limit by
up to its length. Each round is an outbound call per phone on the company's
carrier bill, and so is each round rung for a callback, for up to an hour. A
person on a call is skipped only when this product saw them pick up or place
it (see Waiting lines above); one who answered a plain forwarded call on their
own phone is still rung. The callback offer is said inside the carrier's wait
for a key with the music, and taking the caller out of the line on a 1 is
Twilio's documented `Leave` from a key press: like the rest of the line it has
been tested against a fake carrier, not a live one. A caller is rung back only
on the number they called from; they cannot type another. A callback is never
recorded. The estimate is the same for every caller in the line whatever
their place, said once as they join, and it is not said at all from fewer than
five answered callers in the last three hours.

Browser phone: a call lasts only as long as the `/phone` page stays open, so
somebody taking calls keeps it in a tab of its own. Hold and passing a caller
on work only for calls that came in: on a call placed from the browser the
person called is on a leg the carrier names only when the call ends, so it
cannot be moved, and the screen does not offer it. Hold and passing on move
the caller's leg with Twilio's REST API, built from its documentation and
tested against a fake carrier, not a live line: in particular, that moving the
caller out of a ring group's dial does not also run what the dial does when it
ends is Twilio's documented behaviour, and the step here ignores that result
while a caller is held, but has not been seen on a real call. Talking to a
colleague first is to one colleague, never a ring group or a waiting line,
and that call to the colleague is not on the call log. There is no conference
of three and no second call while on one (a second call to the browser is
declined and rings the rest of the group); somebody taking a caller back from
hold, or a colleague handed one, picks them up as a new call in the browser. A browser
whose page was closed without switching off may be rung for up to two and a
half minutes before its owner's phone is rung again. The technician app has no
browser phone. Nothing here limits which countries a browser may ring beyond
refusing emergency numbers: the geographic permissions on the company's Twilio
account are what stop a call to a premium rate number abroad.

The phone assistant: see M27's "What is not built". The audio of its part of a
call is never recorded; what it heard is kept as text.

Transcripts do not tell voices apart: a recorded call reads as one stream of
words. Only the Whisper API is an adapter; Twilio's own transcription is not
used, because it gives no confidence and covers voicemails only. The worker
writes audio out on its passes for a company with new events, so a provider
that was down catches up on the company's next event or from "Write it out now".

Email replies need a provider that receives mail (Resend); a reply to mail sent
over plain SMTP still goes to the From mailbox. Attachments are fetched only
from Resend, and tested against a fake of its received emails API, not a live
account; another provider's reply files are named and not kept. A file that
could not be fetched is not fetched again later: the thread says it is still at
the provider. Only pictures and PDFs are kept, so a Word document, a
spreadsheet or a zip that came with a reply is named and not kept. A retried
delivery of a reply already stored downloads its files again before it is
recognised and dropped. The reply's HTML is kept only as text, never as HTML.

Pictures: JustCall's are kept as the carrier's link only. The carrier keeps its
own copy of a picture texted in until it is deleted at Twilio.

The messaging registration records a carrier's decision and does not submit the
application.
