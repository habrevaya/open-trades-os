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

## The configuration is already in the app

Netlify reads its configuration from the package directory of a monorepo, so
the two files it needs are committed there:

| File | What |
|---|---|
| `apps/web/netlify.toml` | Build command, publish directory, functions directory, Node and pnpm versions, and when a push builds (below) |
| `apps/web/netlify/functions/worker-tick.mts` | The scheduled function that calls the worker tick once a minute |

**A deployment that is not on Netlify is unaffected by them.** Nothing in the
app, the Docker images or the worker reads either file; they are inert unless
Netlify is the one building. They used to live in this directory as a
template to copy, and two copies of a configuration drift, so there is one,
where Netlify looks for it, and this page documents it.

Create the site in Netlify from your fork with:

| Setting | Value |
|---|---|
| Base directory | empty (the repository root, where the pnpm workspace and lockfile are) |
| Package directory | `apps/web` |

The build command, publish directory and functions directory come from
`netlify.toml`. Its paths are relative to the base directory, the root, even
though the file sits in `apps/web`: that is Netlify's rule for monorepos.
Netlify finds `pnpm-lock.yaml` at the root, installs with pnpm, and its
Next.js adapter does the rest. There is no plugin to add.

### When a push builds

By default every git push builds, which is what somebody deploying their own
fork expects. Set `BUILD_HOOK_ONLY=true` in the site's environment and the
`ignore` command in `netlify.toml` skips every build a build hook did not
start (production, branch deploys and deploy previews alike), so the only way
a deploy starts is the hook. That is how the hosted deployment runs, because
its hook is called after the database is migrated (see
[Hosted release](#hosted-release)); a self hoster can do the same from their
own CI, or leave it unset and run migrations by hand before merging.

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

| `BUILD_HOOK_ONLY` | `true` to build only from a build hook. See [When a push builds](#when-a-push-builds). Builds only |
| `DEMO_ORGANIZATION_ID` | Only on a site that offers the read-only [demo](../../../docs/self-hosting/demo.md) |

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

## Hosted release

This is how the hosted deployment of this repository (`habrevaya/open-trades-os`)
is released, and the order a fork that wants the same would copy. It is driven
by `.github/workflows/deploy.yml`, which does nothing at all in any other
repository, and nothing in this one until the secrets below exist: a fork, or
a contributor's push, gets a green run that skipped every step.

### The branch model

```
feature branch ──PR──▶ develop ──PR──▶ main
                         │               │
                         ▼               ▼
                 development site   production site
```

Work lands on `develop` by pull request and is released by a pull request from
`develop` into `main`. CI (`.github/workflows/ci.yml`) runs on every pull
request and on every push to either branch.

Every push to `develop` or `main` runs the Deploy workflow:

1. **migrate**, in the GitHub environment `development` (for `develop`) or
   `production` (for `main`): `pnpm db:migrate` over that environment's
   `DATABASE_URL_DIRECT`. It refuses a port 6543 address.
2. **deploy**, after migrate succeeds: POSTs that environment's
   `NETLIFY_BUILD_HOOK`, and Netlify builds and publishes. If the branch has
   moved on since step 1 it stands down, and the newer commit's own run
   deploys instead, because a build hook builds the branch head, which might
   need a migration that has not run yet.

Runs for one environment never overlap and are never cancelled part way (a
half finished migration is worse than a queued one). *Actions → Deploy → Run
workflow* re-runs a release by hand for either environment, from the head of
its branch; use that rather than Netlify's *Trigger deploy*, which the
`ignore` command skips.

Migrations therefore always land before the code that needs them. They must
also be safe for the code still running until the new deploy is published (a
minute or two): add columns and tables freely, but drop or rename only in a
later release, once nothing reads the old shape.

### 1. Postgres: one database per environment

One Supabase project for production and a separate one for development. From
each, take two connection strings:

- the **transaction pooler** (port 6543), for the site's `DATABASE_URL`;
- the **session pooler** (pooler host, port 5432), for GitHub's
  `DATABASE_URL_DIRECT`. Not the direct host: GitHub's runners have no IPv6.

The first workflow run migrates the empty database. Then, once per database,
from the SQL editor, the two roles the hosted deployment needs:

```sql
-- The worker's own login: the one role allowed to ask which companies have
-- work. Without it the tick falls back to the app's connection.
alter role background login password '<a long random password>';

-- The operator API's role. The migrations grant it to whichever account ran
-- them (postgres); this grants it to the account the SITE connects as, if
-- that is a different one. Skip it when the site connects as postgres.
grant platform_operator to <the site's database user>;
```

Through Supavisor the worker's user name carries the project reference:
`WORKER_DATABASE_URL=postgresql://background.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`.
See [Supabase](../../../docs/self-hosting/supabase.md#the-roles) for what
each role may do, and [the operator API](../../../docs/self-hosting/operator-api.md)
for creating the first company.

### 2. Netlify: one site per environment

Two sites from the same repository, rather than one site with a branch
deploy, because **scheduled functions run only on a site's published
deploy**: a `develop` branch deploy would have no worker, and every
automation on the development site would sit still.

| Site | Production branch | Build hook (*Site configuration → Build & deploy → Build hooks*) |
|---|---|---|
| production | `main` | `GitHub Deploy (production)`, building `main` |
| development | `develop` | `GitHub Deploy (development)`, building `develop` |

On both: base directory empty, package directory `apps/web`; *Deploy
Previews*: **Don't deploy pull requests**; *Branch deploys*: **none**. Leave
*Stop builds* **off**: it stops the build hooks too.

Each site's environment, with its own database's values (Builds and
Functions both, unless noted):

| Variable | Value |
|---|---|
| `BUILD_HOOK_ONLY` | `true` |
| `DATABASE_URL` | The transaction pooler, port 6543 |
| `DATABASE_POOL_MAX` | `3` |
| `WORKER_DATABASE_URL` | The pooler string for `background`, above |
| `SECRET_STORE` | `database`. Required: the hosted site serves many companies |
| `SECRETS_MASTER_KEY` | `openssl rand -base64 32`, a different one per site, kept somewhere other than the database |
| `AUTH_SECRET` | `openssl rand -base64 48`, a different one per site |
| `AUTH_URL`, `PUBLIC_URL` | The site's own address |
| `OPERATOR_TOKEN` | `openssl rand -base64 48`; the control plane holds the same value |
| `WORKER_TICK_TOKEN` | `openssl rand -base64 48`, Functions and the app both |
| `DEMO_ORGANIZATION_ID` | Optional: the id `demo:seed` printed, to offer the [read-only demo](../../../docs/self-hosting/demo.md) |

And never `ALLOW_PROVIDER_BASE_URL`, on either site. `DATABASE_URL_DIRECT`
stays off Netlify: migrations run in GitHub.

### 3. GitHub: two environments

*Repository → Settings → Environments → New environment*:

| Environment | Deployment branches and tags | Protection | Secrets |
|---|---|---|---|
| `development` | *Selected branches*: `develop` | none | `DATABASE_URL_DIRECT` (development database, session pooler, port 5432), `NETLIFY_BUILD_HOOK` (the development site's hook) |
| `production` | *Selected branches*: `main` | **Required reviewers**: the owner. Tick *Prevent self-review* only if someone else can approve | `DATABASE_URL_DIRECT` (production database, session pooler, port 5432), `NETLIFY_BUILD_HOOK` (the production site's hook) |

The required reviewer is a GitHub setting, not code: with it, every
production release waits in *Actions* until it is approved. Both jobs use the
environment, so GitHub asks twice: approve **migrate**, read its log, then
approve **deploy**. Rejecting deploy after a clean migration leaves
production running the previous code on the new schema, which the rule above
(additive migrations) makes safe.

Restricting each environment to its branch means a workflow started from any
other branch cannot read its secrets. *Run workflow* is offered only once
`deploy.yml` is on the default branch.

Until the secrets exist the workflow is green and does nothing, which is also
what happens in every fork: the jobs are conditioned on this repository's
name and on the secrets being set, so nobody else's push ever touches a
database or calls a hook.

## What this does not do

CI does not deploy a self hoster's site, and the configuration follows Netlify's current
documentation for monorepos, Next.js and scheduled functions, and nothing in
this repository checks it against a live Netlify account. If a key has moved,
that page is the authority and a pull request fixing this one is welcome.
