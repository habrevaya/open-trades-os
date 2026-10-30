import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as jobs from "../src/services/jobs";
import * as jobHolds from "../src/services/job-holds";
import * as dispatch from "../src/services/dispatch";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A JOB LEFT ON HOLD TOO LONG, AND WHY IT IS ON HOLD
 *
 * A company says how many days a job may wait on hold; the worker raises ONE
 * office task for each hold that has lasted that long, naming the job, the
 * reason and the days, and ending the hold closes it. The dispatch board's
 * card for a job on hold says why in words.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("holdnudge:org");
const USER = fixtureId("holdnudge:user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (role: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db(),
});
const owner = () => as("owner");

let customerId = "";
let propertyId = "";
let seq = 0;
let vendorId = "";
let locationId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Hold Nudge Co", slug: "hold-nudge-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`update public."user" set name = 'Ana Ruiz' where id = ${USER}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Dana Whitfield', 0) returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '12 Oak', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id;
  const [vendor] = await raw<{ id: string }[]>`insert into public.vendor (organization_id, name) values (${ORG}, 'Supply House') returning id`;
  vendorId = vendor!.id;
  const [location] = await raw<{ id: string }[]>`insert into public.location (organization_id, name) values (${ORG}, 'Shop') returning id`;
  locationId = location!.id;
});

/** A part order that went to the supplier, for a hold that waits on a part. */
async function sentOrder(): Promise<string> {
  seq += 100;
  const [row] = await raw<{ id: string }[]>`
    insert into public.purchase_order (organization_id, number, vendor_id, default_location_id, status, submitted_at)
    values (${ORG}, ${seq}, ${vendorId}, ${locationId}, 'submitted', now()) returning id`;
  return row!.id;
}

/** A booked job, with one visit today from eight to noon so the board has a card for it. */
async function booked(summary = "No cool"): Promise<string> {
  seq += 1;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, 'scheduled', ${summary}) returning id`;
  await raw`
    insert into public.visit (organization_id, job_id, sequence, status, window_start, window_end)
    values (${ORG}, ${job!.id}, 1, 'scheduled',
            ${raw.unsafe(`('${companyToday()} 08:00'::timestamp at time zone '${ZONE}')`)},
            ${raw.unsafe(`('${companyToday()} 12:00'::timestamp at time zone '${ZONE}')`)})`;
  return job!.id;
}

/** Hold a job through the service, then age the hold: placed at one in the afternoon `daysAgo` company days back. */
async function holdFor(jobId: string, daysAgo: number, reason: "part" | "customer" | "inspection" = "customer", note?: string) {
  const placed = await jobHolds.place(owner(), {
    id: jobId, reason, ...(note ? { note } : {}), ...(reason === "part" ? { purchaseOrderId: await sentOrder() } : {}),
  });
  const id = placed.data.at(-1)!.id;
  await raw`
    update public.job_hold set placed_at = ${raw.unsafe(`('${companyToday(-daysAgo)} 13:00'::timestamp at time zone '${ZONE}')`)}
     where id = ${id}`;
  return id;
}

const nudgeTasks = () => raw<{ id: string; title: string; body: string; queue: string; status: string; entity_type: string; entity_id: string; outcome: string | null }[]>`
  select id, title, body, queue, status, entity_type, entity_id, outcome from public.task
   where organization_id = ${ORG} order by created_at`;

/** One worker pass over every company, as the worker makes it. */
const pass = (now?: Date) => jobHolds.nudgePass(db(), { force: true, ...(now ? { now } : {}) });

const turnOn = (days: number | null) => jobHolds.setNudge(owner(), { days });

run("the hold nudge setting", () => {
  it("is off until the company turns it on, and reads back what was set", async () => {
    expect(await jobHolds.nudgeSetting(owner())).toMatchObject({ days: null });
    expect(await turnOn(5)).toMatchObject({ days: 5 });
    expect(await jobHolds.nudgeSetting(owner())).toMatchObject({ days: 5 });
    expect(await turnOn(null)).toMatchObject({ days: null });
    const audited = await raw<{ action: string }[]>`
      select action from public.audit_log where organization_id = ${ORG} and action = 'organization.hold_nudge_set'`;
    expect(audited).toHaveLength(2);
  });

  it("refuses a number of days that is not a whole number from one to ninety", async () => {
    for (const days of [0, -2, 91, 2.5]) {
      await expect(turnOn(days)).rejects.toBeInstanceOf(ConflictError);
    }
    await expect(turnOn(0)).rejects.toThrow(/whole number from 1 to 90/);
    expect(await jobHolds.nudgeSetting(owner())).toMatchObject({ days: null });
  });

  it("is the company's to change, not a technician's or a dispatcher's", async () => {
    await expect(jobHolds.setNudge(as("technician"), { days: 4 })).rejects.toThrow(PermissionError);
    await expect(jobHolds.setNudge(as("dispatcher"), { days: 4 })).rejects.toThrow(PermissionError);
    expect(await jobHolds.nudgeSetting(owner())).toMatchObject({ days: null });
  });
});

