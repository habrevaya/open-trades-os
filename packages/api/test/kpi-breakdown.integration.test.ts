import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { packs } from "@opentradesos/trade-packs";
import * as kpis from "../src/services/kpis";
import * as reports from "../src/services/reports";
import { CATALOGUE } from "../src/services/kpi-catalogue";
import { NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A KPI BROKEN DOWN BY WHAT ITS RECORDS ALREADY SAY
 *
 * The cancellation rate is "reported per route and per weekday", and each stop
 * behind it names both. A breakdown is those records added up by the group
 * each names, so each group's halves open onto that group's records, and the
 * groups add up to the figure on the scorecard.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("kpi-breakdown:org");
const USER = fixtureId("kpi-breakdown:user");
const WINDOW = { from: "2026-06-01", to: "2026-06-30" };
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (role: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db(),
});
const owner = () => as("owner");

let customerId = "";
let propertyId = "";
let typeId = "";
const routes = new Map<string, string>();
let crewId = "";
let seq = 0;

/** A local wall clock time in Austin as an instant. */
const local = (day: string, clock: string) => raw.unsafe(`('${day} ${clock}'::timestamp at time zone '${ZONE}')`);

/**
 * A stop at nine on `day`, on a route or on the crew with no route, and how it
 * was called off: by the customer `askedHoursBefore` nine under a day's notice,
 * or by the company.
 */
