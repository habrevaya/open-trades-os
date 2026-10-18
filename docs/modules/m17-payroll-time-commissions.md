---
title: Payroll, Time and Commissions
module: M17
domain: Money
phase: 5
status: partial
---

# Payroll, Time and Commissions

> Module M17. Domain: Money. Ships in phase 5.

## What it does

Records time, prices it, classifies a week into regular, overtime and double
time, calculates and settles commission, pays people back what they spent for
the company and the company's allowance for a day away, and produces a CSV a
payroll bureau takes.

## The problem

Labour is the largest expense in a service business and the easiest one to get
wrong in a way nobody notices.

Every punch carries the rate that was applied to it, and nothing was writing
those columns. So every entry's cost was null, every technician's hours cost
nothing, and job costing reported a gross margin missing its largest expense. A
contractor reading that screen would conclude their least profitable work was
their best.

The second failure is commission recorded as a number on a report. The
technician sold the job, the company owes them, and if it shut its doors that
afternoon it would still owe it. A product that does not post that liability has
a company whose accounts never show what it owes its own people.

## Key concepts

**A rate is frozen at the moment an entry closes, from the scale in effect on
the day the work happened.** Not a cache. A rate read live at report time changes
retroactively when somebody edits a scale, so last quarter's job costing moves
after the quarter closed, and nobody can explain why the number they wrote down
is no longer the number on the screen.

**Wage scales are dated.** A union agreement raises rates on a date, and an entry
worked before that date must keep costing what it cost. Resolving by "the active
row" would reprice last year's jobs every time somebody loads a new agreement.

**An entry with no scale is visibly unpriced rather than wrongly priced.** A
company that does not run wage scales should not have its punches refused.

**The week's classification is derived, never stored.** A stored overtime total is
a number somebody can edit, and a payroll figure nobody can explain is the one
thing worse than a wrong one. What is stored is the rate, because that is the
thing that must not move.

**An hour is never paid a premium twice.** That rule lives in core, where it can
be tested without a database, along with the daily and weekly interaction that
makes it hard.

**A pay period has to be a whole number of workweeks and start on the policy's
workweek boundary.** Overtime is measured over a workweek, so a period cutting one
in half cannot be settled: half the hours that decide whether Thursday was
overtime are in the other period, which may already be closed and paid.
Semimonthly periods do exactly this, and are refused by name.

**A period has to be closable, and reopenable by the same power.** Without a
close, the same hours get exported twice and the second file looks as
authoritative as the first. A period closed by mistake that cannot be reopened is
not a control but an obstacle, and people get around obstacles by back dating.

**An export is reproducible, asserted by a checksum rather than hoped for.** Every
input is frozen, including the clock: the statement builder takes the instant as a
parameter so a re-run of a closed period gives the answer it gave the first time,
and the close's own instant is what is passed.

**An edit after an export is visible.** The close records a fingerprint over every
punch and commission line inside the period, and the export recomputes it and
refuses when it has moved. Refusing is the point: a second file with different
numbers and no warning on it is the failure this exists for.

**CSV and only CSV.** Every bureau takes one, no vendor has to approve it, and a
self hoster can open it. A second format would be a format this project has to
keep correct for somebody else's importer.

**A commission is a liability the moment it is earned.** Earning posts an expense
and a liability; paying is a separate event that clears it. This is the deposit
argument with the sign reversed, and it is made just as often.

**A commission plan is superseded, not edited.** A plan that can be edited
reprices commissions already earned and, on a plan edited downward, already paid.
Deactivating and declaring a new one is the supported path, and the earned rows
freeze the basis and the rate anyway, so even a plan deleted outright cannot move
what was paid under it. That is why the commission screen has no edit control.

**A commission plan carries what its basis is wrong about, beside the choice.**
Revenue, gross margin and a flat amount each mislead in their own way, and a note
behind a link is a note nobody reads while choosing.

**What somebody spent for the company is not wages, and is not in the gross.** A
reimbursement and a per diem are paid in full and no tax is taken from them, so a
statement keeps them out of `gross`, totals them beside it as `nonTaxable`, and
the file names each by its own pay category (`reimbursement`, `per_diem`) for the
bureau to read, as it reads `cash_tip`. A commission reversal is never taken out
of one, for the reason it is never taken out of a tip.

**Neither is posted to the ledger.** What the company owes a person for a receipt
is a payable, and whether this product books payables is the question receiving
stock left unanswered (M16), so the conservative answer was taken. They are paid
through payroll and counted in the job's cost (M15), which is where an owner reads
them. Posting them as well would be a second place for the same money to be wrong.

**An approval is dated by the instant it is given.** A receipt from last month
approved this week is paid in this week's pay period and never changes one that has
already been paid. A per diem is dated by the day itself, and a day inside a closed
period is refused.

**Payroll is not processed here.** The export goes to Gusto, ADP, Paychex or
QuickBooks Payroll. BUILD.md says so, and it is a deliberate boundary rather than
a gap.

## Setup

Declaring the pay calendar, the overtime policy and the wage scales all need
`payroll:configure`, which is a different permission from running an export,
because stating what people are owed is a different act from paying them.

## Using it

### Clock and approve

