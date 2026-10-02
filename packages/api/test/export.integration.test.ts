import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as dataExport from "../src/services/export";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, TEARDOWN_ORDER } from "./helpers";

/**
 * TAKING A COPY OF EVERYTHING
 *
 * `data:export` was on the owner's role from the first migration and checked by
 * nothing. The guard test excused it with "export exists per report; a
 * whole-tenant export does not", and that was the weakest excuse on the list:
 * portability is the central argument this project makes against the incumbents,
 * and the answer here was "it is your Postgres instance", which is true for
 * somebody self hosting and false for a company on a hosted deployment.
 *
 * THE TWO TESTS THAT MATTER are the two properties that pull against each other.
 *
 *   COMPLETENESS, asserted against the catalogue rather than against a list. A
 *   table added tomorrow has to be exportable tomorrow, and the test that proves
 *   it is the one that counts tables in `pg_class`.
 *
 *   NO CREDENTIAL LEAVES, asserted on the serialised page rather than by reading
 *   the service. A future column named something innocuous that happens to hold a
 *   token would pass a test that only checked the list.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("exp:org");
const USER = fixtureId("exp:user");
const OTHER_ORG = fixtureId("exp:other-org");
const OTHER_USER = fixtureId("exp:other-user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const other = (): ServiceContext => ({
  actor: { userId: OTHER_USER, organizationId: OTHER_ORG, roles: ["owner"] as Actor["roles"] },
  db: db(),
});
/** Exactly these permissions and no role, so a pair can be told apart. */
const granted = (...permissions: string[]): ServiceContext => ({
  actor: {
    userId: USER, organizationId: ORG,
    roles: [] as unknown as Actor["roles"],
    grants: permissions as NonNullable<Actor["grants"]>,
  },
  db: db(),
});

async function customers(names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const [row] = await raw<{ id: string }[]>`
      insert into public.customer (organization_id, type, name, payment_terms_days)
      values (${ORG}, 'residential', ${name}, 0) returning id`;
    ids.push(row!.id);
  }
  return ids;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Export Co", slug: "export-co" });
  await seedOrg(raw, {
    organizationId: OTHER_ORG, userId: OTHER_USER, name: "Rival Co", slug: "rival-export-co",
  });
});

/* ========================================================== completeness */

