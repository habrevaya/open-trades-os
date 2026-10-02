# Netlify

The cheapest way to run this for real: Netlify's free tier serves the web app
and allows commercial use, and a managed Postgres holds the data. What it
cannot do is keep a process running, so the worker runs as a once a minute
call instead of a loop. This page is what runs where, what to set, and when
that stops being good enough.

## What runs where

| Piece | Where |
|---|---|
| The web app, the API, the MCP endpoint, the customer portal | Netlify, as the functions its Next.js adapter builds from `apps/web` |
| The worker | `POST /api/internal/worker/tick`, inside the same app, called every minute by `netlify/functions/worker-tick.mts` |
| Postgres | **Not on Netlify.** Supabase or Neon, or any Postgres 16 you can reach. See [Supabase](../../../docs/self-hosting/supabase.md) |
| Migrations | Not on Netlify either. From your machine or CI, over a direct connection. See below |

Netlify has no database of its own that this can use, and a function is the
wrong place to run migrations: it has a time limit, it runs once per
instance, and it would run against production from every deploy preview.

## Putting the template in place

This directory is a template, not a live configuration, so that a deployment
on Docker or anywhere else is not carrying Netlify's. Copy it into the app:

```
cp deploy/templates/netlify/netlify.toml apps/web/netlify.toml
cp -r deploy/templates/netlify/netlify apps/web/netlify
```

Commit both in your fork, then create the site in Netlify with:

| Setting | Value |
|---|---|
| Base directory | empty (the repository root, where the pnpm workspace and lockfile are) |
| Package directory | `apps/web` |

The build command, publish directory and functions directory come from
`netlify.toml`. Its paths are relative to the base directory, the root, even
though the file sits in `apps/web`: that is Netlify's rule for monorepos.
Netlify finds `pnpm-lock.yaml` at the root, installs with pnpm, and its
Next.js adapter does the rest. There is no plugin to add.

## Environment

Set these in the site's environment, for Builds and Functions both unless
noted.

| Variable | What |
|---|---|
| `DATABASE_URL` | The **transaction pooler** connection string (Supabase: port 6543). Each function instance opens its own pool, so a direct connection runs out of slots under any real traffic |
| `DATABASE_POOL_MAX` | `3`. Ten per instance is right for one server and wrong for fifty instances |
| `WORKER_DATABASE_URL` | The pooler string for the `background` role, if the app's own role is not allowed to find work across companies. See [the worker](../../../docs/self-hosting/worker.md#the-database-role) |
| `WORKER_TICK_TOKEN` | At least 32 characters: `openssl rand -base64 48`. The app and the scheduled function both read it |
| `PUBLIC_URL` | The site's address. Webhook signatures are computed over it |
| `AUTH_URL`, `AUTH_SECRET` | As in `.env.example` |
| `OPERATOR_TOKEN` | Only if a control plane will call [the operator API](../../../docs/self-hosting/operator-api.md) |
| `SECRET_STORE`, `SECRETS_MASTER_KEY` | `database` and `openssl rand -base64 32`, on any site that serves more than one company: required, not optional. Each company then pastes its own Stripe, Twilio or QuickBooks secret on Settings → Integrations. See [provider secrets](../../../docs/self-hosting/secrets.md) |

Never set `ALLOW_PROVIDER_BASE_URL` on a site. It exists for the test suites,
and with it any company admin can send the server's copy of a provider
credential to an address they choose.

Storage is the same as any other deployment and is listed in `.env.example`.
A company's provider secrets are not site variables: with one company and the
default store they are `OTS_SECRET__<company id>__<name>` variables, which
Settings → Integrations names exactly; with several, they are pasted in the
app.

## Migrations

Run from your machine or from CI, never from a function, and over a
connection that is not the transaction pooler: a migration is many statements
on one session, and a transaction pooler hands consecutive statements to
whichever server connection is free.

```
DATABASE_URL="<direct or session connection, port 5432>" pnpm db:migrate
```

Run it before the deploy that needs it. A deploy whose code expects a column
the database does not have yet fails on its first request, not at build time,
because the build never touches the database.

## The limits, plainly

| Limit | What it means here |
|---|---|
| Schedules are a minute apart at finest | An automation can start up to a minute later than the worker process would start it (that polls every five seconds). "Text the customer when the tech is on the way" arrives within a minute rather than within seconds |
| Scheduled functions stop at 30 seconds | The scheduler waits 28 seconds for the tick and then lets go. The tick is its own request and carries on |
| Synchronous functions stop at 60 seconds | The tick's budget is 20 seconds (`WORKER_TICK_BUDGET_MS`), checked between events, with the rest of the minute for the event in flight and the sends after it. Raise it towards 40 if you must; past that a slow carrier can push a tick into the limit |
| Scheduled functions run on the published deploy only | Deploy previews and branch deploys run no worker, which is what you want if they point at the production database, and a surprise if you were testing an automation on one |
| Nothing runs between ticks | A workflow that waits "until 9:00" resumes on the first tick after 9:00 |

These are Netlify's documented defaults as of this writing. Check the
[functions configuration](https://docs.netlify.com/build/functions/configuration/)
page before relying on a number.

## When to move the worker to a container

Keep the web app on Netlify and run `deploy/docker/Dockerfile.worker`
somewhere that keeps a process alive (Fly, Railway, a $5 VPS) when any of
these is true:

- A tick regularly answers `"stoppedForBudget": true`. The backlog is
  outgrowing twenty seconds a minute, and every minute it does, automations
  run later.
- A minute of latency is not acceptable for something the company relies on.
- An accounting sync or a webhook receiver is slow enough that the sends after
  a drain are what is using the budget.

Turn the tick off by removing `WORKER_TICK_TOKEN` from the site (the endpoint
goes back to a 404 and the scheduled function logs that it is not running),
and point the container's `WORKER_DATABASE_URL` at the same database. Running
both for a while is safe: two workers are a capacity decision rather than a
duplicate message incident, for the reasons in the worker doc.

## What this template does not do

It has not been deployed by CI. The configuration follows Netlify's current
documentation for monorepos, Next.js and scheduled functions, and nothing in
this repository checks it against a live Netlify account. If a key has moved,
that page is the authority and a pull request fixing this one is welcome.