`GET /v1/timeclock/me` is somebody's own clock, with `timeclock:own`.
`GET /v1/timesheets/week` and `GET /v1/timesheets/entries` are the week, with
`timesheet:read`, and `POST /v1/timesheets/approvals` approves it, with
`timesheet:approve`. `/timesheets` is the screen. Timesheets are scoped by the
person they belong to: a branch scoped reader sees and approves the people in
their branch, including an hour one of them spent on another branch's job, and
a crew lead their crew.

### A person's own pay

`/me/pay` is the signed in person's own statement for each period payroll has
closed (`GET /v1/me/pay-statements`, `payroll:own`): their lines exactly as the
register and the export carried them, worked out at the moment the period
closed, and the commission behind the commission lines, invoice by invoice,
with whether it has been paid. Open periods are left off, because a figure
read on Tuesday that has moved by Friday is a dispute rather than a statement.
A year of periods at most. The call takes no person; it is whoever is signed
in.

### Time off

A technician asks for days off on `/me/time-off` (`POST /v1/time-off`, with
`timeclock:own`), and sees each request's answer there. The form takes a first
and last day, which is whole days; or, with "Only part of the day: from" and
"until" as well, those times in the company's own clock: on one day, a lunch hour
to the end of the afternoon, and across several days, from a time on the first
day to a time on the last ("from 1 PM Monday to noon Wednesday", which is all of
Tuesday in between). Half of the two times is refused in words, as is an end
before the start on one day. A request is any two instants, so a run that begins
and ends part way through is one request and one approval. The request and the
approval queue say the hours ("Tue, Oct 6, 1:00 PM to 5:00 PM", "Mon, Oct 5,
1:00 PM to Wed, Oct 7, 12:00 PM"). What part of a day off does elsewhere: the
booking page keeps customers off exactly those hours, booking a visit is refused
only inside them, and the dispatch board reads it the same way (`GET
/v1/dispatch/board`): each technician has `timeOff` (some approved leave on the
day, which is how clients written before the hours existed read it), `timeOffWholeDay`
and `timeOffHours`, the part hours of the day joined and clipped to it. The column
says "Off 1:00 PM to the end of the day." and warns of the jobs that run into those
hours only, and the rest of the day is theirs to be given work; a whole day says
"Off today.", and a leave that only touches the day (it begins the instant today ends)
is not on it. The crew check, the map's suggestions and the multi day rebalance read
it by the hour too:

- The dispatch map's "Suggest who" (`GET /v1/dispatch/suggestions`) and the multi day
  rebalance (`GET /v1/dispatch/rebalance/days`) refuse a visit to a person only when the
  visit's hours meet their leave, in words ("Ray Ortiz is on approved time off from 1:00
  PM to 5:00 PM on 2026-10-06, when that visit is."). A person with the afternoon off is
  offered the morning's visits, and one off all day is refused everything, as before.
  A visit moved to another day by the rebalance is asked about at the same times of day
  on that day. The map's and the rebalance's technicians carry `timeOff` (some leave),
  `timeOffWholeDay` and `timeOffHours`, as the board's do.
- The crew check (`GET /v1/crews/{id}/availability`, `GET /v1/crews/for-job` and putting
  a crew on a visit, `POST /v1/visits/{id}/crew`) asks about the visit's hours when it has
  them: assigning a crew, and a job with a visit that date, count a member as off when
  their leave meets those hours, and the refusal says "when that visit is". A question
  about a date alone, where the job has no visit that day, counts a member as off when
  their leave covers every hour the company works that day (the job's branch's weekly
  hours, or the company's where the branch keeps none, and the holiday list, or eight
  to five when no week is kept, forgiving a minute so a leave written to
  23:59 is still a whole day), and lists anybody with only part of the day off in
  `partDayOff` with their hours, as a note and never a reason to refuse the work. The
  rule is core's `time.leaveMeets`, `time.leaveCovers` and `holidays.workingSpanOn`,
  with unit tests. The multi day rebalance asks a crew about the hours the visit
  would have on each day.

hours answers on `/timesheets/time-off` (`GET /v1/time-off/pending`,
`POST /v1/time-off/{id}/approve`, `POST /v1/time-off/{id}/decline`, all
`timesheet:approve`), which also lists the leave already granted that is still
to come (`GET /v1/time-off/upcoming`, `timesheet:read`). Approved leave is what
the board, the crew check and the booking page read; a request changes nothing
for anybody until it is approved. A request is asked again with the same key
and gets its first answer rather than a refusal that it overlaps itself.

Both lists, and approving and declining, are for the people the approver's
timesheet scope reaches: a branch manager given `timesheet:approve` answers
their own branch's people, and another branch's request is not found.

### Run payroll

`POST /v1/payroll/periods` declares a period with `payroll:configure`.
`GET /v1/payroll/register` is the register, where every line carries a reason and
the people who cannot be paid are named first.
`POST /v1/payroll/periods/close` and `POST /v1/payroll/periods/reopen` close and
reopen. `POST /v1/payroll/exports` produces the CSV and
`GET /v1/payroll/exports` lists what has been produced. `/payroll` and
`/payroll/{id}` are the screens.

### Commission

`GET /v1/commissions/plans` lists the plans and
`POST /v1/commissions/plans` declares one, both with `commission:configure` to
write. `POST /v1/commissions` settles an earning,
`POST /v1/commissions/reversals` reverses one, and
`POST /v1/payroll/commission-payments` records them as paid, which is a payroll
act and takes `payroll:export`. `/payroll/commissions` is the screen.

### An item's own rate

A price book item can carry a commission rate of its own (M06). How it works with
the plan on an invoice line priced from that item is **the company's choice**, one for
everybody, made on `/payroll/commissions` under "When an item has its own rate"
(`GET /v1/commissions/item-rule` with `commission:read`, `POST /v1/commissions/item-rule`
with `commission:configure`, audited with the choice before and after). Each choice is a
sentence the screen shows beside it:

| Choice | What a line for an item with its own rate pays |
|---|---|
| The plan only (`plan_only`, the default) | The plan, as before: the item's rate pays nothing |
| The item's rate, where it has one (`item_wins`) | The item's rate instead of the plan |
| Whichever pays more (`higher`) | The item's rate or the plan's part of the line, whichever comes to more |
| The item's rate on top of the plan (`item_adds`) | The plan's part and the item's rate |

A line with no item rate pays the plan under every choice. The arithmetic is core's
(`labor.computeCommission` with the plan's `itemRule`, unit tested with hand worked
figures for every choice and every basis):

- The plan is worked out on the whole invoice exactly as before. **The plan's part of a
  line** is its rate on what the line charged for a percentage of revenue; for a margin,
  a flat amount or a share of what was collected, which are not a rate on each line, it
  is the line's share of the plan's figure by what the line charged. The item's part is
  its rate on what the line charged, net of the line's discount and before tax.
- The commission is the plan's figure with each item line's difference made, so a line
  with no item rate pays the plan to the cent; it is made payable once, to the cent, and
  then split between the people who share it exactly as any commission is.
- A job that lost money still pays an item's own rate on its line (the plan pays
  nothing), because the item's rate is a share of what the line charged. Lines that come
  to less than nothing pay nothing; they are never taken off other commission.
