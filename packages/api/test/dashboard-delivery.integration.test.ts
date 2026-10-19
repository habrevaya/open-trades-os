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
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A WHOLE DASHBOARD, PRINTED AND EMAILED
 *
 * A dashboard is a page of reports, so printing one and emailing one are the
 * report's promises applied to every tile at once: each tile is drawn as the
 * reader would see it on the screen, a tile they may not see is left out of
 * their copy and NAMED rather than silently missing, and a schedule sending
 * one goes once per occurrence, as the person who set it up, only to people
 * who could open it, through the same outbox and the same do-not-email list.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("ddel:org");
const OWNER = fixtureId("ddel:owner");
const DISPATCH = fixtureId("ddel:dispatcher");
const TECH = fixtureId("ddel:tech");
const ACCOUNTANT = "books@dashboard-accountant.test";
const UNSUBSCRIBED = "gone@dashboard-accountant.test";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: Actor["roles"]): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);
const dispatcher = () => as(DISPATCH, ["dispatcher"]);
const inflate = (bytes: Uint8Array) => new Uint8Array(inflateSync(bytes));

async function member(userId: string, address: string, name: string, role: string) {
  await raw`delete from public."user" where id = ${userId} or email = ${address}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${address}, ${name})`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, ${role}::member_role)`;
}

const messagesTo = (address: string) => raw<{ id: string; subject: string; body: string }[]>`
  select id, subject, body from public.message
  where organization_id = ${ORG} and to_address = ${address} and direction = 'outbound'
  order by created_at`;

const attachmentsOf = (messageId: string) => raw<{ file_name: string; content_type: string; content: Buffer }[]>`
  select file_name, content_type, content from public.message_attachment where message_id = ${messageId}
  order by file_name`;

/** A Monday at seven in the morning in Chicago. */
const MONDAY = new Date("2026-09-14T12:00:00Z");

/** A saved dashboard with a tile everybody here may see and one only the owner may. */
let savedId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Dashboard Mail Co", slug: "dashboard-mail-co" });
  await raw`update public."user" set name = 'Olive Owner' where id = ${OWNER}`;
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await member(DISPATCH, "dispatch@dashboard-mail.test", "Dee Dispatch", "dispatcher");
  // A technician who may not read reports at all.
  await member(TECH, "tech@dashboard-mail.test", "Tia Tech", "technician");
  await raw`
    insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@dashboard-mail.test" })})`;
  await raw`insert into public.suppression (organization_id, address, channel, reason)
            values (${ORG}, ${UNSUBSCRIBED}, 'email', 'unsubscribed')`;

  const customer = await customers.create(owner(), {
    type: "residential", name: "Cora Client", phone: "+15125550177",
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

  const board = await dashboards.create(owner(), { name: "Monday board" });
  savedId = board.id;
  await dashboards.setTiles(owner(), {
    id: savedId,
    tiles: [
      { key: "status", kind: "bars", width: 6, builtIn: "jobs-by-status" },
      { key: "aging", kind: "bars", width: 6, builtIn: "ar-aging" },
    ],
  });
});

afterAll(async () => { if (raw) await raw.end(); });

run("a dashboard as one PDF", () => {
  it("prints every tile the reader may see, as the screen draws them", async () => {
    const file = await dashboards.dashboardPdf(owner(), { builtInDashboard: "operations" });
    expect(file.filename).toMatch(/^operations-\d{4}-\d{2}-\d{2}\.pdf$/);
    const read = pdf.inspectPdf(file.bytes, inflate);
    expect(read.problems).toEqual([]);
    expect(read.title).toMatch(/^Operations, /);
    for (const words of ["Dashboard Mail Co", "Open jobs", "Open tasks", "Jobs by status", "Open jobs by type", "Olive Owner"]) {
      expect(read.text).toContain(words);
    }
    // The three jobs are leads, and the open jobs tile counts them.
    expect(read.text).toContain("Lead");
    expect(read.pages.flat()).toContain("3");
    expect(read.text).not.toContain("Not on this copy");
  });

  it("names a tile the reader may not see, and draws nothing of it", async () => {
    const theirs = pdf.inspectPdf((await dashboards.dashboardPdf(dispatcher(), { dashboardId: savedId })).bytes, inflate);
    expect(theirs.problems).toEqual([]);
    expect(theirs.text).toContain("Jobs by status");
    expect(theirs.text).toContain("Not on this copy");
    expect(theirs.text).toContain("Dee Dispatch may not see it: Receivables by age.");
    // Nothing of the receivables tile: no aging bucket, no balance column.
    expect(theirs.text).not.toContain("Current");
    expect(theirs.text).not.toContain("Balance");

    const mine = pdf.inspectPdf((await dashboards.dashboardPdf(owner(), { dashboardId: savedId })).bytes, inflate);
    expect(mine.text).toContain("Receivables by age");
    expect(mine.text).not.toContain("Not on this copy");
  });

  it("is missing, not forbidden, to somebody who may see none of it, and refused without reports", async () => {
    // The money dashboard is every tile behind the financial permission.
    await expect(dashboards.dashboardPdf(dispatcher(), { builtInDashboard: "money" })).rejects.toThrow(NotFoundError);
    await expect(dashboards.dashboardPdf(owner(), { dashboardId: "not-a-dashboard" })).rejects.toThrow(NotFoundError);
    await expect(dashboards.dashboardPdf(as(TECH, ["technician"]), { builtInDashboard: "operations" }))
      .rejects.toThrow(/report:read/);
  });
});

