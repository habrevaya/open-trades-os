import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import type { schema } from "@opentradesos/db";
import * as workflows from "../src/services/workflows";
import * as tasks from "../src/services/tasks";
import * as customFields from "../src/services/custom-fields";
import * as objects from "../src/services/custom-objects";
import { stopUnless } from "../src/services/workflow-steps";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE QUESTIONS ABOUT AN AGREEMENT, A TASK AND THE COMPANY'S OWN RECORDS
 *
 * Each is asked of the database after a wait, the same as the estimate and
 * invoice questions: a yes carries the run on, a no ends it quietly with the
 * rest skipped. The record question compares with what the EVENT carried,
 * so these build real events from real writes rather than inventing payloads
 * the product never emits.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("stopq:org");
const USER = fixtureId("stopq:user");

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
const eventAbout = (entityType: string, entityId: string, payload: Record<string, unknown> = {}, createdAt = new Date()) =>
  ({ entityType, entityId, payload, createdAt, name: "x", id: fixtureId("e") }) as unknown as Event;

let customerId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Questions Co", slug: "questions-co" });
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name)
    values (${ORG}, 'Ada Member') returning id`;
  customerId = c!.id;
});

async function agreement(status = "active"): Promise<string> {
  const [plan] = await raw<{ id: string }[]>`insert into public.agreement_plan (organization_id, name, price)
    values (${ORG}, 'Comfort Club', 180) returning id`;
  const [row] = await raw<{ id: string }[]>`insert into public.agreement
    (organization_id, plan_id, customer_id, status, started_on, ends_on, price, billing_frequency)
    values (${ORG}, ${plan!.id}, ${customerId}, ${status}, '2025-10-01', '2026-10-01', 180, 'annual') returning id`;
  await raw`insert into public.agreement_term (organization_id, agreement_id, term, starts_on, ends_on)
    values (${ORG}, ${row!.id}, 1, '2025-10-01', '2026-10-01')`;
  return row!.id;
}

run("asking about an agreement", () => {
  it("still active holds; cancelled or lapsed ends the run quietly", async () => {
    const id = await agreement();
    const event = eventAbout("agreement", id, { agreement: { id } });
    expect(await ask({ check: "agreement_active" }, event)).toMatchObject({ ok: true, output: { held: true } });
    await raw`update public.agreement set status = 'cancelled' where id = ${id}`;
    expect(await ask({ check: "agreement_active" }, event)).toMatchObject({
      ok: true, skipOffsets: [1, 2], output: { held: false, because: "the agreement is cancelled now" },
    });
    // Named by `agreementId`, the way the visit and cancel events carry it.
    await raw`update public.agreement set status = 'lapsed' where id = ${id}`;
    expect(await ask({ check: "agreement_active" }, eventAbout("customer", customerId, { agreementId: id })))
      .toMatchObject({ output: { held: false, because: "the agreement is lapsed now" } });
  });

  it("renewed since: a new term written after the event, and only after it", async () => {
    const id = await agreement();
    const before = new Date(Date.now() - 60_000);
    const event = eventAbout("agreement", id, { agreement: { id } }, before);
    expect(await ask({ check: "agreement_not_renewed" }, event)).toMatchObject({ output: { held: true } });
    expect(await ask({ check: "agreement_renewed" }, event)).toMatchObject({
      output: { held: false, because: "the agreement has not been renewed since" },
    });

    await raw`insert into public.agreement_term (organization_id, agreement_id, term, starts_on, ends_on)
      values (${ORG}, ${id}, 2, '2026-10-01', '2027-10-01')`;
    expect(await ask({ check: "agreement_not_renewed" }, event)).toMatchObject({
      skipOffsets: [1, 2], output: { held: false, because: "the agreement was renewed since" },
    });
    expect(await ask({ check: "agreement_renewed" }, event)).toMatchObject({ output: { held: true } });

    // An event after that renewal has not seen one since.
    const later = eventAbout("agreement", id, { agreement: { id } }, new Date(Date.now() + 60_000));
    expect(await ask({ check: "agreement_not_renewed" }, later)).toMatchObject({ output: { held: true } });
  });

  it("refuses to guess when the event names no agreement", async () => {
    for (const check of ["agreement_active", "agreement_not_renewed", "agreement_renewed"]) {
      expect(await ask({ check }, eventAbout("customer", customerId))).toMatchObject({
        output: { held: false, because: "the event names no agreement" },
      });
    }
  });
});

run("asking about a task", () => {
  it("open holds; done or dismissed ends the run", async () => {
    const task = await tasks.create(owner(), { title: "Ring the inspector" });
    const event = eventAbout("task", task.id);
    expect(await ask({ check: "task_open" }, event)).toMatchObject({ output: { held: true } });
    await tasks.close(owner(), { id: task.id, outcome: "Rang them" });
    expect(await ask({ check: "task_open" }, event)).toMatchObject({
      skipOffsets: [1, 2], output: { held: false, because: "the task is done now" },
    });

    const other = await tasks.create(owner(), { title: "Chase the deposit" });
    await tasks.close(owner(), { id: other.id, dismissed: true, outcome: "Paid at the door" });
    expect(await ask({ check: "task_open" }, eventAbout("x", "y", { taskId: other.id }))).toMatchObject({
      output: { held: false, because: "the task is dismissed now" },
    });
  });
});

run("asking about one of the company's own records", () => {
  async function permitKind() {
    await objects.defineKind(owner(), { key: "permit", label: "Permit", titleLabel: "Permit number" });
    await customFields.define(owner(), {
      entityType: "object:permit", key: "status", label: "Status", dataType: "select",
      options: ["submitted", "approved", "refused"],
    });
  }

  it("holds while the field still says what the event said, and not once it changes", async () => {
    await permitKind();
    const permit = await objects.createRecord(owner(), {
      type: "permit", title: "P-100", customFields: { status: "submitted" },
    });
    const created = await latestEvent("record.created", permit.id);
    expect(await ask({ check: "record_field_unchanged", field: "status" }, created)).toMatchObject({ output: { held: true } });

    await objects.updateRecord(owner(), { id: permit.id, title: "P-100 (renumbered)" });
    expect(await ask({ check: "record_field_unchanged", field: "status" }, created)).toMatchObject({ output: { held: true } });

    await objects.updateRecord(owner(), { id: permit.id, customFields: { status: "approved" } });
    expect(await ask({ check: "record_field_unchanged", field: "status" }, created)).toMatchObject({
      skipOffsets: [1, 2], output: { held: false, because: "P-100 (renumbered)'s status has changed since" },
    });
    // The event the change raised carries the new value, so asked about it, it holds.
    const changed = await latestEvent("record.updated", permit.id);
    expect(await ask({ check: "record_field_unchanged", field: "status" }, changed)).toMatchObject({ output: { held: true } });

    await objects.removeRecord(owner(), { id: permit.id });
    expect(await ask({ check: "record_field_unchanged", field: "status" }, changed)).toMatchObject({
      output: { held: false, because: "the record is gone" },
    });
  });

  it("is refused at publish without a field, or with one that is not a key", async () => {
    const make = (config: Record<string, unknown>) => workflows.create(owner(), {
      name: `Permit chase ${Math.random().toString(36).slice(2, 8)}`,
      triggerKind: "event", triggerEvents: ["record.updated"],
      steps: [{ kind: "wait", config: { minutes: 60 } }, { kind: "stop_unless", config }],
    });
    await expect(make({ check: "record_field_unchanged" })).rejects.toThrow(/Step 2: Say which field/);
    await expect(make({ check: "record_field_unchanged", field: "Status!" })).rejects.toThrow(/not a field's key/);
    await expect(make({ check: "record_field_unchanged", field: "status" })).resolves.toMatchObject({ id: expect.any(String) });
    await expect(make({ check: "task_open" })).resolves.toMatchObject({ id: expect.any(String) });
  });
});
