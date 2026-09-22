# Invariants

Rules the system holds everywhere. Each one exists because getting it wrong is
expensive in a way that is not obvious until it happens, so each carries its
reason. If you are about to break one, that is a design conversation, not a
pull request.

## Tenancy

**Every tenant-scoped table carries `organization_id` and is covered by row
level security.** Policies are applied off the `pg_catalog`, so a new table is
protected the moment it exists rather than when someone remembers. A coverage
assertion fails the migration if any table with the column lacks the policy.

**Application code never filters by organization by hand.** A forgotten `WHERE`
clause is a cross-tenant leak, and hand-written filters get forgotten.

**A network never widens the tenant boundary.** Franchise and holding
structures read across organizations only through an explicit grant for a named
aggregate, checked in the application and written to the audit log. Scope
narrows within the boundary; nothing widens it.

**RLS policies are written `to authenticated` with the context function wrapped
in a subselect.** `(select app.current_organization_id())` is hoisted into an
InitPlan and evaluated once; written bare it is evaluated per row. The
difference is measured in orders of magnitude, not percentages.

## Money

**No floats.** `numeric(14,4)` in the database, a scaled `bigint` in code.
Parsing accepts a decimal string and rejects a JS number, because accepting one
is how a float gets in.

**The ledger is append only.** A correction is a reversing entry. Enforced by a
trigger, with a deferred constraint trigger requiring each transaction to
balance at commit.

**Historical rates live on the document.** Tax rates and prices are stored as
applied and never recomputed on read.

**Rounding happens once, at the document total.** Not per line.

**Allocation reconciles exactly.** Money split across invoices, lines, crew
members or tax jurisdictions sums back to the original to the cent. Allocate at
the precision the parts will actually be stored or paid at, or rounding
afterwards loses a cent.

**Every outbound external call writes an `integration_event` with an
idempotency key before it fires.** A retry is a no-op, never a second charge.

## Field work

**Never reject a field write that records something that actually happened.**

A technician completing a visit that dispatch already cancelled is accepted
into `completed_after_cancellation` and raises a dispatcher exception. Their
labour, photos, signature, readings and compliance record all survive. The work
physically happened; deleting the evidence does not undo it.

**Sync the movement, never the balance.** Two trucks decrementing stock offline
must both be recorded as movements. Let the balance go negative and raise an
exception, because that tells you which two jobs caused it. A counter that
silently converges tells you nothing.

**Writes are named intent operations, not row upserts.** "Complete visit with
these readings" survives a replay and a reorder in a way that "set these
columns" does not.

## Records

**Retention clocks rarely start at `created_at`.** Some start at the end of the
calendar year, some at completion of the work, some at the next activity of the
same type, which means the delete date for one year's record cannot be computed
until the following year's record exists. A purge job assuming creation plus N
years will destroy records a contractor is required to hold.

**Capture the classification at the moment of work, not at reporting time.**
Wage classification and workers compensation class code live on the time entry.
If the field was not captured in the field, no downstream report can
reconstruct it, because the information never existed.

**Rules that change on a date live in `regulatory_constant`, never in code.**
The 1099-NEC threshold moved. Anything that hardcoded the old number is now
wrong and will be wrong again.

## Boundaries

**`packages/core` never imports from `packages/api` or any app.** Domain logic
stays pure and testable. CI enforces it.

**An AI agent is the same `Actor` as a person.** There is no separate agent
permission path, so an agent can never exceed what its credential could do in
the UI. Every agent mutation names the agent in the audit log.
