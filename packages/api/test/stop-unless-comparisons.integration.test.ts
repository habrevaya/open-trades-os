import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import type { schema } from "@opentradesos/db";
import * as workflows from "../src/services/workflows";
import * as customFields from "../src/services/custom-fields";
import * as objects from "../src/services/custom-objects";
import { stopUnless } from "../src/services/workflow-steps";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE RECORD QUESTION: GREATER, LESS, ONE OF AND STILL BLANK
 *
 * `stop_unless` asks of a field on one of the company's own records whether it
 * is greater or less than a typed value (a number, or a date where greater is
 * later), one of several typed values, or still blank. The record is read as
 * it is now; a field of a kind the comparison cannot be asked of, or a typed
 * value that cannot be read as the field, fails the step in words; a no ends
 * the run quietly. Real records and real events, as in the neighbouring file.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("stopcompare:org");
const USER = fixtureId("stopcompare:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

type Event = typeof schema.domainEvent.$inferSelect;
const ask = (config: Record<string, unknown>, event: Event) =>
  inTenant(owner(), (tx) => stopUnless(tx, { check: "record_field_unchanged", ...config }, event, 2));
const latestEvent = async (name: string, entityId: string): Promise<Event> => {
  const [row] = await raw`select * from public.domain_event where organization_id = ${ORG}
    and name = ${name} and entity_id = ${entityId} order by created_at desc limit 1`;
  return { ...row, entityType: row!.entity_type, entityId: row!.entity_id, createdAt: row!.created_at } as unknown as Event;
};

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Compare Permits Co", slug: "compare-permits-co" });
  await objects.defineKind(owner(), { key: "permit", label: "Permit", titleLabel: "Permit number" });
  const define = (key: string, label: string, dataType: string, options: string[] = []) =>
    customFields.define(owner(), { entityType: "object:permit", key, label, dataType, options } as never);
  await define("status", "Status", "select", ["submitted", "approved", "refused"]);
  await define("fee", "Fee", "number");
  await define("expires", "Expires", "date");
  await define("trades", "Trades", "multiselect", ["gas", "electric"]);
  await define("inspector", "Inspector", "text");
});

async function aPermit(fields: Record<string, unknown>) {
  const permit = await objects.createRecord(owner(), { type: "permit", title: "P-300", customFields: fields });
  return { permit, created: await latestEvent("record.created", permit.id) };
}

run("greater and less", () => {
  it("compares a number as a number, and ends the run when it is no longer so", async () => {
    const { permit, created } = await aPermit({ fee: 900 });
    expect(await ask({ field: "fee", compare: "greater", value: "500" }, created)).toMatchObject({ ok: true, output: { held: true } });
    expect(await ask({ field: "fee", compare: "greater", value: "900" }, created)).toMatchObject({
      skipOffsets: [1, 2], output: { held: false, because: "P-300's Fee is not greater than 900 now" },
    });
    expect(await ask({ field: "fee", compare: "less", value: "1000" }, created)).toMatchObject({ output: { held: true } });
    /** 90 is less than 500 as a number, and would not be as text. */
    await objects.updateRecord(owner(), { id: permit.id, customFields: { fee: 90 } });
    expect(await ask({ field: "fee", compare: "less", value: "500" }, created)).toMatchObject({ output: { held: true } });
    expect(await ask({ field: "fee", compare: "greater", value: "500" }, created)).toMatchObject({ output: { held: false } });
  });

  it("compares a date as a date, later and earlier, and a blank one is never either", async () => {
    const { permit, created } = await aPermit({ expires: "2026-12-31" });
    expect(await ask({ field: "expires", compare: "greater", value: "2026-06-01" }, created)).toMatchObject({ output: { held: true } });
    expect(await ask({ field: "expires", compare: "less", value: "2026-06-01" }, created)).toMatchObject({
      output: { held: false, because: "P-300's Expires is not earlier than 2026-06-01 now" },
    });
    await objects.updateRecord(owner(), { id: permit.id, customFields: { expires: null } });
    expect(await ask({ field: "expires", compare: "greater", value: "2026-06-01" }, created)).toMatchObject({
      output: { held: false, because: "P-300's Expires is blank now" },
    });
  });

  it("fails the step in words for a field that is not a number or a date, or a value that cannot be read", async () => {
    const { created } = await aPermit({ fee: 900, status: "submitted" });
    expect(await ask({ field: "status", compare: "greater", value: "approved" }, created)).toEqual({
      ok: false, reason: "Status is not a number or a date, so it cannot be greater or less than something. Ask whether it is a value instead.",
    });
    expect(await ask({ field: "fee", compare: "less", value: "a lot" }, created)).toEqual({
      ok: false, reason: "The value typed into this step cannot be compared: Fee has to be a number.",
    });
  });
});

