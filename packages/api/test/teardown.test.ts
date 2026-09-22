import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { TEARDOWN_ORDER, fixtureId } from "./helpers";

const url = process.env.DATABASE_URL;

// A contributor without a database still gets a green suite. CI does not get
// that privilege: these tests are the only thing standing between a schema
// change and a cross tenant leak, and a run that quietly skips them reads
// green while proving nothing.
if (!url && process.env.CI) {
  throw new Error(
    "DATABASE_URL is not set. These tests must run in CI, not skip.",
  );
}

const run = url ? describe : describe.skip;

let sql: postgres.Sql;
beforeAll(() => { if (url) sql = postgres(url, { max: 1, onnotice: () => {} }); });
afterAll(async () => { if (sql) await sql.end(); });

run("the teardown helper keeps up with the schema", () => {
  /**
   * The failure this prevents is not a failing test, it is a suite that stops
   * running. A tenant table missing from the teardown order leaves rows
   * behind, the next file's foreign keys trip on them in beforeAll, and vitest
   * reports the result as SKIPPED. That has already cost this project forty
   * three tests once.
   */
  it("knows about every table carrying an organization_id", async () => {
    const rows = await sql<{ table_name: string }[]>`
      select c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and a.attnum > 0
      where n.nspname = 'public' and c.relkind = 'r'
      order by 1`;

    const known = new Set(TEARDOWN_ORDER);
    const missing = rows.map((r) => r.table_name).filter((t) => !known.has(t));

    expect(
      missing,
      `These tenant tables are not in TEARDOWN_ORDER in test/helpers.ts, so rows will ` +
      `survive a reset and trip another suite's foreign keys: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("lists nothing that is not a real table", async () => {
    const rows = await sql<{ table_name: string }[]>`
      select c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`;

    const real = new Set(rows.map((r) => r.table_name));
    const stale = TEARDOWN_ORDER.filter((t) => !real.has(t));

    expect(stale, `TEARDOWN_ORDER names tables that no longer exist: ${stale.join(", ")}`)
      .toEqual([]);
  });
});

/**
 * Fixture ids are shared state whether or not anyone treats them that way.
 * `seedOrg` resets the organization it is about to seed, so two files holding
 * the same organization id delete each other's data, and only when they run
 * together.
 */
describe("fixture ids do not collide", () => {
  it("derives distinct ids from distinct names", () => {
    const names = ["sell/org-a", "sell/org-b", "sell/user-a", "sell/user-b"];
    const ids = names.map(fixtureId);
    expect(new Set(ids).size).toBe(names.length);
  });

  it("is stable, so a rerun reuses the same rows", () => {
    expect(fixtureId("sell/org-a")).toBe(fixtureId("sell/org-a"));
  });

  it("produces a well formed uuid Postgres will accept", () => {
    expect(fixtureId("sell/org-a"))
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
