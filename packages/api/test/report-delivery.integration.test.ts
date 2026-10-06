import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { inflateSync } from "node:zlib";
import { pdf, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import * as email from "../src/services/email";
import * as workflows from "../src/services/workflows";
import * as schedules from "../src/services/delivery-schedules";
import { composeReportEmail } from "../src/services/report-delivery";
import { drainOrganization, runPass } from "../src/services/workflow-worker";
import type { EmailProvider, OutboundEmail } from "../src/email/provider";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * REPORTS THAT ARRIVE ON THEIR OWN
 *
 * Four promises, and each one is a failure an owner would find in their inbox
 * rather than on a screen:
 *
 *   ONCE. However the worker falls over, restarts or doubles up, a schedule's
 *   occurrence is delivered at most one time.
 *
 *   AS SOMEBODY. The report runs as the person who set it up, as they are on
 *   the day, and stops when they lose the right to see it.
 *
 *   TO PEOPLE WHO COULD SEE IT. A person picked as a recipient who could not
 *   open the report in the app does not get it in their inbox.
 *
 *   WRITTEN DOWN. Every attempt is a row, the ones that went to nobody too.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("rdel:org");
const USER = fixtureId("rdel:owner");
const DISPATCH = fixtureId("rdel:dispatcher");
const MANAGER = fixtureId("rdel:manager");
const TECH = fixtureId("rdel:tech");
const ACCOUNTANT = "books@accountant.test";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: Actor["roles"]): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles }, db: db(),
});
const owner = () => as(USER, ["owner"]);

function fakeProvider(): EmailProvider & { sent: OutboundEmail[] } {
  const sent: OutboundEmail[] = [];
  return {
    name: "fake",
    sent,
    delivery: { kind: "none", because: "A fake." },
    async send(message) {
      sent.push(message);
      return { ok: true, providerMessageId: `re_${sent.length}` };
    },
  };
}

