<div align="center">

# OpenTradesOS

**The open source operating system for home services companies.**

Field service management, dispatch, finance and AI service agents.
Self-hostable. Your database, your data.

[opentradesos.com](https://opentradesos.com) · [Docs](https://opentradesos.com/docs) · [Migrate from Jobber](https://opentradesos.com/migrate-from-jobber)

</div>

---

## Why

Home services software is a closed, expensive oligopoly. ServiceTitan runs $300
to $500 per technician per month with five figure implementation fees and multi
year contracts. Jobber and Housecall Pro are cheaper but all of
them treat your customer list, price book and job history as a retention lever.

OpenTradeOS was built to give trades back ownership of their own systems. So that there doesn't have to be reliance on massive software bills. 

This is for the trades businesses that want to own their own software. You should be relatively tech savvy, live a lot of your day in Claude Code, Codex, or other LLM models if you want to get the most out of OpenTradeOS. 

## What it does

| | |
|---|---|
| **CRM** | Customers and properties modeled separately, equipment with serials and warranty attached to the property, full service history |
| **Dispatch** | Drag and drop board, arrival windows, skill and license matching, territories, route ordering, live technician location |
| **Jobs** | Multi-visit work orders, checklists, forms, photos, signatures, warranty callbacks |
| **Estimates** | Good/better/best proposals, e-signature, deposits, financing links |
| **Invoicing** | Stripe card, card-present, ACH, deposits, progress billing, automated dunning |
| **Finance** | Job costing, P&L by job, tech and service line, purchase orders, inventory, QuickBooks and Xero sync |
| **Workforce** | Timeclock with GPS, commissions, payroll export |
| **Agents** | AI voice intake that answers the phone at 9pm, quotes from your real price book and books against real capacity |
| **Migration** | Get off Jobber, ServiceTitan, Housecall Pro or a spreadsheet in a weekend |

## Status

**Phase 4, alpha.** Booked to paid, the sell path, dispatch and the
technician's day all work against a real database, and no company runs its
business on it yet. [BUILD.md](BUILD.md) says what is built and what is not,
row by row, and the [roadmap](https://opentradesos.com/roadmap) says what is
next.

## Quickstart

```bash
git clone https://github.com/habrevaya/open-trades-os
cd open-trades-os
pnpm install
cp .env.example .env
docker compose -f deploy/docker/docker-compose.yml up -d postgres
DATABASE_URL=postgresql://opentradesos:opentradesos@localhost:5432/opentradesos pnpm db:migrate
docker compose -f deploy/docker/docker-compose.yml up
```

Then open http://localhost:3000. The migration step is not optional: the
containers do not migrate on start, and without it the first sign up fails on
a table that does not exist.

Elsewhere: [Netlify with Supabase](deploy/templates/netlify/README.md) for the
web app and a once a minute worker on a free tier, and
[the worker](docs/self-hosting/worker.md) for what runs automations and why it
is a separate process, and [provider secrets](docs/self-hosting/secrets.md) for
where a company's Stripe or Twilio key goes.

## Stack

TypeScript end to end. Next.js, Postgres 16 with Drizzle, Stripe for
payments, Twilio for texts, Resend or any SMTP server for email. The worker
polls the event log in Postgres rather than a queue, so Redis is in the
compose file and nothing uses it yet. Expo for the technician app and LiveKit
for voice agents are planned, not built.

Runs on plain Postgres or on your own Supabase project. Supabase is the
recommended default, never a requirement.

## Architecture notes worth reading before you contribute

Three decisions everything else depends on, all in `packages/db/src/schema`:

1. **Customers and properties are separate tables.** A property changes owners,
   a customer owns many properties, a landlord has forty. Collapsing these is
   the single most common modeling failure in this category.
2. **Equipment belongs to the property, not the customer.** The serial number
   and warranty follow the furnace, not whoever owned the house in 2019.
3. **A job has many visits.** A diagnostic trip, a parts-return trip and a
   two-day install are one job. Modeling a job as one calendar block is why
   rescheduling half a job is painful everywhere else.

And in `packages/db/migrations`: the ledger is append only, enforced by a
trigger, and row level security is applied to every table with an
`organization_id` column, driven off the catalog so a new table is protected
the moment it exists.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The highest-value contributions right
now are trade packs and migration notes, and neither requires writing code.

## License

[AGPL 3.0](LICENSE) for the core. The migration toolkit is Apache 2.0,
deliberately permissive so anyone can use it to get their data out of anything,
including out of here.
