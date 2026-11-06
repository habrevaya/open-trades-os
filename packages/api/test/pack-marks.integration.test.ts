import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as kpis from "../src/services/kpis";
import * as packMarks from "../src/services/pack-marks";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * M02, M21. A JOB TYPE OR AN ITEM MARKED AS THE TRADE PACK'S BY HAND
 *
 * Hand Marked Plumbing books its drain calls under a job type it made itself,
 * "Sewer call", and sells camera work under its own item, "SCOPE-CAM". Neither
 * code is the plumbing pack's, so drain call conversion counted neither. Marked
 * by hand, the sewer call counts as a drain call and the scope as the upsell.
 * Hand Marked Electric charges for finding a fault under its own "FAULT-FEE":
 * until it is marked, a call with only that on it reads as repair work. A mark
 * no number on the company's scorecard reads is refused, and only somebody who
 * changes settings can mark anything.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const PLUMB = fixtureId("pack-marks:plumb");
const ELEC = fixtureId("pack-marks:elec");
const USER = fixtureId("pack-marks:user");
const WINDOW = { from: "2026-06-01", to: "2026-06-30" };
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (organizationId: string, role: string): ServiceContext =>
  ({ actor: { userId: USER, organizationId, roles: [role] as Actor["roles"] }, db: db() });

const ids = new Map<string, string>();
let seq = 0;

async function jobType(org: string, name: string, code: string): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, revenue_class) values (${org}, ${name}, ${code}, 'service') returning id`;
  ids.set(`${org}:type:${code}`, row!.id);
  return row!.id;
}

async function item(org: string, code: string): Promise<void> {
  const [i] = await raw<{ id: string }[]>`
    insert into public.price_book_item (organization_id, code, kind) values (${org}, ${code}, 'service') returning id`;
  const [v] = await raw<{ id: string }[]>`
    insert into public.price_book_item_version (organization_id, item_id, version, name, price, effective_from)
    values (${org}, ${i!.id}, 1, ${`${code} item`}, '200', now() - interval '400 days') returning id`;
  ids.set(`${org}:item:${code}`, i!.id);
  ids.set(`${org}:version:${code}`, v!.id);
}

/** A job of a type finished on June 20th at two, with one done visit carrying lines of these codes. */
async function job(org: string, customerId: string, code: string, lines: string[]): Promise<string> {
  seq += 1;
  const [p] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${org}, ${`${seq} Mark St`}, 'Austin', 'TX', '78704') returning id`;
  const done = raw.unsafe(`('2026-06-20 14:00'::timestamp at time zone '${ZONE}')`);
  const [j] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary, completed_at)
    values (${org}, ${seq}, ${customerId}, ${p!.id}, ${ids.get(`${org}:type:${code}`)!}, 'completed', ${`Job ${seq}`}, ${done})
    returning id`;
  const [v] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, status, arrived_at, completed_at, estimated_duration_minutes)
    values (${org}, ${j!.id}, 'completed', ${done}, ${done}, 60) returning id`;
  for (const line of lines) {
    await raw`
      insert into public.job_line (organization_id, job_id, visit_id, kind, name, quantity, unit_price, price_book_item_version_id)
      values (${org}, ${j!.id}, ${v!.id}, 'labor', ${line}, 1, 100, ${ids.get(`${org}:version:${line}`)!})`;
  }
  return j!.id;
}

