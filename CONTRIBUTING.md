# Contributing to OpenTradesOS

Thanks for being here. This project replaces software that costs contractors
$300 to $500 per technician per month, so every contribution has a fairly
direct dollar value to someone running a truck.

## You do not have to write code

The highest-value contributions right now are not code:

- **Trade packs.** Price books, checklists, forms and KPIs for a trade. If you
  have run an HVAC, plumbing, electrical, lawn, pest or roofing shop, you know
  things we do not. Open a trade pack issue.
- **Migration notes.** If you have exported data out of Jobber, ServiceTitan,
  Housecall Pro or FieldEdge, tell us what broke. That feedback goes straight
  into `open-trades-os-migration`.
- **Docs.** Especially the operator's guide, which is business guidance rather
  than software documentation.

## Development

```bash
pnpm install
cp .env.example .env
docker compose -f deploy/docker/docker-compose.yml up -d postgres redis minio
pnpm db:migrate && pnpm db:seed
pnpm dev
```

### The browser suite

`pnpm e2e` drives a real browser through the product against a production
build: signing up through the wizard, a job from booked to paid with the
report checked against the invoice to the cent, an estimate approved through
the customer's link, the customer portal pages, one real form submit on each
back office screen, and a technician's day on a phone sized screen.

```bash
pnpm build
pnpm e2e
```

- It **migrates and reseeds the database in `DATABASE_URL`** before it runs,
  so point it at a database you do not mind being reset (a second database on
  the same server is enough: `createdb opentradesos_e2e`).
- It starts `next start` on port 3100 itself, with `PUBLIC_URL` set to that
  address, and reuses a server already listening there. `E2E_PORT` moves it.
- It needs a chromium. CI installs the exact build Playwright pins with
  `pnpm exec playwright install --with-deps chromium` (run in `apps/web`). On
  your own machine, do that once, or let it find one you already have under
  `PLAYWRIGHT_BROWSERS_PATH`, or point `CHROMIUM_PATH` at any chromium binary.
- No retries. A test that passes on its second go is a bug report.
- Where a step has no screen yet (booking a job, raising an invoice, taking a
  payment), the spec calls the HTTP API as the same signed in person and then
  checks the screens. Texts are handed to a fake carrier through the outbox's
  own seam, so nothing reaches a network.
- A failing run leaves a trace per test in `apps/web/test-results`; open one
  with `pnpm --filter @opentradesos/web exec playwright show-trace <file>`.
  CI uploads them as the `e2e-report` artifact.

When a spec fails, fix the product rather than loosening the spec. Every bug
it has found so far was one a person would have hit on their first day.

## Rules that are not style preferences

1. **Every tenant-scoped table carries `organization_id` and is covered by RLS.**
   Application code never filters by organization by hand. A forgotten WHERE
   clause is a cross-tenant data leak, and hand-written filters get forgotten.
2. **No floats in money code, ever.** `numeric(14,4)` plus a currency code.
3. **`ledger_entry` is append only.** A correction is a reversing entry, never
   an edit. The database enforces this with a trigger.
4. **Historical rates live on the document.** Tax rates and prices are stored
   as applied, never recomputed on read.
5. **Every outbound external call writes an `integration_event` with an
   idempotency key before it fires.** A retry must be a no-op, not a second
   charge.
6. **`packages/core` never imports from `packages/api` or any app.** Domain
   logic stays pure and testable. CI enforces the boundary.

## Process

- Conventional commits, checked by CI.
- Changesets for anything user-visible: `pnpm changeset`.
- PRs need a green CI run and one review.
- New tenant-scoped tables need a matching assertion in `packages/db/test/rls.sql`.
- New financial logic needs tests in `packages/core`.

## Licensing

The core is AGPL 3.0. By contributing you agree to the CLA, which lets the
project offer a commercial license alongside the open one. This is the same
arrangement Twenty, Cal.com and Documenso use, and it is what keeps the open
version fully featured rather than deliberately crippled.
