<!--
Thanks for contributing. Pull requests go into `develop`, not `main`.
`main` is what is released; `develop` is where work lands first.
-->

## What this changes

<!-- One or two sentences, in terms of what a contractor or a self-hoster
notices, not which files moved. -->

## Why

<!-- The problem it solves. Link the issue if there is one: "Closes #123". -->

## How it was tested

- [ ] `pnpm typecheck` and `pnpm lint`
- [ ] `pnpm test` (with a Postgres in `DATABASE_URL`)
- [ ] `pnpm e2e`, if a screen changed
- [ ] A migration, if any, runs on a fresh database and `pnpm db:generate` reports no changes

## Anything a reviewer should look at closely

<!-- Money, permissions, anything that crosses companies, anything that
sends a message to a customer. Say so here rather than hoping it is noticed. -->