run("one of", () => {
  it("holds while the field is any one of the values, read as the field's kind", async () => {
    const { permit, created } = await aPermit({ status: "submitted", fee: 150 });
    const values = ["submitted", "approved"];
    expect(await ask({ field: "status", compare: "one_of", values }, created)).toMatchObject({ output: { held: true } });
    expect(await ask({ field: "fee", compare: "one_of", values: ["100", "150.00"] }, created)).toMatchObject({ output: { held: true } });
    await objects.updateRecord(owner(), { id: permit.id, customFields: { status: "refused" } });
    expect(await ask({ field: "status", compare: "one_of", values }, created)).toMatchObject({
      output: { held: false, because: "P-300's Status is not one of submitted, approved now" },
    });
  });

  it("fails the step for a typo in any value and for a field with several choices", async () => {
    const { created } = await aPermit({ status: "submitted", trades: ["gas"] });
    expect(await ask({ field: "status", compare: "one_of", values: ["submitted", "aproved"] }, created)).toMatchObject({
      ok: false, reason: expect.stringContaining("Status is not one of the options"),
    });
    expect(await ask({ field: "trades", compare: "one_of", values: ["gas"] }, created)).toMatchObject({
      ok: false, reason: expect.stringContaining("Trades holds several choices"),
    });
  });
});

run("still blank", () => {
  it("holds while nobody has filled the field in, and ends the run once somebody does", async () => {
    const { permit, created } = await aPermit({ status: "submitted" });
    expect(await ask({ field: "inspector", compare: "blank" }, created)).toMatchObject({ ok: true, output: { held: true } });
    await objects.updateRecord(owner(), { id: permit.id, customFields: { inspector: "Dana" } });
    expect(await ask({ field: "inspector", compare: "blank" }, created)).toMatchObject({
      output: { held: false, because: "P-300's Inspector has been filled in" },
    });
    expect(await ask({ field: "colour", compare: "blank" }, created)).toMatchObject({
      ok: false, reason: expect.stringContaining("Permit has no field called colour"),
    });
  });
});

run("publishing", () => {
  it("refuses each comparison without what it needs, with the step's number, and accepts it with it", async () => {
    const make = (config: Record<string, unknown>) => workflows.create(owner(), {
      name: `Permit compare ${Math.random().toString(36).slice(2, 8)}`,
      triggerKind: "event", triggerEvents: ["record.updated"],
      steps: [{ kind: "wait", config: { minutes: 60 } }, { kind: "stop_unless", config: { check: "record_field_unchanged", ...config } }],
    });
    await expect(make({ field: "fee", compare: "greater" })).rejects.toThrow("Step 2: Type the value fee has to stay greater than.");
    await expect(make({ field: "status", compare: "one_of", values: [] })).rejects.toThrow("Step 2: Type the values status may be, one to a line.");
    await expect(make({ field: "fee", compare: "between", value: "1" })).rejects.toThrow(/Step 2: Compare the field with/);
    await expect(make({ field: "fee", compare: "less", value: "500" })).resolves.toBeDefined();
    await expect(make({ field: "status", compare: "one_of", values: ["submitted", "approved"] })).resolves.toBeDefined();
    await expect(make({ field: "inspector", compare: "blank" })).resolves.toBeDefined();
  });
});
