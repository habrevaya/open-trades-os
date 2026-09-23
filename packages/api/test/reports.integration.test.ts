import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as reports from "../src/services/reports";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * REPORTING
 *
 * The definition is data and this is where it becomes SQL. Two properties
 * matter more than any output being correct:
 *
 *   NOTHING A CALLER SENDS REACHES A QUERY. They send a key; the catalogue
 *   supplies the expression. A key that is not in the catalogue is refused
 *   rather than passed through, which is the whole reason a builder can be
 *   exposed to anybody holding `report:build`.
 *
 *   A REPORT IS A READ LIKE ANY OTHER. Without scope, the builder is the most
 *   convenient way around it in the product: a technician who cannot list the
 *   company's jobs could count them by status and read the customer names off
 *   the group labels.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("rp:org");
const USER = fixtureId("rp:user");
const TECH = fixtureId("rp:tech");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let customerId = "";
let propertyId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Report Co", slug: "report-co" });

  const customer = await customers.create(owner(), {
    type: "residential", name: "Rita Report", phone: "+15125550133",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const property = await properties.create(owner(), {
    address: { line1: "7 Report Rd", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  propertyId = property.id;

  // A technician assigned to one job and not the other, so scope has two
  // sides to tell apart.
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${USER}, 'technician')
    on conflict (organization_id, user_id) do update set role = 'technician' returning id`;
  await raw`insert into public.technician (id, organization_id, membership_id, display_name)
            values (${TECH}, ${ORG}, ${m!.id}, 'Tess Report') on conflict (id) do nothing`;

  const mine = await jobs.create(owner(), {
    customerId, propertyId, summary: "Mine", tags: [], customFields: {},
  });
  await jobs.create(owner(), {
    customerId, propertyId, summary: "Theirs", tags: [], customFields: {},
  });

  const [visit] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, status) values (${ORG}, ${mine.id}, 'scheduled')
    returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id)
            values (${ORG}, ${visit!.id}, ${TECH})`;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.report where organization_id = ${ORG}`;
});

run("ordering", () => {
  it("sorts money by how much it is, not alphabetically", async () => {
    /**
     * A money measure is selected as TEXT on purpose: a sum of `numeric`
     * arriving as a float loses cents at scale. `order by "balance"` then
     * names that text column and Postgres sorts it as a word, so "9.0000"
     * lands above "1000.0000" and the chasing list opens with a nine dollar
     * debt.
     *
     * Two values chosen so the two orders disagree: alphabetically 1000
     * comes first, numerically 9 does not.
     */
    const rows = await raw<{ id: string }[]>`
      insert into public.invoice
        (organization_id, customer_id, number, status, issued_on, due_on, subtotal, total, balance)
      values
        (${ORG}, ${customerId}, 8801, 'open', current_date, current_date + 30, 9, 9, 9),
        (${ORG}, ${customerId}, 8802, 'open', current_date, current_date - 45, 1000, 1000, 1000)
      returning id`;

    try {
      // Two different aging buckets, so there are two rows to order.
      const result = await reports.run(owner(), {
        dataset: "invoices", dimensions: ["aging"], measures: ["balance"],
        orderBy: "balance",
      });
      const balances = result.rows.map((r) => Number(r["balance"]));
      expect(balances).toEqual([...balances].sort((a, b) => b - a));
      expect(balances[0]).toBe(1000);
    } finally {
      for (const row of rows) {
        await raw`delete from public.invoice where id = ${row.id}`;
      }
    }
  });
});

run("running one", () => {
  it("groups and counts", async () => {
    const result = await reports.run(owner(), {
      dataset: "jobs", dimensions: ["status"], measures: ["count"],
    });
    expect(result.columns.map((c) => c.key)).toEqual(["status", "count"]);
    const total = result.rows.reduce((n, r) => n + Number(r["count"]), 0);
    expect(total).toBe(2);
  });

  it("returns a single total row when no dimension is given", async () => {
    // A legitimate report, and the shape a headline number takes.
    const result = await reports.run(owner(), {
      dataset: "jobs", dimensions: [], measures: ["count"],
    });
    expect(result.rows).toHaveLength(1);
    expect(Number(result.rows[0]!["count"])).toBe(2);
  });

  it("tells the screen which columns are groups and which are numbers", async () => {
    /**
     * The result is the whole contract with the screen, and the screen right
     * aligns one and not the other. Inferring it from the type looked fine
     * and breaks the day somebody adds a numeric dimension.
     */
    const result = await reports.run(owner(), {
      dataset: "jobs", dimensions: ["status"], measures: ["count"],
    });
    expect(result.columns.map((c) => c.role)).toEqual(["dimension", "measure"]);
  });

  it("says when a bucket label carries a prefix that only exists to sort", async () => {
    /**
     * The aging buckets are stored as "5 Over 90 days" so they sort. A screen
     * left to guess would either print the digit, or strip it from a customer
     * called "3 Brothers Plumbing".
     */
    const result = await reports.run(owner(), {
      dataset: "invoices", dimensions: ["aging"], measures: ["count"],
    });
    expect(result.columns.find((c) => c.key === "aging")?.sortPrefix).toBe(true);
    expect(result.columns.find((c) => c.key === "count")?.sortPrefix).toBeUndefined();
  });

  it("applies a filter as a parameter", async () => {
    const result = await reports.run(owner(), {
      dataset: "jobs", dimensions: ["status"], measures: ["count"],
      filters: [{ dimension: "status", op: "eq", value: "lead" }],
    });
    expect(result.rows.every((r) => r["status"] === "lead")).toBe(true);
  });
});

run("what a definition cannot contain", () => {
  it("refuses a column that is not in the catalogue", async () => {
    /**
     * The injection story, and the reason a report builder is not a database
     * console. The caller sends a key; the catalogue supplies the SQL.
     */
    await expect(reports.run(owner(), {
      dataset: "jobs",
      dimensions: ["j.id) as x, (select current_setting('app.organization_id')"],
      measures: ["count"],
    })).rejects.toThrow(/Not available/);
  });

  it("refuses a measure that is not in the catalogue", async () => {
    await expect(reports.run(owner(), {
      dataset: "jobs", dimensions: [], measures: ["count(*) from public.credential --"],
    })).rejects.toThrow(/Not available/);
  });

  it("refuses a dataset that does not exist", async () => {
    await expect(reports.run(owner(), {
      dataset: "public.credential", dimensions: [], measures: ["count"],
    })).rejects.toThrow(/no dataset/);
  });

  it("refuses a filter naming a column that is not a dimension", async () => {
    await expect(reports.run(owner(), {
      dataset: "jobs", dimensions: [], measures: ["count"],
      filters: [{ dimension: "j.deleted_at is null or true --", op: "eq", value: "x" }],
    })).rejects.toThrow(/Not available/);
  });

  it("refuses a report with no measure", async () => {
    // A list of distinct values, which the record screens already do better.
    await expect(reports.run(owner(), {
      dataset: "jobs", dimensions: ["status"], measures: [],
    })).rejects.toThrow(/at least one measure/);
  });
});

describe("every dataset has decided what a technician may see", () => {
  it("has a scope filter for each one in the catalogue", () => {
    /**
     * The one guard that does not need a database, and the one that catches
     * the failure this whole file exists for. A dataset added to the
     * catalogue and not given a filter is unscoped: the builder would then be
     * the most convenient way around scope in the product, and no existing
     * test would go red, because every existing test names a dataset that
     * already has one.
     *
     * `scopeFilterFor` still fails closed for anything missing, so the worst
     * case is a report that returns nothing rather than one that returns
     * everything. This is what turns that into a message somebody reads.
     */
    expect(Object.keys(reports.SCOPE_FILTERS).sort())
      .toEqual(reports.CATALOGUE.map((d) => d.key).sort());
  });

  it("fails closed for a dataset nobody wrote a filter for", () => {
    const filter = reports.scopeFilterFor(
      { actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] } } as never,
      { key: "nobody_wrote_this" } as never,
    );
    // Defined, and false. Returning undefined here would mean no WHERE clause
    // at all, which is every row in the table.
    expect(filter).toBeDefined();
    expect(JSON.stringify(filter)).toContain("false");
  });
});

run("permission and scope", () => {
  const dispatcher = (): ServiceContext => ({
    actor: { userId: USER, organizationId: ORG, roles: ["dispatcher"] as Actor["roles"] },
    db: db(),
  });
  const technician = (): ServiceContext => ({
    actor: {
      userId: USER, organizationId: ORG,
      roles: ["technician"] as Actor["roles"], technicianId: TECH,
    },
    db: db(),
  });

  it("refuses a financial dataset to somebody without the permission", async () => {
    // Reading one invoice and reading the company's revenue are different
    // things to be trusted with.
    await expect(reports.run(dispatcher(), {
      dataset: "invoices", dimensions: ["month"], measures: ["total"],
    })).rejects.toThrow(/report.financial:read/);
  });

  it("refuses rather than blanking a measure somebody may not see", async () => {
    /**
     * A report that quietly omits the column somebody asked for teaches them
     * the number is zero, and they act on it. Saying no is the honest answer.
     */
    await expect(reports.run(dispatcher(), {
      dataset: "estimates", dimensions: ["status"], measures: ["count", "value"],
    })).rejects.toThrow(/report.financial:read/);
  });

  it("scopes a technician's report to their own work", async () => {
    /**
     * The one that matters most. Without it the builder is the most
     * convenient way around scope in the product: count the jobs by customer
     * and read the customer list off the group labels.
     */
    const result = await reports.run(technician(), {
      dataset: "jobs", dimensions: ["status"], measures: ["count"],
    });
    const total = result.rows.reduce((n, r) => n + Number(r["count"]), 0);
    expect(total).toBe(1);
  });

  it("still gives an owner the whole company", async () => {
    // The other half, so the test above cannot pass against a filter that
    // returns nothing for anybody.
    const result = await reports.run(owner(), {
      dataset: "jobs", dimensions: ["status"], measures: ["count"],
    });
    expect(result.rows.reduce((n, r) => n + Number(r["count"]), 0)).toBe(2);
  });

  it("offers only the datasets a reader may actually run", async () => {
    expect(reports.available(dispatcher()).map((d) => d.key)).not.toContain("invoices");
    expect(reports.available(owner()).map((d) => d.key)).toContain("invoices");
  });

  it("offers only the built-in reports a reader may actually run", async () => {
    // A list where half the entries error when clicked is worse than a
    // shorter list.
    const theirs = reports.builtIn(dispatcher()).map((r) => r.slug);
    expect(theirs).not.toContain("revenue-by-month");
    expect(reports.builtIn(owner()).map((r) => r.slug)).toContain("revenue-by-month");
  });
});

run("the reports that ship", () => {
  it("every one of them runs", async () => {
    /**
     * A built-in that errors is worse than a missing one: it is the first
     * thing somebody clicks, and it is the whole product's credibility.
     */
    for (const report of reports.BUILT_IN) {
      await expect(
        reports.run(owner(), report.definition),
        `${report.slug} does not run`,
      ).resolves.toBeTruthy();
    }
  });

  it("names the question rather than the table", async () => {
    // "What did we invoice, month by month" is the thing somebody wants.
    // "invoices grouped by month" is how we happen to answer it.
    for (const report of reports.BUILT_IN) {
      expect(report.question.endsWith("?"), `${report.slug} does not ask a question`).toBe(true);
    }
  });
});

run("saving one", () => {
  const definition = { dataset: "jobs", dimensions: ["status"], measures: ["count"] };

  it("stores a definition and runs it back", async () => {
    const saved = await reports.save(owner(), { name: "Open work", definition });
    const { result } = await reports.runSaved(owner(), { id: saved.id });
    expect(result.rows.reduce((n, r) => n + Number(r["count"]), 0)).toBe(2);
  });

  it("refuses to store something the author cannot run", async () => {
    /**
     * Otherwise a definition can be left lying around for somebody with more
     * permissions to run later, without its author ever seeing what is in it.
     */
    const dispatcher: ServiceContext = {
      actor: {
        userId: USER, organizationId: ORG,
        roles: ["dispatcher"] as Actor["roles"],
        grants: ["report:build"] as NonNullable<Actor["grants"]>,
      },
      db: db(),
    };
    await expect(reports.save(dispatcher, {
      name: "Sneaky", definition: { dataset: "invoices", dimensions: ["month"], measures: ["total"] },
    })).rejects.toThrow(/report.financial:read/);
  });

  it("checks again against whoever runs it, not whoever saved it", async () => {
    /**
     * A saved report is a stored intention, not a stored permission. An owner
     * saving "revenue by month" must not make it runnable by a dispatcher.
     */
    const saved = await reports.save(owner(), {
      name: "Revenue", definition: { dataset: "invoices", dimensions: ["month"], measures: ["total"] },
    });
    const dispatcher: ServiceContext = {
      actor: { userId: USER, organizationId: ORG, roles: ["dispatcher"] as Actor["roles"] },
      db: db(),
    };
    await expect(reports.runSaved(dispatcher, { id: saved.id }))
      .rejects.toThrow(/report.financial:read/);
  });

  it("refuses a second report with the same name", async () => {
    await reports.save(owner(), { name: "Open work", definition });
    await expect(reports.save(owner(), { name: "Open work", definition })).rejects.toThrow();
  });
});