run("a job left on hold", () => {
  it("raises nothing while the setting is off, however long the job has waited", async () => {
    await holdFor(await booked(), 30);
    // Only this company's result: another test file's company may have its own nudges on, side by side.
    expect((await pass()).filter((r) => r.organizationId === ORG)).toEqual([]);
    expect(await nudgeTasks()).toHaveLength(0);
  });

  it("raises one office task once the hold has lasted the days, naming the job, the reason and how long", async () => {
    await turnOn(3);
    const jobId = await booked("No cool upstairs");
    await holdFor(jobId, 4, "part", "Condenser fan motor");
    await holdFor(await booked("Drain backs up"), 2, "customer");

    const result = await pass();
    expect(result.find((r) => r.organizationId === ORG)).toMatchObject({ raised: 1, failed: null });

    const [task, ...others] = await nudgeTasks();
    expect(others).toEqual([]);
    expect(task).toMatchObject({
      title: "Job 1 has been on hold 4 days: waiting on a part",
      queue: "office", status: "open", entity_type: "job", entity_id: jobId,
    });
    expect(task!.body).toContain("Dana Whitfield: No cool upstairs.");
    expect(task!.body).toContain("Waiting on a part: Condenser fan motor.");
    expect(task!.body).toContain("put there by Ana Ruiz");
    expect(task!.body).toContain("which is 4 days");
    expect(task!.body).toContain("closes itself when the job comes off hold");
    expect(task!.body).not.toMatch(/[\u2014\u2013]/);
  });

  it("counts the company's calendar days, so a hold placed last evening is a day old this morning", async () => {
    await turnOn(1);
    const jobId = await booked();
    const holdId = await holdFor(jobId, 1);
    await raw`update public.job_hold set placed_at = ${raw.unsafe(`('${companyToday(-1)} 23:30'::timestamp at time zone '${ZONE}')`)} where id = ${holdId}`;
    await pass();
    expect(await nudgeTasks()).toHaveLength(1);
  });

  it("raises it once, however many times the worker comes round", async () => {
    await turnOn(2);
    await holdFor(await booked(), 5);
    await pass();
    await pass();
    await Promise.all([pass(), pass()]);
    expect(await nudgeTasks()).toHaveLength(1);
    const [claim] = await raw<{ nudged_at: Date | null; nudge_task_id: string | null }[]>`
      select nudged_at, nudge_task_id from public.job_hold where organization_id = ${ORG}`;
    expect(claim!.nudged_at).not.toBeNull();
    expect(claim!.nudge_task_id).toBe((await nudgeTasks())[0]!.id);
    const audited = await raw`select 1 from public.audit_log where organization_id = ${ORG} and action = 'job.hold_nudged'`;
    expect(audited).toHaveLength(1);
  });

  it("nudges a hold the setting had not yet reached when the company lowers the number", async () => {
    await turnOn(10);
    await holdFor(await booked(), 4);
    await pass();
    expect(await nudgeTasks()).toHaveLength(0);
    await turnOn(4);
    await pass();
    expect(await nudgeTasks()).toHaveLength(1);
  });

  it("closes the task when the job is taken off hold, and nudges again for a later hold", async () => {
    await turnOn(2);
    const jobId = await booked();
    const first = await holdFor(jobId, 3);
    await pass();
    const [task] = await nudgeTasks();

    await jobHolds.release(owner(), { id: first });
    const [closed] = await nudgeTasks();
    expect(closed).toMatchObject({ id: task!.id, status: "done", outcome: "The job came off hold." });
    const [completer] = await raw<{ completed_by_user_id: string | null; completed_at: Date | null }[]>`
      select completed_by_user_id, completed_at from public.task where id = ${task!.id}`;
    expect(completer).toMatchObject({ completed_by_user_id: USER });
    expect(completer!.completed_at).not.toBeNull();

    // A new hold on the same job is a new hold: it earns its own nudge, in its own time.
    await holdFor(jobId, 2, "inspection", "Gas line");
    await pass();
    const all = await nudgeTasks();
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ status: "open", title: "Job 1 has been on hold 2 days: waiting on an inspection" });
  });

  it("closes the task when an ordinary status change moves the job off hold", async () => {
    await turnOn(1);
    const jobId = await booked();
    await holdFor(jobId, 2);
    await pass();
    await jobs.update(owner(), { id: jobId, status: "scheduled" });
    expect(await nudgeTasks()).toEqual([expect.objectContaining({ status: "done", outcome: "The job came off hold." })]);
  });

  it("closes the task when the job is cancelled while on hold", async () => {
    await turnOn(1);
    const jobId = await booked();
    await holdFor(jobId, 2);
    await pass();
    await jobs.update(owner(), { id: jobId, status: "cancelled" });
    expect((await nudgeTasks())[0]!.status).toBe("done");
  });

  it("leaves a task somebody already closed as they closed it, and does not raise it again for the same hold", async () => {
    await turnOn(1);
    const jobId = await booked();
    const holdId = await holdFor(jobId, 3);
    await pass();
    const [task] = await nudgeTasks();
    await raw`update public.task set status = 'dismissed', outcome = 'Rang them already' where id = ${task!.id}`;
    await pass();
    expect(await nudgeTasks()).toHaveLength(1);
    await jobHolds.release(owner(), { id: holdId });
    expect((await nudgeTasks())[0]).toMatchObject({ status: "dismissed", outcome: "Rang them already" });
  });

  it("does not raise one for a job that has been cancelled outright or deleted", async () => {
    await turnOn(1);
    const gone = await booked();
    await holdFor(gone, 3);
    await raw`update public.job set deleted_at = now() where id = ${gone}`;
    await pass();
    expect(await nudgeTasks()).toHaveLength(0);
  });

  it("is a company's own business: another company's setting does not nudge this one", async () => {
    await holdFor(await booked(), 9);
    const OTHER = fixtureId("holdnudge:other-org");
    const OTHER_USER = fixtureId("holdnudge:other-user");
    await seedOrg(raw, { organizationId: OTHER, userId: OTHER_USER, name: "Other Hold Co", slug: "other-hold-nudge-co" });
    try {
      await raw`update public.organization set settings = '{"holdNudge": {"days": 1}}'::jsonb where id = ${OTHER}`;
      const listed = await raw<{ organization_id: string }[]>`select organization_id from app.job_hold_nudge_organizations(500)`;
      // The other company has the setting on but nothing on hold; this one has a hold but the setting is off.
      expect(listed.map((r) => r.organization_id)).not.toContain(ORG);
      expect(listed.map((r) => r.organization_id)).not.toContain(OTHER);
      await pass();
      expect(await nudgeTasks()).toHaveLength(0);
    } finally {
      await raw`delete from public.membership where organization_id = ${OTHER}`;
      await raw`delete from public.organization where id = ${OTHER}`;
      await raw`delete from public."user" where id = ${OTHER_USER}`;
    }
  });
});

