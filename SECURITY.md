# Security Policy

## Reporting

Report vulnerabilities privately through GitHub Security Advisories on this
repository, or by email to the address in the repository profile. Please do not
open a public issue.

We will acknowledge within 3 business days and aim to ship a fix within 90
days. We will credit you in the advisory unless you prefer otherwise.

## What we consider high severity

This product holds contractors' customer lists, payment records and technician
location data. The following are treated as critical and jump the queue:

- **Cross-tenant data access.** Any path that returns or writes data belonging
  to another organization. Row level security covers every tenant-scoped table
  and is tested on every pull request, but a policy gap is the bug class that
  matters most here.
- **Authentication or session bypass.**
- **Anything touching payments.** We never handle raw card data, which stays
  inside Stripe's hosted elements, but a flaw allowing charges, refunds or
  payouts to be triggered on another account is critical.
- **Privilege escalation across roles**, including an AI agent acting outside
  its scoped permissions.
- **Exposure of stored credentials**, including integration OAuth tokens and
  webhook signing secrets.

## Advisories

### An integration admin could read the deployment's environment variables

**Affected:** every version before the change that introduced
`OTS_SECRET__<company>__<name>` secret names (October 2026, before any tagged
release). **Fixed in:** that change on `main`; there was no release in
between.

A connection's credential (`credentialRef`, and settings such as
`webhookSecretRef`) is the name of a secret. The default secret store read
the environment variable with exactly that name, so anybody holding
`integration:write` in any company could name `AUTH_SECRET`, `DATABASE_URL`,
`OPERATOR_TOKEN` or any other variable the server had. Several provider
adapters also accepted a `baseUrl` setting, so the same person could point
the adapter at their own host and receive the variable's value as the
provider's bearer token. On a deployment serving several companies that
exposed every company (the session signing key forges a session for anyone);
on a single company install it let a company admin read the server's own
secrets.

The fix: secret names are resolved only inside the company's own namespace
(`OTS_SECRET__<company id>__<name>`, or encrypted per company rows with
`SECRET_STORE=database`), never as a bare variable name, and provider
endpoint overrides are refused when a connection is saved and ignored when
one is used unless `ALLOW_PROVIDER_BASE_URL=1`, which only the test suites
set.

If you ran an earlier version: rename each provider variable as
[docs/self-hosting/secrets.md](docs/self-hosting/secrets.md) describes, and if
anybody you do not fully trust held `integration:write`, check
`integration_connection` for a `credential_ref` naming a server variable or a
`baseUrl`/`tokenUrl` setting, and rotate `AUTH_SECRET`, `OPERATOR_TOKEN`,
`WORKER_TICK_TOKEN` and the database password. A shared deployment must run
with `SECRET_STORE=database` and without `ALLOW_PROVIDER_BASE_URL`.

## Self-hosted deployments

Self-hosters are responsible for their own transport security, backups, secret
management and patching. A deployment serving more than one company must use
the database secret store and must not set `ALLOW_PROVIDER_BASE_URL`
([docs/self-hosting/secrets.md](docs/self-hosting/secrets.md)). The service role database credential bypasses row
level security and must never be reachable from a request path. It exists for
migrations and the reconciliation worker only.
