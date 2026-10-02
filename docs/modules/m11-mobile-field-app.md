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

`/my-day` is the page, and it runs in a browser, which is what a self hoster can
deploy today without an app store.

### Sync

`POST /v1/field/devices` registers a device, `GET /v1/field/snapshot` is what the
phone needs to work offline, and `POST /v1/field/sync` sends the queue. All three
need `field:sync`, which is the permission for using the field app at all.

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

None of that is reachable from the phone page yet. The server takes bytes and the
client does not send any: `/my-day` has no camera control, and the queue in
`packages/field-client` carries operations rather than files. So the upload path
is a server with nobody uploading to it, which is the honest state of it and the
right order to have built it in, because the half that has to be idempotent,
hash checked and tenant scoped is the half that is hard to change later.

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

**Can a technician open the app with no signal?** Not yet. They can record a day
on a page already open, and true offline page loads need a service worker.

**What happens to a photo taken offline?** The record that it exists syncs with
everything else; the bytes follow separately, and the office can see what has
not arrived.

**Why is the queue its own package?** So its failures can be tested without a
device, and so an Expo app and the web page share one implementation.

## What is not built

A camera control on `/my-day` and a client queue that sends bytes. The server
side of uploading is built and nothing in the phone page uses it. The Expo app,
which adds background sync, reliable camera capture and a home screen icon.
Object storage: the bytes are columns in Postgres, which is right
for a self hoster with a few gigabytes of photographs and wrong for a company
with a terabyte. The customer portal cannot show a job photograph, because every
read of one is scoped by a session and a portal visitor has none; when it needs
them it gets the treatment the logo already has, a token that already grants
sight of the record the file is on. Adding an unauthenticated way to read one
"for later" is how a private photograph of somebody's house becomes public. True
offline page loads need a service worker: a technician with no signal can record
a day on a page already open; they cannot open the page.
