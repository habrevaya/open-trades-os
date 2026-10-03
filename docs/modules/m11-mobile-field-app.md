---
title: Mobile Field App
module: M11
domain: Operate
phase: 3
status: partial
---

# Mobile Field App

> Module M11. Domain: Operate. Ships in phase 3.

## What it does

Runs a technician's whole day from a phone: the visits, the clock, the
checklist, the readings, the parts, the photos, the signature. Offline, because
the basement is where the furnace is.

## The problem

A technician with no signal is the normal case, not the edge case. Every design
that treats sync as "save the row and retry" fails on the same day: the office
changes something while the phone is offline, and then one of two bad things
happens. Either the server rejects the technician's write, which destroys the
labour record, the photos, the signature, the readings and, in a regulated
trade, a compliance record that legally has to exist. Or the phone's write
silently overwrites the office's, and dispatch finds out on Friday.

Neither is acceptable, and "last write wins" is the wrong default because the
right answer is different for different things.

## Key concepts

**Writes are named intents, not row diffs.** Seventeen operation kinds and the
list is closed (the sixteenth, `payment.collect`, is money taken on site, and the seventeenth, `inspection.record`, is an inspection filed whole): a new kind is a schema decision and a conflict decision, not
something a client invents.

**The conflict rule is per kind.** Four rules, and which one applies is the
whole design:

| Rule | Behaviour | Example |
|---|---|---|
| fact | It happened. Record it whatever the current state says, and raise a conflict if the state disagrees | Arriving at a visit somebody cancelled is still an arrival |
| append | It adds a row, so nothing can conflict with it | A part used, a photo, a note |
| edit | It sets a value; the most recent by occurrence time wins | A form field somebody typed into twice |
| transition | It moves state and only makes sense from certain states; rejected and returned to the device rather than forced | Submitting a service report |

**A punch is a payroll record.** Never dropped, never overwritten, never
reordered, because somebody is paid from these.

**Nothing is lost on the phone.** An operation is durable before the caller is
told it happened. A tap that appears to work and then is not there after a
restart is worse than a tap that visibly fails, because the technician has
moved on.

**Nothing is duplicated.** The client id is generated once, persisted with the
operation, and reused on every retry. A queue that regenerates it turns one
punch into four.

**Nothing is reordered.** Sequence numbers come from a counter persisted before
use and never reused, including across a reinstall that kept the device
registration. A gap is recoverable; a repeat is not, because the server treats
it as a replay and discards the second one.

**The sequence is per device, not global.** Two technicians working offline have
no shared clock and no shared order, and pretending otherwise invents one.

**The whole batch applies in one transaction.** A day that half lands is worse
than one that does not land at all, because the technician cannot tell which
half and will either redo work or not redo it, and both are wrong.

**Nothing is dropped, including what could not be applied.** The log is the
evidence for what somebody was paid and what a customer was billed. An
operation that vanishes because it arrived inconveniently is the failure this
design exists to prevent.

**Every operation kind has an effect outside the log, and a test fails if one
stops.** Three kinds once fell through to a default branch with a comment
claiming another path applied them; no such path existed, and the server marked
them applied anyway. The phone deletes an applied operation from its queue, so a
chemical application recorded in a crawl space was accepted, acknowledged, and
gone.

**The queue's storage is injected.** On a phone it is AsyncStorage or SQLite; in
a test it is a map. The interesting failures are ordering, crash recovery and
duplication, none of which need a device to reproduce and all of which are
miserable to reproduce on one. So the app being killed, the battery dying mid
write and a response truncated by a dropped connection are tested in a
millisecond.

## Using it

### The technician's day

Two ways, sharing one queue. The phone app in `apps/mobile` is an Expo app a
company builds and installs (`apps/mobile/README.md` says how, including with
EAS). `/my-day` is the same day as a page in a browser, which is what a self
hoster can use without an app store at all.

### The phone app

The technician types the company's server address, then their email and
password, or asks for a one time code instead (below). `POST /v1/field/sign-in` checks them with the sign in form's own
password check and lockout and hands back a device token, `otd_` and then a
secret, which the phone keeps in the Keychain or Keystore and presents as a
bearer token. The token is a session underneath: it acts as the person,
lasts ninety days, and stops working the moment they are deactivated. Only an
account with a technician record is let in, because an owner holding every
permission would otherwise get a token for an app with no day to show.