run("a dashboard on a schedule", () => {
  let scheduleId = "";

  it("refuses dates on a dashboard, which is sent as it stands", async () => {
    await expect(schedules.createReportSchedule(owner(), {
      dashboard: "operations", frequency: "weekly", weekdays: [1], time: "07:00", period: "last_7_days",
      userIds: [OWNER],
    })).rejects.toThrow(/does not take dates of its own/);
  });

  it("refuses two things at once, and somebody who could not open the dashboard", async () => {
    await expect(schedules.createReportSchedule(owner(), {
      builtIn: "jobs-by-status", dashboard: "operations", frequency: "daily", time: "07:00", userIds: [OWNER],
    })).rejects.toThrow(ConflictError);
    await expect(schedules.createReportSchedule(owner(), {
      dashboard: "money", frequency: "daily", time: "07:00", userIds: [DISPATCH],
    })).rejects.toThrow("Dee Dispatch may not see anything on this dashboard, so it cannot be sent to them.");
    await expect(schedules.createReportSchedule(owner(), {
      dashboard: "operations", frequency: "daily", time: "07:00", userIds: [TECH],
    })).rejects.toThrow("Tia Tech may not read reports, so it cannot be sent to them.");
    await expect(schedules.createReportSchedule(dispatcher(), {
      dashboard: "money", frequency: "daily", time: "07:00", userIds: [DISPATCH],
    })).rejects.toThrow();
  });

  it("is stored as a pointer to the dashboard, with no dates", async () => {
    const created = await schedules.createReportSchedule(owner(), {
      dashboardId: savedId, frequency: "weekly", weekdays: [1], time: "07:00",
      userIds: [OWNER, DISPATCH], addresses: [ACCOUNTANT, UNSUBSCRIBED],
    });
    scheduleId = created.id;
    expect(created).toMatchObject({
      name: "Monday board", dashboardId: savedId, builtInDashboard: null, builtInReport: null, reportId: null, period: "all",
    });
    const listed = (await schedules.listReportSchedules(owner())).find((s) => s.id === scheduleId)!;
    expect(listed).toMatchObject({ dashboardId: savedId, dashboard: null, reportPath: `/dashboards/saved/${savedId}` });
  });

  it("emails each person their own copy as one PDF, once, and not to an address that asked to stop", async () => {
    await raw`update public.delivery_schedule set next_run_at = ${MONDAY} where id = ${scheduleId}`;
    const tick = await schedules.deliverOne(db(), ORG, scheduleId, new Date());
    expect(tick).toMatchObject({ action: "delivered", queued: true, report: { status: "partly_queued" } });

    const deliveries = await raw<{
      status: string; idempotency_key: string; dashboard_id: string | null; report_name: string;
      recipients: { address: string; messageId?: string; refused?: string }[];
    }[]>`select status, idempotency_key, dashboard_id, report_name, recipients from public.report_delivery
         where schedule_id = ${scheduleId} order by created_at`;
    expect(deliveries).toHaveLength(1);
    const [delivery] = deliveries;
    expect(delivery!).toMatchObject({
      status: "partly_queued", idempotency_key: `schedule:${scheduleId}:2026-09-14`,
      dashboard_id: savedId, report_name: "Monday board",
    });
    const unsubscribed = delivery!.recipients.find((r) => r.address === UNSUBSCRIBED)!;
    expect(unsubscribed.messageId).toBeUndefined();
    expect(unsubscribed.refused).toMatch(/do-not-email/);

    // The owner's copy has every tile.
    const [toOwner] = await messagesTo("dashboard-mail-co@test.local");
    expect(toOwner!.subject).toMatch(/^Monday board: [A-Z][a-z]+ \d{1,2}, \d{4}$/);
    expect(toOwner!.body).toContain("Every tile is in the attached file");
    const ownerFiles = await attachmentsOf(toOwner!.id);
    expect(ownerFiles).toHaveLength(1);
    expect(ownerFiles[0]!.file_name).toMatch(/^monday-board-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(ownerFiles[0]!.content_type).toBe("application/pdf");
    const ownerCopy = pdf.inspectPdf(new Uint8Array(ownerFiles[0]!.content), inflate);
    expect(ownerCopy.problems).toEqual([]);
    expect(ownerCopy.text).toContain("Receivables by age");
    expect(ownerCopy.text).not.toContain("Not on this copy");

    // The dispatcher's is drawn as them: the money tile named, not drawn.
    const [toDispatch] = await messagesTo("dispatch@dashboard-mail.test");
    expect(toDispatch!.body).toContain("Left out of your copy because you may not see it: Receivables by age.");
    const dispatchCopy = pdf.inspectPdf(new Uint8Array((await attachmentsOf(toDispatch!.id))[0]!.content), inflate);
    expect(dispatchCopy.text).toContain("Dee Dispatch may not see it: Receivables by age.");
    expect(dispatchCopy.text).toContain("Jobs by status");

    // The accountant gets the owner's copy, and no link into an app they cannot sign in to.
    const [toAccountant] = await messagesTo(ACCOUNTANT);
    expect(toAccountant!.body).not.toContain("http");
    const accountantCopy = pdf.inspectPdf(new Uint8Array((await attachmentsOf(toAccountant!.id))[0]!.content), inflate);
    expect(accountantCopy.text).toContain("Olive Owner");
    expect(accountantCopy.text).toContain("Receivables by age");

    // The same occurrence again sends nothing.
    await raw`update public.delivery_schedule set next_run_at = ${MONDAY} where id = ${scheduleId}`;
    await schedules.deliverOne(db(), ORG, scheduleId, new Date());
    expect(await messagesTo(ACCOUNTANT)).toHaveLength(1);
  });

  it("sends now as the person pressing it, through the same delivery", async () => {
    const sent = await schedules.sendReportScheduleNow({ ...owner(), idempotencyKey: "ddel-send-now-1" }, { id: scheduleId });
    expect(sent.status).toBe("partly_queued");
    expect(sent.recipients.filter((r) => r.messageId)).toHaveLength(3);
    expect(await messagesTo(ACCOUNTANT)).toHaveLength(2);
  });

  it("says so when the dashboard it sends has been deleted", async () => {
    const doomed = await dashboards.create(owner(), { name: "Short lived board" });
    await dashboards.setTiles(owner(), { id: doomed.id, tiles: [{ key: "s", kind: "bars", width: 6, builtIn: "jobs-by-status" }] });
    const created = await schedules.createReportSchedule(owner(), {
      dashboardId: doomed.id, frequency: "daily", time: "07:00", userIds: [OWNER],
    });
    await dashboards.remove(owner(), { id: doomed.id });
    await raw`update public.delivery_schedule set next_run_at = ${MONDAY} where id = ${created.id}`;
    const tick = await schedules.deliverOne(db(), ORG, created.id, new Date());
    expect(tick.report).toMatchObject({ status: "failed", error: "The dashboard this sends has been deleted, so there was nothing to send." });
    await expect(schedules.sendReportScheduleNow(owner(), { id: created.id })).rejects.toThrow(/has been deleted/);
  });

  it("changed to send a report instead, it forgets the dashboard", async () => {
    const changed = await schedules.updateReportSchedule(owner(), {
      id: scheduleId, builtIn: "jobs-by-status", frequency: "weekly", weekdays: [1], time: "07:00", period: "all",
      userIds: [OWNER],
    });
    expect(changed).toMatchObject({ builtInReport: "jobs-by-status", dashboardId: null, builtInDashboard: null });
  });
});

run("a tile cut by the grouping somebody picks", () => {
  it("draws along one of its report's groupings and cuts by the other, and refuses one it does not have", async () => {
    const report = await reports.save(owner(), {
      name: "Jobs by status and type",
      definition: { dataset: "jobs", dimensions: ["status", "job_type"], measures: ["count"] },
    });
    const board = await dashboards.create(owner(), { name: "Cut board" });
    const tiles: dashboards.StoredTile[] = [
      { key: "by-type", kind: "bars", width: 6, reportId: report.id, breakdown: "stacked" },
      { key: "by-status", kind: "bars", width: 6, reportId: report.id, breakdown: "stacked", splitBy: "status" },
    ];
    await dashboards.setTiles(owner(), { id: board.id, tiles });

    const drawn = await dashboards.getSaved(owner(), { id: board.id });
    const [asSaved, turned] = drawn.tiles;
    expect([asSaved!.dimension?.key, asSaved!.breakdown?.key]).toEqual(["status", "job_type"]);
    expect([turned!.dimension?.key, turned!.breakdown?.key]).toEqual(["job_type", "status"]);
    expect(turned!.cuts).toEqual([{ key: "status", label: "Status" }, { key: "job_type", label: "Job type" }]);
    expect(turned!.problem).toBeUndefined();

    // Printed the same way: the legend is the statuses, the bars the job types.
    const printed = dashboards.printedTile(turned!);
    expect(printed.chart?.dimension.key).toBe("job_type");
    expect(printed.chart?.split?.dimension.key).toBe("status");

    await expect(dashboards.setTiles(owner(), {
      id: board.id, tiles: [{ ...tiles[0]!, splitBy: "customer" }],
    })).rejects.toThrow("can be cut by status or by job type, the two things its report is grouped by, and not by \"customer\".");
    await expect(dashboards.setTiles(owner(), {
      id: board.id, tiles: [{ key: "plain", kind: "bars", width: 6, builtIn: "jobs-by-status", splitBy: "status" }],
    })).rejects.toThrow(/not broken down, so there is nothing to cut it by/);
  });
});
