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

**Writes are named intents, not row diffs.** Thirty one operation kinds and the
list is closed (`visit.call_off` is a visit called off from the door, below; the sixteenth, `payment.collect`, is money taken on site, the seventeenth, `inspection.record`, is an inspection filed whole, the next seven are selling and closing on site, below, `expense.record` is what the technician paid for the company, `notice.read` is a notice opened on the phone, `truck.water` is the fresh water a truck used on a day, and the last, `haul.time`, is the moment a driver put a container down or emptied one, below): a new kind is a schema decision and a conflict decision, not
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

Taking a browser away lasts until its person signs in again, as it does for a
phone. A browser has no token of its own: `/my-day` registers it on the
person's ordinary sign in each time the day is opened. The sign in's start is
resolved with the session (`app.resolve_session` returns the session row's
creation as `session_started_at`), and registering lifts a revocation only when
that sign in began after it; the revocation is stamped by the database's clock
so the two are compared on one clock. Reloading the day keeps it revoked: the
page says "The office has stopped this browser sending your work" and every
sync is refused. Signing out and in again is a new session, so it lifts it, and
the audit log records `device.revocation_lifted`. A phone's token is ended by
the revocation, so the token it signs in with next is always newer and lifts
it, exactly as before. `POST /v1/field/devices` answers `revoked: true` for a
device that stays revoked, and takes no push token and binds no token to it.

