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
 * THE RECORD QUESTION, COMPARED WITH A VALUE TYPED INTO THE STEP
 *
 * `stop_unless` already asked whether a field on one of the company's records
 * still said what the event carried. Here it is asked whether it still says a
 * value typed into the step, whatever the event said: read as the field's own
 * kind from the record's kind as it is now, ending the run quietly when the
 * record has moved on, and failing the step in words when what was typed cannot
 * be read that way. Real events from real writes, as in the neighbouring file.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("stoptyped:org");
const USER = fixtureId("stoptyped:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

type Event = typeof schema.domainEvent.$inferSelect;
const ask = (config: Record<string, unknown>, event: Event) =>
  inTenant(owner(), (tx) => stopUnless(tx, config, event, 2));
const latestEvent = async (name: string, entityId: string): Promise<Event> => {
  const [row] = await raw`select * from public.domain_event where organization_id = ${ORG}
    and name = ${name} and entity_id = ${entityId} order by created_at desc limit 1`;
  return {
    ...row, entityType: row!.entity_type, entityId: row!.entity_id, createdAt: row!.created_at,
  } as unknown as Event;
};

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Typed Value Co", slug: "typed-value-co" });
  await objects.defineKind(owner(), { key: "permit", label: "Permit", titleLabel: "Permit number" });
  const define = (key: string, label: string, dataType: string, options: string[] = []) =>
    customFields.define(owner(), { entityType: "object:permit", key, label, dataType, options } as never);
  await define("status", "Status", "select", ["submitted", "approved", "refused"]);
  await define("fee", "Fee", "number");
  await define("paid", "Fee paid", "boolean");
  await define("expires", "Expires", "date");
  await define("trades", "Trades", "multiselect", ["gas", "electric", "plumbing"]);
  await define("notes", "Notes", "text");
});

async function aPermit(fields: Record<string, unknown>) {
  const permit = await objects.createRecord(owner(), { type: "permit", title: "P-200", customFields: fields });
  return { permit, created: await latestEvent("record.created", permit.id) };
}

const typed = (field: string, value: string) => ({ check: "record_field_unchanged", field, compare: "value", value });

run("a record question compared with a typed value", () => {
  it("holds while the field is the typed value, whatever the event said", async () => {
    const { permit, created } = await aPermit({ status: "submitted" });
    // The event says submitted; the step asks about approved, which it is not.
    expect(await ask(typed("status", "approved"), created)).toMatchObject({
      skipOffsets: [1, 2], output: { held: false, because: "P-200's Status is not approved now" },
    });
    expect(await ask(typed("status", "submitted"), created)).toMatchObject({ ok: true, output: { held: true } });

    await objects.updateRecord(owner(), { id: permit.id, customFields: { status: "approved" } });
    // The same old event, and the answer is about the record now.
    expect(await ask(typed("status", "approved"), created)).toMatchObject({ ok: true, output: { held: true } });
    expect(await ask(typed("status", "submitted"), created)).toMatchObject({ output: { held: false } });
  });

  it("is the event's comparison unless the step says otherwise", async () => {
    const { permit, created } = await aPermit({ status: "submitted" });
    await objects.updateRecord(owner(), { id: permit.id, customFields: { status: "approved" } });
    expect(await ask({ check: "record_field_unchanged", field: "status" }, created)).toMatchObject({ output: { held: false } });
    expect(await ask({ check: "record_field_unchanged", field: "status", compare: "event" }, created)).toMatchObject({ output: { held: false } });
    /** A typed comparison needs no fields in the event at all. */
    const bare = { ...created, payload: { record: { id: permit.id } } } as Event;
    expect(await ask(typed("status", "approved"), bare)).toMatchObject({ output: { held: true } });
    expect(await ask({ check: "record_field_unchanged", field: "status" }, bare)).toMatchObject({
      output: { held: false, because: "the event carries no fields" },
    });
  });

  it("reads the typed words as the field's own kind", async () => {
    const { created } = await aPermit({
      fee: 150, paid: true, expires: "2026-12-31", trades: ["gas", "plumbing"], notes: "Call the inspector",
    });
    expect(await ask(typed("fee", "150"), created)).toMatchObject({ output: { held: true } });
    expect(await ask(typed("fee", "150.00"), created)).toMatchObject({ output: { held: true } });
    expect(await ask(typed("fee", "151"), created)).toMatchObject({ output: { held: false } });
    expect(await ask(typed("paid", "yes"), created)).toMatchObject({ output: { held: true } });
    expect(await ask(typed("paid", "no"), created)).toMatchObject({ output: { held: false } });
    expect(await ask(typed("expires", "2026-12-31"), created)).toMatchObject({ output: { held: true } });
    expect(await ask(typed("trades", "plumbing, gas"), created)).toMatchObject({ output: { held: true } });
    expect(await ask(typed("trades", "gas"), created)).toMatchObject({ output: { held: false } });
    expect(await ask(typed("notes", "Call the inspector"), created)).toMatchObject({ output: { held: true } });
  });

  it("fails the step, in words, when what was typed cannot be read as that field, rather than quietly ending the run", async () => {
    const { created } = await aPermit({ status: "submitted", fee: 150 });
    expect(await ask(typed("fee", "a lot"), created)).toEqual({
      ok: false, reason: "The value typed into this step cannot be compared: Fee has to be a number.",
    });
    expect(await ask(typed("status", "done"), created)).toMatchObject({
      ok: false, reason: expect.stringContaining("Status is not one of the options (submitted, approved, refused)"),
    });
    expect(await ask(typed("colour", "red"), created)).toMatchObject({
      ok: false, reason: expect.stringContaining("Permit has no field called colour"),
    });
  });

  it("ends the run quietly when the record is gone, like every other question", async () => {
    const { permit, created } = await aPermit({ status: "approved" });
    await objects.removeRecord(owner(), { id: permit.id });
    expect(await ask(typed("status", "approved"), created)).toMatchObject({ output: { held: false, because: "the record is gone" } });
  });

  it("is refused at publish without a value, and accepted with one", async () => {
    const make = (config: Record<string, unknown>) => workflows.create(owner(), {
      name: `Permit chase ${Math.random().toString(36).slice(2, 8)}`,
      triggerKind: "event", triggerEvents: ["record.updated"],
      steps: [{ kind: "wait", config: { minutes: 60 } }, { kind: "stop_unless", config }],
    });
    await expect(make({ check: "record_field_unchanged", field: "status", compare: "value" }))
      .rejects.toThrow(/Step 2: Type the value status has to still be/);
    await expect(make({ check: "record_field_unchanged", field: "status", compare: "value", value: "  " }))
      .rejects.toThrow(/Step 2: Type the value status has to still be/);
    await expect(make({ check: "record_field_unchanged", field: "status", compare: "sideways" }))
      .rejects.toThrow(/Step 2: Compare the field with what the event said/);
    await expect(make({ check: "record_field_unchanged", field: "status", compare: "value", value: "approved" }))
      .resolves.toMatchObject({ id: expect.any(String) });
  });
});
