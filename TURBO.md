# Why turbo.json declares `env` on the test task

Turbo does not pass the ambient environment through to a task. It passes only
what the task declares, so that a cache hit means the same inputs produced the
same outputs.

That is correct, and it had one expensive consequence here.

`DATABASE_URL` was not declared, so `pnpm test` at the repository root ran the
integration suites with no database. They did not fail. They skipped, because
a suite with no database to connect to has nothing to assert, and the summary
read green with 139 of 250 tests not run.

CI was never affected, because CI invokes each package directly with
`pnpm --filter`. That is exactly what made it hard to notice: the command a
contributor runs locally behaved differently from the command that gates a
pull request, and the local one was the quieter of the two.

The test files already throw rather than skip when `CI` is set and no database
is present, which is why `CI` is declared here too.
