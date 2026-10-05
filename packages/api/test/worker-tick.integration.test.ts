import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { handleWorkerTick } from "../src/http/worker-tick";
import { drainOrganization, runBounded } from "../src/services/workflow-worker";
import { resetOrg, seedOrg, testDb, fixtureId, holdWholePassLock, WHOLE_PASS_WAIT_MS } from "./helpers";

/**
 * THE WORKER ON A HOST THAT CANNOT KEEP IT RUNNING
 *
 * The tick is the worker's own pass behind a URL with a deadline. What can go
 * wrong is specific: the budget being checked somewhere it can cut an event in
 * half, the cursor moving past events that were never handled, and the URL
 * being reachable without its token. Each of those is asserted here.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("tick:org");
const USER = fixtureId("tick:user");
const TOKEN = "w".repeat(48);

let raw: postgres.Sql;
const db = () => testDb(url!);

const cursor = async () => {
  const rows = await raw<{ last_sequence: number }[]>`
    select last_sequence from public.event_cursor
    where organization_id = ${ORG} and consumer = 'workflow'`;
  return rows[0]?.last_sequence ?? 0;
};

async function threeEvents(): Promise<void> {
  for (const sequence of [1, 2, 3]) {
    await raw`insert into public.domain_event (organization_id, sequence, name, entity_type, payload)
              values (${ORG}, ${sequence}, 'job.created', 'job', '{}'::jsonb)`;
  }
}

/** This file runs the worker's pass over every company: see `holdWholePassLock`. */
let releaseWholePass: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (url) releaseWholePass = await holdWholePassLock(url);
}, WHOLE_PASS_WAIT_MS);
afterAll(async () => { await releaseWholePass?.(); });

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Tick Co", slug: "tick-co" });
  await threeEvents();
});

afterAll(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

const tick = (token: string | null, presented = TOKEN, method = "POST") =>
  handleWorkerTick(new Request("https://ots.example.test/api/internal/worker/tick", {
    method,
    headers: { authorization: `Bearer ${presented}` },
  }), { db: db(), token, afterDrain: async () => {} });

run("the worker tick", () => {
  it("drains the log the way the worker does", async () => {
    const res = await tick(TOKEN);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["passes"]).toBeGreaterThanOrEqual(1);
    expect(body["events"]).toBeGreaterThanOrEqual(3);
    expect(await cursor()).toBe(3);
  });

  it("is a 404 when it has no token, and a 401 with the wrong one, and touches nothing", async () => {
    expect((await tick(null)).status).toBe(404);
    expect((await tick(TOKEN, "w".repeat(47))).status).toBe(401);
    expect(await cursor()).toBe(0);
  });

  it("stops between events when the budget is spent, and leaves the rest unread", async () => {
    let calls = 0;
    // Allow exactly one event: the check before the first passes, the one
    // before the second does not.
    const result = await drainOrganization(db(), ORG, 100, () => calls++ >= 1);
    expect(result.events).toBe(1);
    expect(await cursor()).toBe(1);

    // And a run with no time left at all reaches nothing and moves nothing.
    const spent = await runBounded({
      db: db(), budgetMs: 1, now: (() => { let t = 0; return () => (t += 10); })(),
      afterDrain: async () => {}, push: false,
    });
    expect(spent.stoppedForBudget).toBe(true);
    expect(await cursor()).toBe(1);
  });
});
