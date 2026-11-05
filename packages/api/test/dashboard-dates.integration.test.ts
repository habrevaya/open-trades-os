import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { inflateSync } from "node:zlib";
import { pdf, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as dashboards from "../src/services/dashboards";
import * as schedules from "../src/services/delivery-schedules";
import * as reports from "../src/services/reports";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A DASHBOARD SENT WITH DATES OF ITS OWN
 *
 * Dates reach only the tiles that follow them. A tile about how things stand
 * keeps its report's own dates, and the page says which tiles those are, so a
 * figure that is not about the week is never read as if it were. A second
 * measure on a tile is held to the same rules as the report behind it.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("ddates:org");
const OWNER = fixtureId("ddates:owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const inflate = (bytes: Uint8Array) => new Uint8Array(inflateSync(bytes));

let boardId = "";
let reportId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Dates Board Co", slug: "dates-board-co" });
  await raw`update public."user" set name = 'Olive Owner' where id = ${OWNER}`;
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`
    insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@dates-board.test" })})`;

  const customer = await customers.create(owner(), {
    type: "residential", name: "Cora Client", phone: "+15125550178",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: "9 Tile Way", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id as string, customerRole: "owner",
  });
  for (const summary of ["Furnace check", "Leaky valve", "New thermostat"]) {
    await jobs.create(owner(), {
      customerId: customer.id as string, propertyId: property.id as string, summary, tags: [], customFields: {},
    });
  }
  const report = await reports.save(owner(), {
    name: "All jobs", definition: { dataset: "jobs", dimensions: [], measures: ["count"] },
  });
  reportId = report.id;
  const board = await dashboards.create(owner(), { name: "Week board" });
  boardId = board.id;
  await dashboards.setTiles(owner(), {
    id: boardId,
    tiles: [
      { key: "booked", title: "Jobs booked", kind: "number", width: 3, reportId, followsDates: true },
      { key: "standing", title: "Jobs on the books", kind: "number", width: 3, reportId },
    ],
  });
});

afterAll(async () => { if (raw) await raw.end(); });

const figure = (tile: dashboards.TileResult) => Number(tile.result?.rows[0]?.["count"]);

run("dates given to a dashboard", () => {
  it("cut the tiles that follow dates, leave the others as they are, and say which", async () => {
    const past = { from: "2000-01-01", to: "2000-02-01", label: "Jan 1, 2000 to Jan 31, 2000" };
    const drawn = await dashboards.drawDashboard(owner(), { dashboardId: boardId }, { dates: past });
    const [booked, standing] = drawn.tiles;
    expect(figure(booked!)).toBe(0);
    expect(figure(standing!)).toBe(3);
    expect(booked!.definition).toMatchObject({ from: "2000-01-01", to: "2000-02-01" });
    expect(standing!.definition?.from).toBeUndefined();
    expect(drawn.dates).toEqual(past);
    expect(drawn.keepsOwnDates).toEqual(["Jobs on the books"]);

    const today = await dashboards.drawDashboard(owner(), { dashboardId: boardId }, {
      dates: { from: "2000-01-01", to: "2999-01-01", label: "All of it" },
    });
    expect(figure(today.tiles[0]!)).toBe(3);

    const plain = await dashboards.drawDashboard(owner(), { dashboardId: boardId });
    expect(plain.dates).toBeNull();
    expect(plain.keepsOwnDates).toEqual([]);
    expect(figure(plain.tiles[0]!)).toBe(3);
  });

  it("replace the dates a report carries on a tile that follows them", async () => {
    const dated = await reports.save(owner(), {
      name: "Jobs from the past",
      definition: { dataset: "jobs", dimensions: [], measures: ["count"], from: "2000-01-01", to: "2000-02-01" },
    });
    const board = await dashboards.create(owner(), { name: "Own dates board" });
    await dashboards.setTiles(owner(), {
      id: board.id,
      tiles: [
        { key: "follows", title: "Follows", kind: "number", width: 3, reportId: dated.id, followsDates: true },
        { key: "own", title: "Own", kind: "number", width: 3, reportId: dated.id },
      ],
    });
    const drawn = await dashboards.drawDashboard(owner(), { dashboardId: board.id }, {
      dates: { from: "2000-01-01", to: "2999-01-01", label: "All of it" },
    });
    expect(figure(drawn.tiles[0]!)).toBe(3);
    expect(figure(drawn.tiles[1]!)).toBe(0);
  });
});