async function member(userId: string, address: string, role: string) {
  await raw`delete from public."user" where id = ${userId} or email = ${address}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${address}, ${address.split("@")[0]!})`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, ${role}::member_role)`;
}

/** Put a schedule's next occurrence in the past, the way time passing would. */
async function due(id: string, at: Date) {
  await raw`update public.delivery_schedule set next_run_at = ${at} where id = ${id}`;
}

const deliveriesOf = (scheduleId: string) => raw<{
  id: string; status: string; error: string | null; idempotency_key: string;
  recipients: { address: string; userId?: string; messageId?: string; refused?: string }[];
  period_from: string | null; period_to: string | null; row_count: number | null;
}[]>`select id, status, error, idempotency_key, recipients, period_from::text, period_to::text, row_count
     from public.report_delivery where schedule_id = ${scheduleId} order by created_at`;

const messagesTo = (address: string) => raw<{ id: string; subject: string; body: string; body_html: string }[]>`
  select id, subject, body, body_html from public.message
  where organization_id = ${ORG} and to_address = ${address} and direction = 'outbound'
  order by created_at`;

/** A Monday at seven in the morning in Chicago, two weeks back. */
const MONDAY = new Date("2026-09-14T12:00:00Z");

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Delivery Co", slug: "delivery-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await member(DISPATCH, "dispatch@delivery.test", "dispatcher");
  await member(MANAGER, "manager@delivery.test", "admin");
  await member(TECH, "tech@delivery.test", "technician");
  // A technician may read reports here, about their own work.
  await raw`update public.membership set grants = '["report:read"]'::jsonb
            where organization_id = ${ORG} and user_id = ${TECH}`;
  await raw`insert into public.technician (organization_id, membership_id, display_name)
            select ${ORG}, id, 'Tia Tech' from public.membership
            where organization_id = ${ORG} and user_id = ${TECH}`;
  await raw`
    insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@delivery.test" })})`;

  const customer = await customers.create(owner(), {
    type: "residential", name: "Cora Client", phone: "+15125550141",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const property = await properties.create(owner(), {
    address: { line1: "3 Report Way", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id as string, customerRole: "owner",
  });
  for (const summary of ["Furnace check", "Leaky valve"]) {
    await jobs.create(owner(), {
      customerId: customer.id as string, propertyId: property.id as string, summary, tags: [], customFields: {},
    });
  }
});

afterAll(async () => { if (raw) await raw.end(); });

run("setting a report up to arrive", () => {
  it("refuses a weekly schedule with no day, and a monthly one on a day some months lack", async () => {
    await expect(schedules.createReportSchedule(owner(), {
      builtIn: "jobs-by-status", frequency: "weekly", weekdays: [], time: "07:00", userIds: [USER],
    })).rejects.toThrow(/day of the week/);
    await expect(schedules.createReportSchedule(owner(), {
      builtIn: "jobs-by-status", frequency: "monthly", dayOfMonth: 31, time: "07:00", userIds: [USER],
    })).rejects.toThrow(/1 to 28/);
  });

  it("refuses to send it to nobody", async () => {
    await expect(schedules.createReportSchedule(owner(), {
      builtIn: "jobs-by-status", frequency: "daily", time: "07:00",
    })).rejects.toThrow(/somebody to send it to/);
  });

  it("refuses a person who could not open the report themselves, by name", async () => {
    // The dispatcher may not read financial reports, so receivables in their
    // inbox would be the report builder's scope hole with a mail server on it.
    await expect(schedules.createReportSchedule(owner(), {
      builtIn: "ar-aging", frequency: "daily", time: "07:00", userIds: [DISPATCH],
    })).rejects.toThrow(/dispatch.*may not see this report/);
  });

  it("refuses an address that is not one", async () => {
    await expect(schedules.createReportSchedule(owner(), {
      builtIn: "jobs-by-status", frequency: "daily", time: "07:00", addresses: ["Dave the accountant"],
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses somebody who may not build reports", async () => {
    await expect(schedules.createReportSchedule(as(DISPATCH, ["dispatcher"]), {
      builtIn: "jobs-by-status", frequency: "daily", time: "07:00", userIds: [DISPATCH],
    })).rejects.toThrow();
  });

  it("plans the first one for the next occurrence in the company's timezone, not now", async () => {
    const created = await schedules.createReportSchedule(owner(), {
      builtIn: "jobs-by-status", frequency: "weekly", weekdays: [1], time: "07:00",
      userIds: [USER], addresses: [ACCOUNTANT],
    });
    const next = created.nextRunAt!;
    expect(next.getTime()).toBeGreaterThan(Date.now());
    const local = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago", weekday: "long", hour: "numeric", minute: "2-digit",
    }).format(next);
    expect(local).toBe("Monday 7:00 AM");
    expect(created.period).toBe("last_7_days");
    await schedules.removeReportSchedule(owner(), { id: created.id });
  });
});

run("a delivery", () => {
  let scheduleId = "";

  beforeAll(async () => {
    if (!url) return;
    const created = await schedules.createReportSchedule(owner(), {
      builtIn: "jobs-by-status", frequency: "weekly", weekdays: [1], time: "07:00", period: "all",
      userIds: [USER, DISPATCH], addresses: [ACCOUNTANT],
    });
    scheduleId = created.id;
  });

  it("does nothing before it is due", async () => {
    const tick = await schedules.deliverOne(db(), ORG, scheduleId, new Date());
    expect(tick).toMatchObject({ action: "skipped", reason: "not_due" });
    expect(await deliveriesOf(scheduleId)).toHaveLength(0);
  });

  it("goes to everybody it is for, with the report in the body, every row attached, and a PDF with its chart", async () => {
    await due(scheduleId, MONDAY);
    const tick = await schedules.deliverOne(db(), ORG, scheduleId, new Date());
    expect(tick).toMatchObject({ action: "delivered", queued: true, report: { status: "queued" } });

    const [delivery] = await deliveriesOf(scheduleId);
    expect(delivery!.status).toBe("queued");
    expect(delivery!.row_count).toBeGreaterThan(0);
    expect(delivery!.idempotency_key).toBe(`schedule:${scheduleId}:2026-09-14`);
    expect(delivery!.recipients.map((r) => r.address).sort())
      .toEqual([ACCOUNTANT, "delivery-co@test.local", "dispatch@delivery.test"].sort());
    expect(delivery!.recipients.every((r) => r.messageId)).toBe(true);

    const [toOwner] = await messagesTo("delivery-co@test.local");
    expect(toOwner!.subject).toBe("Jobs by status: Everything to date");
    expect(toOwner!.body).toContain("Dates: Everything to date.");
    expect(toOwner!.body).toContain("Status: Lead, Jobs: 2");
    expect(toOwner!.body).toContain("jobs-by-status.csv");

    expect(toOwner!.body).toContain("with its chart in jobs-by-status.pdf");

    const files = await raw<{ file_name: string; content_type: string; content: Buffer }[]>`
      select file_name, content_type, content from public.message_attachment where message_id = ${toOwner!.id}
      order by file_name`;
    expect(files.map((f) => f.file_name)).toEqual(["jobs-by-status.csv", "jobs-by-status.pdf"]);
    expect(files[0]!.content.toString("utf8")).toBe("Status,Jobs\r\nLead,2\r\n");

    /**
     * A PDF a reader can open, saying what the CSV says, with the chart: the
     * bar for the one status is labelled with its count, and the page says
     * whose run it is.
     */
    expect(files[1]!.content_type).toBe("application/pdf");
    const read = pdf.inspectPdf(new Uint8Array(files[1]!.content), (b) => new Uint8Array(inflateSync(b)));
    expect(read.problems).toEqual([]);
    expect(read.title).toBe("Jobs by status, Everything to date");
    expect(read.text).toContain("Delivery Co");
    expect(read.text).toContain("Jobs by status");
    expect(read.text).toContain("As seen by");
    expect(read.pages[0]).toContain("Lead");
    expect(read.pages[0]!.filter((t) => t === "2").length).toBeGreaterThanOrEqual(2);
  });

  it("moves the clock on to the next occurrence and records when it went", async () => {
    const [row] = await raw<{ next_run_at: Date; last_run_at: Date; last_error: string | null }[]>`
      select next_run_at, last_run_at, last_error from public.delivery_schedule where id = ${scheduleId}`;
    expect(row!.last_run_at.toISOString()).toBe(MONDAY.toISOString());
    // Late by two weeks, so the next one is planned from now: one delivery for
    // the occurrence that was missed, not one per missed Monday.
    expect(row!.next_run_at.getTime()).toBeGreaterThan(Date.now());
    expect(row!.last_error).toBeNull();
  });

  it("never sends the same occurrence twice, whatever happens to the clock", async () => {
    const before = (await messagesTo(ACCOUNTANT)).length;
    // The cursor put back to the occurrence that already went: a restart
    // that lost its place, or a second worker that read it stale.
    await due(scheduleId, MONDAY);
    await schedules.deliverOne(db(), ORG, scheduleId, new Date());
    expect(await deliveriesOf(scheduleId)).toHaveLength(1);
    expect((await messagesTo(ACCOUNTANT)).length).toBe(before);

    // And two workers at once on a fresh occurrence: one sends, one does not.
    const tuesday = new Date("2026-09-15T12:00:00Z");
    await due(scheduleId, tuesday);
    const [a, b] = await Promise.all([
      schedules.deliverOne(db(), ORG, scheduleId, new Date()),
      schedules.deliverOne(db(), ORG, scheduleId, new Date()),
    ]);
    expect([a!.action, b!.action].sort()).toEqual(["delivered", "skipped"]);
    expect(await deliveriesOf(scheduleId)).toHaveLength(2);
    expect((await messagesTo(ACCOUNTANT)).length).toBe(before + 1);
  });

  it("hands the CSV to the mail provider with the message", async () => {
    const provider = fakeProvider();
    await email.flush(db(), ORG, { provider });
    const report = provider.sent.find((m) => m.to === ACCOUNTANT)!;
    expect(report.attachments!.map((a) => a.filename).sort()).toEqual(["jobs-by-status.csv", "jobs-by-status.pdf"]);
    const csv = report.attachments!.find((a) => a.filename.endsWith(".csv"))!;
    expect(csv.content.toString("utf8")).toContain("Status,Jobs");
    const printed = report.attachments!.find((a) => a.filename.endsWith(".pdf"))!;
    expect(printed.contentType).toBe("application/pdf");
    expect(pdf.inspectPdf(new Uint8Array(printed.content), (b) => new Uint8Array(inflateSync(b))).problems).toEqual([]);
    // The accountant has no login, so there is no link for them to be refused at.
    expect(report.text).not.toContain("http");
  });

  it("is not sent while paused, and resumes on the clock rather than catching up", async () => {
    await schedules.setReportSchedulePaused(owner(), { id: scheduleId, paused: true });
    await due(scheduleId, new Date("2026-09-21T12:00:00Z"));
    const due_ = await raw`select 1 from app.due_deliveries(1000) where schedule_id = ${scheduleId}`;
    expect(due_).toHaveLength(0);
    expect(await schedules.deliverOne(db(), ORG, scheduleId, new Date()))
      .toMatchObject({ action: "skipped", reason: "paused" });

    const resumed = await schedules.setReportSchedulePaused(owner(), { id: scheduleId, paused: false });
    expect(resumed.pausedAt).toBeNull();
    expect(resumed.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("leaves out a recipient who has lost the right to see it, and says so", async () => {
    await raw`update public.membership set revocations = '["report:read"]'::jsonb
              where organization_id = ${ORG} and user_id = ${DISPATCH}`;
    await due(scheduleId, new Date("2026-09-22T12:00:00Z"));
    const tick = await schedules.deliverOne(db(), ORG, scheduleId, new Date());
    expect(tick.report?.status).toBe("partly_queued");
    const latest = (await deliveriesOf(scheduleId)).at(-1)!;
    const dispatcher = latest.recipients.find((r) => r.userId === DISPATCH)!;
    expect(dispatcher.messageId).toBeUndefined();
    expect(dispatcher.refused).toMatch(/may not read reports/);
    await raw`update public.membership set revocations = '[]'::jsonb
              where organization_id = ${ORG} and user_id = ${DISPATCH}`;
  });

  it("lists each schedule with its last delivery and how each message went", async () => {
    const [view] = (await schedules.listReportSchedules(owner())).filter((s) => s.id === scheduleId);
    expect(view!.cadenceText).toBe("Every Monday at 7:00 AM");
    // By name where there is one, and by address where there is not.
    expect(view!.people.map((p) => p.name).sort()).toEqual(["delivery-co@test.local", "dispatch"].sort());
    expect(view!.lastDelivery?.status).toBe("partly_queued");
    expect(view!.lastDelivery?.recipients.find((r) => r.address === ACCOUNTANT)?.messageStatus).toBe("queued");
  });
});

run("what each person is sent", () => {
  it("is the report as they would see it, not as the person who set it up sees it", async () => {
    // The technician may run "jobs by status", and on their own screen it
    // counts their own jobs, which is none. The owner's run counts the
    // company's two. Sending the technician the owner's run would be the
    // report builder's scope hole with a mail server attached.
    const created = await schedules.createReportSchedule(owner(), {
      builtIn: "jobs-by-status", frequency: "daily", time: "06:30", period: "all", userIds: [USER, TECH],
    });
    await due(created.id, MONDAY);
    const tick = await schedules.deliverOne(db(), ORG, created.id, new Date());
    expect(tick.report?.status).toBe("queued");

    const [mine] = (await messagesTo("delivery-co@test.local")).slice(-1);
    const [theirs] = await messagesTo("tech@delivery.test");
    expect(mine!.body).toContain("Status: Lead, Jobs: 2");
    expect(theirs!.body).toContain("Nothing fell inside this report for these dates.");
    expect(theirs!.body).not.toContain("Jobs: 2");
    await schedules.removeReportSchedule(owner(), { id: created.id });
  });
});

run("whose authority a report runs under", () => {
  it("stops when the person who set it up can no longer see it, and says why", async () => {
    const created = await schedules.createReportSchedule(as(MANAGER, ["admin"]), {
      builtIn: "jobs-by-status", frequency: "daily", time: "06:00", period: "yesterday", userIds: [MANAGER],
    });
    // The administrator who set it up is barred from reading jobs.
    await raw`update public.membership set revocations = '["job:read"]'::jsonb
              where organization_id = ${ORG} and user_id = ${MANAGER}`;
    await due(created.id, MONDAY);
    const tick = await schedules.deliverOne(db(), ORG, created.id, new Date());
    expect(tick.report?.status).toBe("failed");
    expect(tick.report?.error).toMatch(/job:read/);
    const [delivery] = await deliveriesOf(created.id);
    expect(delivery!.status).toBe("failed");
    expect(delivery!.period_from).toBe("2026-09-13");
    expect(delivery!.period_to).toBe("2026-09-14");
    const [row] = await raw<{ last_error: string }[]>`select last_error from public.delivery_schedule where id = ${created.id}`;
    expect(row!.last_error).toMatch(/job:read/);
    expect(await messagesTo("manager@delivery.test")).toHaveLength(0);
    await raw`update public.membership set revocations = '[]'::jsonb
              where organization_id = ${ORG} and user_id = ${MANAGER}`;
  });
});

run("the worker", () => {
  it("delivers what is due on its pass and hands the outbox to the mail step for that company", async () => {
    const created = await schedules.createReportSchedule(owner(), {
      builtIn: "jobs-by-type", frequency: "daily", time: "05:00", addresses: [ACCOUNTANT],
    });
    await due(created.id, new Date(Date.now() - 60_000));
    const sentFor: string[] = [];
    await runPass({ db: db(), afterDrain: async (org) => { sentFor.push(org); }, push: false });
    expect(await deliveriesOf(created.id)).toHaveLength(1);
    // This company had no events on the pass; it is still handed to the outbox.
    expect(sentFor).toContain(ORG);
    // A whole pass over every company in the test database, which the suites
    // running beside this one keep busy: the time a pass takes, not a unit.
  }, 60_000);
});

run("an automation that emails a report", () => {
  it("refuses to publish one that sends a report to somebody who could not open it", async () => {
    await expect(workflows.create(owner(), {
      name: "Money to dispatch", triggerKind: "event", triggerEvents: ["invoice.issued"],
      steps: [{ kind: "email_report", config: { report: "builtIn:ar-aging", userIds: [DISPATCH] } }],
    })).rejects.toThrow(/Step 1: .*may not see this report/);
  });

  it("refuses one that names no report", async () => {
    await expect(workflows.create(owner(), {
      name: "Nothing", triggerKind: "event", triggerEvents: ["invoice.issued"],
      steps: [{ kind: "email_report", config: { addresses: [ACCOUNTANT] } }],
    })).rejects.toThrow(/Pick the report/);
  });

  it("runs the report and emails it, through the same delivery, once per run", async () => {
    const flow = await workflows.create(owner(), {
      name: "Receivables to the books", triggerKind: "event", triggerEvents: ["invoice.issued"],
      steps: [{
        kind: "email_report",
        config: { report: "builtIn:ar-aging", addresses: [ACCOUNTANT], userIds: [USER], period: "all" },
      }],
    });
    await workflows.setEnabled(owner(), { id: flow.id, enabled: true });

    const [customer] = await raw<{ id: string }[]>`select id from public.customer where organization_id = ${ORG} limit 1`;
    await billing.create(owner(), {
      customerId: customer!.id,
      lines: [{ name: "Visit", quantity: "1", unitPrice: "95.00", discountAmount: "0", taxable: false }],
    });
    const before = (await messagesTo(ACCOUNTANT)).length;
    await drainOrganization(db(), ORG);
    await drainOrganization(db(), ORG);

    const delivered = await raw<{ status: string; workflow_run_id: string; idempotency_key: string }[]>`
      select status, workflow_run_id, idempotency_key from public.report_delivery
      where organization_id = ${ORG} and workflow_run_id is not null`;
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.status).toBe("queued");
    expect(delivered[0]!.idempotency_key).toBe(`run:${delivered[0]!.workflow_run_id}:0`);
    expect((await messagesTo(ACCOUNTANT)).length).toBe(before + 1);

    const [step] = await raw<{ status: string; output: { status: string; queued: number } }[]>`
      select status, output from public.workflow_step_run where run_id = ${delivered[0]!.workflow_run_id}`;
    expect(step!.status).toBe("succeeded");
    expect(step!.output).toMatchObject({ status: "queued", queued: 2 });
    await workflows.setEnabled(owner(), { id: flow.id, enabled: false });
  });
});

run("a file on an email", () => {
  it("refuses a file name with a path in it, which a mail client would save somewhere it should not", async () => {
    await expect(email.queue(owner(), {
      to: ACCOUNTANT, subject: "Report", text: "Attached.",
      attachments: [{ filename: "../../report.csv", contentType: "text/csv", content: Buffer.from("a,b") }],
    })).rejects.toThrow(/plain file name/);
  });

  it("refuses files too large for any receiving server to take", async () => {
    await expect(email.queue(owner(), {
      to: ACCOUNTANT, subject: "Report", text: "Attached.",
      attachments: [{ filename: "big.csv", contentType: "text/csv", content: Buffer.alloc(6 * 1024 * 1024) }],
    })).rejects.toThrow(/too large/);
  });
});

describe("the email itself", () => {
  const result = {
    columns: [
      { key: "aging", label: "Age", type: "text", role: "dimension" as const, sortPrefix: true },
      { key: "balance", label: "Outstanding", type: "money", role: "measure" as const },
    ],
    rows: Array.from({ length: 25 }, (_, i) => ({ aging: `${i} Bucket ${i}`, balance: `${i}.5000` })),
    truncated: false,
  };

  it("summarises the first rows, points at the file for the rest, and escapes what it shows", () => {
    const composed = composeReportEmail({
      name: "Receivables <by> age", question: "Who owes us?", period: "Sep 1, 2026 to Sep 30, 2026",
      result, link: "https://app.example/reports/built-in/ar-aging", filename: "ar.csv",
    });
    expect(composed.subject).toBe("Receivables <by> age: Sep 1, 2026 to Sep 30, 2026");
    expect(composed.text).toContain("Age: Bucket 3, Outstanding: $3.50");
    expect(composed.text).toContain("The first 20 of 25 rows");
    expect(composed.text).toContain("https://app.example/reports/built-in/ar-aging");
    expect(composed.html).toContain("Receivables &lt;by&gt; age");
    expect(composed.html).not.toContain("<by>");
  });

  it("says when there was nothing, rather than sending an empty table", () => {
    const composed = composeReportEmail({
      name: "Jobs", question: null, period: "Sep 14, 2026", result: { ...result, rows: [] }, link: null, filename: "j.csv",
    });
    expect(composed.text).toContain("Nothing fell inside this report for these dates.");
    expect(composed.html).not.toContain("<table");
  });
});