The phone then registers itself with `POST /v1/field/devices`, once per person
per install, and registering with a device token binds the token to the device.
That binding is what makes it revocable: `POST /v1/field/devices/{id}/sign-out`
is the phone signing itself out (its own device only, `field:sync`), and
`POST /v1/field/devices/{id}/revoke` is the office taking a lost phone away
(`user:write`), which stops it syncing, ends its token on every route at once
and stops its notices. `GET /v1/field/devices` lists the phones (`user:read`).
Signing in again on the same phone ends the token it had, so a handset never
holds two.

### Signing in with a code

A technician who has no password, or has forgotten it, signs in with a six
digit code instead. `POST /v1/field/sign-in/code` sends one by text to the
mobile number the office recorded for them, or to their email, and
`POST /v1/field/sign-in/verify` trades it for the same device token a password
gets. Both are public, like the password sign in.

The rules are in `packages/core/src/field/codes.ts` and the database functions
that keep them: a code lives ten minutes, is spent the moment it works, dies
after five wrong guesses, and only the newest one works; a person may ask
three times in fifteen minutes, and an address is limited per minute on both
calls. Only a hash is kept. Asking answers the same sentence whether or not
the address belongs to anybody, so the form cannot be used to find out who
works where; what actually happened (sent, no number on file, asked too often)
is in the company's audit log.

The code goes straight to the carrier or the mail provider and not through the
outbox, because the outbox keeps every body in the inbox where the office reads
it, and a code there would be a sign in anybody in the office could use. And it
goes only to the number the office set with
`POST /v1/field/technicians/{id}/mobile` (`user:write`), never to one typed at
the sign in screen.

### The office's view of the phones

`/settings/phones` is each technician, the number their code is texted to, and
every phone they have signed in on: when it was last heard from, whether it is
signed in, and whether changes to their day reach it, with a button to take a
lost one away. `GET /v1/field/technicians` is the same list (`user:read`).

