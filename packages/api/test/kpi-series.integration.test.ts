import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { packs } from "@opentradesos/trade-packs";
import * as kpis from "../src/services/kpis";
import { CATALOGUE } from "../src/services/kpi-catalogue";
import { routes as contracts } from "../src/contracts";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE CANCELLATION RATE, MONTH BY MONTH AND BY ROUTE
 *
 * The same stops the scorecard sums and the breakdown adds up by route, added
 * up again by the month each stop's window began in, in the company's calendar.
 * Each month opens onto its own stops, the months add up to the breakdown over
 * the whole window, and a month the window cuts short says so.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("kpi-series:org");
const USER = fixtureId("kpi-series:user");
const ZONE = "America/Chicago";
const WINDOW = { from: "2026-05-01", to: "2026-08-15" };

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (role: string, grants: string[] = []): ServiceContext => {
  const actor: Actor = { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"] };
  if (grants.length > 0) actor.grants = grants as NonNullable<Actor["grants"]>;
  return { actor, db: db() };
};
const owner = () => as("owner");

let customerId = "";
let propertyId = "";
let typeId = "";
const routes = new Map<string, string>();
let seq = 0;

const local = (day: string, clock: string) => raw.unsafe(`('${day} ${clock}'::timestamp at time zone '${ZONE}')`);

/** A stop at nine on `day`, on a route, and how it was called off, if it was. */
async function stop(day: string, route: string, calledOff?: { by: "customer" | "company"; askedHoursBefore: number }, at = "09:00") {
  seq += 1;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, ${typeId}, 'scheduled', ${`Stop ${seq}`}) returning id`;
  await raw`
    insert into public.visit (organization_id, job_id, status, window_start, window_end, route_id,
                              cancelled_by, cancelled_at, cancel_notice_hours)
    values (${ORG}, ${job!.id}, ${calledOff ? "cancelled" : "scheduled"}::visit_status,
            ${local(day, at)}, ${local(day, "23:00")}, ${routes.get(route)!},
            ${calledOff?.by ?? null}::visit_cancelled_by,
            ${calledOff ? raw.unsafe(`(('${day} ${at}'::timestamp at time zone '${ZONE}') - interval '${calledOff.askedHoursBefore} hours')`) : null},
            ${calledOff ? 24 : null})`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Series Cleaning Co", slug: "kpi-series-co" });
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
    values (${ORG}, 'Recurring clean', 'ks-recurring', 'route', 'recurring') returning id`;
  typeId = type!.id;
  for (const name of ["North", "South", "East"]) {
    const [route] = await raw<{ id: string }[]>`
      insert into public.route (organization_id, name, day_of_week) values (${ORG}, ${name}, 3) returning id`;
    routes.set(name, route!.id);
  }

  /**
   * By hand. "Late" is the customer calling it off with less than the 24 hours
   * frozen on the stop; "in time" is more than that.
   *
   *   May   North  2 stops on the 4th, one late                  1 of 2
   *         South  1 stop on the 6th, kept                       0 of 1
   *   June  North  3 on the 1st (one late), 2 on the 3rd (one late, one in time)   2 of 5
   *         South  2 on the 3rd, kept                            0 of 2
   *         East   1 on the 3rd, the company called it off       none, one beside
   *   July  North  1 on the 6th, kept                            0 of 1
   *   Aug   nothing
   *
   *   A stop at 11pm on May 31 is May's; one at half past midnight on June 1 is June's.
   */
  await stop("2026-05-04", "North");
  await stop("2026-05-04", "North", { by: "customer", askedHoursBefore: 2 });
  await stop("2026-05-06", "South");
  await stop("2026-06-01", "North");
  await stop("2026-06-01", "North");
  await stop("2026-06-01", "North", { by: "customer", askedHoursBefore: 2 });
  await stop("2026-06-03", "North", { by: "customer", askedHoursBefore: 3 });
  await stop("2026-06-03", "North", { by: "customer", askedHoursBefore: 30 });
  await stop("2026-06-03", "South");
  await stop("2026-06-03", "South");
  await stop("2026-06-03", "East", { by: "company", askedHoursBefore: 40 });
  await stop("2026-07-06", "North");
});

afterAll(async () => { if (raw) await raw.end(); });

const cell = (month: kpis.KpiSeriesMonth, value: string) => month.groups.find((g) => g.value === value);
const north = () => `route:${routes.get("North")}`;
const south = () => `route:${routes.get("South")}`;
const east = () => `route:${routes.get("East")}`;

