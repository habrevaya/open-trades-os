# Calls on your own Twilio account

Tracking numbers can be bought on the settings screen and answered by this
installation: the call is recorded and credited to its campaign, the person
answering hears where it came from, calls outside business hours go where you
say, the caller is asked before anything is recorded, and an unanswered call
leaves a voicemail and can be texted back. All of it runs through the Twilio
account you already text through. There is no second account and no second
credential.

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