async function customer(org: string): Promise<string> {
  const [c] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days) values (${org}, 'residential', 'Mark Family', 0) returning id`;
  return c!.id;
}

const figure = async (org: string, key: string) =>
  (await kpis.scorecard(as(org, "owner"), WINDOW)).computed.find((k) => k.key === key)!;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  ids.clear();
  await seedOrg(raw, { organizationId: PLUMB, userId: USER, name: "Hand Marked Plumbing", slug: "pack-marks-plumbing" });
  await seedOrg(raw, { organizationId: ELEC, userId: USER, name: "Hand Marked Electric", slug: "pack-marks-electric" });
  await raw`update public.organization set timezone = ${ZONE}, primary_trade = 'plumbing' where id = ${PLUMB}`;
  await raw`update public.organization set timezone = ${ZONE}, primary_trade = 'electrical' where id = ${ELEC}`;
});

run("marking a hand made drain call and its camera work", () => {
  it("counts a job type and an item made under other codes once they are marked, and says so on the list", async () => {
    const c = await customer(PLUMB);
    await jobType(PLUMB, "Drain call", "drain");
    await jobType(PLUMB, "Sewer call", "sewer-call");
    await item(PLUMB, "CAMERA-INSPECT");
    await item(PLUMB, "SCOPE-CAM");
    await job(PLUMB, c, "drain", ["SCOPE-CAM"]);
    await job(PLUMB, c, "sewer-call", ["SCOPE-CAM"]);

    const before = await figure(PLUMB, "drain_conversion");
    expect([before.numerator, before.denominator]).toEqual(["0", "1"]);

    const listed = await packMarks.list(as(PLUMB, "owner"));
    expect(listed.offered).toEqual({ jobType: ["drain"], item: ["drain_upsell"] });
    expect(listed.jobTypes.find((t) => t.code === "drain")).toMatchObject({ fromPack: ["drain"], byHand: [] });
    expect(listed.items.find((i) => i.code === "CAMERA-INSPECT")).toMatchObject({ fromPack: ["drain_upsell"], byHand: [] });

    await packMarks.setJobTypeMarks(as(PLUMB, "owner"), { id: ids.get(`${PLUMB}:type:sewer-call`)!, marks: ["drain"] });
    const typed = await figure(PLUMB, "drain_conversion");
    expect([typed.numerator, typed.denominator]).toEqual(["0", "2"]);

    await packMarks.setItemMarks(as(PLUMB, "owner"), { id: ids.get(`${PLUMB}:item:SCOPE-CAM`)!, marks: ["drain_upsell", "drain_upsell"] });
    const both = await figure(PLUMB, "drain_conversion");
    expect([both.numerator, both.denominator, both.value]).toEqual(["2", "2", "100.0"]);

    const after = await packMarks.list(as(PLUMB, "owner"));
    expect(after.jobTypes.find((t) => t.code === "sewer-call")).toMatchObject({ fromPack: [], byHand: ["drain"] });
    expect(after.items.find((i) => i.code === "SCOPE-CAM")).toMatchObject({ byHand: ["drain_upsell"] });

    const audits = await raw<{ action: string; after: { packMarks: string[] } }[]>`
      select action, "after" from public.audit_log where organization_id = ${PLUMB} and action like '%pack_marks_set' order by created_at`;
    expect(audits.map((a) => [a.action, a.after.packMarks])).toEqual([
      ["job_type.pack_marks_set", ["drain"]],
      ["price_book_item.pack_marks_set", ["drain_upsell"]],
    ]);

    /** Taking the marks off puts the numbers back. */
    await packMarks.setJobTypeMarks(as(PLUMB, "owner"), { id: ids.get(`${PLUMB}:type:sewer-call`)!, marks: [] });
    await packMarks.setItemMarks(as(PLUMB, "owner"), { id: ids.get(`${PLUMB}:item:SCOPE-CAM`)!, marks: [] });
    const undone = await figure(PLUMB, "drain_conversion");
    expect([undone.numerator, undone.denominator]).toEqual(["0", "1"]);
  });

  it("refuses a mark the company's scorecard does not read, and a mark that does not exist", async () => {
    await jobType(PLUMB, "Fault finding", "fault");
    await expect(packMarks.setJobTypeMarks(as(PLUMB, "owner"), { id: ids.get(`${PLUMB}:type:fault`)!, marks: ["troubleshooting"] }))
      .rejects.toThrow("No number on your trade's scorecard reads a troubleshooting call, so marking it would change nothing.");
    await expect(packMarks.setJobTypeMarks(as(PLUMB, "owner"), { id: ids.get(`${PLUMB}:type:fault`)!, marks: ["drain_upsell"] }))
      .rejects.toThrow("drain_upsell is not a mark a job type can have.");
  });

  it("is changed only by somebody who changes settings, and a job type of another company is not found", async () => {
    await jobType(PLUMB, "Sewer call", "sewer-call");
    const id = ids.get(`${PLUMB}:type:sewer-call`)!;
    await expect(packMarks.setJobTypeMarks(as(PLUMB, "dispatcher"), { id, marks: ["drain"] })).rejects.toThrow();
    await expect(packMarks.setJobTypeMarks(as(PLUMB, "technician"), { id, marks: ["drain"] })).rejects.toThrow();
    await expect(packMarks.setJobTypeMarks(as(ELEC, "owner"), { id, marks: ["troubleshooting"] })).rejects.toThrow("Job type");
    await expect(packMarks.list(as(PLUMB, "technician"))).rejects.toThrow();
  });
});

run("marking a hand made charge for finding a fault", () => {
  it("stops a call with only that charge on it reading as repair work, and counts a hand made troubleshooting type", async () => {
    const c = await customer(ELEC);
    await jobType(ELEC, "Diagnosis", "diag");
    await jobType(ELEC, "Fault finding", "fault-find");
    await item(ELEC, "FAULT-FEE");
    await job(ELEC, c, "diag", ["FAULT-FEE"]);
    await job(ELEC, c, "fault-find", ["FAULT-FEE"]);

    const before = await figure(ELEC, "diag_conversion");
    expect([before.numerator, before.denominator]).toEqual(["1", "1"]);

    await packMarks.setItemMarks(as(ELEC, "owner"), { id: ids.get(`${ELEC}:item:FAULT-FEE`)!, marks: ["troubleshooting"] });
    await packMarks.setJobTypeMarks(as(ELEC, "owner"), { id: ids.get(`${ELEC}:type:fault-find`)!, marks: ["troubleshooting"] });
    const after = await figure(ELEC, "diag_conversion");
    expect([after.numerator, after.denominator]).toEqual(["0", "2"]);
  });
});
