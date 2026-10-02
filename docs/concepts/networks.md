# Networks: a franchise or a holding group

A franchisor with thirty franchisees is not one company with thirty branches.
Each franchisee is a separate business with its own customers, its own books,
its own staff and, in most agreements, its own legal obligation to report some
numbers upward and none of the rest.

That shape is a tenancy question and a consent question at the same time, and
the two pull in opposite directions. Row level security is forced on every
table in this product that carries an `organization_id`, which is the property
everything else rests on. A roll up is by definition a read across that
boundary.

This document says how that read happens, what it can and cannot reach, and
why each limit is where it is.

## Three objects

**`network`** is the group. A kind (`franchise`, `holding`, `cooperative`), a
name, a slug, and optionally the organization that operates it. A cooperative
buying group may have no operating company at all, and then nobody can read a
roll up of it, which is correct.

**`organization.network_id`** and **`.network_member_code`** are the
membership. The code is the franchisee's territory, or the acquired brand's
identifier, and it is what a consolidated report is grouped by, because
"Franchisee A-01" means something to a franchisor and a uuid does not.

**`network_grant`** is the consent. One row per `(network, organization,
aggregate)`, with `granted_at` and `revoked_at`. This is the object the whole
feature turns on.

## The member grants, per aggregate

Not the operator, and not per network.

A franchise agreement that entitles a franchisor to royalties on revenue does
not thereby entitle them to the franchisee's general ledger. Those are
different obligations with different scopes, and a product that modelled
sharing as one switch would make the software's answer narrower or wider than
the agreement's in every case.

So there are four aggregates and a member turns on each one separately:

| Aggregate | What it is |
|---|---|
| `job_counts` | Jobs completed per month. No customers, no addresses, no amounts. |
| `revenue_summary` | Invoiced and collected per month, as totals. |
| `kpi_scorecard` | The revenue summary plus invoice counts, so an average ticket can be worked out. |
| `gl_summary` | Ledger totals by account CLASS per month. Never a single account. |

There is no `customer_list` and there will not be one. A franchisor who wants
a franchisee's customers is asking for the asset the franchisee owns, and no
consent dialogue in a piece of software makes that a feature.

**The grant is written by the member's own session.** That is structural rather
than checked: `share` inserts a row with `ctx.actor.organizationId`, so there
is no argument in which another organization's id could be put. There is also
no operator function that grants on a member's behalf, and the absence is
deliberate: an operator that could grant would be consenting for somebody else.

**A revocation is immediate and is a revocation, not a delete.** The roll up
checks for a live grant on every call and caches nothing. The row stays with
`revoked_at` set, because "they used to see our revenue and we stopped letting
them in March" is a fact a member may need to prove, and a deleted row proves
nothing. It is also what makes re-granting an update rather than an insert: the
unique index has no predicate, so a revoked grant and a never-granted one are
the same row.

## Membership is set from outside the product

`POST /v1/operator/organizations/{id}/network`, on the operator API, which is
off unless `OPERATOR_TOKEN` is set.

An organization must not be able to put another organization into its network.
Joining is harmless on its own, because nothing is shared until the member
grants it. But joining is what creates the relationship the member is then
asked to consent to, and a consent dialogue about a relationship the member
never agreed to is not consent. Whoever runs the deployment already knows which
companies are franchisees of which franchisor, because they set them up.

**Leaving revokes every grant.** A franchisee who leaves the franchise has not
agreed to keep sharing their revenue with their former franchisor, and a grant
row left behind with the membership gone would start sharing again the day
somebody put them back in.

## The operator is a member of its own network

It has to be, for a reason that is worth stating because it looks like an
accident. The policy on `network` admits the network a session's own
organization belongs to, so an operator that was not a member could not read the
row describing the network it operates.

It is also right on its own terms: a franchisor with company owned branches
wants them in the roll up, and a member code of `operator` says which row is
the head office.

