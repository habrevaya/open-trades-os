import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as retention from "../src/services/retention";
import * as safety from "../src/services/safety";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE PURGE, AND EVERYTHING THAT STANDS IN ITS WAY
 *
 * The one job in the product that destroys records on its own. These tests
 * hold the four things that must each say yes before anything goes: the rule
 * allows purging, the clock has run out, no other rule keeps it longer or
 * forbids purging, and nobody has put a hold on it. And the two promises
 * around it: the preview says exactly what the purge then does, and every
 * record removed leaves an audit line.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("retention:org");
const USER = fixtureId("retention:user");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });

async function rule(over: { name: string; entityType: string; entityKind?: string | null; months: number; purge: boolean; clock?: string }) {
  const [row] = await raw<{ id: string }[]>`
    insert into public.retention_policy (organization_id, name, entity_type, entity_kind, clock_start, retain_months, purge_allowed)
    values (${ORG}, ${over.name}, ${over.entityType}, ${over.entityKind ?? null}, ${over.clock ?? "record_created"}, ${over.months}, ${over.purge})
    returning id`;
  return row!.id;
}

/** A closed near miss made `yearsAgo` years back. */
async function oldNearMiss(yearsAgo: number, closed = true): Promise<string> {
  const { id } = await safety.report(owner(), {
    kind: "near_miss", occurredAt: new Date().toISOString(), description: `Near miss ${yearsAgo} years ago`,
  });
  await raw`update public.task set status = 'done' where entity_id = ${id}`;
  await raw`update public.incident_report set
    created_at = now() - make_interval(years => ${yearsAgo}),
    occurred_at = now() - make_interval(years => ${yearsAgo}),
    status = ${closed ? "closed" : "open"}, closed_at = ${closed ? new Date() : null}
    where id = ${id}`;
  return id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Retention Co", slug: "retention-co" });
});

afterAll(async () => {
  if (raw) await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  for (const table of ["retention_hold", "retention_purge_run", "retention_policy", "incident_person", "incident_report",
    "safety_meeting_attendee", "safety_meeting", "task", "audit_log"]) {
    await raw.unsafe(`delete from public.${table} where organization_id = $1`, [ORG]);
  }
});

const rows = async () => (await raw<{ id: string }[]>`select id from public.incident_report where organization_id = ${ORG}`).map((r) => r.id);

run("previewing", () => {
  it("removes nothing while purging is off, and says turning it on is what would", async () => {
    await rule({ name: "Near misses", entityType: "incident_report", entityKind: "near_miss", months: 12, purge: false });
    await oldNearMiss(3);
    const [row] = await retention.preview(owner());
    expect(row!.counts).toMatchObject({ due: 0, kept: 1 });
    expect(row!.summary).toMatch(/Purging is off/);
    const ran = await retention.runNow(owner());
    expect(ran.purged).toBe(0);
    expect(await rows()).toHaveLength(1);
  });

  it("lists exactly what the purge then removes", async () => {
    const policyId = await rule({ name: "Near misses", entityType: "incident_report", entityKind: "near_miss", months: 12, purge: false });
    const old = await oldNearMiss(3);
    const recent = await oldNearMiss(0);
    const open = await oldNearMiss(5, false);
    await retention.updatePolicy(owner(), { id: policyId, purgeAllowed: true });

    const [row] = await retention.preview(owner());
    expect(row!.counts).toMatchObject({ due: 1, notYet: 1, kept: 1 });
    expect(row!.records.find((r) => r.id === old)).toMatchObject({ state: "due" });
    expect(row!.records.find((r) => r.id === open)).toMatchObject({ state: "kept", why: expect.stringMatching(/still open/) });

    const ran = await retention.runNow(owner());
    expect(ran).toMatchObject({ purged: 1, failed: 0, trigger: "person" });
    expect(new Set(await rows())).toEqual(new Set([recent, open]));

    const audits = await raw<{ entity_id: string; after: { policy: string; runId: string } }[]>`
      select entity_id, after from public.audit_log where organization_id = ${ORG} and action = 'retention.purged'`;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entity_id: old, after: { policy: "Near misses", runId: ran.id } });
  });

  it("does not act on a rule about records this product does not hold, and says so", async () => {
    await rule({ name: "Scale tickets", entityType: "disposal_ticket", months: 36, purge: true });
    const [row] = await retention.preview(owner());
    expect(row!.policy.actsOn).toBe(false);
    expect(row!.summary).toMatch(/Nothing in this product holds/);
  });

  it("says when a rule names a kind no record is", async () => {
    await rule({ name: "Spills", entityType: "incident_report", entityKind: "environmental", months: 12, purge: true });
    await oldNearMiss(3);
    const [row] = await retention.preview(owner());
    expect(row!.summary).toMatch(/No record here is of kind "environmental"/);
  });
});

