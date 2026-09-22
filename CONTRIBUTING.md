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