## One place crosses the boundary

`app.network_rollup(network, aggregate, from, to)` in `sql/after.sql`. It is a
`security definer` function, it is granted to `authenticated` and to nothing
else, and it enforces four things:

1. **The caller is the network's OPERATOR.** Not a member of it. A franchisee
   must not be able to read its neighbour's numbers by naming the network it
   also belongs to, and that is the first thing anybody would try. The service
   answers `404` rather than `403`, because `403` confirms there is something
   there and invites the next attempt.
2. **The member granted THAT aggregate.** Checked per member per call.
3. **A suspended organization contributes nothing**, for the same reason its
   credentials stop resolving: whoever runs the deployment has turned it off.
4. **The return shape is `(organization, period, metric, value)`.** There is no
   path through it to a customer name, an address, a job description or an
   invoice number. That is a property of the function body rather than of a
   convention: every branch of it is a `GROUP BY`.

`app.network_members(network)` is the second function, and it answers a
different question: who is in the network, including the members sharing
nothing. Name and member code only.

## Why the roster shows the silent members

"We have six franchisees and two have not turned sharing on" is what an
operator needs to see. A roster that listed only the sharing ones would make
the missing numbers look like zeros, which is the difference between chasing a
franchisee and writing off a market.

The roll up itself carries the same idea in `notContributing`, with a flag
separating two facts that look identical in a total:

- `sharesThis: false` means they have not consented.
- `sharesThis: true` means they have, and had no activity in the window.

A consolidated figure that cannot distinguish those is a figure somebody will
read as the whole network.

## Why a member with no grant is silent rather than an error

Raising an error would let an operator lean on a member by making the whole
report fail until they consent. The pressure would be real and the software
would be the thing applying it.

## Two deliberate shapes in the numbers

**No ratios inside an aggregate.** `kpi_scorecard` returns the invoice count
and the invoiced total, not an average ticket. A ratio computed per member
cannot be summed across members afterwards, and a franchisor comparing six
brands will try.

**The ledger by class, never by code.** An account code is the member's own
chart of accounts. Naming one would let an operator ask about a single account,
which is a row read wearing an aggregate's clothes. The five classes are
revenue, expense, asset, liability and equity, signed to each account's normal
balance, which is the same rule `core/ledger` holds.

## The screen

`Settings > Group`, and it is one screen with two halves because a company can
be on either side of the relationship. A franchisee sees the top half: four
measures, each with the service's own description of what it gives away, and a
switch on each. A franchisor sees both, because it is a company in its own right
and its own numbers are in its own roll up.

**The member's half is the important one.** A consent nobody can see the state of
is not a consent. Until this screen existed the grants were rows an owner could
only read through the API, and somebody who cannot tell what their franchisor
can see will assume the worst and be right to.

Two details that are the screen rather than decoration:

- **Shared and not shared are one list.** A list of only what is on is a list of
  facts; this has to be a list of choices, so the measures a member has not
  granted are on it, marked as not shared.
- **The labels are words.** `gl_summary` reads "Ledger totals by class". On a
  screen whose whole job is informed consent, a label that looks like a variable
  name is what makes somebody click away without deciding.

A company in no network is told so in a sentence. Most companies running this
are one company, and a screen that treated that as a misconfiguration would be
wrong about the common case.

Changing what is shared needs `settings:write`; reading the screen needs
`settings:read`, and a reader who holds only the second is told which permission
is missing rather than shown switches that refuse.

## What is not built

- **No network level user.** A franchisor's analyst signs in to the operator
  organization. There is no account that spans members, and adding one would
  need a second answer to "what can this person see" alongside the grant.
- **No benchmarking.** A franchisor comparing a franchisee against the network
  median is the obvious next thing and is not here, because a median computed
  over the members who happen to have consented is not the network's median and
  would be read as one.
- **No roll up of anything a member has not granted**, which is not a gap.
