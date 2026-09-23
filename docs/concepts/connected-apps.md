# Connected applications

How a third party reads and writes against a company's instance, with the
company in control of exactly what it may touch.

Neighbrium is the first consumer and the worked example at the end, but
nothing in this design is specific to it. A partner-shaped hole in an open
source product is a liability: the next integrator finds a door built for
somebody else and has to ask permission to use it.

## What already exists

More than it looks like.

- **A published contract.** Sixty routes with a schema per route, served over
  HTTP at `/api/v1`, with the method, the path, the input shape and the
  required permissions all declared in one place.
- **An actor model that does not care what you are.** A service takes a
  `ServiceContext` carrying an actor. A user, an AI agent and an app are the
  same shape, and the permission check and the scope filter do not branch on
  which one it is. That was deliberate from the start and it is why this is a
  small piece of work rather than a parallel authorization system.
- **Scopes that narrow WHICH records**, not just which endpoints.
- **The licensing answer.** An Application Exception under AGPL section 7 is
  proposed in `docs/project/licensing-and-hosting.md`, so a partner building
  against the API is not pulled into AGPL. That has to be settled before
  anybody will build the integration, and it is a decision rather than code.

## What is missing

Three things, and none of them is the API.

### An app registry

A row per installed application: who it is, what it asked for, who approved
it, and when. The operator's view of this is one screen listing what is
connected and a revoke button per row, and the revoke has to be immediate
rather than "at next token refresh".

The thing it must never become is a list of API keys with no provenance.
"Which integration is reading my customer list" is the question, and a bare
key cannot answer it.

### Scoped tokens

A token carries a subset of the permissions the granting user holds, and the
same rule as everywhere else in this codebase: **you cannot grant what you do
not hold.** An office manager installing an app cannot give it the ledger.

The resolution is already written. `canDefineRole` refuses a permission the
author lacks and refuses a scope wider than their own, and an app grant is
the same decision with a different subject. It should reuse that function
rather than grow a second one, because two implementations of "may you grant
this" will disagree eventually and the disagreement will be silent.

Tokens also need an expiry and a rotation path. A partner integration that
holds a permanent credential is a permanent liability on both sides.

### A consent screen the operator actually reads

The app names the permissions it wants and the operator approves that exact
list. Not "connect this app", which is a yes/no to an unknown, but the list,
in the words the permission catalogue already uses.

An app asking for more than it needs should be visibly asking for more than
it needs. That is the only mechanism here that scales, because nobody is
going to audit a partner's code.

## Two things that are genuinely new work

### A publishable catalogue: it already exists

This was going to be a `publishable` flag on price book items, and building
it would have been a mistake.

`bookable_service` is already the operator-curated, customer-facing subset. It
carries a public name, a public description, a display price, a deposit, the
notice required and the territory, and `listServices` already serves it to an
unauthenticated caller. A shop with four hundred price book items exposes the
eleven it has made bookable, which is the same curation the flag was for.

A second flag would be a second source of truth about what a stranger may see,
and two of those disagree eventually. The disagreement would be a price shown
to a partner that the company does not honour, or an item exposed that the
operator thought they had unpublished.

What genuinely does not exist is attribution: a booking arriving through a
partner was indistinguishable from one off the widget. That is a column on
`booking_request` naming the app, not a new catalogue.

### Availability without exposing the schedule

A partner offering a time needs to know a slot exists. It does not need the
board, the technician names, or the other customers.

The booking module already answers this shape of question through
`getAvailability`, which returns bookable windows rather than the schedule. A
connected app should reach exactly that endpoint and nothing near it. This is
the case that most argues for scopes on an app grant rather than plain
permissions: `booking:read` on its own is a broader thing than "may see
whether Tuesday at two is open".

## The worked example: Neighbrium

Neighbrium turns neighbourhoods into buying groups for home services. What it
needs from a contractor's instance is small and it is all reads plus one
write:

1. **Which services this company offers, and the price.** `listServices`,
   which already returns exactly this and nothing more.
2. **Whether they serve this address.** Territory and business hours, both of
   which exist.
3. **Whether a slot is open.** `getAvailability`.
4. **Create a booking request.** `createBookingRequest`, which already exists
   and is already reachable without a session, because the public booking
   widget uses it.

So the integration is: one new flag on price book items, an app registry, a
scoped token, and a consent screen. Nothing about the API changes.

"Super easy to set up" means the contractor does three things: install the
app, tick which services to publish, and approve the permission list. Anything
beyond that is a place the integration will not get adopted, because the
person installing it is running a business and is doing this between calls.

What should NOT happen is a direct database connection, a shared credential,
or a Neighbrium-specific endpoint. All three are faster to build and each one
makes the second partner harder than the first, which is the wrong direction
for a project whose argument is that you own your data and can connect
whatever you like to it.

## Order

1. ~~The publishable flag on price book items.~~ Not needed:
   `bookable_service` already is that subset. See above.
2. The app registry and scoped tokens, reusing `canDefineRole`. **Built.**
3. The consent screen. Still to do: the registry records what was approved
   and by whom, and an operator approving an install still does it through
   the API rather than a screen that names the permissions in plain words.
4. The first integration, against the same public API any other partner gets.

None of it is scheduled yet. The licensing decision gates step four and only
step four, so the first three can proceed while that is being settled.
