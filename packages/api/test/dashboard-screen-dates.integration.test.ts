import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { inflateSync } from "node:zlib";
import { pdf, reporting, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as dashboards from "../src/services/dashboards";
import * as reports from "../src/services/reports";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * M21. DATES CHOSEN ON A DASHBOARD'S OWN SCREEN, AND ITS PDF WITH THEM
 *
 * Somebody looking at a dashboard chooses the days it covers: one of the five
 * a schedule offers, or two dates of their own, both kept. The tiles that
 * follow dates are drawn over them and the rest keep their own, as a
 * schedule's delivery does, and "Download as PDF" prints the same days.
 * Dates the wrong way round, half a range, or a period that is not one are
 * refused in words.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("dscreen:org");
const OWNER = fixtureId("dscreen:owner");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (role: string): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db() });
const owner = () => as("owner");
const inflate = (bytes: Uint8Array) => new Uint8Array(inflateSync(bytes));

let boardId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Screen Dates Co", slug: "dashboard-screen-dates-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const customer = await customers.create(owner(), {
    type: "residential", name: "Dee Dates", phone: "+15125550179",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: "4 Range Rd", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id as string, customerRole: "owner",
  });
  for (const summary of ["Tune up", "No heat"]) {
    await jobs.create(owner(), {
      customerId: customer.id as string, propertyId: property.id as string, summary, tags: [], customFields: {},
    });
  }
  const report = await reports.save(owner(), { name: "Jobs", definition: { dataset: "jobs", dimensions: [], measures: ["count"] } });
  const board = await dashboards.create(owner(), { name: "Screen board" });
  boardId = board.id;
  await dashboards.setTiles(owner(), {
    id: boardId,
    tiles: [
      { key: "booked", title: "Jobs booked", kind: "number", width: 3, reportId: report.id, followsDates: true },
      { key: "standing", title: "Jobs on the books", kind: "number", width: 3, reportId: report.id },
    ],
  });
});

afterAll(async () => { if (raw) await raw.end(); });

const figure = (tile: dashboards.TileResult) => Number(tile.result?.rows[0]?.["count"]);

run("dates chosen on a dashboard's screen", () => {
  it("are one of a schedule's periods, worked out on the company's day", async () => {
    const chosen = await dashboards.chosenDates(owner(), { period: "last_7_days" });
    const expected = reporting.periodFor("last_7_days", new Date(), ZONE);
    expect(chosen).toEqual({ from: expected.from, to: expected.to, label: expected.label });
    expect(chosen!.to).toBe(companyToday(0, ZONE));
    expect(await dashboards.chosenDates(owner(), {})).toBeUndefined();
    expect(await dashboards.chosenDates(owner(), { period: "now" })).toBeUndefined();
  });

  it("are two dates of somebody's own, both kept", async () => {
    expect(await dashboards.chosenDates(owner(), { from: "2026-09-01", to: "2026-09-30" }))
      .toEqual({ from: "2026-09-01", to: "2026-10-01", label: "Sep 1, 2026 to Sep 30, 2026" });
    expect(await dashboards.chosenDates(owner(), { from: "2026-09-01", to: "2026-09-01" }))
      .toEqual({ from: "2026-09-01", to: "2026-09-02", label: "Sep 1, 2026" });
  });

  it("are refused the wrong way round, half given, or not a period", async () => {
    await expect(dashboards.chosenDates(owner(), { from: "2026-09-30", to: "2026-09-01" }))
      .rejects.toThrow("The last day, Sep 1, 2026, is before the first, Sep 30, 2026. Swap them.");
    await expect(dashboards.chosenDates(owner(), { from: "2026-09-01" }))
      .rejects.toThrow("Give the first day and the last day, or choose one of the periods.");
    await expect(dashboards.chosenDates(owner(), { period: "fortnight" }))
      .rejects.toThrow("Choose one of the periods offered.");
    await expect(dashboards.chosenDates(owner(), { from: "2026-02-30", to: "2026-03-02" }))
      .rejects.toThrow("Give the days as dates.");
    await expect(dashboards.chosenDates(owner(), { from: "2026-02-32", to: "2026-03-02" }))
      .rejects.toThrow("Give the days as dates.");
  });

  it("cut the tiles that follow dates on the screen, and are printed on its PDF", async () => {
    const dates = (await dashboards.chosenDates(owner(), { from: "2000-01-01", to: "2000-01-31" }))!;
    const drawn = await dashboards.getSaved(owner(), { id: boardId }, { dates });
    expect(drawn.tiles.map(figure)).toEqual([0, 2]);

    const file = await dashboards.dashboardPdf(owner(), { dashboardId: boardId }, { dates });
    const read = pdf.inspectPdf(file.bytes, inflate);
    expect(read.text).toContain("Jan 1, 2000 to Jan 31, 2000");
    expect(read.text).toContain("Not cut to these dates");
    expect(read.text).toContain("Jobs on the books");

    const plain = pdf.inspectPdf((await dashboards.dashboardPdf(owner(), { dashboardId: boardId })).bytes, inflate);
    expect(plain.text).not.toContain("Jan 1, 2000");
  });

  it("are for somebody who may read reports", async () => {
    await expect(dashboards.chosenDates(as("technician"), { period: "yesterday" })).rejects.toThrow();
    await expect(dashboards.dashboardPdf(as("technician"), { dashboardId: boardId })).rejects.toThrow();
  });
});
