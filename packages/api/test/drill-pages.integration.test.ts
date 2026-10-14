import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { reporting, type Actor } from "@opentradesos/core";
import * as reports from "../src/services/reports";
import * as kpis from "../src/services/kpis";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE RECORDS BEHIND A NUMBER, PAST A THOUSAND
 *
 * A drill used to list a thousand records and stop, with the totals over all
 * of them. Now it pages. What is worth a test is the promise the pages make
 * together: every record is on exactly one page, no record is on two, the
 * pages in order are the whole list in order, and the totals on every page are
 * the number that was clicked, never the page's own sum.
 *
 * Two thousand and five invoices make three pages of a report drill, and two
 * thousand and five completed jobs make three pages of a KPI half. Written
 * straight into the tables because the point is the count, not how each one
 * was raised.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("pages:org");
const USER = fixtureId("pages:user");
const MANY = 2005;
const WINDOW = { from: "2026-05-01", to: "2026-05-31" };

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

/** What every invoice adds up to, worked by hand: invoice n is n % 7 dollars and 25 cents. */
function handTotal(): string {
  let cents = 0;
  for (let n = 1; n <= MANY; n += 1) cents += (n % 7) * 100 + 25;
  return (cents / 100).toFixed(2);
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Pages Co", slug: "drill-pages-co" });
  await raw`update public.organization set timezone = 'America/Chicago', primary_trade = 'hvac' where id = ${ORG}`;

  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, name, type) values (${ORG}, 'Paige Pager', 'residential') returning id`;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '1 Page St', 'Austin', 'TX', '78701') returning id`;
  const [type] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, revenue_class)
    values (${ORG}, 'Repair', 'repair', 'service') returning id`;

  /** Open invoices, issued across the year, worth n % 7 dollars and 25 cents each. */
  await raw`
    insert into public.invoice (organization_id, number, customer_id, status, issued_on, subtotal, total, balance)
    select ${ORG}, n, ${customer!.id}, 'open', date '2026-01-01' + (n % 300),
           (n % 7) + 0.25, (n % 7) + 0.25, (n % 7) + 0.25
    from generate_series(1, ${MANY}) as n`;
  /** A paid one, which the drill of the open ones must leave out of every page. */
  await raw`
    insert into public.invoice (organization_id, number, customer_id, status, issued_on, subtotal, total, balance)
    values (${ORG}, ${MANY + 1}, ${customer!.id}, 'paid', '2026-02-01', 500, 500, 0)`;

  /**
   * Completed repairs through May in Austin, several to a day, so the KPI's
   * own order (the latest day first) has thousands of ties to break. Ten in
   * the morning in Austin is fifteen hundred UTC.
   */
  await raw`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary, completed_at)
    select ${ORG}, n, ${customer!.id}, ${property!.id}, ${type!.id}, 'completed', 'Repair ' || n,
           (date '2026-05-01' + (n % 31))::timestamp + interval '15 hours'
    from generate_series(1, ${MANY}) as n`;
}, 120_000);

afterAll(async () => { if (raw) await raw.end(); });

run("a report's records, a thousand to a page", () => {
  const definition: reporting.ReportDefinition = {
    dataset: "invoices", dimensions: ["status"], measures: ["count", "total", "average"],
  };

  it("lists every record exactly once across the pages, with the totals of all of them on each", async () => {
    const result = await reports.run(owner(), definition);
    const open = result.rows.find((row) => row["status"] === "open")!;
    expect(String(open["count"])).toBe(String(MANY));
    expect(reporting.normalizeDecimal(String(open["total"]))).toBe(reporting.normalizeDecimal(handTotal()));

    const seen: string[] = [];
    let added = "0";
    for (const page of [1, 2, 3]) {
      const drilled = await reports.drill(owner(), { definition, match: { status: "open" }, page });
      expect(drilled.page).toBe(page);
      expect(drilled.pages).toBe(3);
      expect(drilled.perPage).toBe(1000);
      expect(drilled.truncated).toBe(true);
      expect(drilled.rows).toHaveLength(page < 3 ? 1000 : 5);
      // The number that was clicked, on every page: never the page's own sum.
      expect(drilled.count).toBe(MANY);
      expect(reporting.normalizeDecimal(drilled.totals["total"]!)).toBe(reporting.normalizeDecimal(handTotal()));
      expect(drilled.totals["count"]).toBe(String(MANY));
      expect(reporting.roundDecimal(drilled.totals["average"]!, 4))
        .toBe(reporting.roundDecimal(Number(handTotal()) / MANY, 4));
      seen.push(...drilled.rows.map((row) => row.id));
      added = reporting.sumDecimals([added, ...drilled.rows.map((row) => String(row.values["total"]))]);
    }

    // Every record once: none twice, none missing, the paid one on no page.
    expect(new Set(seen).size).toBe(MANY);
    expect(seen).toHaveLength(MANY);
    // And the pages, added up by hand, are the number that was clicked.
    expect(reporting.normalizeDecimal(added)).toBe(reporting.normalizeDecimal(handTotal()));
  });

  it("keeps the order of the first page through the rest: the newest first, the last page the oldest", async () => {
    const first = await reports.drill(owner(), { definition, match: { status: "open" }, page: 1 });
    const last = await reports.drill(owner(), { definition, match: { status: "open" }, page: 3 });
    const issued = (r: (typeof first.rows)[number]) => String(r.values["issued"] ?? "");
    expect(issued(first.rows[0]!) >= issued(first.rows.at(-1)!)).toBe(true);
    expect(issued(first.rows.at(-1)!) >= issued(last.rows[0]!)).toBe(true);
  });

  it("shows the last page for a page past the end, and a list of one page as one page", async () => {
    const past = await reports.drill(owner(), { definition, match: { status: "open" }, page: 9 });
    expect(past.page).toBe(3);
    expect(past.rows).toHaveLength(5);
    expect(past.count).toBe(MANY);

    const paid = await reports.drill(owner(), { definition, match: { status: "paid" } });
    expect(paid).toMatchObject({ page: 1, pages: 1, truncated: false, count: 1 });
    expect(paid.totals["total"]).toBe("500.0000");
  });

  it("totals nothing as nothing: a row with no records is one empty page", async () => {
    const none = await reports.drill(owner(), { definition, match: { status: "void" } });
    expect(none).toMatchObject({ page: 1, pages: 1, truncated: false, count: 0, rows: [] });
    expect(none.totals).toEqual({ count: "0", total: "0", average: null });
  });
});

run("a KPI's records, a thousand to a page", () => {
  it("pages the completed jobs behind the callback rate, with the half's own total on every page", async () => {
    const card = await kpis.scorecard(owner(), WINDOW);
    const callback = card.computed.find((row) => row.key === "callback_rate")!;
    expect(callback.denominator).toBe(String(MANY));

    const ids: string[] = [];
    let days: string[] = [];
    for (const page of [1, 2, 3]) {
      const drilled = await kpis.drill(owner(), { key: "callback_rate", half: "denominator", ...WINDOW, page });
      expect(drilled).toMatchObject({ page, pages: 3, perPage: 1000, count: MANY, total: String(MANY), truncated: true });
      expect(drilled.records).toHaveLength(page < 3 ? 1000 : 5);
      ids.push(...drilled.records.map((record) => record.id));
      days = [...days, ...drilled.records.map((record) => record.onDay ?? "")];
    }

    // Each job on exactly one page, though some sixty five share each day.
    expect(new Set(ids).size).toBe(MANY);
    // And the latest day first, all the way through.
    expect(days).toEqual([...days].sort().reverse());
  });

  it("reads a page past the end as the last page", async () => {
    const drilled = await kpis.drill(owner(), { key: "callback_rate", half: "denominator", ...WINDOW, page: 40 });
    expect(drilled.page).toBe(3);
    expect(drilled.records).toHaveLength(5);
  });

  it("is one page with nothing on it for a window with no records, and a total of nought", async () => {
    const drilled = await kpis.drill(owner(), { key: "callback_rate", half: "numerator", ...WINDOW });
    expect(drilled).toMatchObject({ page: 1, pages: 1, count: 0, total: "0", truncated: false, records: [] });
  });
});