run("the manifest", () => {
  it("names every tenant table in the database, not a list somebody maintains", async () => {
    /**
     * THE TEST THAT MAKES THE PROMISE REAL. The comparison pages name what
     * ServiceTitan's export leaves behind, and the only way to say that honestly
     * is for this one to leave nothing behind by construction.
     *
     * Counted from `pg_class`, the same place the row level security sweep counts
     * from, so a table added tomorrow fails this test tomorrow unless it is
     * exportable.
     */
    const inDatabase = await raw<{ table_name: string }[]>`
      select c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and exists (
          select 1 from pg_attribute o
          where o.attrelid = c.oid and o.attname = 'organization_id' and o.attnum > 0
        )
      order by 1`;

    const manifest = await dataExport.manifest(owner());
    const exported = new Set(manifest.tables.map((table) => table.table));
    const missing = inDatabase.map((row) => row.table_name).filter((name) => !exported.has(name));

    expect(
      missing,
      "These tenant tables are in the database and not in the export, so a company moving away "
      + `would lose them: ${missing.join(", ")}`,
    ).toEqual([]);
    expect(exported.size).toBe(inDatabase.length);
    expect(exported.size).toBeGreaterThan(100);
  });

  it("agrees with the teardown list, which is the other census of the same thing", async () => {
    /**
     * Two independent lists of every tenant table now exist: this export and
     * `TEARDOWN_ORDER` in the test helpers. Neither is the source of truth, the
     * catalogue is, and the point of comparing them is that a disagreement means
     * one of them has gone stale against it.
     */
    const manifest = await dataExport.manifest(owner());
    const exported = new Set(manifest.tables.map((table) => table.table));
    const torn = new Set(TEARDOWN_ORDER);
    expect([...exported].filter((name) => !torn.has(name))).toEqual([]);
    expect([...torn].filter((name) => !exported.has(name))).toEqual([]);
  });

  it("counts the rows, which is what makes an export checkable", async () => {
    /**
     * Somebody who pulls 14,812 customers and had 14,900 has a problem they can
     * see. Without the count they have a file and a hope.
     */
    await customers(["Ann", "Bob", "Cal"]);
    const manifest = await dataExport.manifest(owner());
    const customer = manifest.tables.find((table) => table.table === "customer")!;
    expect(customer.rows).toBe(3);
    expect(manifest.totalRows).toBeGreaterThanOrEqual(3);
  });

  it("counts only this company's rows", async () => {
    await customers(["Ann"]);
    await raw`insert into public.customer (organization_id, type, name, payment_terms_days)
              values (${OTHER_ORG}, 'residential', 'Theirs', 0)`;

    const mine = await dataExport.manifest(owner());
    expect(mine.tables.find((table) => table.table === "customer")!.rows).toBe(1);
    const theirs = await dataExport.manifest(other());
    expect(theirs.tables.find((table) => table.table === "customer")!.rows).toBe(1);
  });

  it("names the primary key of every table, including the composite ones", async () => {
    /**
     * Pagination walks the key, so a table whose key the manifest got wrong is a
     * table the export would walk wrongly. `event_cursor` and
     * `workflow_schedule` are the two with composite keys, which is why they are
     * named here rather than left to a generic assertion.
     */
    const manifest = await dataExport.manifest(owner());
    const byName = new Map(manifest.tables.map((table) => [table.table, table]));
    expect(byName.get("customer")!.key).toEqual(["id"]);
    expect(byName.get("event_cursor")!.key).toEqual(["organization_id", "consumer"]);
    expect(byName.get("workflow_schedule")!.key).toEqual(["organization_id", "workflow_id"]);
    for (const table of manifest.tables) {
      expect(table.key.length, `${table.table} has no key to paginate on`).toBeGreaterThan(0);
    }
  });

  it("says what is outside the tenant, so the absence is a statement", async () => {
    /**
     * A reader who notices there is no `user` table in the export should find the
     * reason in the export rather than having to ask. And the reason for
     * `credential` is the strongest line in the file: password hashes are
     * unreachable from here, which is why no part of this export has to be
     * trusted not to include them.
     */
    const manifest = await dataExport.manifest(owner());
    const named = new Map(manifest.outsideTheTenant.map((row) => [row.table, row.reason]));
    expect([...named.keys()].sort())
      .toEqual(["credential", "demo_visit", "network", "organization", "session", "setup_token", "user"]);
    expect(named.get("credential")).toMatch(/Password hashes/);
    expect(named.get("user")).toMatch(/membership/);
  });

  it("lists every table that is outside the tenant and no more", async () => {
    /**
     * Both directions. A table that stops carrying `organization_id` has to
     * appear in the outside list, and a name in that list that is now a tenant
     * table is a note about nothing.
     */
    const outside = await raw<{ table_name: string }[]>`
      select c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and not exists (
          select 1 from pg_attribute o
          where o.attrelid = c.oid and o.attname = 'organization_id' and o.attnum > 0
        )
        and c.relname not like '%drizzle%'
      order by 1`;

    const manifest = await dataExport.manifest(owner());
    const named = new Set(manifest.outsideTheTenant.map((row) => row.table));
    expect(outside.map((row) => row.table_name).filter((name) => !named.has(name))).toEqual([]);
  });
});

/* ========================================================== the redaction */