On the phone: the day in route order, today and then tomorrow, each visit with
the customer, the job, the address (a tap opens the phone's own maps app), the
arrival window in the company's timezone and the notes; the gate code, the dog
and the hazards before anything else; one big button that moves the visit
along, on my way, I have arrived, start work, finish (which asks first); clock
in and out; notes; photos from the camera; a signature from the customer's
finger; and the text to the customer that they are on the way, which is sent
there and then or not at all, because queued it would arrive an hour late.

### The rest of the visit

On the phone, a visit also has its checklist to tick (`visit.checklist_item`),
the readings its job type's service report template asks for
(`service_report.set_field`, with a number refused as a number before it is
saved and a reading outside the template's range said), sending the report
(`service_report.submit`), parts picked from the price book the phone carries
or typed when they are not in it (`visit.add_line`, a job line the office
prices), and money. Each is an operation in the queue like everything else, so
it is recorded in a basement and drawn from the queue until the server has it,
marked "waiting to send". The snapshot carries what the phone needs for them:
the template's fields with the last value recorded, the parts already on the
visit, the price book, and what is owed on the job's invoices.

A report made on the phone is filed against the job type's template and its
version, so the office reads it against the fields the technician was asked
for.

### Money on site

Cash and checks are `payment.collect`: a fact that always applies, because the
money is in the technician's hand whether or not the office still wants the
visit. The server records it through the same `billing.pay` the office uses,
dated when it was handed over, applied to this job's open invoices oldest first
and held for the customer when nothing has been invoiced. A check needs its
number. A refusal (a closed period, a date too far back) is said to the
technician in the office's own words.

A card never touches the phone. `POST /v1/visits/{id}/payment-link`
(`payment:collect`) fetches the job's invoice link, the same one an emailed
invoice carries, and texts it to the customer or hands it to the phone's share
sheet; the payment lands when the card processor's webhook says it did. Only
the technician on the visit, or somebody who may send invoices, can ask.

`/my-day` takes cash, checks and the card link the same way.

### Inspections

A technician the company lets file inspections (`compliance:write`, which the
technician preset does not hold) is sent the inspection programmes with the day,
and runs one against a visit: pass or fail, readings with the range beside them,
not applicable with a reason, a photo per checkpoint and a signature. The whole
inspection is one `inspection.record` operation, an append that always applies,
with an id the phone made so a retry files it once. The server files it through
the same service the office uses, against the visit's own customer and address,
and draws the verdict itself; the phone never sends one. `/my-day` runs the same
inspection with a typed signature.

### Notices about the day

When the office puts a visit on somebody's day, takes it off, moves it or
cancels it, the change emits `visit.assigned`, `visit.unassigned`,
`visit.rescheduled` or `visit.cancelled`, naming the technicians it is about.
Every path that does those things emits them: the board, booking a job with
people on it, adding a visit, and the office answering a customer's request to
move or cancel.

The worker reads them from its own place in each company's log and pushes a
notice through Expo's push service to every phone of those technicians with a
push token ("Job cancelled: Job 1042, Nina Patel, Tue, Oct 6, 1:00 PM, is
cancelled. Do not go."), one per change per phone however often the event is
read, and a tap opens the visit. The customer's name and the time are on the
lock screen; the address is not. Each notice is a `push_delivery` row saying
whether it went and why not.

Inside the company's quiet hours (the same window its customer texts keep,
nine to eight unless it says otherwise) a notice is sent without a sound,
unless the work starts before the quiet hours end: an emergency put on the on
call technician's day at ten for eleven rings. A change read more than twelve
hours after it was made is skipped as old news. When Expo says the app is gone
from a phone, at the send or in the receipt a quarter of an hour later, the
phone's token is forgotten.

The app asks for permission on its first launch, makes the two Android
channels the server sends to, and registers its token with
`POST /v1/field/devices`, the call it already makes. Signing out and taking a
phone away both clear the token. A company can require an access token for its
Expo project and set `EXPO_ACCESS_TOKEN` for the worker.

### Offline, and sending

Every write goes into the queue in `packages/field-client` first, the same
queue the web page uses, kept on the phone in SQLite (a write that has returned
is on disk, which matters more for a payroll record than the speed of a memory
map), and the screen is drawn from the queue, so a visit the technician has
started still shows as started after the app is killed with no signal. A line
under the date says what is waiting to send, or that everything has gone.

Sending happens after every tap, every half minute while the app is open,
when the app comes back to the front, when the phone gets a connection back,
and from the operating system's background task, which on Android runs no more
often than every fifteen minutes and on iOS when the phone decides. A send
that got no answer is not counted against the work, and the timer backs off
from five seconds to fifteen minutes so a phone without signal does not spend
its battery asking. A sign in that has ended keeps everything on the phone
and asks the person to sign in again.

Photographs and signatures go in two halves, as the server takes them: the
record that one exists, with its hash and size, goes through the queue in
order; the bytes follow once the server lists them as owed, and are deleted
from the phone once it has them. Asking what is owed, rather than remembering
what was sent, is what makes a lost answer harmless.

A conflict, the office having cancelled a visit the technician then arrived
at, is said in words ("You arrived at Nina Patel's job is on the record, but
the office had cancelled it before it reached them") with nothing for the
technician to do. A refusal says it was not recorded and offers to try again
or let it go. Nothing leaves the phone without the technician choosing it.

### Sync

`POST /v1/field/devices` registers a device, `GET /v1/field/snapshot` is what the
phone needs to work offline, and `POST /v1/field/sync` sends the queue. All three
need `field:sync`, which is the permission for using the field app at all.

An operation held behind a gap is judged again each time it is sent, and
applied once the gap is filled. A gap can also be a number the phone handed
out and then lost, when it died between numbering an operation and writing
it, or when the technician let go of one that never got through. The server
says which numbers it is waiting for in `awaiting`, and the phone declares the
ones it does not hold in `skipped` on its next send, so nothing after them is
held for ever.

### Photos and signatures

`GET /v1/field/uploads` lists what the device still owes,
`POST /v1/field/uploads/{clientId}` sends the bytes and
`POST /v1/field/uploads/{clientId}/failed` records that it could not.
`GET /v1/field/uploads/outstanding` is the office's view of what has not arrived.

Four things happen to bytes that arrive. They are checked against the hash the
device declared, and a mismatch is a corrupted file refused rather than stored.
They are stored under a content addressed key, so a phone retrying four times in
a car park does not leave four copies of a four megabyte photograph. They are
attached to the record they were taken for, because an upload that reached
storage and never reached the job is a photograph nobody will ever find. And the
attempt is counted, so an upload that can never succeed is abandoned with the
error on the row rather than circling forever.

The phone app sends them, and so does `/my-day` in a browser: its camera
control makes the picture smaller, hashes it (with the field client's own
SHA-256 where the page is not on HTTPS and the browser offers none), keeps it
in IndexedDB and sends it through the same upload queue.

A refusal here is RETURNED rather than thrown, which is not a style choice: the
first version threw after writing the attempt count, the throw rolled the
transaction back and took the bookkeeping with it, and a phone could send the
same corrupted file forever with every attempt refused and every attempt
forgotten.

The bytes are served at `/files/{key}`, scoped by the caller's own company rather
than by the key in the path. The key is content addressed and begins with an
organization id, and that prefix is deliberately not what decides access:
otherwise a content addressed key would be a capability anybody could type.

### Conflicts

`GET /v1/field/conflicts` is what the office has to resolve and
`POST /v1/field/conflicts/{id}/resolve` resolves one. Both are visit permissions,
because a conflict is a question about a visit.

### Service reports

`GET /v1/service-reports` and `GET /v1/service-reports/{id}` read them,
`PATCH /v1/service-reports/{id}` annotates one from the office, and
`POST /v1/service-reports/{id}/publish` puts it on the customer portal.
Publishing is its own permission, because showing a customer what a technician
wrote is a different decision from writing it.

## Permissions

| Role | Access |
|---|---|
| Technician | `field:sync`, `timeclock:own`, writes service reports, reads their own work, takes payments on site (`payment:collect`) |
| Crew lead | The same, scoped to the crew |
| Dispatcher | Reads and resolves conflicts |
| Office manager | Reads service reports and publishes them |
| Owner, administrator | Everything |

A technician writes a service report and does not publish it. A dispatcher
resolves a conflict and does not write a report.

## Common questions

**Can a technician open the app with no signal?** The phone app, yes: it opens
on the day it last fetched, with everything done since laid over it. The web
page, no: they can record a day on a page already open, and true offline page
loads need a service worker.

**What happens to a photo taken offline?** The record that it exists syncs with
everything else; the bytes follow separately, and the office can see what has
not arrived.

**Two technicians share a phone.** Each signs in as themselves, and each gets
their own device and their own queue on it, so neither sends the other's work.
Work left by one waits on the phone until they sign in again.

**A phone is lost.** `POST /v1/field/devices/{id}/revoke`. Its token stops
working everywhere at once. Anything it had not sent is on the lost phone.

**Why is the queue its own package?** So its failures can be tested without a
device, and so an Expo app and the web page share one implementation.

## What is not built

The phone app has not been run on a device or a simulator. It is typechecked,
its logic is unit tested and it bundles for Android and iOS, and that is all,
so no push notice has been seen on a real phone: the server side is tested
against a fake of the push service, and a build needs an Expo project id
(`eas init`) before the app can get a token at all. There is no store listing
and no icon of its own; a company builds and distributes it.

Notices go to the technicians on a visit's assignment list. A visit sent to a
crew is not on any one technician's phone day, so a change to it tells nobody.
Cancelling a whole job does not cancel its visits, so it sends no notice; a
visit is cancelled today when the office agrees to a customer's request.
A notice that could not be sent is tried again on the worker's next passes for
twelve hours and then left, with the reason on its row; nobody is told about
a phone that missed one.

A code is sent only by a company with a text number or a mail provider
connected; with neither, the person is told a code is on its way and none
comes, and the office sees why in the audit log. The mobile number a code goes
to is set only on `/settings/phones`.

Readings cover the kinds a keyboard can fill in: numbers, measurements, text,
yes or no, a choice, and a chemical application; a photo or signature field on
a template is taken with the camera and the signature pad instead. A report
cannot be changed on the phone after it is sent.

The phone records cash and checks and fetches a card link; it does not take a
tip, and the technician cannot raise an invoice, so a card link needs the
office to have issued one.

Object storage: the bytes are columns in Postgres, which is right
for a self hoster with a few gigabytes of photographs and wrong for a company
with a terabyte. The customer portal shows a job's photographs only through
the job link, the treatment the logo already has (a token that already grants
sight of the record), and only the ones somebody chose with **Show the
customer** or all of them when the company says so (M05). There is still no
unauthenticated way to read one. True
offline page loads need a service worker: a technician with no signal can record
a day on a page already open; they cannot open the page.