On the phone: the day in route order, today and then tomorrow, each visit with
the customer, the job, the address (a tap opens the phone's own maps app), the
arrival window in the company's timezone and the notes; the gate code, the dog
and the hazards before anything else; one big button that moves the visit
along, on my way, I have arrived, start work, finish (which asks first); clock
in and out; notes; photos from the camera; a signature from the customer's
finger; and the text to the customer that they are on the way, which is sent
there and then or not at all, because queued it would arrive an hour late.

Beside the clock, off it, "Getting a job ready first? Clock in for it" asks which
of the day's stops the crew is loading, driving out to and unloading for, on the
phone and on `/my-day` alike, and clocks in for that (`timeclock.punch_in` naming
the stop, with the kind `mobilisation`); the server files the punch on the stop's
job, and the clock then says "Getting a job ready" until it is clocked out. It is
paid exactly as on site time (M17). A punch of a kind the product does not know is
refused in words rather than stopping the phone's whole send.

### The rest of the visit

On the phone, a visit also has its checklist to tick (`visit.checklist_item`),
the readings its job type's service report template asks for
(`service_report.set_field`, with a number refused as a number before it is
saved and a reading outside the template's range said), sending the report
(`service_report.submit`), parts picked from the price book the phone carries
or typed when they are not in it (`visit.add_line`, a job line the office
prices), a unit found or put in at the address, typed off its plate under
"Equipment here" (`equipment.record`, matched on its serial across the whole
company with the office's rules, and held for the office rather than added
twice when the serial is on file somewhere else: M04), and money. Each is an operation in the queue like everything else, so
it is recorded in a basement and drawn from the queue until the server has it,
marked "waiting to send". The snapshot carries what the phone needs for them:
the template's fields with the last value recorded, the parts already on the
visit, the price book, and what is owed on the job's invoices.

A report made on the phone is filed against the job type's template and its
version, so the office reads it against the fields the technician was asked
for. It also keeps the list of fields it was **required** to capture, frozen
from the template when the server writes it (each with whether a regulator asks
for it), so a template changed next month does not change what this visit was
held to. The phone marks a required field with a star; pest control's
application record completeness (M21) reads the frozen list.

The company's own records on the visit's job or on a unit recorded on the
visit (a permit, a warranty registration, M29) come with the day too, of the
kinds the technician may read, with every field that holds a value, under
"Records on this job" on the phone and on `/my-day`. They are read only there.

THE OFFICE'S NOTES (M03) are on the visit, under "Notes from the office", on the
phone as on `/my-day`: the notes the office marked for the field, read from
`customerNotes` on each visit of `GET /v1/field/snapshot`, pinned first and then
newest first, at most twenty, each with who wrote it and the day in the company's
zone. They ride in the day, so they read with no signal, and a note marked afterwards
arrives on the next sync. They are read only on the phone: a note is written, pinned
and fixed in the office, and a customer's other notes never reach the phone. The
phone sorts them again itself (`customerNotesToShow` in `packages/field-client`), so
a day saved by an older build cannot put a pinned note under an old remark, and the
section is absent when the office marked none or the server is too old to send them.

WHAT THE CUSTOMER SENT (M05) is on the visit too, under "From the customer": the
photographs and PDFs the customer sent from their own account to this visit or its
job, the broken unit before anybody arrives, newest first (`customerFiles` on each
visit of `GET /v1/field/snapshot`, sent only to somebody who may read documents).
On the phone a photograph is a thumbnail that opens full size and a PDF is a line
that opens in whatever on the phone reads PDFs; on `/my-day` each is a link. The bytes
are not in the day: the phone reads them from `/files/{storageKey}` when the
technician looks, with its own sign in as a bearer header, because it is a customer's
document and the file route is held to the same rule as for a browser, whose cookie
it used to know alone. The phone's token reads files for the person it belongs to, in
their own company, with `document:read`; a token that has ended (signed out, a phone
the office took away, a person deactivated) reads nothing and is never read as a
cookie; a connected app's token is not a way in. The token travels as a header and
never in the address. A photograph is drawn straight from the server by the image
component; a PDF cannot be, because the phone's PDF reader is another app and
cannot be handed a header, so it is downloaded with the header into the app's cache and
offered to the share sheet, and that cache is emptied when the person signs out.
Both need a signal, and the screen says so under the thumbnails when a photograph will not load.

### Calling a visit off from the door

A team turned away at the door, or sent home by rain, calls the visit off on
the phone: "Call off this visit" on the visit screen (on `/my-day`, folded
under the visit's card), offered only for a visit on today's day that nobody
has started. It asks who called it off with no default: "The customer turned us
away", with what they said if anything, or "We called it off" with the office's
reasons (rain or weather, crew short, equipment, something else with words).
The phone asks once more before it goes. It is `visit.call_off`, a transition:
allowed from unassigned, scheduled, dispatched and on the way (which is where a
visit is while the team stands at the door), and refused from anything else,
so a visit the office already cancelled keeps the office's cancellation and the
phone says "The office had cancelled it". The visit leaves the day as
cancelled the moment it is pressed, with no signal. The server lands it as the
office's call off lands (M09): the same columns, the same audit entry and the
same figures. The choices and the checks are in `packages/field-client`
(`CALL_OFF_CHOICES`, `checkCallOff`, `canCallOff`, `recordCallOff`), the four
company reasons held to core's list by a test.

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

### Selling and closing on site

The sale at the kitchen table, on the phone and on `/my-day`, all through the
same queue, so all of it works in a basement and lands when the van finds a
signal. Seven operation kinds:

| Kind | Rule | What it is |
|---|---|---|
| `estimate.create` | append | Good, better and best built on the phone, with ids the phone made |
| `estimate.approve` | transition | The customer's choice and signature, drawn on the glass |
| `estimate.decline` | transition | The customer saying no, with why |
| `invoice.raise` | transition | The invoice for the visit's work, shown and signed for |
| `task.claim` | transition | Taking a task off the office's queue |
| `task.close` | transition | Finishing your own task, with the reason when items are unticked |
| `task.tick` | edit | Ticking an item of your own task's checklist, or unticking it |
| `tip.record` | append | A cash tip the technician kept |

**Building the options.** The price book the phone carries is searched with
no signal, by name, code, description and what a kit contains; a kit is one
line at its own price and says what it covers. Each line is priced from the
version the phone holds, and the server writes that version's price when it
was in force in the week before, so a price rise the phone had not heard of
does not change what the customer was shown; an older one is refused in
words. The customer's membership is on the day (`member` on each visit), and
the phone takes the plan's discount off each line, and waives a diagnostic or
after hours fee, exactly as the server will. The phone offers no discount of
its own and never shows a cost or a margin.

**The figure is the server's figure.** The phone's arithmetic is one file,
`packages/core/src/field/pricing.ts`, which imports nothing so the phone can
bundle it, and a test in core holds every line and every total it gives to
the server's estimate, invoice and member pricing over thousands of random
documents. So the total a customer signs for on the phone is the total the
server writes.

**The customer's screen.** The options in the order a proposal uses
(recommended first, then the dearest), each line at its price with the
member's saving said, the extras to tick and the total for what is ticked,
the terms, and a box to sign in with their name. Choosing and signing puts
the drawn signature into the queue first (the hash checked upload path, as a
photograph), then `estimate.approve` naming it and the total the customer was
shown. The server works the option out again with what they ticked and
records the approval only when the two agree to the cent, through
`estimates.decide`, the same approval the customer's own link makes,
recorded as given in person and signed at the moment they signed. A
different figure is refused and said ("The customer was shown $1,500.00, and
this option with what they ticked comes to $1,620.00 ...").

**Who may carry a customer's yes.** `estimate:present`, which the technician
preset holds: the technician on the visit, with the customer's own name and
drawn signature. It is not `estimate:approve`, which records a yes on the
customer's behalf and which a technician does not hold.

**The invoice on site.** `invoice:raise_on_site`, which the technician preset
holds, raises and issues one invoice for the technician's own visit, and is
not `invoice:write`. It bills one of two things, never both, because an
option is usually a flat price that covers the parts used to do it: the
option the customer signed for, copied as signed by the estimate's own
conversion, or the parts and charges recorded on the job (a part recorded on
the phone carries an id the phone made, so it can be billed before there is a
signal), priced by the same `billing.createIn` as an invoice the office
raises. The phone sends the total the customer saw. When the server's total
agrees, the invoice is issued and the customer's signature recorded against
a hash of it; when it does not (a price changed, a warranty the phone could
not see), the invoice is kept as a DRAFT for the office, never issued at a
figure the customer did not sign for, and the operation is recorded as a
conflict the office sees and the phone says in the office's words.

**The after hours or holiday rate.** When a visit on the job was booked outside the
company's hours or on a holiday (M02), the day carries the rate on offer for an
estimate and for an invoice (`rateOffers` on each visit in `GET /v1/field/snapshot`),
with the sentence that says why, so it shows with no signal. It is offered and never
added: on the estimate builder a button puts it on every option, and on the invoice for
recorded work a button adds it to the invoice and to the figure the customer signs
(`rateItems` on `invoice.raise`, by price book item and quantity). The phone prices it
from the price book it carries, with the plan's waiver of the after hours rate. The server
checks it is still on offer when the invoice lands, and an invoice naming a rate that is
not (billed meanwhile, or carried by an approved estimate) is refused in words and the
work stays unbilled. The day's revision moves when the company's hours, holidays or
chosen rates, or any visit on the job, change.

**Taking the money, and a tip.** Cash or a check against the invoice raised
there, through `payment.collect` as before, now with a tip on top when the
company takes tips (the setting on `/settings/portal`, the same one the
portal's pay button reads): the tip is held in Tips payable and shared
between everybody on the job's visits by the company's rule (evenly, by hours on
the job or to the lead: M17), the way a tip on the portal is, with the same
suggestions and the same refusals. A card goes through the
invoice's own link, where the customer can add a tip. With a lender
connected (M13), `POST /v1/visits/{id}/financing-link` opens the lender's
application for what is owing and texts it or hands it over; like the card
link it needs a signal.

**A cash tip kept.** A customer hands the technician a twenty for
themselves. It never reaches the company, so nothing is booked; `tip.record`
puts it on the technician's own pay statement as `cash_tip`, already in their
hand (M17). Always the phone's own person: the office records one for somebody who did not, or corrects one, on `/timesheets/tips` (M17), and the technician sees both on `/me/pay`.

**Money I spent.** What the technician paid out of their own pocket for the
company: the amount, the day, what it was for, the job from the day's visits if
there was one and a photograph of the receipt, on the phone ("Money I spent") and on
`/my-day`. `expense.record` (an append, the twenty fifth kind) carries it with an id the phone made, so a retry records
it once, and the receipt is an `attachment.attach` whose payload says
`entityType: "expense"`, kept beside the expense by the same hash checked upload path
as any photograph and only for the phone's own person's expense. The office decides
on `/timesheets/expenses` and the answer, with the reason for a refusal in the
office's own words, comes back in the day's `expenses` (the last sixty days) and
moves the revision, so the next poll fetches it. Always the phone's own person
(`expense:own`); an approved one is paid back through payroll (M17).

A claim can be in miles instead of an amount (M17): "Or the miles you drove", offered
only when the company has a mileage rate in force today (`abilities.mileageRate` in the
day; with none the box is hidden). The phone sends `miles` on `expense.record` and no
amount, never both, and checks them to a tenth with no signal; the server works the
amount out at the rate in force on the day driven and sends it back in the day's
`expenses` with `miles` and `mileageRate`. Until then the phone shows "18.4 miles", not
a figure of its own, because it may not know the rate. The rate on the phone is as of
its last fetch, and the server's rate on the day wins.

**Your phone and address.** The person's own phone number and home address, the same
record `/me` keeps (M24), from "Your phone and address" at the foot of the day. It reads
`GET /v1/me` and saves with `POST /v1/me/contact` (`profile:own`) over the phone's own
sign in, the whole of it each time, a box left empty taking that part off. It is the one
thing here that is not queued: a number that does not dial or a ZIP that is not a ZIP is
told to the person now, in the server's own words ("The ZIP code is five digits, like
78701, or nine with a dash."), so it needs a signal and says so, and nothing on the
phone repeats the server's rules. Save waits until a box has changed; sending the same
again changes nothing and is not written down twice. The office reads what was saved
and every change on the person's page and cannot write it.

**The office's tasks.** The snapshot carries the person's own tasks and the
ones nobody has taken, and the phone takes one (`task.claim`) and finishes
its own (`task.close`) through the queue's own services, so the second of two
people taking the same task offline is told somebody else has it. A task with a
checklist carries its items with the day: the person it is assigned to ticks them one
at a time (`task.tick`, an item set to ticked or not, the later of two ticks of one item
winning), and finishing with items unticked needs the reason, which the phone asks for
before it is sent, in the office's words, and sends beside the outcome. A task finished
meanwhile refuses a tick in words.

**Toolbox talks.** The snapshot carries the talks on the person's own sheet lines
(`talks`), and "Toolbox talks to sign" on the day opens them: what was covered,
then a pad to draw a signature on. The signature is kept on the phone and recorded
first, as an upload for the talk (`signature.capture` naming the talk), then
`safety.sign` names it, so a talk signed with no signal is signed in order when
the phone next has one. The server finds the line from the phone's own
technician and refuses a closed sheet, a talk not held yet or somebody not on it
in words; a refused signature is attached to nothing (M23).

**What the person may do.** The snapshot's `abilities` says, from the
person's permissions and the company's settings, whether they may build
estimates, take a customer's signature, raise invoices and take tasks,
whether the company takes tips and with which suggestions, whether a lender
is connected and whether the field assistant (M27) is on, so the phone
offers only what the server would accept.

**Asking the field assistant.** **Ask** on the day, or **Ask about this job**
on a visit, opens a question box. The answer appears as it is written, a
finished sentence at a time under "Still writing...", and the whole answer
takes its place once the server has checked it; that can be a line saying the
answer cannot be shown. The phone asks `POST /v1/ai/field-assistant` for
Server-Sent Events (`field:sync`, the same permission and limits as the whole
answer) and reads them through React Native's own `XMLHttpRequest`, whose
`responseText` grows as the answer arrives on Android and iOS alike, so no
native module is added. A server that answers whole is read whole. A dropped
signal mid answer says there is no signal, and the sentences shown so far go.

### The fresh water a truck used

A driver with a company vehicle checked out to them today sees a card for it
on the day ("Truck 3: fresh water today"), on the phone app and on `/my-day`:
what is already recorded for today, a box for the gallons read off the tank
gauge or the fill meter, and "Save the reading". It goes into the queue as
`truck.water` (an edit: the subject is the truck and the day is the field, so a
second reading of the day replaces the first, an older one arriving late is
superseded, and a reading of another day is its own), shown as waiting to send
until it lands, and is refused in words for a truck that was not checked out to
the phone's own person that day. The snapshot carries the trucks the person had
yesterday and today with the water already read (`trucks`), so the card works
with no signal and shows a reading the office corrected. The office's side and
what the figure is are M22 and M21 (fresh water per stop).

### When a container was put down, and when one was emptied

A driver whose day has container stops (a visit that names a hire as its drop
off, collection or swap) sees "Container times" on the day, on the phone app
and on `/my-day`: for a drop off, when the can was put down; for a collection,
when the full can was emptied at the facility; for a swap, both, the empty
once the office has recorded the swap. "Now" records the moment it is tapped,
or a time typed for earlier today ("14:30" or "2:30 pm", in the phone's own
clock, never one still to come). It goes into the queue as `haul.time` (an
edit: the subject is the hire and `placed` or `tipped` is the field, so tapping
again replaces that time and leaves the other alone), shown as waiting to send
until it lands, and is refused in words for a hire that is not on one of the
phone's own person's stops, and with the office's own refusals (a drop on
another day than the delivery recorded, a tip before the delivery or after the
can was on its next site). The snapshot carries the hauls on the day's stops
with the times already recorded (`hauls`), so it works with no signal and
shows a time the office corrected. What the times are for is M22 and M21
(turnaround between pickup and redelivery).

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
people on it, adding a visit, the office answering a customer's request to
move or cancel, a customer taking a time the office offered, the several
day rebalance, and cancelling a whole job with its visits still to come.

A visit sent to a crew is on every member's day, so a change to it names
each member of the crew as it stands: sending it to the crew tells them all
it is theirs, moving or cancelling it tells them all, and a crew card handed
to one person on the board tells the others it is off their day.

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

A notice that never reached anybody is put in front of the office. Once
every one of a person's phones has finished with a change (five tries, or
twelve hours, or a receipt saying it was not shown) and none of them got
it, the worker raises a task in the office queue on the visit, high and due
when the work starts: "Ray Nunez's phone was not told: Job cancelled", with
the notice's own words, why it could not be sent, and "Call Ray Nunez to
tell them." One task per change per person, never one per retry. A phone
signed out or taken away on purpose raises nothing, and nor does a change
another of their phones received. A task rather than the field conflicts
list, because a conflict is something a phone sent that the office must
reconcile, and this is something the office sent that never arrived.

The app asks for permission on its first launch, makes the two Android
channels the server sends to, and registers its token with
`POST /v1/field/devices`, the call it already makes. Signing out and taking a
phone away both clear the token. A company can require an access token for its
Expo project and set `EXPO_ACCESS_TOKEN` for the worker.

### Notices to the person, beside the day

The same phones get the notices the product sends a person about their own work
(M34): a task given to them, a late task, an order waiting for their approval, a
toolbox talk they have not signed, their expense answered, their licence running
out. The worker sends them through the same push service, to every phone the
person is signed in on, each kind only when they left "Phone app" ticked for it
on `/me`. Inside the company's quiet hours they go without a sound; none of them
is work starting that night, so none rings. Each is a row of its own
(`staff_notice_delivery`, not `push_delivery`) saying whether it went and why
not; one not sent within twelve hours is skipped, and "the app is gone from this
phone", at the send or in the receipt, forgets the phone's token exactly as a
change to the day does. A notice that never reached the phone raises no task:
it is still on the person's bell in the app.

A TAP ON ONE OPENS WHAT IT IS ABOUT. The push carries the notice's id, its kind, the
kind and id of the record it is about and the page the bell would open
(`noticeId`, `kind`, `about: { type, id }`, `href`), and nothing the bell does not show:
the words are the title and body the lock screen already shows, and a record is an
opaque id. A notice about a task opens the Tasks screen with that task first, to
take, tick and finish; one about a toolbox talk opens the talks to sign, and one about
the person's expense opens "Money I spent". Any other kind (an order waiting, an app
asking, a licence running out) opens the notice's page in the phone's browser, on the
company's own server: the phone only ever follows a path on that server, never an
address a notice carries. A task the phone does not hold yet (given a moment ago) is
asked for with a fresh fetch; one it still does not hold (finished, or taken by somebody
else) is said so in words, with the page in the browser. A change to the day opens its
visit, as before.

OPENING IT MARKS IT READ for the bell in a browser, as a queue operation, `notice.read`,
and not a call of its own. A notice is often tapped where there is no signal, the
screen it opens comes from what the phone already holds, and the mark should not be
lost for the same reason a tick is not: it is kept on the phone, sent when the van finds
a signal, and applied once. It is an append (the one-way state of being read has nothing to conflict with),
marks only the signed in person's own notice, and leaves somebody else's notice, or one
that is gone, alone without a word, as `POST /v1/me/notices/read` does, so it cannot be
used to learn whose a notice id is. It changes nothing on the day. The system hands back the
tap that launched the app each time it is asked, so the phone remembers which taps it has
acted on and does not open the same notice twice.

### Location while working, and the privacy choices behind it

The phone app shares where its person is with the office, and with the
customer they are on the way to, and every choice about it is made for the
person being located:

- **Off until the company turns it on.** An owner turns it on at
  `/schedule/technicians` (`PUT /v1/dispatch/location-sharing`,
  `settings:write`), where the rule is written out in the words below. The
  office can turn it off for any one person (`PATCH /v1/technicians/{id}`,
  `user:write`).
- **Only while working.** Clocked in, on the way to a visit, or working one.
  The phone decides from the day it holds, offline (`sharingFor` in
  `packages/field-client`), and starts the operating system's location only
  then; the moment it says otherwise the updates stop and any position not
  yet sent is thrown away rather than sent after the fact.
- **The server checks every position again.** Positions ride along with the
  sync (`positions` on `POST /v1/field/sync`), after the operations in the
  same send, and each one is judged against the server's own record of the
  punches and the visits. One taken outside working time is dropped and
  counted in the answer, never stored, so a phone that is wrong cannot put an
  evening at home on the map. A visit marked on the way and never finished
  counts for twelve hours at most.
- **The person always knows.** A line at the top of their day says when it is
  on and who can see them ("Nina Patel can see you on their tracking link
  until you arrive"), and says when it is off. Android shows its own notice
  for as long as it runs and iOS its blue location indicator. The snapshot
  tells the phone the company's setting and the person's
  (`locationSharing`), so they can see which applies to them.
- **Few people see it.** Live positions are shown to people who dispatch
  (`visit:dispatch`), not to a CSR and not to other technicians. A customer
  sees one pin, only on the way to their own visit, only after the text, and
  nothing once the technician arrives.
- **Kept briefly, and bounded.** Three days unless the company sets one to
  thirty, then deleted by the worker. Turning sharing off for the company or
  a person deletes what was kept at once; shortening the retention deletes
  what is now past it. No two positions of one person are kept closer
  together than half the company's interval (never under five seconds), so a
  person's day is at most 2,880 positions at the default of one a minute,
  and the whole store at most that times the retention.
- **Summed for route density, then gone.** Before the worker deletes a
  finished day's positions it keeps, for each person, that day's count of
  completed stops, the number of drives between them and their miles, and
  nothing else: no position, no place. That is what route density reads
  (M21). A day whose positions have a gap on a drive is kept as not counted,
  with no miles. Turning sharing off for the company or a person deletes
  these with the positions, because they are made from where that person
  drove. They are listed, inside the figure, only to people who dispatch.
- **Today's path, to the same few people.** The dispatch map draws the path
  each person took today behind their pin, from the positions already kept,
  for `visit:dispatch` only. Yesterday's is inside the retention for the
  record and is not drawn.
- **Not precise beyond need.** A fix less accurate than a kilometre, one from
  the future, one at 0, 0 and one from a phone faking its GPS are refused.
  The phone thins what it keeps: a parked van sends one every few minutes.

The phone asks for location permission only when sharing first becomes due,
not at sign in. With "while using the app" only, it shares while the app is
open and says so.

Telling the customer you are on the way also moves the visit on the way on
the phone, into the queue like every other tap, so the tracking link has a
van to show and the office sees the visit move whether or not the text got
through.

### Opening `/my-day` with no signal

The first time `/my-day` is opened on a phone with a signal, it registers a
service worker for `/my-day` alone (`/my-day-sw.js`) and keeps two things on
the phone: the day as the server drew it for the person signed in, and the
page's own script and style files. A line at the top says "This day is
saved on this phone, so it opens with no signal." From then on, every time
the page is opened with a signal the kept copy is refreshed; opened with no
answer from the network, the kept copy is shown instead, with "No signal.
This is your day as it was last saved on this phone", and everything done
on it goes into the queue as it would on a page already open.

Only that person's own day is kept, never another screen and never an API
answer. The copy is written down as belonging to whoever is signed in:
every signed in page checks it, and a different person signing in on the
same phone empties it before anything of theirs is kept. The sign in page
empties it outright, and signing out and an ended session both land there,
so a shared or borrowed phone keeps nobody's day once they have gone.
`apps/web/src/lib/my-day-offline.ts` has the rules.

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
a car park does not leave four copies of a four megabyte photograph, in Postgres
or in the deployment's bucket, whichever it keeps files in. They are
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
wrote is a different decision from writing it. A report read back says what it
was required to capture (`requiredFields`), or null for one written before that
was kept.

**Products applied** are chosen, not typed, where the company has marked its
chemicals in the price book (M06). On a report's chemical question the phone
offers "Find the product", lists the chemicals by name with the unit their cost
is per, and asks only how much; "Not in the price book? Type it" keeps the old
typed form for a product the book does not hold. `/my-day` asks the same under
"Products applied" on each visit, with "Not in the price book" for a typed one.
Both send `service_report.set_field` naming the item (`priceBookItemId`), and
the server carries the item's name, EPA number and unit onto the record
whatever the phone typed beside them (the unit the phone sent is kept only when
the item's version says it is bought in one unit and used in another and the
unit is one of those two, M06); an item that is not a chemical in the
company's book is recorded as typed, never refused. The visit's page in the
office (`/visits/{id}`, "Products applied") lists each product question's
latest answer, from the price book or typed by name, and "Record the product"
adds one the technician missed, chosen from the book onto the visit's report
(created as the phone would create it): `GET /v1/visits/{id}/products-applied`
(`servicereport:read`) and `POST /v1/visits/{id}/products-applied`
(`servicereport:write`, audited, refused for a published report). For a product
bought in one unit and used in another, "In what" records it in either unit
(`unit`); anything else is recorded in the chemical's own unit. The licence
and the target pest are kept as before. Pest control's chemical cost per stop
(M21) values only what was chosen from the book.

**What a technician must fill in** is set per template on Settings, Service
reports (`/settings/service-reports`): every field of every template, which a
regulator asks for, and a box for each the company requires. Saving is
`PATCH /v1/service-report-templates/{id}` (`servicereport:write`) and moves the
template to a new version. An edit keeps which fields are regulated; it used to
drop that, so the first change in the office stopped every field being
regulated.

## Permissions

| Role | Access |
|---|---|
| Technician | `field:sync`, `timeclock:own`, writes service reports, reads their own work, takes payments on site (`payment:collect`), takes a customer's choice and signature on an estimate (`estimate:present`) and raises the invoice for their own visit (`invoice:raise_on_site`); with `field:sync` alone, calls off a visit on their own day that nobody has started (`visit.call_off`), where the office needs `visit:reschedule` |
| Crew lead | The same, scoped to the crew |
| Dispatcher | Reads and resolves conflicts |
| Office manager | Reads service reports and publishes them |
| Owner, administrator | Everything |

A technician writes a service report and does not publish it. A dispatcher
resolves a conflict and does not write a report.

## Common questions

**Can a technician open the app with no signal?** The phone app, yes: it opens
on the day it last fetched, with everything done since laid over it. The web
page, yes, once it has been opened on that phone with a signal: it opens as
the day was when it was last saved there, says so, and keeps recording into
the queue.

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

A truck's water is read for today only on the phone; a reading for an earlier
day, or for a truck that was not the person's, is the office's to type on
`/fleet/water`.

The phone app has not been run on a device or a simulator, so live location
has been tested against its logic and a fake server, not against a real
phone's GPS, battery or background limits; iOS in particular decides how often
a backgrounded app is woken. It is typechecked,
its logic is unit tested and it bundles for Android and iOS, and that is all,
so no push notice has been seen on a real phone: the server side is tested
against a fake of the push service, and a build needs an Expo project id
(`eas init`) before the app can get a token at all. There is no store listing
and no icon of its own; a company builds and distributes it.

Only somebody on the board has a phone registered, so office staff with no place on the
board get notices about their own work on the bell and by text, never by push. A notice
the phone has no screen for opens in the browser, where the person must be signed in on
the web as well; the phone's sign in does not carry over to it. Opening a notice
offline marks it read once a signal returns, so the bell in a browser can show it unread
until then.

The phone's "Your phone and address" needs a signal and is not kept for later, so a
change made in a basement is made again above ground; it also cannot show the list of
earlier changes, which is on `/me` and on the person's page in the office.

Notices go to the technicians on a visit's assignment list and to the
members of the crew it is sent to. Somebody with no phone registered for
notices is told nothing and raises no task, because there was nothing to
send; the office sees which phones get changes on `/settings/phones`.

A code is sent only by a company with a text number or a mail provider
connected; with neither, the person is told a code is on its way and none
comes, and the office sees why in the audit log. The mobile number a code goes
to is set only on `/settings/phones`.

`/my-day` answers a report's product questions only; its other readings are the
phone app's. The phone and `/my-day` offer the chemicals the day's price book
carried when it was fetched, so an item marked an hour ago is typed until the
day is fetched again.

Readings cover the kinds a keyboard can fill in: numbers, measurements, text,
yes or no, a choice, and a chemical application; a photo or signature field on
a template is taken with the camera and the signature pad instead. A report
cannot be changed on the phone after it is sent. The phone stars a required
field and does not stop a technician sending a report without it: an
application record with a gap is still a record, and the gap is what the
completeness figure counts. Which fields a regulator asks for comes from the
trade pack; the settings screen shows it and does not change it.

Selling on site is on the phone and on `/my-day`, and the phone app has, like
everything else in it, not been run on a device: the estimate builder, the
customer's screen, the signature pad, the invoice and the tip are typechecked
and their logic unit tested, and the same flow is driven end to end in a
browser on `/my-day`. On the phone an estimate has at most three options
(the server takes five) and no discount the technician types; a line not in
the price book is typed with its price. An invoice raised on site bills the
option signed for or the work recorded, never both; recorded parts left off
stay unbilled for the office. An invoice raised on site is taxed exactly as one the
office raises. An invoice made from the option the customer signed for carries the
tax that estimate was written with, each line at the rate it was charged, because the
phone runs the same conversion the office's "Convert to job" does and a test raises
both from the same estimate and compares the tax to the cent. An invoice made from
work recorded on the visit is taxed from the company's own rates (M13): the day the
phone carries (`GET /v1/field/snapshot`) says each visit's rate, the one the server
works out for that customer at that address today, and the phone taxes the taxable
lines at it, so the figure the customer signs is the one `billing.createIn` writes.
The phone's estimate builder starts its percentage at the same rate, with the reason
beside it, and the technician can change it. A part recorded without saying whether
it is taxed is taxed, and labour is not. If the rate changes between the day being
fetched and the invoice landing, the invoice is kept as a draft for the office with
the difference in words, as any other disagreement is. A signature for an invoice the customer was not
there for can be skipped, and the invoice is raised unsigned. A task with a
checklist shows its items to tick, one at a time, and is finished with the reason the
office asks for when some are unticked (M34). The
lender's link and the field assistant need a signal; nothing about them is
queued. The assistant's answer as it is written has, like the rest of the app,
been read only from a fake of `XMLHttpRequest` handing the body over in pieces,
never from a real phone's network stack.

Photographs and signatures are kept in Postgres by default, which is right
for a self hoster with a few gigabytes, and in an S3 compatible bucket when the
deployment sets `FILE_STORAGE=s3` (`docs/self-hosting/files-and-backups.md`);
`move-files` moves what is already stored, checking each file's hash, while the
app is in use. Files are served through the app either way, never by a link
straight into the bucket, which costs the app's bandwidth on a large deployment
and keeps every read behind the company's own permission. The customer portal shows a job's photographs only through
the job link, the treatment the logo already has (a token that already grants
sight of the record), and only the ones somebody chose with **Show the
customer** or all of them when the company says so (M05). There is still no
unauthenticated way to read one.

A revoked browser stays revoked until its person signs in again, and then it
is lifted, as a phone's is: revoking does not stop somebody signing in, so to
keep a person out for good the office deactivates them, which ends every sign
in they have, or takes `field:sync` from their role. Revoking a browser does
not end its sign in (a browser's session is the person's whole sign in to the
office screens, not the day's alone), so the person can still open the rest of
the product; only their day stops reaching the office.

The files a customer sent are read from the server when the technician looks, so they
need a signal and are not kept on the phone: a visit opened in a basement shows empty
squares and a line saying the photos could not be loaded. A photograph is drawn at the
size the server sent it (up to five megabytes), with no smaller copy made for the
thumbnail, so a visit with many photographs is slow on a weak signal; the phone shows at
most twelve and says how many more are on the job. Opening a PDF hands a downloaded copy
to the phone's share sheet, so what opens it is whatever the person has installed; like
all of the app, that has been typechecked and its logic tested but not run on a device.

`/my-day` opens with no signal only once it has been opened on that phone
with one, only in a browser that keeps service workers (any current one, on
HTTPS or localhost), and only as the day was when it was last saved: a
visit the office added since is not on it until the signal is back, and
neither is anything the server would have redrawn (a closed punch, a
finished visit) beyond what the phone's own queue lays over it. A day kept
from yesterday opens as yesterday's, with its date. Other screens do not
open without a signal. The copy kept is the page and its script files,
nothing else, so photographs of earlier visits and the price book's
pictures are not there offline.