run("the dispatch board's card for a job on hold", () => {
  const boardCards = async () => {
    const board = await dispatch.board(owner(), { date: companyToday() });
    return board.unassigned;
  };

  it("says why the job is waiting, in words, with how long", async () => {
    const jobId = await booked("No cool upstairs");
    expect((await boardCards())[0]!.onHold).toBeNull();

    await holdFor(jobId, 3, "part", "Condenser fan motor");
    const [card] = await boardCards();
    expect(card!.onHold).toEqual({
      reason: "part", days: 3, words: "On hold 3 days. Waiting on a part: Condenser fan motor",
    });
  });

  it("says a job placed on hold today is on hold since today", async () => {
    const jobId = await booked();
    await jobHolds.place(owner(), { id: jobId, reason: "weather" });
    expect((await boardCards())[0]!.onHold).toEqual({ reason: "weather", days: 0, words: "On hold since today. Waiting on the weather" });
  });

  it("says so, and does not guess, for a job moved to on hold before reasons existed", async () => {
    const jobId = await booked();
    await raw`update public.job set status = 'on_hold' where id = ${jobId}`;
    expect((await boardCards())[0]!.onHold).toEqual({ reason: null, days: null, words: "On hold. No reason was given." });
  });

  it("stops saying it the moment the job is taken off hold", async () => {
    const jobId = await booked();
    const holdId = await holdFor(jobId, 1);
    expect((await boardCards())[0]!.onHold).not.toBeNull();
    await jobHolds.release(owner(), { id: holdId });
    expect((await boardCards())[0]!.onHold).toBeNull();
  });
});
