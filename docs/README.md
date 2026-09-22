# OpenTradesOS Documentation

Source markdown, rendered by the `open-trades-os-website` repo at build time so
docs ship with the code they describe rather than drifting from it.

Documentation quality is a growth channel in this category, not a support cost.
Every incumbent hides their real documentation behind a login and sells the rest
as consulting. Ours is public, complete and indexed.

## Tree

```
docs/
  getting-started/     Install, first company, first job, first invoice
  operators-guide/     Business guidance, not software docs. The SEO engine
  modules/             One page per module, thirty of them
  trades/              One page per trade: workflows, price book, compliance
  migrate/             One guide per source platform
  self-hosting/        Docker, Kubernetes, Supabase, backups, upgrades, scaling
  integrations/        One page per provider: setup, credentials, limits
  api/                 Generated from the OpenAPI spec, plus guides
  agents/              AI agents and the MCP server
  develop/             Architecture, data model, contributing, plugin authoring
  reference/           Glossary, schema reference, permissions matrix, changelog
```

## Four audiences, four entry points

| Audience | Enters at | Wants |
|---|---|---|
| Contractor evaluating | `trades/`, `migrate/` | Does this fit my trade, and can I get my data out of what I am on |
| Contractor operating | `getting-started/`, `operators-guide/`, `modules/` | How do I do the thing, and what does good look like |
| Self hoster | `self-hosting/` | Get it running, keep it running, back it up |
| Developer or agent | `develop/`, `api/`, `agents/` | The data model, the API, and how to extend it |

The `operators-guide/` section is the one most likely to be underrated. It is
business guidance rather than software documentation: how to price flat rate,
set a margin target, build a commission plan that does not wreck gross margin,
run a morning dispatch meeting, structure memberships, handle 10DLC. It is what
a free product can give away that a sales-led incumbent charges for, and it is
the content that earns links.

## Writing rules

- Every module page follows the same shape: what it does, key concepts, how to
  set it up, how to use it, permissions, API surface, common questions.
- Screenshots are real product, never mockups, and are regenerated on release.
- Code samples are executable and tested in CI where practical.
- No em dashes or en dashes. Use a colon, a comma or a period.
- Say plainly what does not work yet. An honest gap costs less than a surprise.
