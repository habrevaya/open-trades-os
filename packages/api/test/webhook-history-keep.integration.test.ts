import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as webhooks from "../src/services/webhooks";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * M26. HOW LONG A COMPANY KEEPS ITS WEBHOOK DELIVERY HISTORY
 *
 * Every attempt to deliver an event, and what the receiver answered, is kept
 * thirty days and a thousand attempts per endpoint unless the company says
 * otherwise. A company debugging a receiver over a quarter keeps more; one
 * that wants customer data out of a debugging table sooner keeps less. The
 * delivery pass trims each endpoint by what the company chose, whichever of
 * the two cuts first.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("webhook-keep:org");
const USER = fixtureId("webhook-keep:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db() });
const owner = () => as(["owner"]);

const NOW = new Date("2026-11-05T15:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

let endpointId = "";

/** Attempts written straight in, so the test is about what is kept, not about sending. */
async function attempts(ages: number[]) {
  for (const [i, age] of ages.entries()) {
    await raw`insert into public.webhook_delivery
                (organization_id, endpoint_id, event_id, event_sequence, event_name, attempt, requested_at, duration_ms, response_status, ok)
              values (${ORG}, ${endpointId}, ${fixtureId(`webhook-keep:event:${i}`)}, ${i + 1}, 'job.completed', 1, ${daysAgo(age)}, 12, 200, true)`;
  }
}

async function kept(): Promise<number> {
  const [row] = await raw<{ n: number }[]>`select count(*)::int as n from public.webhook_delivery where endpoint_id = ${endpointId}`;
  return row!.n;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Webhook Keep Co", slug: "webhook-keep-co" });
  endpointId = (await webhooks.register(owner(), { url: "https://hooks.example.test/keep", events: ["invoice.paid"] })).id;
});

afterAll(async () => {
  if (!raw) return;
  await raw`delete from public.webhook_endpoint where organization_id = ${ORG}`;
  await raw.end();
});

run("how long webhook delivery history is kept", () => {
  it("keeps thirty days and a thousand attempts until the company says otherwise", async () => {
    expect(await webhooks.historyKeeping(owner())).toEqual({ keepDays: 30, keepPerEndpoint: 1000, defaults: { keepDays: 30, keepPerEndpoint: 1000 } });
    await attempts([1, 20, 45]);
    await webhooks.deliver(db(), ORG, { send: async () => ({ status: 200, ok: true }), now: () => NOW });
    expect(await kept()).toBe(2);
  });

  it("keeps what the company chose, by age and by count, whichever cuts first", async () => {
    await raw`delete from public.webhook_delivery where endpoint_id = ${endpointId}`;
    const set = await webhooks.setHistoryKeeping(owner(), { keepDays: 90, keepPerEndpoint: 100 });
    expect(set).toMatchObject({ keepDays: 90, keepPerEndpoint: 100 });
    await attempts([1, 20, 45, 89, 120]);
    await webhooks.deliver(db(), ORG, { send: async () => ({ status: 200, ok: true }), now: () => NOW });
    expect(await kept()).toBe(4);

    await attempts(Array.from({ length: 110 }, () => 2));
    await webhooks.deliver(db(), ORG, { send: async () => ({ status: 200, ok: true }), now: () => NOW });
    expect(await kept()).toBe(100);

    const [audit] = await raw<{ before: unknown; after: unknown }[]>`
      select before, after from public.audit_log where organization_id = ${ORG} and action = 'organization.webhook_history_kept' limit 1`;
    expect(audit).toMatchObject({ before: { keepDays: 30, keepPerEndpoint: 1000 }, after: { keepDays: 90, keepPerEndpoint: 100 } });
  });

  it("refuses what it cannot keep, in words, and somebody who may not change integrations", async () => {
    await expect(webhooks.setHistoryKeeping(owner(), { keepDays: 0, keepPerEndpoint: 1000 })).rejects.toThrow(/between 1 and 365 days/);
    await expect(webhooks.setHistoryKeeping(owner(), { keepDays: 400, keepPerEndpoint: 1000 })).rejects.toThrow(/between 1 and 365 days/);
    await expect(webhooks.setHistoryKeeping(owner(), { keepDays: 30, keepPerEndpoint: 50 })).rejects.toThrow(/between 100 and 10000/);
    await expect(webhooks.setHistoryKeeping(as(["dispatcher"]), { keepDays: 30, keepPerEndpoint: 1000 })).rejects.toThrow();
    expect((await webhooks.historyKeeping(owner())).keepDays).toBe(90);
  });

  it("goes back to the default", async () => {
    expect(await webhooks.setHistoryKeeping(owner(), { keepDays: 30, keepPerEndpoint: 1000 })).toMatchObject({ keepDays: 30, keepPerEndpoint: 1000 });
  });
});
