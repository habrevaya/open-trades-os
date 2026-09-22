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

## Self-hosted deployments

Self-hosters are responsible for their own transport security, backups, secret
management and patching. The service role database credential bypasses row
level security and must never be reachable from a request path. It exists for
migrations and the reconciliation worker only.