run("a schedule that gives a dashboard dates", () => {
  let scheduleId = "";

  it("is taken when a tile follows dates, and refused when none does", async () => {
    const created = await schedules.createReportSchedule(owner(), {
      dashboardId: boardId, frequency: "weekly", weekdays: [1], time: "07:00", period: "last_7_days", userIds: [OWNER],
    });
    scheduleId = created.id;
    expect(created.period).toBe("last_7_days");

    const bare = await dashboards.create(owner(), { name: "No followers board" });
    await dashboards.setTiles(owner(), { id: bare.id, tiles: [{ key: "t", title: "T", kind: "number", width: 3, reportId }] });
    await expect(schedules.createReportSchedule(owner(), {
      dashboardId: bare.id, frequency: "weekly", weekdays: [1], time: "07:00", period: "last_7_days", userIds: [OWNER],
    })).rejects.toThrow(/None of this dashboard's tiles follow dates/);
    // With no dates it is still taken, as before.
    await expect(schedules.createReportSchedule(owner(), {
      dashboardId: bare.id, frequency: "weekly", weekdays: [1], time: "07:00", userIds: [OWNER],
    })).resolves.toMatchObject({ period: "all" });
  });

  it("goes with the dates on the page and in the email, and writes them on the delivery", async () => {
    const sent = await schedules.sendReportScheduleNow({ ...owner(), idempotencyKey: "ddates-now-1" }, { id: scheduleId });
    expect(sent.status).toBe("queued");

    const [delivery] = await raw<{ period_from: string | null; period_to: string | null }[]>`
      select period_from::text, period_to::text from public.report_delivery where schedule_id = ${scheduleId}`;
    expect(delivery!.period_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(delivery!.period_to).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const [message] = await raw<{ id: string; subject: string; body: string }[]>`
      select id, subject, body from public.message
      where organization_id = ${ORG} and direction = 'outbound' order by created_at desc limit 1`;
    expect(message!.subject).toMatch(/^Week board: .* to /);
    expect(message!.body).toContain("Dates:");
    expect(message!.body).toContain("Jobs on the books");
    const [file] = await raw<{ content: Buffer }[]>`select content from public.message_attachment where message_id = ${message!.id}`;
    const read = pdf.inspectPdf(new Uint8Array(file!.content), inflate);
    expect(read.problems).toEqual([]);
    expect(read.text).toContain("Dates");
    expect(read.text).toContain("Not cut to these dates");
    expect(read.text).toContain("Jobs on the books");
  });

  it("fails on the day, in words, when the last tile that followed dates has stopped", async () => {
    await dashboards.setTiles(owner(), {
      id: boardId,
      tiles: [
        { key: "booked", title: "Jobs booked", kind: "number", width: 3, reportId },
        { key: "standing", title: "Jobs on the books", kind: "number", width: 3, reportId },
      ],
    });
    const sent = await schedules.sendReportScheduleNow({ ...owner(), idempotencyKey: "ddates-now-2" }, { id: scheduleId });
    expect(sent.status).toBe("failed");
    expect(sent.error).toMatch(/None of this dashboard's tiles follow dates/);
  });
});

run("a second measure on a saved tile", () => {
  it("is kept, offered as another measure to draw, and refused where it cannot be drawn", async () => {
    const board = await dashboards.create(owner(), { name: "Two measures board" });
    await dashboards.setTiles(owner(), {
      id: board.id,
      tiles: [{ key: "t", kind: "trend", width: 12, builtIn: "revenue-by-month", secondMeasure: "count" }],
    });
    const [tile] = (await dashboards.getSaved(owner(), { id: board.id })).tiles;
    expect(tile!.problem).toBeUndefined();
    expect(tile!.second).toMatchObject({ key: "count", label: "Invoices" });
    expect(tile!.alsoCanDraw?.map((m) => m.key)).toEqual(["count", "average"]);
    // With rows, as the PDF prints it: both measures in the table and a chart that carries the second.
    const withRows: dashboards.TileResult = {
      ...tile!,
      result: {
        columns: [], truncated: false,
        rows: [{ month: "2026-07", total: "100.00", count: 3 }, { month: "2026-08", total: "250.00", count: 5 }],
      },
    };
    const printed = dashboards.printedTile(withRows);
    expect(printed.table?.columns.map((c) => c.key)).toEqual(["month", "total", "count"]);
    expect(printed.chart?.secondary?.measure.key).toBe("count");
    expect(printed.chart?.secondary?.ownAxis).toBe(true);

    await expect(dashboards.setTiles(owner(), {
      id: board.id, tiles: [{ key: "t", kind: "trend", width: 12, builtIn: "revenue-by-month", secondMeasure: "balance" }],
    })).rejects.toThrow(/draws "balance" beside the first, which its report does not select/);
    await expect(dashboards.setTiles(owner(), {
      id: board.id, tiles: [{ key: "t", kind: "trend", width: 12, builtIn: "revenue-by-month", secondMeasure: "total" }],
    })).rejects.toThrow(/already draws "total"/);
    await expect(dashboards.setTiles(owner(), {
      id: board.id, tiles: [{ key: "t", kind: "number", width: 3, builtIn: "ar-aging", secondMeasure: "count" }],
    })).rejects.toThrow();
  });
});
