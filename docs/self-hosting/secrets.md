# Provider secrets

A connection on **Settings → Integrations** never holds a secret. Its
credential (`credentialRef`), and any setting ending in `Ref` such as Stripe's
`webhookSecretRef`, is the NAME of a secret. The deployment's secret store
turns that name into a value, and it does so for the company that owns the
connection and nobody else.

## Names

A name is letters, digits and underscores, starting with a letter or an
underscore, at most a hundred characters: `STRIPE_SECRET_KEY`,
`RESEND_WEBHOOK_SECRET`. Anything else is refused when the connection is
saved.

## The environment store (the default)

With `SECRET_STORE` unset, or set to `environment`, a company's secret is an
environment variable under that company's own prefix:

```
OTS_SECRET__<organization id, no dashes, uppercase>__<name>
```

For a company whose id is `0b9c6a8e-1f2d-4c3b-9a8e-7d6c5b4a3f21` and a Stripe
connection whose credential is named `STRIPE_SECRET_KEY`, the server reads

```
OTS_SECRET__0B9C6A8E1F2D4C3B9A8E7D6C5B4A3F21__STRIPE_SECRET_KEY
```

You do not have to work this out. **Settings → Integrations** shows the exact
variable under every connected provider, says whether it is set, and the
connect form shows the company's prefix. An error at use time names the
variable it looked for.

The prefix is added by the server from the signed-in company, never typed. A
company can name any secret it likes and still only ever reach variables that
start with its own prefix, so it cannot name `AUTH_SECRET`, `DATABASE_URL`,
`OPERATOR_TOKEN` or another company's secrets.

This store suits a self-hosted install where the person who connects Stripe
is also the person who sets the server's environment. It is not suitable for a
deployment that serves several companies: there the environment is the
operator's, and a company has no way to put its own key in it. Use the
database store.

### Upgrading from a version that read the bare name

Earlier versions read the variable named exactly as typed, so an install
connected Stripe under `STRIPE_SECRET_KEY` with `STRIPE_SECRET_KEY` set in the
environment. That variable is no longer read, and there is deliberately no
fallback to it: reading the bare name when the prefixed one is missing would
be the vulnerability described in [SECURITY.md](../../SECURITY.md) again.

After upgrading, for each connected provider:

1. Open **Settings → Integrations**. Each connection lists its secret names
   and the variable each one is now read from, marked **Not set**.
2. Rename the variable in your environment to the one shown (keep the value),
   for example `STRIPE_SECRET_KEY` becomes
   `OTS_SECRET__<your company id>__STRIPE_SECRET_KEY`.
3. Restart the web app and the worker.

Until you do, anything that needs the secret fails with a message naming the
variable it expects, rather than quietly using a different one.

Lead webhooks follow the same rule: `POST /v1/lead-connectors` returns
`secretEnvironmentVariable`, the variable to put the signing secret in.

OAuth refresh tokens (QuickBooks, Xero) rotate. The environment store keeps a
rotated token in the running process only and logs a warning, so the
connection needs reauthorizing after a restart. Use the database store for
accounting connections you want to survive restarts.

## The database store (required for a shared deployment)

```
SECRET_STORE=database
SECRETS_MASTER_KEY=<openssl rand -base64 32>
```

Each company pastes its own secrets on **Settings → Integrations** (or
`PUT /v1/secrets/{name}`, which needs `integration:write`). A pasted value is
encrypted by the application with AES-256-GCM before it is written to the
`integration_secret` table, and the key never reaches the database, so a dump,
a replica or a SQL injection sees ciphertext only. What comes back is whether a
secret is set and its last four characters. There is no way to read a value
back, through the screen, the API or the export; a secret is replaced or
cleared. Every change is in the audit log by name, never by value.

Each envelope is bound to its company and its name: a row moved to another
company, or renamed to stand in for a different secret, fails to decrypt
rather than being used. Row level security scopes the table like every
other tenant table as well.

A rotated OAuth refresh token is written back to the store as it rotates, so
QuickBooks and Xero connections survive restarts. A lead webhook's signing
secret is stored as it is minted.

The worker refuses to start with `SECRET_STORE=database` and no usable key.
Keep `SECRETS_MASTER_KEY` out of the database and its backups: without it no
company's secrets can be read, and with it and a dump all of them can.

### Rotating the master key

1. Generate a new key. Set it as `SECRETS_MASTER_KEY`, and move the old one to
   `SECRETS_MASTER_KEY_PREVIOUS` (comma separated, newest first). Restart.
   Both keys now decrypt; only the new one encrypts.
2. Run `pnpm --filter @opentradesos/api secrets:rotate` with the same
   environment (and `WORKER_DATABASE_URL` pointing at the `background` role,
   or a `DATABASE_URL` that can call `app.secret_organizations`). It
   re-encrypts every company's secrets under the new key and is safe to run
   again.
3. When it reports nothing left, remove the old key from
   `SECRETS_MASTER_KEY_PREVIOUS`.

### Moving from the environment store

Paste each secret on **Settings → Integrations** after switching. The names
the connections already hold keep working: paste the value under the same
name with `PUT /v1/secrets/{name}`, or paste it in the connect form, which
stores it under `<PROVIDER>_CREDENTIAL` and points the connection there.

## Provider addresses are fixed

Every adapter talks to its provider's own address. The `baseUrl` and
`tokenUrl` settings (and Nominatim's `endpoint`) exist so the test suites can
point an adapter at a local fake, and they are refused on connect and ignored
if found in a stored connection, unless the server is started with

```
ALLOW_PROVIDER_BASE_URL=1
```

Never set this outside a test environment. With it set, anybody who can
connect an integration can send the provider credential the server holds to a
host of their choosing.

That covers every provider: payments, accounting, texts, calls on Twilio
(numbers, recordings), email, AI models, call tracking and the geocoders. A
self hosted Nominatim server is set for the whole deployment with
`NOMINATIM_URL`, by whoever runs it, rather than on a company's connection.