run("the cancellation rate month by month", () => {
  it("says on the scorecard which figures can be shown by month", async () => {
    const card = await kpis.scorecard(owner(), { from: "2026-06-01", to: "2026-06-30" });
    const figure = card.computed.find((k) => k.key === "cancel_rate_route")!;
    expect(figure.monthly).toBe(true);
    expect(card.computed.filter((k) => k.key !== "cancel_rate_route").every((k) => !k.monthly)).toBe(true);
  });

  it("gives every month from the window's first to its last, by route, worked out by hand", async () => {
    const series = await kpis.series(owner(), { key: "cancel_rate_route", by: "route", ...WINDOW });
    expect(series.by).toEqual({ key: "route", label: "Route" });
    expect(series.months.map((m) => [m.month, m.from, m.to, m.partial])).toEqual([
      ["2026-05", "2026-05-01", "2026-05-31", false],
      ["2026-06", "2026-06-01", "2026-06-30", false],
      ["2026-07", "2026-07-01", "2026-07-31", false],
      ["2026-08", "2026-08-01", "2026-08-15", true],
    ]);
    expect(series.groups.map((g) => g.label)).toEqual(["East", "North", "South"]);

    const [may, june, july, august] = series.months;
    expect([cell(may!, north())!.numerator, cell(may!, north())!.denominator, cell(may!, north())!.figure]).toEqual(["1", "2", "50.0"]);
    expect([cell(may!, south())!.numerator, cell(may!, south())!.denominator, cell(may!, south())!.figure]).toEqual(["0", "1", "0.0"]);
    expect(cell(may!, east())).toBeUndefined();
    expect([may!.total.numerator, may!.total.denominator, may!.total.figure]).toEqual(["1", "3", "33.3"]);

    expect([cell(june!, north())!.numerator, cell(june!, north())!.denominator, cell(june!, north())!.figure]).toEqual(["2", "5", "40.0"]);
    expect([cell(june!, south())!.numerator, cell(june!, south())!.denominator]).toEqual(["0", "2"]);
    // The company's own call is out of both halves, counted beside, so the route has no figure that month.
    expect(cell(june!, east())).toMatchObject({ numerator: "0", denominator: "0", figure: null });
    expect(cell(june!, east())!.besides).toEqual([{ key: "excluded", count: "1" }, { key: "unknown", count: "0" }]);
    expect([june!.total.numerator, june!.total.denominator, june!.total.figure]).toEqual(["2", "7", "28.6"]);

    expect([cell(july!, north())!.numerator, cell(july!, north())!.denominator]).toEqual(["0", "1"]);
    // A month with nothing in it is still a month, with no figure rather than nought.
    expect(august!.groups).toEqual([]);
    expect(august!.total).toMatchObject({ numerator: "0", denominator: "0", figure: null });
  });

  it("adds up to the breakdown and to the scorecard over the whole window", async () => {
    const series = await kpis.series(owner(), { key: "cancel_rate_route", by: "route", ...WINDOW });
    const breakdown = await kpis.breakdown(owner(), { key: "cancel_rate_route", by: "route", ...WINDOW });
    expect(series.all.map((g) => [g.value, g.numerator, g.denominator, g.figure]))
      .toEqual(breakdown.groups.map((g) => [g.value, g.numerator, g.denominator, g.figure]));
    const card = (await kpis.scorecard(owner(), WINDOW)).computed.find((k) => k.key === "cancel_rate_route")!;
    const top = series.months.reduce((n, m) => n + Number(m.total.numerator), 0);
    const bottom = series.months.reduce((n, m) => n + Number(m.total.denominator), 0);
    expect([String(top), String(bottom)]).toEqual([card.numerator, card.denominator]);
  });

  it("says a month the window cuts short is part of one, and counts only its days", async () => {
    const series = await kpis.series(owner(), { key: "cancel_rate_route", by: "route", from: "2026-05-05", to: "2026-06-02" });
    expect(series.months.map((m) => [m.month, m.from, m.to, m.partial])).toEqual([
      ["2026-05", "2026-05-05", "2026-05-31", true],
      ["2026-06", "2026-06-01", "2026-06-02", true],
    ]);
    // The two stops on the 4th are before the window; the 6th is in it.
    const [may, june] = series.months;
    expect([may!.total.numerator, may!.total.denominator]).toEqual(["0", "1"]);
    // Only June 1st: three North stops, one late.
    expect([june!.total.numerator, june!.total.denominator]).toEqual(["1", "3"]);
  });

  it("keeps a stop in the month of its day in the company's calendar, not UTC", async () => {
    // 11pm in Chicago on May 31 is June 1 in UTC. It is May's stop.
    await stop("2026-05-31", "South", undefined, "23:00");
    try {
      const series = await kpis.series(owner(), { key: "cancel_rate_route", by: "route", from: "2026-05-01", to: "2026-06-30" });
      const [may, june] = series.months;
      expect(cell(may!, south())).toMatchObject({ numerator: "0", denominator: "2" });
      expect(cell(june!, south())).toMatchObject({ numerator: "0", denominator: "2" });
    } finally {
      await raw`delete from public.visit where organization_id = ${ORG} and window_start = ${local("2026-05-31", "23:00")}`;
    }
  });

  it("opens a route's month onto that month's own stops", async () => {
    const series = await kpis.series(owner(), { key: "cancel_rate_route", by: "route", ...WINDOW });
    const june = series.months[1]!;
    const records = await kpis.drill(owner(), {
      key: "cancel_rate_route", half: "denominator", from: june.from, to: june.to, by: "route", group: north(),
    });
    expect(records.count).toBe(Number(cell(june, north())!.denominator));
    expect(records.records.every((r) => r.label.includes("North") && (r.onDay ?? "").startsWith("2026-06"))).toBe(true);
  });

  it("is by weekday too, since every stop names its weekday", async () => {
    const series = await kpis.series(owner(), { key: "cancel_rate_route", by: "weekday", from: "2026-06-01", to: "2026-06-30" });
    expect(series.groups.map((g) => g.label)).toEqual(["Monday", "Wednesday"]);
    expect(series.months).toHaveLength(1);
    const [june] = series.months;
    expect(june!.groups.map((g) => [g.value, g.numerator, g.denominator])).toEqual([["1", "1", "3"], ["3", "1", "4"]]);
  });
});