- The rate read is the one on **the price book version the line was priced from**, never
  the item's version today, so raising a rate does not reprice what was already sold.
- A plan that would refuse (a margin with no cost) still refuses under every choice.

Settling records on the earning which choice produced it and, line by line, the version,
the rate it carried, the plan's part, the item's part, what the line paid and which of
the two that was (`commission_event.item_rule` and `lines`, returned as `itemRule` and
`lines` by `POST /v1/commissions` and the split proposal, and `itemRule` on every entry of
`GET /v1/commissions`). The reason is written into each person's part ("The company pays
an item's own rate on its line instead of the plan. ... Water heater: 10% of $1,000.00
is $100.00, paid instead of the plan's $80.00. Commission: $116.00."), which is what the
payroll register and the person's pay statement show. The split screen shows the choice
and a table of what each line pays, before settling and after.

**A change applies from then on**: a commission is worked out under the choice in force
when it is settled, and keeps it. A reversal recomputes under the choice the earning was
made under, taking the credit off every line in proportion to what it charged, since a
credit names an amount and not the lines it came off.

### A commission several people share

`/payroll/commissions/splits` ("Shared commission" under Payroll) lists the
invoices waiting to be shared: sent or paid, not voided or written off, on a job
two or more people were assigned to, made since the company's first commission
plan, with no commission settled yet (`GET /v1/commissions/shared`,
`commission:read`). Under them, "Shared lately" is the last twenty earnings paid
to more than one person, each person's part, and the reason given for the split.

"Share it" opens `/payroll/commissions/splits/{invoiceId}`: what the invoice
earns under the plan, and who gets what under the split proposed between the
people on the job (even, or shaped by their standing shares, below), worked out by core (`GET /v1/commissions/split-proposal`,
`commission:read`, which writes nothing). The office changes the shares, adds
somebody who was not on the visits (the person who sold it, say) or puts 0 to
leave somebody out, and "Work it out" shows each part again through the same
code settling uses, so what is on the screen is what will be owed. A share is a
part of the whole, not a percent: 2 and 1 is two thirds and one third, and the
odd cent goes to the biggest share. With two plans in force the page asks which
one. Anything settling would refuse (a margin plan with no cost, a split of
zeros) is said on the page instead.

**Within the rule.** The total is the plan's and is never changed on this
screen; the shares only divide it. The rule is core's (`labor.checkShares`,
`labor.evenShares`, `labor.sameSplit`, with unit tests), and the API's settling
refuses the same splits in the same words: nobody twice, a weight a decimal of
at most six places, at least one share above zero.

"Settle this split" (`POST /v1/commissions/splits`, `commission:configure`) is
the same settling as `POST /v1/commissions`, with one more rule: **a split that
is not the one proposed between the people on the job needs a reason.** The reason
is kept on the earning and written into each person's part ("Shared this way by
the office: ..."), which is the sentence they read beside the commission on
their own pay statement, and the audit records the split proposed beside the one
settled. Sent again with the same split, it answers with what was settled; a
different split for an invoice that has already earned is refused, because
settling twice pays twice.

