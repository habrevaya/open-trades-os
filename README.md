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
year contracts. Jobber and Housecall Pro are cheaper but cap out fast. All of
them treat your customer list, price book and job history as a retention lever.

CRM has Twenty. Scheduling has Cal.com. Billing has Lago. E-signature has
Documenso. Support has Chatwoot. Field service management for the trades, a
multi billion dollar category, has no equivalent.

Not nothing, and it is worth being precise about that. [OCA/field-service](https://github.com/OCA/field-service)
is real, actively maintained and good, and Dolibarr and Axelor both ship an
interventions module. But they model the *intervention document*, not the
dispatched job, and the Odoo dispatch board and mobile app that would complete
the picture are Enterprise only. That is the honest shape of the gap: the back
office exists in open source, the front line does not.

Worth knowing why, because it is not that people tried and failed. Searching
the archives turns up no graveyard of serious attempts, only solo projects
abandoned before their second user. Open source usually survives on a loop
where users are developers who file issues and become contributors. HVAC owners
are not developers, so the loop never closes. For calibration: the ServiceTitan
S-1, documenting a multi billion dollar outcome in this exact market, got 5
points and no comments on Hacker News.

That is the actual risk here, and it is distribution rather than engineering.

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

**Phase 0.** Foundations. Not usable yet. Watch the repo or check the
[roadmap](https://opentradesos.com/roadmap) for where things stand.

## Quickstart

```bash
git clone https://github.com/habrevaya/open-trades-os
cd open-trades-os
pnpm install
cp .env.example .env
docker compose -f deploy/docker/docker-compose.yml up
```

Then open http://localhost:3000.

## Stack

TypeScript end to end. Next.js, Postgres 16 with Drizzle, BullMQ on Redis,
Expo for the technician app, Stripe for payments, LiveKit for voice agents.

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