run("what does not leave", () => {
  it("holds back a live webhook token and says so", async () => {
    /**
     * THE SHARPEST ONE, because it is a plaintext secret rather than a hash.
     * Whoever holds it can post leads into this company as if they were the
     * partner. The connector's name, URL and field map are exported so the
     * connection can be rebuilt; the token has to be reissued on both sides.
     */
    await raw`
      insert into public.lead_source_connector (organization_id, source, display_name,
                                                webhook_token, field_map)
      values (${ORG}, 'angi', 'Angi', 'live-secret-value-nobody-should-see', '{}'::jsonb)`;

    const page = await dataExport.page(owner(), { table: "lead_source_connector" });
    expect(page.rows).toHaveLength(1);
    expect(page.redacted).toEqual(["webhook_token"]);
    expect(JSON.stringify(page)).not.toContain("live-secret-value-nobody-should-see");
    /** And the useful part is still there, which is the point of not dropping the row. */
    expect(page.rows[0]!["display_name"]).toBe("Angi");
  });

  it("holds back a token hash, because a short token is a cracking target", async () => {
    const customer = (await customers(["Ann"]))[0]!;
    await raw`
      insert into public.portal_grant (organization_id, customer_id, scope, token_hash, expires_at)
      values (${ORG}, ${customer}, 'customer', 'deadbeef-hash-value',
              now() + interval '30 days')`;

    const page = await dataExport.page(owner(), { table: "portal_grant" });
    expect(page.redacted).toEqual(["token_hash"]);
    expect(JSON.stringify(page)).not.toContain("deadbeef-hash-value");
  });

  it("holds back nothing that is merely a reference to a secret", async () => {
    /**
     * `credential_ref` is the NAME of a secret in the deployment's own store, by
     * design, and a company moving away needs it: it is how they know which
     * secrets to go and find. Redacting a name because it has "credential" in it
     * would make the export less useful for no gain.
     */
    await raw`
      insert into public.integration_connection (organization_id, capability, provider, status,
                                                 credential_ref, settings)
      values (${ORG}, 'payments', 'stripe', 'connected', 'STRIPE_SECRET_KEY', '{}'::jsonb)`;

    const page = await dataExport.page(owner(), { table: "integration_connection" });
    expect(page.redacted).toEqual([]);
    expect(page.rows[0]!["credential_ref"]).toBe("STRIPE_SECRET_KEY");
  });

  it("gives a reason for every redaction, in the manifest", async () => {
    /**
     * Somebody moving to another system needs to know their webhook tokens are
     * not in the file, so they reissue rather than discover it when the leads
     * stop. A column name with no sentence beside it is not that.
     */
    const manifest = await dataExport.manifest(owner());
    const withRedactions = manifest.tables.filter((table) => table.redacted.length > 0);
    expect(withRedactions.length).toBeGreaterThan(3);
    for (const table of withRedactions) {
      for (const column of table.redacted) {
        expect(column.reason.length, `${table.table}.${column.column} has no reason`)
          .toBeGreaterThan(40);
      }
    }
  });

  it("accounts for every column in the database that looks like a credential", async () => {
    /**
     * THE GUARD THE SWEEP SENT ME LOOKING FOR, and it is better than the one it
     * probed.
     *
     * The manifest used to filter its redaction list against the live columns,
     * which could not matter: every name in `REDACTED` is real. The failure that
     * actually costs something is a RENAME. If `webhook_token` became
     * `inbound_token` in a migration, the stale entry would be cosmetic noise and
     * the column under its new name would start being exported, in every export,
     * silently, and no filter in the service would have stopped it.
     *
     * So the check reads the catalogue. Every column on every tenant table whose
     * name contains token, secret, password, hash, key or credential is either
     * redacted or named in `EXPORTED_DELIBERATELY` with a reason. A new one has to be put in
     * one list or the other before this passes, which means nobody has to notice
     * the day a migration adds one.
     */
    const suspicious = await raw<{ table_name: string; column_name: string }[]>`
      select c.relname as table_name, a.attname as column_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'public' and c.relkind = 'r'
        and exists (
          select 1 from pg_attribute o
          where o.attrelid = c.oid and o.attname = 'organization_id' and o.attnum > 0
        )
        and a.attname ~ '(token|secret|password|hash|key|credential)'
      order by 1, 2`;

    expect(suspicious.length).toBeGreaterThan(15);

    const unaccounted = suspicious
      .filter(({ table_name, column_name }) =>
        !(dataExport.REDACTED[table_name]?.[column_name])
        && !(dataExport.EXPORTED_DELIBERATELY[table_name]?.[column_name]))
      .map(({ table_name, column_name }) => `${table_name}.${column_name}`);

    expect(
      unaccounted,
      "These columns read like credentials and are in neither REDACTED nor "
      + `EXPORTED_DELIBERATELY, so nobody has decided whether they leave: ${unaccounted.join(", ")}`,
    ).toEqual([]);

    /** And both lists name only columns that exist, so a rename cannot hide in one. */
    const real = new Set(suspicious.map((row) => `${row.table_name}.${row.column_name}`));
    for (const [list, name] of [
      [dataExport.REDACTED, "REDACTED"],
      [dataExport.EXPORTED_DELIBERATELY, "EXPORTED_DELIBERATELY"],
    ] as const) {
      for (const [table, columns] of Object.entries(list)) {
        for (const column of Object.keys(columns)) {
          expect(
            real.has(`${table}.${column}`),
            `${name} names ${table}.${column}, which is not a column that looks like a credential`,
          ).toBe(true);
        }
      }
    }
  });

  it("gives a reason for every column it lets through", async () => {
    for (const [table, columns] of Object.entries(dataExport.EXPORTED_DELIBERATELY)) {
      for (const [column, reason] of Object.entries(columns)) {
        expect(reason.length, `${table}.${column} leaves with no reason given`).toBeGreaterThan(20);
      }
    }
  });

  it("redacts nothing that is not a column on that table", async () => {
    /**
     * BOTH DIRECTIONS, and the sweep is why. The first version only checked that
     * every name in `REDACTED` reached the manifest, which stays true when the
     * manifest stops filtering against the real columns: it would then promise to
     * hold back a column that has been renamed away, and a reader would trust a
     * redaction that does nothing.
     */
    const real = await raw<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public'`;
    const columnsOf = new Map<string, Set<string>>();
    for (const row of real) {
      const set = columnsOf.get(row.table_name) ?? new Set<string>();
      set.add(row.column_name);
      columnsOf.set(row.table_name, set);
    }

    const manifest = await dataExport.manifest(owner());
    const byName = new Map(manifest.tables.map((table) => [table.table, table]));

    for (const [table, columns] of Object.entries(dataExport.REDACTED)) {
      const entry = byName.get(table);
      expect(entry, `REDACTED names ${table}, which is not a tenant table`).toBeTruthy();
      const named = new Set(entry!.redacted.map((column) => column.column));
      for (const column of Object.keys(columns)) {
        expect(named.has(column), `${table}.${column} is redacted and is not a column`).toBe(true);
      }
    }

    /** And nothing the manifest claims to hold back is absent from the table. */
    for (const table of manifest.tables) {
      for (const column of table.redacted) {
        expect(
          columnsOf.get(table.table)?.has(column.column),
          `the manifest says it holds back ${table.table}.${column.column}, which is not a column`,
        ).toBe(true);
      }
    }
  });
});

