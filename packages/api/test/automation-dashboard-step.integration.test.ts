import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { inflateSync } from "node:zlib";
import { pdf, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as billing from "../src/services/billing";
import * as dashboards from "../src/services/dashboards";
import * as workflows from "../src/services/workflows";
import { readReportStep } from "../src/services/report-delivery";
import { drainOrganization } from "../src/services/workflow-worker";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, holdWholePassLock, WHOLE_PASS_WAIT_MS } from "./helpers";

/**
 * AN AUTOMATION THAT SENDS A WHOLE DASHBOARD
 *
 * "Run and email a report" can name a dashboard, and then it is a dashboard
 * schedule fired by an event instead of a clock: the same delivery, the same
 * checks at publish and again on the day, as the person who published it,
 * each person picked sent their own copy with the tiles they may not see
 * named, once per run, and never to a customer or over dates of its own.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("autodash:org");
const OWNER = fixtureId("autodash:owner");
const DISPATCH = fixtureId("autodash:dispatcher");
const TECH = fixtureId("autodash:tech");
const ACCOUNTANT = "books@autodash-accountant.test";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: Actor["roles"]): ServiceContext => ({ actor: { userId, organizationId: ORG, roles }, db: db() });
const owner = () => as(OWNER, ["owner"]);
const inflate = (bytes: Uint8Array) => new Uint8Array(inflateSync(bytes));

async function member(userId: string, address: string, name: string, role: string) {
  await raw`delete from public."user" where id = ${userId} or email = ${address}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${address}, ${name})`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, ${role}::member_role)`;
}

const messagesTo = (address: string) => raw<{ id: string; subject: string; body: string }[]>`
  select id, subject, body from public.message
  where organization_id = ${ORG} and to_address = ${address} and direction = 'outbound' order by created_at`;
const attachmentsOf = (messageId: string) => raw<{ file_name: string; content: Buffer }[]>`
  select file_name, content from public.message_attachment where message_id = ${messageId}`;

let savedId = "";
let customerId = "";
const step = (config: Record<string, unknown>) => ({
  name: `Board ${crypto.randomUUID().slice(0, 8)}`, triggerKind: "event" as const, triggerEvents: ["invoice.issued"],
  steps: [{ kind: "email_report", config }],
});

/** This file drains a company and asserts what it handled: see `holdWholePassLock`. */
let releaseWholePass: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (url) releaseWholePass = await holdWholePassLock(url);
}, WHOLE_PASS_WAIT_MS);
afterAll(async () => { await releaseWholePass?.(); });

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Automation Board Co", slug: "automation-board-co" });
  await raw`update public."user" set name = 'Olive Owner' where id = ${OWNER}`;
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await member(DISPATCH, "dispatch@autodash.test", "Dee Dispatch", "dispatcher");
  await member(TECH, "tech@autodash.test", "Tia Tech", "technician");
  await raw`
    insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@autodash.test" })})`;
  const customer = await customers.create(owner(), {
    type: "residential", name: "Cora Board", phone: "+15125550188",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id as string;
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

describe("the step's settings", () => {
  it("reads a dashboard that ships and a saved one, beside the two kinds of report", () => {
    expect(readReportStep({ report: "dashboard:operations" }).source).toEqual({ builtInDashboard: "operations" });
    expect(readReportStep({ report: "savedDashboard:abc" }).source).toEqual({ dashboardId: "abc" });
    expect(readReportStep({ report: "builtIn:ar-aging" }).source).toEqual({ builtIn: "ar-aging" });
    expect(readReportStep({ report: "saved:abc" }).source).toEqual({ reportId: "abc" });
    expect(readReportStep({ report: "elsewhere:abc" }).source).toBeNull();
  });
});

run("publishing one", () => {
  it("refuses a dashboard to a customer, with dates of its own, or to somebody who could not open it", async () => {
    await expect(workflows.create(owner(), step({ report: `savedDashboard:${savedId}`, to: "customer" })))
      .rejects.toThrow(/Step 1: A dashboard is the company's own, so it is never sent to a customer/);
    await expect(workflows.create(owner(), step({ report: "dashboard:operations", userIds: [OWNER], period: "last_7_days" })))
      .rejects.toThrow(/Step 1: .*does not take dates of its own/);
    await expect(workflows.create(owner(), step({ report: "dashboard:money", userIds: [DISPATCH] })))
      .rejects.toThrow("Step 1: Dee Dispatch may not see anything on this dashboard, so it cannot be sent to them.");
    await expect(workflows.create(owner(), step({ report: "dashboard:operations", userIds: [TECH] })))
      .rejects.toThrow("Step 1: Tia Tech may not read reports, so it cannot be sent to them.");
    await expect(workflows.create(owner(), step({ report: `savedDashboard:${crypto.randomUUID()}`, userIds: [OWNER] })))
      .rejects.toThrow(/Step 1: The dashboard this step emails does not exist/);
    await expect(workflows.create(owner(), step({ report: "dashboard:operations" })))
      .rejects.toThrow(/Step 1: Pick somebody to email the dashboard to/);
  });
});

run("running one", () => {
  it("sends each person their own copy as one PDF, through the dashboard delivery, once per run", async () => {
    const flow = await workflows.create(owner(), step({
      report: `savedDashboard:${savedId}`, userIds: [OWNER, DISPATCH], addresses: [ACCOUNTANT], period: "all",
    }));
    await workflows.setEnabled(owner(), { id: flow.id, enabled: true });
    await billing.create(owner(), {
      customerId, lines: [{ name: "Visit", quantity: "1", unitPrice: "95.00", discountAmount: "0", taxable: false }],
    });
    await drainOrganization(db(), ORG);
    await drainOrganization(db(), ORG);
    await workflows.setEnabled(owner(), { id: flow.id, enabled: false });

    const delivered = await raw<{
      status: string; workflow_run_id: string; idempotency_key: string; dashboard_id: string | null; report_name: string;
    }[]>`select status, workflow_run_id, idempotency_key, dashboard_id, report_name from public.report_delivery
         where organization_id = ${ORG} and workflow_run_id is not null`;
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!).toMatchObject({
      status: "queued", dashboard_id: savedId, report_name: "Monday board",
      idempotency_key: `run:${delivered[0]!.workflow_run_id}:0`,
    });
    const [ran] = await raw<{ status: string; output: { status: string; queued: number } }[]>`
      select status, output from public.workflow_step_run where run_id = ${delivered[0]!.workflow_run_id}`;
    expect(ran!).toMatchObject({ status: "succeeded", output: { status: "queued", queued: 3 } });

    // The dispatcher's copy is drawn as them: the money tile named, not drawn.
    const [toDispatch] = await messagesTo("dispatch@autodash.test");
    const [file] = await attachmentsOf(toDispatch!.id);
    expect(file!.file_name).toMatch(/^monday-board-\d{4}-\d{2}-\d{2}\.pdf$/);
    const theirs = pdf.inspectPdf(new Uint8Array(file!.content), inflate);
    expect(theirs.problems).toEqual([]);
    expect(theirs.text).toContain("Jobs by status");
    expect(theirs.text).toContain("Dee Dispatch may not see it: Receivables by age.");

    // The outside address is sent the copy of the person who published it.
    const [toBooks] = await messagesTo(ACCOUNTANT);
    const [booksFile] = await attachmentsOf(toBooks!.id);
    expect(pdf.inspectPdf(new Uint8Array(booksFile!.content), inflate).text).toContain("Receivables by age");
  });

  it("fails the step on the day when the publisher can no longer see it, and sends nothing", async () => {
    const flow = await workflows.create(owner(), step({ report: "dashboard:money", userIds: [OWNER] }));
    await workflows.setEnabled(owner(), { id: flow.id, enabled: true });
    /** The owner who published it is now a dispatcher, who sees nothing on the money dashboard. */
    await raw`update public.membership set role = 'dispatcher' where organization_id = ${ORG} and user_id = ${OWNER}`;
    try {
      const before = (await messagesTo("automation-board-co@test.local")).length;
      await billing.create(owner(), {
        customerId, lines: [{ name: "Visit", quantity: "1", unitPrice: "80.00", discountAmount: "0", taxable: false }],
      });
      await drainOrganization(db(), ORG);
      const [delivery] = await raw<{ status: string; error: string | null }[]>`
        select status, error from public.report_delivery
        where organization_id = ${ORG} and built_in_dashboard = 'money' and workflow_run_id is not null`;
      expect(delivery!.status).toBe("failed");
      expect(delivery!.error).toMatch(/may not see anything on this dashboard/);
      expect((await messagesTo("automation-board-co@test.local")).length).toBe(before);
    } finally {
      await raw`update public.membership set role = 'owner' where organization_id = ${ORG} and user_id = ${OWNER}`;
      await workflows.setEnabled(owner(), { id: flow.id, enabled: false });
    }
  });
});