async function stop(day: string, where: string | null, calledOff?: { by: "customer" | "company"; askedHoursBefore: number }) {
  seq += 1;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, ${typeId}, 'scheduled', ${`Stop ${seq}`}) returning id`;
  await raw`
    insert into public.visit (organization_id, job_id, status, window_start, window_end, route_id, crew_id,
                              cancelled_by, cancelled_at, cancel_notice_hours)
    values (${ORG}, ${job!.id}, ${calledOff ? "cancelled" : "scheduled"}::visit_status,
            ${local(day, "09:00")}, ${local(day, "11:00")},
            ${where ? routes.get(where)! : null}, ${where ? null : crewId},
            ${calledOff?.by ?? null}::visit_cancelled_by,
            ${calledOff ? raw.unsafe(`(('${day} 09:00'::timestamp at time zone '${ZONE}') - interval '${calledOff.askedHoursBefore} hours')`) : null},
            ${calledOff ? 24 : null})`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Breakdown Cleaning Co", slug: "kpi-breakdown-co" });
  await raw`update public.organization set timezone = ${ZONE}, primary_trade = 'cleaning' where id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Rosa Reyes', 0) returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '12 Willow', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id;
  const [type] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, capacity_model, revenue_class)
    values (${ORG}, 'Recurring clean', 'bd-recurring', 'route', 'recurring') returning id`;
  typeId = type!.id;
  for (const name of ["North", "South", "East"]) {
    const [route] = await raw<{ id: string }[]>`
      insert into public.route (organization_id, name, day_of_week) values (${ORG}, ${name}, 3) returning id`;
    routes.set(name, route!.id);
  }
  const [crew] = await raw<{ id: string }[]>`insert into public.crew (organization_id, name) values (${ORG}, 'Team B') returning id`;
  crewId = crew!.id;

  /**
   * June 2026, by hand. The 1st is a Monday, the 3rd a Wednesday.
   *
   *   North, Monday:     kept, kept, late                     1 of 3
   *   North, Wednesday:  late, in time                        1 of 2
   *   South, Wednesday:  kept, kept                           0 of 2
   *   Team B, Monday:    late                                 1 of 1
   *   East, Wednesday:   the company called it off            none of none, one beside
   *
   *   Late 3, scheduled 8. By route North 2/5, South 0/2, Team B 1/1, East 0/0.
   *   By weekday Monday 2/4, Wednesday 1/4.
   */
  await stop("2026-06-01", "North");
  await stop("2026-06-01", "North");
  await stop("2026-06-01", "North", { by: "customer", askedHoursBefore: 2 });
  await stop("2026-06-03", "North", { by: "customer", askedHoursBefore: 3 });
  await stop("2026-06-03", "North", { by: "customer", askedHoursBefore: 30 });
  await stop("2026-06-03", "South");
  await stop("2026-06-03", "South");
  await stop("2026-06-01", null, { by: "customer", askedHoursBefore: 1 });
  await stop("2026-06-03", "East", { by: "company", askedHoursBefore: 40 });
});

afterAll(async () => { if (raw) await raw.end(); });

run("the cancellation rate broken down", () => {
  it("says on the scorecard what it can be broken down by", async () => {
    const card = await kpis.scorecard(owner(), WINDOW);
    const figure = card.computed.find((k) => k.key === "cancel_rate_route")!;
    expect(figure).toMatchObject({ numerator: "3", denominator: "8" });
    expect(figure.groupings).toEqual([{ key: "route", label: "Route" }, { key: "weekday", label: "Weekday" }]);
    // A figure whose records name no grouping offers none.
    expect(card.computed.filter((k) => k.key !== "cancel_rate_route").every((k) => k.groupings?.length === 0)).toBe(true);
  });

  it("by route: each route's two halves, in name order, adding up to the figure", async () => {
    const result = await kpis.breakdown(owner(), { key: "cancel_rate_route", by: "route", ...WINDOW });
    expect(result.by).toEqual({ key: "route", label: "Route" });
    expect(result.groups.map((g) => [g.label, g.numerator, g.denominator, g.figure])).toEqual([
      // The company's own call: out of both halves, counted beside, so no figure.
      ["East", "0", "0", null],
      ["North", "2", "5", "40.0"],
      ["South", "0", "2", "0.0"],
      ["Team B", "1", "1", "100.0"],
    ]);
    expect(result.groups.find((g) => g.label === "East")!.besides).toEqual([
      { key: "excluded", count: "1" }, { key: "unknown", count: "0" },
    ]);
    expect([result.numerator, result.denominator]).toEqual(["3", "8"]);
  });

  it("by weekday, Monday first", async () => {
    const result = await kpis.breakdown(owner(), { key: "cancel_rate_route", by: "weekday", ...WINDOW });
    expect(result.groups.map((g) => [g.value, g.label, g.numerator, g.denominator])).toEqual([
      ["1", "Monday", "2", "4"],
      ["3", "Wednesday", "1", "4"],
    ]);
  });

  it("opens one group's records, which add up to that group's half", async () => {
    const result = await kpis.breakdown(owner(), { key: "cancel_rate_route", by: "route", ...WINDOW });
    const north = result.groups.find((g) => g.label === "North")!;
    const records = await kpis.drill(owner(), {
      key: "cancel_rate_route", half: "denominator", ...WINDOW, by: "route", group: north.value,
    });
    expect(records.count).toBe(5);
    expect(records.total).toBe("5");
    expect(records.records.every((r) => r.label.includes("North"))).toBe(true);
    expect(records.group).toEqual({ by: "route", byLabel: "Route", value: north.value, label: "North" });
    // The whole half when no group is named.
    expect((await kpis.drill(owner(), { key: "cancel_rate_route", half: "denominator", ...WINDOW })).count).toBe(8);
  });

  it("is refused where the records are, and for a grouping the figure does not carry", async () => {
    await expect(kpis.breakdown(owner(), { key: "cancel_rate_route", by: "customer", ...WINDOW }))
      .rejects.toThrow("This figure can be broken down by route or weekday, not by \"customer\".");
    // A technician who may read reports, about their own work only.
    const technician: ServiceContext = {
      actor: { userId: USER, organizationId: ORG, roles: ["technician"], grants: ["report:read"] }, db: db(),
    };
    await expect(kpis.breakdown(technician, { key: "cancel_rate_route", by: "route", ...WINDOW }))
      .rejects.toThrow(/whole company's/);
    await expect(kpis.drill(owner(), { key: "cancel_rate_route", half: "numerator", ...WINDOW, by: "route" }))
      .rejects.toThrow(/grouping and its value together/);
    // Not the company's trade: missing, as its records are.
    await expect(kpis.breakdown(owner(), { key: "water_per_stop", by: "truck", ...WINDOW })).rejects.toThrow(NotFoundError);
  });
});

run("every figure that declares a grouping carries it on every record", () => {
  /**
   * The guard on the catalogue: a grouping is declared only where every
   * records query of every half names the group on each row. Run each
   * breakdown under a trade that declares the KPI; a query missing the
   * columns is a database error here rather than on somebody's scorecard.
   */
  it("runs every declared breakdown under a trade that declares it", async () => {
    const declared = Object.entries(CATALOGUE).flatMap(([key, entry]) =>
      entry.state === "computed" ? (entry.measure.groupings ?? []).map((g) => ({ key, by: g.key })) : []);
    expect(declared.map((d) => `${d.key}:${d.by}`).sort()).toEqual([
      "cancel_rate_route:route", "cancel_rate_route:weekday",
      "route_density:person", "route_density:weekday",
      "water_per_stop:truck",
    ]);
    try {
      for (const { key, by } of declared) {
        const pack = packs.find((p) => p.kpis.some((k) => k.key === key))!;
        await raw`update public.organization set primary_trade = ${pack.id} where id = ${ORG}`;
        const result = await kpis.breakdown(owner(), { key, by, ...WINDOW });
        const card = (await kpis.scorecard(owner(), WINDOW)).computed.find((k) => k.key === key)!;
        expect([result.numerator, result.denominator], `${key} by ${by}`).toEqual([card.numerator, card.denominator]);
      }
    } finally {
      await raw`update public.organization set primary_trade = 'cleaning' where id = ${ORG}`;
    }
  });
});

run("a page size on the records", () => {
  it("lists as many to a page as asked, with the count and the total over every record", async () => {
    const first = await kpis.drill(owner(), { key: "cancel_rate_route", half: "denominator", ...WINDOW, perPage: 3 });
    expect([first.records.length, first.count, first.total, first.pages, first.perPage]).toEqual([3, 8, "8", 3, 3]);
    const last = await kpis.drill(owner(), { key: "cancel_rate_route", half: "denominator", ...WINDOW, perPage: 3, page: 3 });
    expect([last.records.length, last.page, last.total]).toEqual([2, 3, "8"]);
    // Every record on exactly one page.
    const second = await kpis.drill(owner(), { key: "cancel_rate_route", half: "denominator", ...WINDOW, perPage: 3, page: 2 });
    expect(new Set([...first.records, ...second.records, ...last.records].map((r) => r.id)).size).toBe(8);
    // Left out, a thousand.
    expect((await kpis.drill(owner(), { key: "cancel_rate_route", half: "denominator", ...WINDOW })).perPage).toBe(1000);
  });

  it("pages the records behind a report row the same way", async () => {
    const drilled = await reports.drill(owner(), {
      definition: { dataset: "jobs", dimensions: ["status"], measures: ["count"] },
      match: { status: "scheduled" }, perPage: 4, page: 3,
    });
    expect([drilled.count, drilled.rows.length, drilled.pages, drilled.page, drilled.perPage]).toEqual([9, 1, 3, 3, 4]);
    expect(drilled.totals["count"]).toBe("9");
  });
});