/* ========================================================== the pagination */

run("walking a table", () => {
  it("pages through on the key, and stops on more rather than on an empty page", async () => {
    await customers(["A", "B", "C", "D", "E"]);

    const first = await dataExport.page(owner(), { table: "customer", limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.more).toBe(true);
    expect(first.cursor).toHaveLength(1);

    const second = await dataExport.page(owner(), {
      table: "customer", limit: 2, after: first.cursor!,
    });
    expect(second.rows).toHaveLength(2);
    expect(second.more).toBe(true);

    const third = await dataExport.page(owner(), {
      table: "customer", limit: 2, after: second.cursor!,
    });
    expect(third.rows).toHaveLength(1);
    expect(third.more).toBe(false);

    const seen = [...first.rows, ...second.rows, ...third.rows].map((row) => row["name"]);
    expect(new Set(seen).size).toBe(5);
  });

  it("does not repeat or skip a row when one is inserted mid walk", async () => {
    /**
     * WHY IT IS A KEYSET AND NOT AN OFFSET. A company exports while its office is
     * still working, so rows arrive during the walk. An offset shifts every
     * remaining row by one and the export quietly loses one; a keyset does not,
     * and the row that arrived either sorts after the cursor or does not appear,
     * which are both correct answers.
     */
    const ids = await customers(["A", "B", "C", "D"]);
    const first = await dataExport.page(owner(), { table: "customer", limit: 2 });
    await customers(["Arrived"]);

    const second = await dataExport.page(owner(), {
      table: "customer", limit: 10, after: first.cursor!,
    });
    const walked = [...first.rows, ...second.rows].map((row) => row["id"]);
    expect(new Set(walked).size).toBe(walked.length);
    for (const id of ids) expect(walked).toContain(id);
  });

  it("walks a table whose key is two columns", async () => {
    /**
     * `event_cursor`'s key is (organization_id, consumer). A function that
     * assumed `id` would throw on it, and a function that compared the key as
     * text would work here and break on an integer key later.
     */
    for (const consumer of ["accounting", "outbox", "webhooks"]) {
      await raw`insert into public.event_cursor (organization_id, consumer, last_sequence)
                values (${ORG}, ${consumer}, 1)`;
    }

    const first = await dataExport.page(owner(), { table: "event_cursor", limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.cursor).toHaveLength(2);
    const second = await dataExport.page(owner(), {
      table: "event_cursor", limit: 2, after: first.cursor!,
    });
    expect(second.rows).toHaveLength(1);
    expect(second.more).toBe(false);
  });

  it("refuses a cursor with the wrong number of columns", async () => {
    await customers(["A"]);
    await expect(dataExport.page(owner(), { table: "customer", after: ["a", "b"] }))
      .rejects.toThrow(/key has 1 column/);
  });

  it("returns an empty page and a null cursor at the end of an empty table", async () => {
    const page = await dataExport.page(owner(), { table: "customer" });
    expect(page.rows).toEqual([]);
    expect(page.cursor).toBeNull();
    expect(page.more).toBe(false);
  });

  it("caps the page size rather than taking the caller's word for it", async () => {
    /**
     * WITH MORE ROWS THAN THE CAP, which the sweep showed is the only way this
     * means anything: the first version of this test asked for 999,999 rows from
     * a table holding two and would have passed against a service that honoured
     * whatever it was given.
     *
     * One statement rather than 1,100 round trips, because a fixture that takes
     * twenty seconds is a test somebody deletes.
     */
    await raw`
      insert into public.customer (organization_id, type, name, payment_terms_days)
      select ${ORG}, 'residential', 'Bulk ' || n, 0
      from generate_series(1, 1100) as n`;

    const page = await dataExport.page(owner(), { table: "customer", limit: 5000 });
    expect(page.rows).toHaveLength(dataExport.MAX_PAGE);
    expect(page.more).toBe(true);
  });

  it("says there is no more when the last page is exactly full", async () => {
    /**
     * THE OFF BY ONE THE SWEEP FOUND NOTHING COVERING. The service asks for one
     * row more than the caller wanted and reports `more` on whether it got it. A
     * version comparing `>=` instead of `>` says there is another page whenever a
     * page comes back full, so a caller walking a table of exactly a thousand
     * rows asks for a second page, gets nothing, and either loops or has to learn
     * to stop on an empty page instead of on the flag.
     */
    await customers(["A", "B"]);
    const page = await dataExport.page(owner(), { table: "customer", limit: 2 });
    expect(page.rows).toHaveLength(2);
    expect(page.more).toBe(false);
  });

  it("refuses a cursor that is not in the key's shape", async () => {
    /**
     * `customer`'s key is a uuid. A cursor that is not one is a caller's mistake
     * and used to come back as a 500 from Postgres saying "invalid input syntax
     * for type uuid", which tells somebody nothing about what to do.
     */
    await customers(["A"]);
    await expect(dataExport.page(owner(), { table: "customer", after: ["not-a-uuid"] }))
      .rejects.toThrow(/not in the shape/);
  });

  it("refuses a table that is not a tenant table, without echoing the name", async () => {
    /**
     * NOT FOUND rather than forbidden, and the same answer for a table that does
     * not exist and one that exists outside the tenant. A caller probing names
     * learns nothing either way.
     */
    await expect(dataExport.page(owner(), { table: "credential" }))
      .rejects.toThrow(NotFoundError);
    await expect(dataExport.page(owner(), { table: "user" })).rejects.toThrow(NotFoundError);
    await expect(dataExport.page(owner(), { table: "no_such_table" }))
      .rejects.toThrow(NotFoundError);
  });

  it("refuses a name that is not an identifier at all", async () => {
    await expect(dataExport.page(owner(), { table: 'customer"; drop table customer; --' }))
      .rejects.toThrow(NotFoundError);
    const [{ n } = { n: "?" }] = await raw<{ n: string }[]>`
      select count(*)::text as n from pg_class where relname = 'customer'`;
    expect(n).toBe("1");
  });
});

/* ========================================================== the boundary */

run("whose data it is", () => {
  it("gives a company only its own rows", async () => {
    /**
     * Row level security rather than a clause in the service, which is why this
     * test matters: the export's SELECT carries NO organization filter of its
     * own. There is nothing in the query to get wrong, and RLS is the only thing
     * between two companies' customer lists.
     */
    await customers(["Mine"]);
    await raw`insert into public.customer (organization_id, type, name, payment_terms_days)
              values (${OTHER_ORG}, 'residential', 'Theirs', 0)`;

    const mine = await dataExport.page(owner(), { table: "customer" });
    expect(mine.rows.map((row) => row["name"])).toEqual(["Mine"]);
    const theirs = await dataExport.page(other(), { table: "customer" });
    expect(theirs.rows.map((row) => row["name"])).toEqual(["Theirs"]);
  });

  it("needs data:export and nothing else will do", async () => {
    /**
     * The whole customer list is the company's most valuable asset, and
     * `data:export` is owner-only for that reason. Both halves with an explicit
     * grant and NO role, because the owner holds everything.
     */
    await customers(["Ann"]);
    await expect(dataExport.manifest(granted("customer:read")))
      .rejects.toThrow(/permission/);
    await expect(dataExport.page(granted("customer:read"), { table: "customer" }))
      .rejects.toThrow(/permission/);
    const ok = await dataExport.page(granted("data:export"), { table: "customer" });
    expect(ok.rows).toHaveLength(1);
  });

  it("writes an audit line naming the table and the row count", async () => {
    /**
     * "When did somebody take a copy of our entire customer list, and how much of
     * it" is the question an export has to be able to answer. It is the single
     * most sensitive read in this product, and a log that records only that
     * somebody read something is not an answer.
     */
    await customers(["A", "B"]);
    await dataExport.page(owner(), { table: "customer" });

    const [line] = await raw<{ action: string; after: Record<string, unknown> }[]>`
      select action, "after" from public.audit_log
      where organization_id = ${ORG} and action = 'data.export.page'
      order by created_at desc limit 1`;
    expect(line!.action).toBe("data.export.page");
    expect(line!.after["table"]).toBe("customer");
    expect(line!.after["rows"]).toBe(2);
  });

  it("records that a page was a resumption, not a fresh read", async () => {
    await customers(["A", "B", "C"]);
    const first = await dataExport.page(owner(), { table: "customer", limit: 1 });
    await dataExport.page(owner(), { table: "customer", limit: 1, after: first.cursor! });

    const lines = await raw<{ after: Record<string, unknown> }[]>`
      select "after" from public.audit_log
      where organization_id = ${ORG} and action = 'data.export.page'
      order by created_at asc`;
    expect(lines.map((line) => line.after["resumed"])).toEqual([false, true]);
  });

  it("writes an audit line for the manifest too", async () => {
    await dataExport.manifest(owner());
    const [line] = await raw<{ action: string }[]>`
      select action from public.audit_log
      where organization_id = ${ORG} and action = 'data.export.manifest' limit 1`;
    expect(line!.action).toBe("data.export.manifest");
  });
});

/** Keeps the ConflictError import honest. */
describe("refusal types", () => {
  it("uses ConflictError for a malformed cursor rather than a missing row", () => {
    expect(new ConflictError("x")).toBeInstanceOf(Error);
  });
});
