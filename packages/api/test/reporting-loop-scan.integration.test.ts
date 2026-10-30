import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import * as taskRules from "../src/services/task-rules";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * THE DAILY SCAN FOR A LOOP IN WHO ANSWERS TO WHOM
 *
 * Once a day, in the company's calendar, the worker scans the reporting lines
 * and raises one office task, naming each loop in words, while none is open.
 * It never repairs a line.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("loopscan:org");
const OTHER = fixtureId("loopscan:other-org");
const OWNER = fixtureId("loopscan:owner");
const OTHER_OWNER = fixtureId("loopscan:other-owner");
const ANA = fixtureId("loopscan:ana");
const BEN = fixtureId("loopscan:ben");
const CY = fixtureId("loopscan:cy");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

async function member(id: string, email: string, name: string) {
  await raw`delete from public."user" where id = ${id}`;
  await raw`insert into public."user" (id, email, name) values (${id}, ${email}, ${name})`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${id}, 'office_manager')`;
}
/** A line straight into the data, as one from before the check would be. */
const reports = (who: string, to: string | null) =>
  raw`update public.membership set reports_to_user_id = ${to} where organization_id = ${ORG} and user_id = ${who}`;

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Loop Scan Co", slug: "loop-scan-co" });
  await seedOrg(raw, { organizationId: OTHER, userId: OTHER_OWNER, name: "Loop Scan Two Co", slug: "loop-scan-two-co" });
  await raw`update public.organization set timezone = ${ZONE}, settings = '{}'::jsonb where id in (${ORG}, ${OTHER})`;
  await raw`delete from public.task where organization_id = ${ORG} and entity_type = 'reporting_lines'`;
  await member(ANA, "ana@loop-scan-co.test", "Ana Reyes");
  await member(BEN, "ben@loop-scan-co.test", "Ben Cole");
  await member(CY, "cy@loop-scan-co.test", "Cy Dunn");
});

/** The company's noon, `daysFromToday` days on. */
const noonIn = (daysFromToday: number) => new Date(`${companyToday(daysFromToday)}T18:00:00Z`);
const scan = (now = new Date()) => taskRules.scanLoopsFor(db(), ORG, now);
const loopTasks = () => raw<{ id: string; title: string; body: string; status: string; queue: string | null; outcome: string | null; assignee_user_id: string | null }[]>`
  select id, title, body, status, queue, outcome, assignee_user_id from public.task
   where organization_id = ${ORG} and entity_type = 'reporting_lines' order by created_at`;
const lines = () => raw<{ user_id: string; reports_to_user_id: string | null }[]>`
  select user_id, reports_to_user_id from public.membership where organization_id = ${ORG} order by user_id`;

run("the daily scan", () => {
  it("raises nothing for a company with no loop, and says it scanned", async () => {
    await reports(ANA, BEN);
    await reports(BEN, CY);
    expect(await scan()).toMatchObject({ loops: 0, raisedTaskId: null });
    expect(await loopTasks()).toEqual([]);
  });

  it("raises one task in the office queue naming the loop in words", async () => {
    await reports(ANA, BEN);
    await reports(BEN, ANA);
    const result = await scan();
    expect(result).toMatchObject({ loops: 1 });
    const [task, ...more] = await loopTasks();
    expect(more).toEqual([]);
    expect(task).toMatchObject({
      title: "There is a loop in who answers to whom", queue: "office", status: "open", assignee_user_id: null,
    });
    expect(task!.body).toContain("Ana Reyes reports to Ben Cole and Ben Cole reports to Ana Reyes.");
    expect(task!.body).toContain("Nothing was changed.");
  });

  it("names every loop in one task, and a person reporting into a loop is not in it", async () => {
    await reports(ANA, BEN);
    await reports(BEN, ANA);
    await reports(CY, CY);
    await reports(OWNER, ANA);
    await scan();
    const [task] = await loopTasks();
    expect(task!.title).toBe("There are 2 loops in who answers to whom");
    expect(task!.body).toContain("Ana Reyes reports to Ben Cole and Ben Cole reports to Ana Reyes.");
    expect(task!.body).toContain("Cy Dunn is recorded as reporting to themselves.");
  });

  it("never repairs a line", async () => {
    await reports(ANA, BEN);
    await reports(BEN, ANA);
    const before = await lines();
    await scan();
    await scan(noonIn(1));
    expect(await lines()).toEqual(before);
  });

  it("scans a company once a day however many workers come round", async () => {
    await reports(ANA, BEN);
    await reports(BEN, ANA);
    const results = await Promise.all([scan(noonIn(1)), scan(noonIn(1)), scan(noonIn(1))]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await loopTasks()).toHaveLength(1);
    expect(await scan(noonIn(1))).toBeNull();
  });

  it("does not raise a second task while the first is open, on any later day", async () => {
    await reports(ANA, BEN);
    await reports(BEN, ANA);
    await scan(noonIn(1));
    await scan(noonIn(2));
    await scan(noonIn(3));
    expect(await loopTasks()).toHaveLength(1);
  });

  it("raises it again the next day when it was closed as done and the loop is still there", async () => {
    await reports(ANA, BEN);
    await reports(BEN, ANA);
    await scan(noonIn(1));
    await raw`update public.task set status = 'done', completed_at = now() where organization_id = ${ORG} and entity_type = 'reporting_lines'`;
    await scan(noonIn(2));
    expect((await loopTasks()).map((t) => t.status)).toEqual(["done", "open"]);
  });

  it("leaves the same loops alone once the task was dismissed, and raises it again for different ones", async () => {
    await reports(ANA, BEN);
    await reports(BEN, ANA);
    await scan(noonIn(1));
    await raw`update public.task set status = 'dismissed', outcome = 'We know' where organization_id = ${ORG} and entity_type = 'reporting_lines'`;
    await scan(noonIn(2));
    await scan(noonIn(3));
    expect(await loopTasks()).toHaveLength(1);
    await reports(CY, CY);
    await scan(noonIn(4));
    expect((await loopTasks()).map((t) => t.status)).toEqual(["dismissed", "open"]);
  });

  it("closes the open task by itself when no loop is left", async () => {
    await reports(ANA, BEN);
    await reports(BEN, ANA);
    await scan(noonIn(1));
    await reports(BEN, CY);
    const result = await scan(noonIn(2));
    expect(result).toMatchObject({ loops: 0, closedTaskId: expect.any(String) });
    const [task] = await loopTasks();
    expect(task).toMatchObject({ status: "done", outcome: "No loop is left in who answers to whom." });
  });

  it("audits what it raised and what it closed", async () => {
    await reports(ANA, BEN);
    await reports(BEN, ANA);
    await scan(noonIn(1));
    await reports(BEN, null);
    await scan(noonIn(2));
    const actions = await raw<{ action: string }[]>`
      select action from public.audit_log
       where organization_id = ${ORG} and action like 'task.reporting_loops_%' order by created_at`;
    expect(actions.map((a) => a.action)).toEqual(["task.reporting_loops_raised", "task.reporting_loops_cleared"]);
  });
});

run("which companies the worker scans", () => {
  const listed = async () => (await raw<{ organization_id: string }[]>`
    select organization_id from app.reporting_loop_organizations(1000)`).map((r) => r.organization_id);

  it("lists a company with a line that has not been scanned today, and not one with no lines", async () => {
    expect(await listed()).not.toContain(ORG);
    await reports(ANA, BEN);
    expect(await listed()).toContain(ORG);
    expect(await listed()).not.toContain(OTHER);
  });

  it("stops listing it once scanned, by the company's day, and lists it again tomorrow", async () => {
    await reports(ANA, BEN);
    await scan();
    expect(await listed()).not.toContain(ORG);
    await raw`update public.organization
                 set settings = jsonb_set(settings, '{reportingLoopScan,on}', to_jsonb(${companyToday(-1)}::text))
               where id = ${ORG}`;
    expect(await listed()).toContain(ORG);
  });

  it("leaves a suspended company alone", async () => {
    await reports(ANA, BEN);
    await raw`update public.organization set suspended_at = now() where id = ${ORG}`;
    try {
      expect(await listed()).not.toContain(ORG);
    } finally {
      await raw`update public.organization set suspended_at = null where id = ${ORG}`;
    }
  });

  it("runs as the worker's pass, over the companies it was asked for", async () => {
    await reports(ANA, BEN);
    await reports(BEN, ANA);
    const results = await taskRules.loopScanPass(db(), { only: [ORG] });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ organizationId: ORG, failed: null });
    expect(results[0]!.result).toMatchObject({ loops: 1 });
    expect(await loopTasks()).toHaveLength(1);
  });
});
