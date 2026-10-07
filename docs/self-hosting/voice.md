# Calls on your own Twilio account

Tracking numbers can be bought on the settings screen and answered by this
installation, by a phone menu, a ring group, a waiting line, the phone
assistant, or a person in their browser: the call is recorded and credited to
its campaign, the person answering hears where it came from, calls outside
business hours go where you say, the caller is asked before anything is
recorded, and an unanswered call leaves a voicemail and can be texted back.
All of it runs through the Twilio account you already text through. There is
no second account, and the only second credential is the API key the browser
phone signs its passes with.

## What you need first

1. **Twilio connected for texts**, as `docs/self-hosting/messaging.md`
   describes: the Account SID on the connection, the auth token in your
   company's own secrets under the name the connection holds, and the webhook
   token the connection was given. Voice uses all three as they are. With the
   default store the token is the variable
   `OTS_SECRET__<company id>__<name>`, which **Settings → Integrations** shows
   under the connection; with `SECRET_STORE=database` it is pasted there and
   kept encrypted. A variable with the bare name alone is never read
   ([secrets.md](secrets.md)).
2. **`PUBLIC_URL`** set to the address Twilio reaches you on, with its scheme,
   and no trailing path. Every webhook URL a number is pointed at is built
   from it, and Twilio signs each request over the full URL it called, so a
   `PUBLIC_URL` that differs from what Twilio called (http against https, a
   different host behind a proxy) makes every call fail its signature and be
   refused.
3. **Your recording declarations**, on **Settings**, if you want recording at
   all. Without them every call resolves to the strictest rule, which a caller
   pressing 1 still satisfies; with a broken set of declarations nothing is
   recorded.
4. **Business hours**, on **Booking**, if a number should route by them. A
   company with no hours declared is treated as always open.

## Buying a number

**Settings**, under phone numbers, then "Buy a number from your Twilio
account": search by area code or town, pick one, choose a tracking campaign (or
"Website pool" for the snippet's numbers), and buy. The purchase sets the
number's webhooks at Twilio itself:

```
Voice URL        https://your-host/api/webhooks/voice/<webhookToken>
Status callback  https://your-host/api/webhooks/voice/<webhookToken>/status
Messaging URL    https://your-host/api/webhooks/messaging/<webhookToken>
```

Nothing has to be pasted into the Twilio console. A number you already own at
Twilio can be pointed at the same three URLs by hand and then added on the
settings screen; the "Save how it rings" settings only appear for numbers
bought here, because only those are known to be pointed at this installation.

Each step of a call (the answer to the recording question, the whisper, the
result of ringing the office, the voicemail, the recording) is a path beneath
the voice URL. Twilio is told each one in the instructions it is given, so
nothing else needs configuring, and each is signed and checked like the first.

## Answering a number you already have

A number already on your Twilio account (the one your texts go from, usually)
can be answered here without buying another: Settings, Phone menus, "Answer
calls here". Its Voice URL and status callback are pointed at this
installation and what they were before is written down; its SMS URL is left
alone. "Stop answering here" puts the old ones back, and releasing such a
number here never releases it at Twilio, because that would give it away.

## Phone menus and ring groups

Menus and ring groups are built on Settings, Phone menus. Each step of a call
through a menu (the key pressed, the next person in a group that rings one
after another) comes back to the same voice webhook path with what the step
needs in its query string, and the query string is part of what Twilio signs,
so an edited step fails the signature like a forged body. A call is passed
between at most eight destinations before it goes to voicemail, whatever the
settings say, so no combination of menus and groups can keep a caller going
round. People are rung on the number kept for them on that screen.

## Waiting lines

Made on Settings, Phone menus, and reached from a menu option like any other
destination. A caller sent to one is put in a Twilio queue named after the
line, and Twilio asks this installation what to play each time the music
finishes (`/queue-wait` beneath the voice URL): the caller's place, then the
music, which is the line's own MP3 or Twilio's hold music. Each of those
requests is also when the line's ring group is rung: this installation places
an outbound call from the company's number, through the same Twilio account,
to each phone (or browser) in the round, and whoever answers is put through
to the caller at the front. Those calls are on the company's Twilio bill like
any other. Pick a hold track of a minute or two: the longest wait is checked
only between plays, so a ten minute track lets a caller wait ten minutes past
the limit.

## The phone assistant and the voice relay

The phone assistant (M27) is the company's own model answering a call. Twilio
holds the call with ConversationRelay, turns the caller's speech into text and
sends it over a WebSocket; the answer goes back as text and Twilio reads it
aloud. The web app cannot hold a WebSocket open (a Next.js route handler
answers a request and is done), so the conversations go to the **voice
relay**, a small process of its own:

```
pnpm --filter @opentradesos/api voice-relay
```

or, with Docker, `docker compose -f deploy/docker/docker-compose.yml --profile voice up`.

It needs, in its own environment:

- `DATABASE_URL`, the same role the web app uses: it writes what the carrier's
  webhooks write.
- `VOICE_RELAY_URL`, the public `wss://` address Twilio reaches it on, for
  example `wss://relay.example.com`. The **web app needs the same value**: it
  is what the web app hands Twilio when a call is sent to the assistant, and
  Twilio signs the WebSocket handshake over that exact address, which the relay
  checks with the account's auth token before it accepts the connection.
- `VOICE_RELAY_PORT`, where it listens, 3300 when unset. Put it behind
  whatever terminates TLS for the web app; Twilio will only open `wss://`.
- The secrets the Twilio and model connections name, the same as the web app
  and the worker.