run("what keeps a record", () => {
  it("a hold, until it is released", async () => {
    await rule({ name: "Near misses", entityType: "incident_report", entityKind: "near_miss", months: 12, purge: true });
    const id = await oldNearMiss(3);
    const hold = await retention.placeHold(owner(), { entityType: "incident_report", entityId: id, reason: "The Smith claim" });
    // Holding twice is one hold.
    expect((await retention.placeHold(owner(), { entityType: "incident_report", entityId: id, reason: "again" })).id).toBe(hold.id);

    const [row] = await retention.preview(owner());
    expect(row!.counts).toMatchObject({ due: 0, held: 1 });
    expect((await retention.runNow(owner())).held).toBe(1);
    expect(await rows()).toEqual([id]);

    await retention.releaseHold(owner(), { id: hold.id, note: "Settled" });
    expect((await retention.runNow(owner())).purged).toBe(1);
    expect(await rows()).toEqual([]);
  });

  it("a longer rule on the same records", async () => {
    await rule({ name: "Near misses", entityType: "incident_report", entityKind: "near_miss", months: 12, purge: true });
    await rule({ name: "Every incident", entityType: "incident_report", months: 120, purge: true });
    await oldNearMiss(3);
    expect((await retention.runNow(owner())).purged).toBe(0);
    expect(await rows()).toHaveLength(1);
  });

  it("another rule over the same records with purging off", async () => {
    await rule({ name: "Near misses", entityType: "incident_report", entityKind: "near_miss", months: 12, purge: true });
    await rule({ name: "Every incident, never purged", entityType: "incident_report", months: 1, purge: false });
    await oldNearMiss(3);
    const preview = await retention.preview(owner());
    expect(preview.find((p) => p.policy.name === "Near misses")!.records[0]!.why).toMatch(/purging is off for "Every incident, never purged"/);
    expect((await retention.runNow(owner())).purged).toBe(0);
  });

  it("a clock that has not started", async () => {
    await rule({ name: "Talks", entityType: "safety_meeting", months: 1, purge: true, clock: "report_prepared" });
    const { id } = await safety.createMeeting(owner(), { topic: "Never closed", heldAt: new Date().toISOString() });
    await raw`update public.safety_meeting set created_at = now() - interval '3 years' where id = ${id}`;
    const [row] = await retention.preview(owner());
    expect(row!.counts).toMatchObject({ due: 0, kept: 1 });
  });
});

run("purging a talk", () => {
  it("removes it with its signatures, and empties files nothing else points at", async () => {
    await rule({ name: "Talks", entityType: "safety_meeting", months: 12, purge: true, clock: "calendar_year_end" });
    const { id } = await safety.createMeeting(owner(), { topic: "Old talk", heldAt: new Date(Date.now() - 4 * 365 * 86_400_000).toISOString() });
    await safety.addMeetingPhoto(owner(), { id, fileName: "sheet.png", bytes: PNG });
    const ran = await retention.runNow(owner());
    expect(ran.purged).toBe(1);
    const [meeting] = await raw<{ n: number }[]>`select count(*)::int as n from public.safety_meeting where id = ${id}`;
    expect(meeting!.n).toBe(0);
    const [file] = await raw<{ size_bytes: number; deleted_at: Date | null }[]>`
      select f.size_bytes, f.deleted_at from public.stored_file f
      join public.attachment a on a.storage_key = f.storage_key and a.organization_id = f.organization_id
      where a.entity_id = ${id}`;
    expect(file).toMatchObject({ size_bytes: 0 });
    expect(file!.deleted_at).not.toBeNull();
  });
});

run("the worker's pass", () => {
  it("runs once a day for a company with a rule that may purge", async () => {
    await rule({ name: "Near misses", entityType: "incident_report", entityKind: "near_miss", months: 12, purge: true });
    await oldNearMiss(3);
    const first = (await retention.purgePass(db())).find((r) => r.organizationId === ORG);
    expect(first?.run).toMatchObject({ purged: 1, trigger: "worker" });
    await oldNearMiss(3);
    const second = (await retention.purgePass(db())).find((r) => r.organizationId === ORG);
    expect(second).toBeUndefined();
  });
});
