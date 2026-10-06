# The public demo

One shared sample company that anybody can click around in, read only, the
way an accounting product's "test drive" works: a link on a website, no
signup, no form, and nothing anybody does is kept. It is off unless you turn
it on, and a deployment that never sets it up has no `/demo` at all.

## What a visitor gets

`GET /demo` signs the visitor in as the demo company's read only user for
**two hours** and takes them to the dispatch board. Every screen shows a
banner, *You're viewing a demo company. Nothing you do here is saved.*, with
a link back to your website.

They see what the `readonly` role sees: customers, properties, equipment,
jobs and visits, estimates, invoices and payments, the price book (no cost
or margin), agreements, reports and documents. Not settings, integrations,
payroll, the ledger or automations, because that role has none of them. The
navigation only offers screens the session can open, and the controls on a
screen follow the session's permissions, so the demo does not show buttons
that would only be refused.

## Why it is safe, in order

Hiding buttons is not the guarantee. These are, and each one would hold if
the others were removed:

1. **The demo user's sessions are read only in SQL.** The company names its
   demo user (`organization.demo_user_id`) and `app.resolve_session` marks
   every session of that user as a demo session, whatever company it is in
   and whatever the membership row says. The flag is derived from the user,
   not stored on the session, so there is no way to hold a writable session
   as the demo user: not by signing in with a password somebody set for it,
   not by an administrator widening its membership.
2. **A read only actor holds only `...:read` permissions.** The session
   resolves to the `readonly` preset with grants, custom roles and scope
   overrides ignored, and `readOnly` set, which drops every permission that
   is not a read. Every service refuses a write before it touches the
   database. That includes everything a session could escalate with:
   issuing an application token, inviting a user, changing a role, setup.
3. **The API refuses every route that is not a GET**, with
   `403 {"code":"demo_read_only"}`, before the body is read or the handler
   runs. A test walks the whole route table and asserts it for every one.
4. **Postgres refuses the write anyway.** Every transaction the service layer
   opens for a read only actor is `READ ONLY`, so a write that forgot its
   permission check (a preference, a saved view, a write somebody adds next
   year) fails in the database.
5. **Nothing leaves the demo company.** Its portal links (`/e`, `/i`, `/c`,
   `/pay`, `/j`) open but approve, decline and pay nothing; its booking page
   and web forms store nothing; and the worker finds no work for it, so no
   workflow runs and no text, email, webhook or accounting push is ever sent
   from it.
6. **`/demo` only opens a company that was set up as the demo.** Pointing
   `DEMO_ORGANIZATION_ID` at a real company by mistake is a 404, not a public
   window into that company.

Demo sessions are created at most 20 per client address per hour (counted in
the database, so every instance of a serverless site shares the count; only
a hash of the address is kept). The demo's visitors are never counted as
active users in the [operator API](operator-api.md)'s usage report.

Signing out works and ends that visitor's session. Opening `/demo` with a
live demo session keeps it rather than making another. Opening `/demo` while
signed in to a real company replaces that browser's session cookie with the
demo's, which signs that browser out of the real company (the session itself
is untouched and still valid elsewhere).

## Turning it on

### 1. A company to show

To create the sample company (Ridgeline Mechanical, the HVAC shop the
development seed is built around) in a deployment that already has real
companies:

```
DATABASE_URL="<session connection, port 5432>" \
  pnpm --filter @opentradesos/api demo:seed
```

It writes a day of work dated today, customers, estimates, invoices in three
states (raised and paid through the billing service, so the ledger has the
postings a real company would), a price book from the HVAC trade pack,
inventory, timesheets and a booking page, and then makes the company the
demo (step 2). The last line it prints is the id:

```
DEMO_ORGANIZATION_ID=<uuid>
```

**It never deletes anything.** It uses its own ids, the slug
`ridgeline-demo` and people at `@demo.ridgeline.example`, so it shares nothing
with a development seed in the same database. Run again, it finds the demo
company in place, makes sure it is still set up as the demo, and stops.

The day is dated when it is seeded, so after a while the board shows last
month. `demo:seed --refresh` replaces the demo company with a fresh one. It
deletes only rows carrying the demo company's own id and only its own
people, but it does so with `session_replication_role = replica` (the
ledger refuses a `DELETE` otherwise), which needs a superuser. On a managed
Postgres where that is not allowed, leave it, or create a new demo company
and point the site at it.

### 2. Or your own company

Any company can be the demo, for example one set up in the app to look like
a plumbing shop:

```
DATABASE_URL="<session connection, port 5432>" \
  pnpm --filter @opentradesos/api demo:setup --organization <company id>
```

This creates a dedicated user (`demo+<company id>@demo.invalid`, an address
nobody can own or receive mail at) with a `readonly` membership, and marks
the company as the demo. It is idempotent, deletes nothing, and refuses an
address that already belongs to somebody who can sign in or who belongs to
another company. Making a company the demo needs the deployment's own
database account: the trigger that guards the operator's columns refuses it
to any company, including the demo itself.

**Once a company is the demo, nobody can change it from inside**, the
company's own owner included: their sessions are not affected, but the
company stops running workflows and its links stop taking payments. Use a
company that exists only to be looked at.

### 3. The site

| Variable | Value |
|---|---|
| `DEMO_ORGANIZATION_ID` | The id from step 1 or 2. Unset (the default), `/demo` is a 404 |
| `DEMO_WEBSITE_URL` | Where the banner's "Back to the website" goes. Defaults to `https://opentradesos.com` |

Then link to `https://<your site>/demo` from your website.

## Turning it off

Unset `DEMO_ORGANIZATION_ID` and `/demo` is a 404 again. Visitors already
inside keep their sessions until they expire (two hours at most). To make
the company an ordinary one again, from the database's own account:

```sql
update public.organization set demo_user_id = null where id = '<company id>';
```