Without `VOICE_RELAY_URL` on the web app, a call sent to the assistant goes
where the assistant puts callers through (its ring group, or voicemail), and
"Where it went" on the call says why. If the relay is down when a call
arrives, Twilio cannot open the conversation and the caller is put through the
same way. Restarting the relay cuts off conversations in progress, and those
callers are put through too. `GET /healthz` on the relay's port answers `ok`.

Nothing in the relay decides anything about a call: it checks who is
connecting and hands each message to the same services the webhooks use.

## Calling from the browser

The browser phone at `/phone` uses Twilio's Voice JavaScript SDK, which
registers each browser with Twilio using a short lived pass this
installation signs with an API key on your account:

1. In the Twilio console, make an API key (Standard is enough). Put its secret
   in this installation's secret store, for example
   `TWILIO_API_KEY_SECRET=...` in `.env`, on the web app.
2. On Settings, Phone menus, under "Calling from the browser", give the key's
   SID (`SK...`), the secret's name, and the number calls should show. The
   number must be one answered here, because Twilio only shows a number on a
   call when it is on the same account.
3. Saving makes a TwiML application on your account, "OpenTradesOS browser
   phone", whose voice URL is `/softphone` beneath the voice URL above. Saving
   again points the same application again rather than making another.

Browsers need a microphone and the page open over https. Calls from the
browser are logged like every call; on a number set to record calls the
person called is asked to press 1 first, and recording is started through
Twilio's API only on their yes.

## Transcripts

Connect speech to text under Settings, Integrations, Call transcripts. It
speaks the Whisper API: OpenAI's (an API key in the company's own secrets,
its name on the form, read the same way as the Twilio token above) or a
Whisper server you run yourself, such as faster-whisper-server, LocalAI or the
whisper.cpp server. A server of your own is the deployment's to set, as
`WHISPER_URL` (up to and including `/v1`), and applies to every company here
that connects speech to text; with it set the key is optional. A company
cannot point its connection at an address of its choosing, for the reason in
[secrets.md](secrets.md#provider-addresses-are-fixed): the server would send
the key it holds, and every customer's voice, wherever it was told. The
worker sends each kept recording and voicemail to it with no database
transaction open, and writes the words back through the redaction gate. The
audio leaves your network only if the server is outside it.

## What is kept, and where

A permitted recording and every voicemail are fetched from Twilio when it says
they are ready, kept in this installation's file store (Postgres, by default),
and then **deleted at Twilio**. The copy here is the only copy, so deleting a
recording on the call screen or through the API deletes it everywhere, and a
retention policy for `call_recording` that allows purging is applied by the
worker. A recording Twilio made for a call that was not allowed one is deleted
at Twilio and never kept.

Recordings are fetched only from Twilio's own API host, with the account's
credentials. A webhook naming a recording anywhere else is refused rather than
fetched. Every request goes to `api.twilio.com`: a `baseUrl` on the
connection is refused when it is saved and ignored if one is found, unless the
server runs with `ALLOW_PROVIDER_BASE_URL=1`, which only the test suites set
([secrets.md](secrets.md#provider-addresses-are-fixed)).

## Releasing a number

"Hand it back to Twilio" releases it at Twilio first and then here. If Twilio
refuses, nothing changes here and the screen says why. A number already gone
at Twilio (released in their console) is released here too.

## When it does not work

- **Every call is refused with 403.** `PUBLIC_URL` does not match the address
  Twilio called. Compare it with the Voice URL on the number in the Twilio
  console, character for character.
- **Calls answer "not in service".** The number is not on file here, or was
  released here. Add it on the settings screen, or release it at Twilio.
- **"Connect your Twilio account first" when buying.** No connected Twilio
  messaging connection.
- **"No secret named … is set for this company".** The auth token is not
  where this version reads it. The message names the variable
  (`OTS_SECRET__<company id>__<name>`); set it and restart, or paste the token
  on **Settings → Integrations** with the database store. An install upgraded
  from a version that read `TWILIO_AUTH_TOKEN` alone has to rename it.
- **A menu option rings nobody.** The person has no number on Settings, Phone
  menus, or the group's members have none; the call screen says which under
  "Where it went", and the call went to voicemail.
- **Transcripts stay "Being written out".** The worker is not running, or the
  speech to text server cannot be reached; the reason is on the call once it
  gives up, and "Write it out now" tries again.
- **Nothing is ever recorded.** Recording is off for the number, the callers
  are not pressing 1, or your recording declarations do not pass their own
  check. The call screen says which, under "Not recorded".
- **Calls sent to the phone assistant go straight to a person.** The web app
  has no `VOICE_RELAY_URL`, the relay is not running or not reachable at it
  over `wss://`, or the assistant is switched off; "Where it went" says which.
  A relay that refuses every connection with 403 has a `VOICE_RELAY_URL` that
  differs from the address Twilio connected to.
- **Callers wait in a line and nobody is rung.** The line's ring group has
  nobody with a number (or a browser taking calls), which the call says, or
  Twilio refused the outbound calls, which the call also says.
- **The browser phone says it is not set up, or will not switch on.** The API
  key's secret is not in this installation's environment under the name given,
  or the number it shows is no longer answered here.

## What has not been tried

The waiting line, the phone assistant and the browser phone are built from
Twilio's documentation and tested against a fake Twilio: signed webhooks, a
fake REST API, and a WebSocket client playing ConversationRelay's part. None
of the three has been tried on a live phone line. Try each on a number of your
own before sending customers to it.
