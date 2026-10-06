# Supabase

Supabase is the recommended database, never a requirement: nothing here uses
a Supabase-only API, and everything below is ordinary Postgres with a pooler
in front of it. What this page covers is the three places where Supabase's
defaults and this product's assumptions meet, because each of them fails in a
way that does not name its cause.

## Two connection strings, not one

Supabase gives you three ways in. This product needs two of them.

| Connection | Port | Use it for |
|---|---|---|
| Transaction pooler (Supavisor) | 6543 | **The app.** `DATABASE_URL` on any serverless host, and `WORKER_DATABASE_URL` for the tick |
| Session pooler, or direct | 5432 | **Migrations.** And a long running worker process, if you run one |

The app is safe behind the transaction pooler, and that is a property kept on
purpose rather than an accident. A transaction pooler hands each transaction
to whichever server connection is free, so anything a connection remembers
between transactions belongs to somebody else by the next one. So:

- `prepare: false` on every client (`packages/db/src/client.ts`), because a
  named prepared statement made on one server connection is not there on the
  next.
- The tenant context is `set_config(..., true)` and the role is `set local
  role`, both of which end with the transaction.
- The one lock anywhere in the request path is `pg_advisory_xact_lock`, which
  is released at commit.
- Nothing listens. The worker polls, for exactly this reason among others.

A change that sets session state, takes a session level lock or calls
`LISTEN` breaks every deployment behind a transaction pooler, quietly, as one
tenant's context arriving on another tenant's request. Do not make one.

Migrations are the opposite: many statements that expect one session, run
once, from your machine or from CI.

```
DATABASE_URL="postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres" \
  pnpm db:migrate
```

Never from a serverless function. It has a time limit, it would run once per
instance, and from a deploy preview it would migrate production.

On a serverless host, also set `DATABASE_POOL_MAX=3`. Every function instance
opens its own pool, ten connections each by default, and a burst of traffic
is a burst of instances.

## The roles

The migrations run as `postgres`, which on Supabase is not a superuser, and
they create or reuse three roles.

| Role | On Supabase | What it is for |
|---|---|---|
| `authenticated` | Already exists. The migrations see it and do not create it | Every request runs as it, inside its transaction, so row level security applies |
| `background` | Created by the migrations, with no login | The worker: the one role that may ask which companies have work |
| `platform_operator` | Created by the migrations, with no login, and granted to `postgres` | The [operator API](operator-api.md) |

`postgres` is already a member of `authenticated` on Supabase, which is what
lets the app's `set local role authenticated` work. The migrations grant
`platform_operator` to whichever account runs them, so the same applies to
the operator API without a step from you.

To give the worker its own login, from the SQL editor:

```sql
alter role background login password 'a long random password';
```

Through Supavisor the username carries the project reference:

```
WORKER_DATABASE_URL=postgresql://background.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Leaving `WORKER_DATABASE_URL` unset uses `DATABASE_URL`, which as `postgres`
can call everything. That works; it gives the worker more than it needs.

## Turn off what this product does not use

Supabase's own API layer (PostgREST, "Data API") serves the `public` schema to
callers holding a Supabase JWT, and a signed in Supabase Auth user arrives as
**the same `authenticated` role** this product's requests run as. This
product does not use either, and the two sharing a role name is the one real
overlap between them.

It does not leak today, and the reason is worth stating so that nobody
removes it: every policy compares against `app.current_organization_id()` or
`app.current_user_id()`, which read settings that only this application sets,
inside its own transactions. A Data API caller cannot set them, so every
policy evaluates against null and admits nothing. Tables holding passwords and
setup links deny that role outright.

That is one layer, and it should not be the only one. In the Supabase
dashboard:

1. **Disable the Data API**, or remove `public` from its exposed schemas.
   Nothing in this product calls it.
2. **Turn off sign ups in Supabase Auth.** People sign in to this product
   through its own sessions, not Supabase's, and a Supabase account would be
   an `authenticated` login that this product never issued.

With both off, the role is reachable only by the application.

## Provider secrets

A Supabase project hosting more than one company sets `SECRET_STORE=database`
and `SECRETS_MASTER_KEY`, and never `ALLOW_PROVIDER_BASE_URL`. The secrets live
in this database's `integration_secret` table as ciphertext, encrypted by the
application; the key is not in Supabase and must not be put there (not in
Vault, not in a table, not in a database setting), or a database dump becomes
every company's Stripe and Twilio keys. Keep it in the host's environment
beside `AUTH_SECRET`. Supabase Vault is not used.
[Provider secrets](./secrets.md) has the rest.

## Storage

Uploads and brand assets are stored in Postgres today, so the database is the
only thing that needs backing up. Supabase Storage is not used yet.