**A judgement the product owner has not made, and the conservative reading
taken.** Only the split screen asks for a reason. `POST /v1/commissions` with
named shares, which existed before the screen, still settles without one, so an
integration that sends its own split keeps working; its earning is audited with
its parts as it always was.

### Settle several at once

On `/payroll/commissions/splits`, each invoice waiting to be shared shows the
split proposed for it (even, or with standing shares), worked out as settling
it would be, with who gets what; one that settling would refuse says why
instead (two plans in force and none named, a margin plan with no cost). Whoever
holds `commission:configure` ticks the ones whose proposed split they are happy
with and presses "Settle the ticked ones as proposed"; with more than one plan in
force they name the plan they are all under. Each ticked invoice is settled
exactly as "Settle this split" would settle it alone with the split proposed and
no reason (`POST /v1/commissions/splits/as-proposed`, which hands each one to
`POST /v1/commissions/splits`'s own settling), in its own transaction, so each is
audited as its own earning (`commission.earned`, with the split proposed beside
the one settled and `changed: false`) and posted to the ledger on its own. One
that settling refuses is listed with its reason and does not stop the rest; the
page then says "Settled 2: ..." under the button and names any that were not,
and why (when the last waiting invoices settle, the list empties instead and
they appear under "Shared lately"). The
proposal is read and then checked again inside each settle, so a standing share
changed in between is refused for that invoice rather than settled under a
split nobody saw. Sent again, an invoice already settled with its proposed split
answers with that earning, and one settled another way since is refused. At most
fifty at a time, the length of the waiting list.

### A standing share

Somebody can always take the same part of a commission they share: the
person who sells the systems always gets 30%, say, or a lead gets 40% of the
jobs they lead. "Standing shares" on `/payroll/commissions/splits` lists the
ones in force with the reason for each, and sets one: who, a whole percent
from 1 to 99, "Only on jobs where they lead a visit" or whenever they are on
the job, and why (`GET /v1/commissions/standing-shares` with
`commission:read`, `POST /v1/commissions/standing-shares` with
`commission:configure`). "Stop" ends one
(`POST /v1/commissions/standing-shares/{id}/end`). A share is stopped, never
edited: setting a new one for the same person stops the one before it, both
are audited, and the last ones stopped are listed under the table. Sent again
with what is already in force, the set answers with that.

**It proposes; the office still decides.** When a shared commission is
proposed, everybody on the job's visits with a standing share that applies
gets it, and whatever is left is split evenly between the others, worked out
by core (`labor.proposeSplit`, with unit tests) in whole number weights so the
fractions stay exact: 30% beside two others is 90, 70 and 70, which is $24.00,
$28.00 and $28.00 of $80.00. The split page says it in a sentence ("Standing
shares: Ray Nunez takes 30% (He sells the systems). The remaining 70% is split
evenly between the other 2 people."), and its column is "Proposed" rather than
"Even split". Settling as proposed needs no reason; the sentence is kept on the
earning (`commission_event.standing_note`) and written into each person's part,
because a standing share can be stopped later and the earning has to keep
saying why. The office can still change the split, within the same rules
(nobody twice, a weight of at most six decimal places, one share above zero),
and a split that is not the proposed one needs a reason, as before; its reason
is then what each part says. `POST /v1/commissions` with no shares named takes
the same proposal, so an earning settled over the API divides the way the
screen would have proposed. Commissions already settled are never touched by
setting or stopping a share.

**Two judgements the product owner has not made, and the conservative reading
taken.** When the standing shares on a job cannot all be honoured (they add up
to 100% or more with somebody else on the job, who would get nothing, or
everybody on the job has one and they do not add up to 100%), nothing is scaled
or guessed: the even split is proposed and the page says why, and the office
settles it as it sees fit. And a standing share applies only to people on the
job's visits: somebody the office adds to a split by hand gets what the office
types, and that is a change that needs a reason.

### What people paid for the company, and a day away

A technician records what they paid out of their own pocket: the amount, the day,
what it was for, the job if any and a photograph of the receipt. From the phone app
and `/my-day` it is an `expense.record` in the same offline queue as everything else
(M11), the receipt following through the hash checked upload path as an
`attachment.attach` naming the expense; from a desk it is `/me/expenses`
(`POST /v1/me/expenses`, `expense:own`, which every preset holds).
`GET /v1/me/expenses` is the person's own list with the office's answer and the days
away they are paid for, and `POST /v1/me/expenses/{id}/receipts` adds a photograph
while it is still waiting. The id is made by the phone, so a retried send records it
once. Always the person's own: nothing here takes a person.

Whoever approves them (`expense:approve`: the office manager, the branch manager for
their own branch's people, the accountant and the owner) answers on
`/timesheets/expenses`: `GET /v1/expenses` is the queue, waiting ones first, each
with its receipt and the job it was for, and `POST /v1/expenses/{id}/decision`
approves it or refuses it with a reason the person reads. The person is told the
decision (and the reason) by a notice (M34) on the bell, the phone app or a text, as
they chose on `/me`, opening `/me/expenses`. The people a reader may
decide for are the ones their timesheet scope reaches. **A decision is final,**
because the payroll file is built from it: the same decision again answers with the
first, and the other one is refused saying who decided. A wrong approval is put right
with the bureau and a wrong refusal by the person recording it again; taking a
decision back is not built.

An approved expense goes to the pay period the approval falls in, as a
`reimbursement` line on the register and in the export, in the export's existing
format: one row per person per pay category, the amount in `amount`, no hours and no
rate. It is not in `grossTotal`; the register and the export carry it as
`reimbursementTotal`. A period that has not been declared for the day of the approval
leaves the expense approved and unpaid, and the office's screen says so beside it.
The close's fingerprint covers approved expenses and days away, so an edit after the
close is refused at the export like any other.

**Miles.** A claim can be entered as miles driven in the person's own vehicle instead of an
amount: `miles` (to a tenth, at most 2000.0 for one claim) in place of `amount` on
`POST /v1/me/expenses`, never both. The company sets what one mile is paid on
`/payroll/pay-rules` under "Mileage": `POST /v1/payroll/mileage-rates` adds a line (`from`, the first
day it applies, and `perMile`, dollars to three decimals because the tax authority's own rate
has half cents, at most 3.000) and `POST /v1/payroll/mileage-rates/{from}/removal` takes one off
(`payroll:configure`, which the office manager does not hold; the owner and the accountant do).
`GET /v1/payroll/pay-extras` returns the lines, oldest first, and the rate in force today. A claim
is worked out by the server, never by the caller, at the rate in force on the day of the drive
(`spentOn`, not the day it was typed): the latest line that starts on or before it. Miles times
the rate is rounded to the cent, the half cent up (12.5 miles at 0.725 is 9.0625, paid as 9.06). The
miles, the rate and the amount are kept on the claim (`expense.miles`, `expense.mileage_rate`), so
adding or taking off a line never reprices a claim already made, and the same claim sent again
keeps the first rate. With no rate in force on that day the claim is refused in words and says
so; there is no guessing at the nearest rate. A line for a day that already has one is refused
rather than replaced, because claims worked out at it keep it: take it off and add the right one.
It is approved, exported and counted in the job's cost exactly like any other expense; the same
`reimbursement` pay category carries it, the register and statement line says "(12.5 miles at
$0.725 a mile)" so the bureau's copy shows where the figure came from, and the office sees the
miles and the rate beside the amount on `/timesheets/expenses`. It is not posted to the ledger,
for the reason a receipt is not. The person enters miles on `/me/expenses`, on `/my-day` and on the
phone app, each only when a rate is in force today (the phone is told it with the day,
`abilities.mileageRate`, and hides the box otherwise); the phone sends miles as `miles` on
`expense.record` and shows "18.4 miles" until the server has worked the amount out, so it never
shows a figure it made up. The phone's rate is as of its last fetch: the server works the claim
out at the rate on the day whatever the phone showed.

A per diem is the company's rate for one day away. `POST /v1/payroll/pay-extras`
(`payroll:configure`) sets it, on `/payroll/pay-rules` under "A day away", and
`GET /v1/payroll/pay-extras` reads it (`timesheet:read`). No standard rate and no place
means no per diem is paid; with places and no standard rate, days are paid only at a place.
`POST /v1/per-diem` (`expense:approve`) records each day from the first to the
last (at most 31) a person was away on a job, named by id or by number, at the rate as
it stands that day, kept on the row so a later change does not reprice it. A day that
already has one for that person is left as it was and named. A day inside a closed
period is refused, and `POST /v1/per-diem/{id}/removal` takes a wrong one back out while
its period is open. `GET /v1/per-diem` lists them. A per diem is exported as `per_diem`,
the same way, and the office does it on `/timesheets/expenses`.

**A day away by place.** The rate above is the company's standard one. A company whose
days away are worth more in some places keeps a list of places on `/payroll/pay-rules`
under "Days away by place": a name, optionally a city and a state (two letters), and a day
rate from a date, with more rates added later and each place's list kept oldest first, the
way mileage rates are (`POST /v1/payroll/per-diem-places`,
`POST /v1/payroll/per-diem-places/{id}/rates`,
`POST /v1/payroll/per-diem-places/{id}/rates/{from}/removal` and
`POST /v1/payroll/per-diem-places/{id}/retirement`, all `payroll:configure`; the list is on
`GET /v1/payroll/pay-extras` as `perDiemPlaces`, with what a day there is worth today). A
rate for a day that already has one is refused rather than replaced, a place is retired and
never deleted because recorded days name it, and two places in use cannot share a name. The
places are kept in the company's pay settings beside the mileage rates. Recording a day
(`POST /v1/per-diem`, `expense:approve`) takes a `placeId`. Left out, the place is the one
whose city is the job's address's city (and whose state, when it gives one), compared
without regard to case or spacing: nothing is matched on a near miss, a place with a state
only or a name only is never picked for a job by itself, and a city no place names (or two
that do) is refused in words that name the city and ask the office to choose, never guessed.
`placeId: null` says the standard rate on purpose, which the screen offers as "Nowhere on
the list: the standard rate". A company with no places records exactly as before. Each day
is worked out at the rate in force on that day at the place, and is kept with the place's id
and name (`per_diem.place_id`, `place_name`), so a rate added, taken off or a place retired
afterwards never reprices a day recorded. A day the place has no rate for (before its first
rate, or after its only rate was taken off) is refused by name and nothing in that entry is
recorded. One entry is one place: a span that crosses places is recorded as separate
entries, each with its own days, and a day somebody already has one for is left alone and
named, so the second entry cannot overwrite the first. The answer carries `place` and
`amounts` (each new day's figure) when a place was used, and `rate` is the place's rate when
it was the same on every day recorded. The days list, a person's own page of days away, and
the job's "Paid back to people" show the place. Like the standard rate, a place's day is
paid with no tax taken, which is only right within the tax authority's allowance for that
place and day, and that check is the company's; none of it is posted to the ledger.

**Three judgements the product owner has not made, and the conservative reading taken.**
A per diem is paid with no tax taken from it, which is only right while it is within
what the tax authority allows for the place and the day (an accountable plan), and
that check is the company's: the screen says so beside the rate. And a receipt is not
required to record an expense; the office sees "No receipt" and decides. And a mileage rate is
the company's to set and its to keep within the tax authority's own rate, which this product
does not know or check: nothing is preloaded, so no mileage is paid until the owner or the
accountant adds a line, and a mile is paid with no tax taken, which is only right within that
rate (the screen says so beside it). The rate is read on the day driven, never the day typed or
approved, so a claim made late for last year uses last year's rate.

**On the job.** Approved reimbursements and per diem days for a job are in its cost:
`expenseCost` on `GET /v1/jobs/{jobId}/expenses` (`job.cost:read`) and on the job's
costing statement, subtracted in the gross margin, in the project roll up and
available as the "Expenses and per diem" report measure. A receipt still waiting for
the office is not counted, and the job's margin says so in words while there is one.

### Tips

A tip a customer adds when paying an invoice from the portal (M05, M13) is
shared between the technicians on the job's visits by the company's rule and
arrives owed to them. Each share is its own line on that technician's register and export,
`tip` in the pay category column, in the period the payment arrived in, and a
technician who was tipped and not on the clock that period is still on the
register. A commission reversal is never taken out of a tip: it is measured
against wages, carried forward when wages cannot take it, and the tips are
added whole afterwards, because a tip is the technician's money and an
employer keeping part of one is what US federal law forbids. A tip arriving
inside a period after it closed moves the period's fingerprint, so the export
refuses until it is reopened and closed again.

**A visit recorded from history earns nothing here.** A past visit brought in
from the company's old system (M30, `fromHistory` on the visit) is left out of
the people a tip is shared between and the people a commission is split
between or proposed for, and puts no time on anybody's timesheet: whatever
that work earned was settled in the old system, if it was settled at all. A
job whose only visits are from history has nobody to infer a split from, so a
commission on it names who it is for.

A tip taken with cash or a check on site (M11) is the same: held, split and
paid through payroll. A cash tip a customer hands the technician for
themselves, which they keep, is different: it never reaches the company and
nothing about it is booked, but it is still pay that has to be reported, so
the technician records it on the phone and it is a `cash_tip` line on their
register and export, in the gross, said to be already in their hand. The
bureau reading that category withholds on it and pays none of it out, and
paying tips through payroll leaves it alone.

`POST /v1/payroll/tip-payments` records the tips as passed on, from a closed
period, everything owed up to its end; it debits Tips payable against cash and
marks each share with the period that paid it, so running it twice pays nothing
twice. **Record tips as paid** on `/payroll/{id}` is the same thing.

**How a tip is shared.** The company chooses on `/payroll/pay-rules`, under "Tips
and days away" (`POST /v1/payroll/pay-extras`, `payroll:configure`;
`GET /v1/payroll/pay-extras` reads it, `timesheet:read`): evenly to the cent, as it
always was and what a company that never chose gets; by the hours each person was
clocked in on the job (closed, paid punches against that job, in proportion, to the
cent, the odd cent to the largest share; somebody with no hours has no share); or all
to the lead, the person marked lead on any of the job's visits that were not
cancelled (several leads share it evenly). A rule with nothing to go on, no hours
recorded or no lead marked, shares the tip evenly and says so in a sentence kept on
the share and shown on the invoice's tips. **It applies to tips from then on:** a
tip is shared the moment the money arrives with the rule in force then, the rule is
kept on each share, and a change never re-splits one already shared. The arithmetic
is core's (`payExtras.splitTipByRule`), with unit tests, and the portal and the
phone's cash payment both go through it.

**The office and a cash tip.** A tip the technician kept normally comes from their
phone. When they did not record it, or got the amount wrong, whoever holds `tip:record`
(the office manager, the branch manager for their own branch's people, the accountant
and the owner) records it on `/timesheets/tips` (`POST /v1/cash-tips`) or corrects
it (`POST /v1/cash-tips/{id}/correction`), each with a reason, audited, and
`GET /v1/cash-tips` lists them with every change. A correction keeps the amount before
and after, the reason and who made it, and a correction to 0 takes a tip that was never
given off their pay. A second tip of the same amount for the same person on the same
day is refused as a likely duplicate, because tax paid on a tip twice is the mistake
this would otherwise make easy. A tip in a pay period that has been closed is not
recorded or changed: the period is reopened first, as with a backdated commission, and
the close's fingerprint covers every amount, so an edit that slips round it is refused
at the export. **The technician sees it:** `GET /v1/me/cash-tips` (`payroll:own`) and
"Cash tips on your pay" on `/me/pay` list their own, including the ones the office put
there, why, and every change with the reason, before the period closes.

### Declare overtime and wage scales

`/payroll/pay-rules` is the screen: the overtime rule in use and the ones it
replaced, every wage scale with its dates, and who is paid at which classification
with the people whose time would cost nothing named. Reading it takes
`timesheet:read` and changing anything `payroll:configure`.

`GET /v1/payroll/overtime-policies` lists the policies and
`POST /v1/payroll/overtime-policies` declares a new one, which replaces the old one
and says when it reclassifies weeks already approved.
`GET /v1/payroll/wage-scales` lists the scales and `POST /v1/payroll/wage-scales`
loads one. `POST /v1/payroll/wage-scales/{id}/revisions` changes a rate from a date:
the old scale is closed the day before and a new one opened from that day with
everything else it said, in one step, so time worked before keeps its rate. A change
dated on or before the day the scale began is refused, because that scale was wrong
rather than changed: `POST /v1/payroll/wage-scales/{id}/retire` stops it on a date
and the right one is loaded.

A scale can also carry the terms of the agreement it came from: its own overtime
multiplier, its own double time multiplier (each a number of at least 1, double
time not below overtime) and an apprentice ratio in the agreement's words ("1:3").
"Load a wage scale" on `/payroll/pay-rules` offers all three, the scales table
shows them under "Agreement terms", `GET /v1/payroll/wage-scales` returns them,
and a change of rate carries them to the new scale. **They are records, not
rules.** Overtime is worked out from the company's overtime rule, as it always
was, and nothing checks the apprentice ratio against who is on a job, so loading
a scale with 2 for double time does not change what a week costs; the screen says
so beside the boxes. Making a scale's own multipliers override the company rule
changes pay, which is a decision for whoever answers for the payroll rather than a
default, and it is not built. Nothing is deleted.
`GET /v1/payroll/crew-rates` says who costs what today and
`POST /v1/payroll/classifications` sets a person's classification. Loading,
changing and declaring answer a retried request with the first answer rather than
writing a second row.

## Permissions

| Role | Access |
|---|---|
| Owner | Everything |
| Administrator | Nothing in payroll unless it is granted explicitly, which includes approving what people paid for the company and recording cash tips |
| Office manager | Reads timesheets, approves what people paid for the company (`expense:approve`) and records or corrects a cash tip (`tip:record`) |
| Dispatcher | Reads timesheets |
| Technician | Clocks in and out. Their own time only, their own pay statements for closed periods, and what they paid for the company (`expense:own`, which every preset holds) |
| Branch manager | Reads their branch's people's timesheets and time off; approving them is granted by name |
| Accountant | Reads payroll, runs the export, reads commission, approves what people paid for the company and records or corrects a cash tip |

`payroll:read` and `commission:read` are both on the sensitive list, and the
administrator preset deliberately excludes `payroll:read`, `payroll:export` and
`payroll:configure`: running the system is not the same job as paying people.

## API

| Call | Needs |
|---|---|
| `GET /v1/timeclock/me` | `timeclock:own` |
| `GET /v1/timesheets/week` | `timesheet:read` |
| `POST /v1/timesheets/approvals` | `timesheet:approve` |
| `POST /v1/payroll/periods` | `payroll:configure` |
| `GET /v1/payroll/register` | `payroll:read` |
| `POST /v1/payroll/periods/close` | `payroll:export` |
| `POST /v1/payroll/exports` | `payroll:export` |
| `GET /v1/commissions` | `commission:read` |
| `POST /v1/commissions/plans` | `commission:configure` |
| `GET /v1/commissions/shared` | `commission:read` |
| `GET /v1/commissions/split-proposal` | `commission:read` |
| `POST /v1/commissions/splits` | `commission:configure` |
| `POST /v1/commissions/splits/as-proposed` | `commission:configure` |
| `GET /v1/commissions/standing-shares` | `commission:read` |
| `POST /v1/commissions/standing-shares` | `commission:configure` |
| `POST /v1/commissions/standing-shares/{id}/end` | `commission:configure` |
| `GET /v1/commissions/item-rule` | `commission:read` |
| `POST /v1/commissions/item-rule` | `commission:configure` |
| `POST /v1/payroll/commission-payments` | `payroll:export` |
| `POST /v1/payroll/tip-payments` | `payroll:export` |
| `GET /v1/payroll/overtime-policies` | `timesheet:read` |
| `POST /v1/payroll/overtime-policies` | `payroll:configure` |
| `GET /v1/payroll/wage-scales` | `timesheet:read` |
| `POST /v1/payroll/wage-scales` | `payroll:configure` |
| `POST /v1/payroll/wage-scales/{id}/revisions` | `payroll:configure` |
| `POST /v1/payroll/wage-scales/{id}/retire` | `payroll:configure` |
| `GET /v1/payroll/crew-rates` | `timesheet:read` |
| `POST /v1/payroll/classifications` | `payroll:configure` |
| `GET /v1/me/pay-statements` | `payroll:own` |
| `GET /v1/time-off/pending` | `timesheet:approve` |
| `GET /v1/time-off/upcoming` | `timesheet:read` |
| `POST /v1/me/expenses` | `expense:own` |
| `POST /v1/me/expenses/{id}/receipts` | `expense:own` |
| `GET /v1/me/expenses` | `expense:own` |
| `GET /v1/expenses` | `expense:approve` |
| `POST /v1/expenses/{id}/decision` | `expense:approve` |
| `POST /v1/per-diem` | `expense:approve` |
| `GET /v1/per-diem` | `expense:approve` |
| `POST /v1/per-diem/{id}/removal` | `expense:approve` |
| `GET /v1/payroll/pay-extras` | `timesheet:read` |
| `POST /v1/payroll/pay-extras` | `payroll:configure` |
| `POST /v1/cash-tips` | `tip:record` |
| `POST /v1/cash-tips/{id}/correction` | `tip:record` |
| `GET /v1/cash-tips` | `tip:record` |
| `GET /v1/me/cash-tips` | `payroll:own` |

## Common questions

**Why does the export refuse after somebody edits a punch?** Because the numbers
would differ from the file already sent, with nothing saying so. Reopen the
period, close it again, and export.

**Can a technician see their own pay rate?** On their own statement for a closed
period, yes: `payroll:own`, which every preset holds, shows them the rate their
hours were paid at. Anybody else's, and the rates on a punch while a period is
open, need `payroll:read`, which the technician preset does not hold. A company
that shows pay through its payroll bureau's own portal revokes `payroll:own`.

**Why is there one commission permission for declaring a plan and settling an
earning?** Declaring and settling are different acts and a larger product would
separate them, but a third permission no role preset grants is a power nobody
could hold, which is worse than a coarse one.

## What is not built

No payroll processing, by design. A wage scale's own overtime multipliers and
apprentice ratio are kept and shown but do not change any figure: overtime comes
from the company's overtime rule only, and the ratio is not checked against crews.
A scale's agreement terms are set when it is loaded and cannot be changed on the
screen afterwards; a scale cannot be corrected in place: a wrong one is retired and
the right one loaded. Tips given through the portal or with a payment on site are paid through
payroll; a cash tip a technician kept is recorded on the phone and on `/my-day` by
the technician, and by the office when they did not or got it wrong, on
`/timesheets/tips`. A tip is shared evenly, by hours on the job or to the lead, one
rule for the whole company: there is no rule per job or per technician, and "hours" is
the hours clocked against the job, not against one visit of it. Reimbursements and per diem
are recorded, decided and exported, but not posted to the ledger, only for people on
the board, and a decision on a reimbursement cannot be taken back. A mileage rate is one
company wide figure from a day: there is no rate per person, per vehicle or per kind of work, no
odometer or trip log behind the miles (they are what the person types, and the office
decides), no distance worked out from the addresses, and nothing checks the rate or the miles against the
tax authority's rate. A claim in miles is not repriced when its rate is wrong: it is refused by the
office and entered again. A per diem does not vary by meal, and nothing checks a per diem against the tax
authority's allowance, at a place or at the standard rate. A place is only a name, a city
and a state: there is no radius or postcode, no place picked from where a technician's phone
was, and a trip crossing places is recorded one place at a time by the office, because one
entry has one place. A place's rate is not corrected in place: a wrong one is taken off and
the right one added, and days already recorded are not repriced, so a wrong day is taken out
and recorded again while its pay period is open. Certified payroll reporting is not built. How an item's own commission rate works
with the plan is one choice for the whole company: there is no choice per plan, per item
or per person, and the plan's part of a line on a margin, flat or collected plan is its
share by what it charged, not a margin or a cost worked out for the line. Three
judgements the product owner has not made were taken the conservative way: the choice in
force when a commission is settled applies (not the one when the invoice was raised); a
credit comes off every line in proportion, because a credit does not say which lines it
was for; and lines that come to less than nothing pay nothing rather than reducing other
commission. A commission
several people share is settled from the split screen, one invoice at a time or
several at once each with its proposed split; a page of them cannot be settled
with a split the office changed, which is done one invoice at a time with a
reason. A person can have a standing share
that the split proposes, but there is no standing rule per job type, a standing
share applies only to the people on the job's visits (somebody added by hand gets
what the office types), and standing shares that cannot all be honoured propose
the even split rather than being scaled. Nothing settles a commission by itself
when an invoice is paid. A split already settled is not changed on the
screen: the way to put one right is a reversal and settling again. Only the split
screen asks for a reason for an uneven split; the older settling route does not. A person's own statement is gross pay: what the
bureau withheld is on the bureau's statement, and this product never knows it.
Part of a day off is read by the hour on the booking page, in booking a visit, on the
dispatch board, in the crew check, in the map's suggestions and in the multi day
rebalance. The planner keeps a visit out of the hours somebody is off, but it does not
plan around them: it does not know a person's route would run into the afternoon they
are off, so a day it orders for them is not shortened to the morning. There is
no leave of part of the first day and a different part of the last other than the one
pair of times (from a time on the first day to a time on the last), and no recurring
part day off.
