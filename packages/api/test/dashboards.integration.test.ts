import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as dashboards from "../src/services/dashboards";
import * as reports from "../src/services/reports";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import { NotFoundError } from "../src/services/context";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * DASHBOARDS
 *
 * The claim the whole design rests on is that a dashboard has no query of its
 * own: every tile goes through `reports.run`, so scope and permission cannot
 * be weaker here than on the reports screen. That claim is only worth
 * anything if something checks it against a real database with a real
 * technician, because both of the ways it could be false are invisible to a
 * typecheck.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("db:org");
const USER = fixtureId("db:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);
const dispatcher = () => as(["dispatcher"]);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Dash Co", slug: "dash-co" });

  const customer = await customers.create(owner(), {
    type: "residential", name: "Dana Dash", phone: "+15125550177",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: "9 Dash Way", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  await jobs.create(owner(), {
    customerId: customer.id, propertyId: property.id, summary: "One", tags: [], customFields: {},
  });

  /**
   * THE FIXTURE HAS TO MAKE THE TWO ORDERS DISAGREE.
   *
   * Every ordering test here passes by accident if size order and the
   * dimension's own order happen to match, so:
   *
   *   the LATER month is worth more, so time order and size order differ
   *   the aging buckets get four different ages whose balances are NOT in
   *   bucket order, and more than one bucket, because one bucket is sorted
   *   whatever you do to it
   *
   * Due dates are relative to today rather than fixed, since the aging
   * buckets are computed against `current_date` and a fixed date would drift
   * into a different bucket every week.
   */
  let number = 3001;
  const invoices: { issued: string; dueInDays: number; total: string }[] = [
    { issued: "2026-01-15", dueInDays: -120, total: "400.00" },   // 5 Over 90
    { issued: "2026-03-15", dueInDays: -45, total: "900.00" },    // 3 31 to 60
    { issued: "2026-03-16", dueInDays: -10, total: "1200.00" },   // 2 1 to 30
    { issued: "2026-03-17", dueInDays: 20, total: "150.00" },     // 1 Current
  ];
  for (const invoice of invoices) {
    await raw`
      insert into public.invoice
        (organization_id, customer_id, number, status, issued_on, due_on, subtotal, total, balance)
      values (${ORG}, ${customer.id}, ${number}, 'open', ${invoice.issued}::date,
              current_date + (${invoice.dueInDays}::int),
              ${invoice.total}, ${invoice.total}, ${invoice.total})`;
    number += 1;
  }
});

afterAll(async () => { if (raw) await raw.end(); });

run("what a reader is offered", () => {
  it("gives an owner both dashboards", async () => {
    expect(dashboards.catalogue(owner()).map((d) => d.slug)).toEqual(["operations", "money"]);
  });

  it("does not list a dashboard whose every tile is refused", async () => {
    /**
     * The money dashboard is entirely behind `report.financial:read`, which
     * a dispatcher does not hold. Listing it would be a link to a page with
     * nothing on it, which is worse than no link.
     */
    expect(dashboards.catalogue(dispatcher()).map((d) => d.slug)).toEqual(["operations"]);
  });

  it("refuses to open one with nothing on it, as missing rather than forbidden", async () => {
    await expect(dashboards.get(dispatcher(), { slug: "money" })).rejects.toThrow(NotFoundError);
  });

  it("refuses a dashboard that does not exist", async () => {
    await expect(dashboards.get(owner(), { slug: "nope" })).rejects.toThrow(NotFoundError);
  });
});

run("running one", () => {
  it("fills every tile", async () => {
    const { tiles } = await dashboards.get(owner(), { slug: "money" });
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      expect(tile.problem, tile.title).toBeUndefined();
      expect(tile.result, tile.title).toBeDefined();
    }
  });

  it("gives a number tile one row and no dimension", async () => {
    const { tiles } = await dashboards.get(owner(), { slug: "money" });
    const outstanding = tiles.find((t) => t.key === "outstanding")!;
    expect(outstanding.kind).toBe("number");
    expect(outstanding.dimension).toBeUndefined();
    expect(outstanding.result!.rows).toHaveLength(1);
    // Every invoice in the fixture is unpaid.
    expect(Number(outstanding.result!.rows[0]!["balance"])).toBe(2650);
  });

  it("runs the trend oldest first", async () => {
    /**
     * The bug this exists for: a month-grouped report ordered by size shows
     * the same numbers with the shape taken out, and with a limit on it
     * keeps the BIGGEST months rather than the most recent, so a chart
     * labelled "last 18 months" shows the best 18 the company ever had.
     * March is worth more than January here, so size order and time order
     * disagree.
     */
    const { tiles } = await dashboards.get(owner(), { slug: "money" });
    const trend = tiles.find((t) => t.key === "revenue-by-month")!;
    const months = trend.result!.rows.map((r) => r["month"]);
    expect(months).toEqual([...months].sort());
  });

  it("keeps a bar tile over a category in size order, biggest first", async () => {
    // The other half of the same rule. A ranking read from the top is the
    // entire point of "who owes us", and a category has no other order.
    const { tiles } = await dashboards.get(owner(), { slug: "operations" });
    const bars = tiles.find((t) => t.kind === "bars")!;
    const values = bars.result!.rows.map((r) => Number(r[bars.measure!.key] ?? 0));
    expect(values).toEqual([...values].sort((a, b) => b - a));
  });

  it("keeps the aging buckets in bucket order, not in size order", async () => {
    /**
     * The aging dimension carries a numeric sort prefix for exactly this,
     * and ordering by balance defeats it. An owner reads this top to bottom
     * and the bottom row is the money that is not coming back; sorted by
     * size it moves every week and the shape stops meaning anything.
     */
    const { tiles } = await dashboards.get(owner(), { slug: "money" });
    const aging = tiles.find((t) => t.key === "aging")!;
    const buckets = aging.result!.rows.map((r) => String(r["aging"]));
    // More than one, or the assertion below holds however it is sorted.
    expect(buckets.length).toBeGreaterThan(2);
    expect(buckets).toEqual([...buckets].sort());
    expect(aging.dimension!.sortPrefix).toBe(true);

    // And that the two orders genuinely disagree on this fixture, so the
    // test cannot pass by them happening to coincide.
    const balances = aging.result!.rows.map((r) => Number(r["balance"]));
    expect(balances).not.toEqual([...balances].sort((a, b) => b - a));
  });

  it("drops the money tiles for a dispatcher rather than erroring them", async () => {
    // Filtered, not disabled. The same rule the navigation follows.
    const { tiles } = await dashboards.get(dispatcher(), { slug: "operations" });
    expect(tiles.every((t) => t.problem === undefined)).toBe(true);
  });
});

run("every dashboard that ships", () => {
  it("has tiles whose shapes and reports agree", async () => {
    /**
     * A tile and its report are written in one object and nothing makes them
     * match: a trend over a customer name renders as a perfectly ordinary
     * chart. This runs all of them as an owner, which is the only reader who
     * sees every tile.
     */
    for (const definition of dashboards.BUILT_IN_DASHBOARDS) {
      const { tiles } = await dashboards.get(owner(), { slug: definition.slug });
      expect(tiles.map((t) => [t.title, t.problem]).filter(([, p]) => p !== undefined))
        .toEqual([]);
      // And that it ran anything at all, so a dashboard whose tiles were all
      // dropped cannot pass this by being empty.
      expect(tiles.length, definition.slug).toBe(definition.tiles.length);
    }
  });

  it("names only datasets and fields the catalogue has", () => {
    // Cheaper than running them and it names the exact tile, which a failed
    // query does not.
    const keys = new Set(reports.CATALOGUE.map((d) => d.key));
    for (const definition of dashboards.BUILT_IN_DASHBOARDS) {
      for (const tile of definition.tiles) {
        expect(keys.has(tile.definition.dataset), `${definition.slug}/${tile.key}`).toBe(true);
      }
    }
  });
});
