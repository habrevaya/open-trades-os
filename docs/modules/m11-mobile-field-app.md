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

**Writes are named intents, not row diffs.** Sixteen operation kinds and the
list is closed: a new kind is a schema decision and a conflict decision, not
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
password. `POST /v1/field/sign-in` checks them with the sign in form's own
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
(`user:write`), which stops it syncing and ends its token on every route at
once. `GET /v1/field/devices` lists the phones (`user:read`). Signing in again
on the same phone ends the token it had, so a handset never holds two.

On the phone: the day in route order, today and then tomorrow, each visit with
the customer, the job, the address (a tap opens the phone's own maps app), the
arrival window in the company's timezone and the notes; the gate code, the dog
and the hazards before anything else; one big button that moves the visit
along, on my way, I have arrived, start work, finish (which asks first); clock
in and out; notes; photos from the camera; a signature from the customer's
finger; and the text to the customer that they are on the way, which is sent
there and then or not at all, because queued it would arrive an hour late.

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

The phone app sends them; `/my-day` in a browser has no camera control.

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
| Technician | `field:sync`, `timeclock:own`, writes service reports, reads their own work |
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
its logic is unit tested and it bundles for Android and iOS, and that is all.
There is no store listing and no icon of its own; a company builds and
distributes it. Push notifications for a newly assigned or changed visit: the
device row has a push token column and nothing writes or reads it, and
assigning a visit emits no event a worker could send from. Signing in with a
one time code rather than a password. A screen in the office for the phones
and revoking one: it is the API only. Recording a payment from the phone,
which the web page does not do either. Service report readings, checklist
ticks and parts from the phone: the operations exist and the app offers none
of them. A camera control on `/my-day`.
Object storage: the bytes are columns in Postgres, which is right
for a self hoster with a few gigabytes of photographs and wrong for a company
with a terabyte. The customer portal shows a job's photographs only through
the job link, the treatment the logo already has (a token that already grants
sight of the record), and only the ones somebody chose with **Show the
customer** or all of them when the company says so (M05). There is still no
unauthenticated way to read one. True
offline page loads need a service worker: a technician with no signal can record
a day on a page already open; they cannot open the page.