run("what a series refuses", () => {
  it("refuses a figure that is not shown by month, in words, and a grouping it does not carry", async () => {
    await expect(kpis.series(owner(), { key: "cancel_rate_route", by: "customer", ...WINDOW }))
      .rejects.toThrow("This figure can be broken down by route or weekday, not by \"customer\".");
    await raw`update public.organization set primary_trade = 'hvac' where id = ${ORG}`;
    try {
      const pack = packs.find((p) => p.id === "hvac")!;
      const other = pack.kpis.find((k) => CATALOGUE[k.key]?.state === "computed" && !(CATALOGUE[k.key] as { measure: { monthly?: boolean } }).measure.monthly);
      if (other) {
        await expect(kpis.series(owner(), { key: other.key, by: "route", ...WINDOW })).rejects.toBeInstanceOf(ConflictError);
        await expect(kpis.series(owner(), { key: other.key, by: "route", ...WINDOW })).rejects.toThrow(/not shown month by month/);
      }
    } finally {
      await raw`update public.organization set primary_trade = 'cleaning' where id = ${ORG}`;
    }
  });

  it("is refused to a reader whose scope is narrower than the company, and when the window is backwards or too long", async () => {
    await expect(kpis.series(as("technician", ["report:read"]), { key: "cancel_rate_route", by: "route", ...WINDOW }))
      .rejects.toThrow(/whole company's/);
    await expect(kpis.series(owner(), { key: "cancel_rate_route", by: "route", from: "2026-06-30", to: "2026-06-01" }))
      .rejects.toThrow("The end of the window is before its start.");
    await expect(kpis.series(owner(), { key: "cancel_rate_route", by: "route", from: "2020-01-01", to: "2026-01-31" }))
      .rejects.toThrow(/up to 60 months/);
    // Sixty months exactly is allowed.
    const sixty = await kpis.series(owner(), { key: "cancel_rate_route", by: "route", from: "2021-08-01", to: "2026-07-31" });
    expect(sixty.months).toHaveLength(60);
  });

  it("is a read with the same permission as the breakdown, and is audited", async () => {
    expect(contracts.getKpiSeries.permissions).toEqual(contracts.getKpiBreakdown.permissions);
    await kpis.series(owner(), { key: "cancel_rate_route", by: "route", ...WINDOW });
    const [audited] = await raw`select count(*)::int as n from public.audit_log where organization_id = ${ORG} and action = 'kpi.series'`;
    expect(audited!.n).toBeGreaterThan(0);
  });
});

run("every figure that declares itself monthly names the day on every record", () => {
  /**
   * The guard on the catalogue: `monthly` is declared only where every records
   * query of every half names `on_day` as a calendar day. Run each series under
   * a trade that declares the figure; a query without it is a database error
   * here rather than on somebody's scorecard, and a day that is not a day of
   * the window's months would be caught as a total that does not add up.
   */
  it("runs each declared series and adds up to the scorecard", async () => {
    const declared = Object.entries(CATALOGUE).flatMap(([key, entry]) =>
      entry.state === "computed" && entry.measure.monthly ? (entry.measure.groupings ?? []).map((g) => ({ key, by: g.key })) : []);
    expect(declared.map((d) => `${d.key}:${d.by}`).sort()).toEqual(["cancel_rate_route:route", "cancel_rate_route:weekday"]);
    for (const { key, by } of declared) {
      const pack = packs.find((p) => p.kpis.some((k) => k.key === key))!;
      await raw`update public.organization set primary_trade = ${pack.id} where id = ${ORG}`;
      try {
        const series = await kpis.series(owner(), { key, by, ...WINDOW });
        const card = (await kpis.scorecard(owner(), WINDOW)).computed.find((k) => k.key === key)!;
        const top = series.months.reduce((n, m) => n + Number(m.total.numerator), 0);
        const bottom = series.months.reduce((n, m) => n + Number(m.total.denominator), 0);
        expect([String(top), String(bottom)], `${key} by ${by}`).toEqual([card.numerator, card.denominator]);
      } finally {
        await raw`update public.organization set primary_trade = 'cleaning' where id = ${ORG}`;
      }
    }
  });
});
