import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as dwell from "../src/services/workflow-dwell";
import * as workflows from "../src/services/workflows";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * WORK THAT HAS BEEN SITTING THERE TOO LONG
 *
 * The third trigger kind, and the one the other two cannot express. An event
 * fires when something happens and a schedule fires on a clock; neither of
 * them fires when something has NOT happened, and "the estimate nobody
 * answered" is the single most valuable automation a contractor can have,
 * because it is money that quietly did not arrive and leaves no record that
 * it was supposed to.
 *
 * `trigger_kind` has had `dwell` in it since the first migration and nothing
 * fired one.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("dw:org");
const USER = fixtureId("dw:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let customerId = "";
let propertyId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Dwell Co", slug: "dwell-co" });

  const customer = await customers.create(owner(), {
    type: "residential", name: "Della Dwell", phone: "+15125550155",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const property = await properties.create(owner(), {
    address: { line1: "3 Dwell Dr", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  propertyId = property.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.task where organization_id = ${ORG}`;
  await raw`delete from public.workflow_step_run where organization_id = ${ORG}`;
  await raw`delete from public.workflow_run where organization_id = ${ORG}`;
  await raw`delete from public.workflow_version where organization_id = ${ORG}`;
  await raw`delete from public.workflow where organization_id = ${ORG}`;
  await raw`delete from public.domain_event where organization_id = ${ORG}`;
  await raw`delete from public.estimate_option where organization_id = ${ORG}`;
  await raw`delete from public.estimate where organization_id = ${ORG}`;
});

const TASK_STEP = {
  kind: "create_task",
  config: { title: "Chase estimate {{ estimate.number }}", queue: "office" },
};

async function defineDwell(over: Partial<{ shape: string; afterDays: number }> = {}) {
  const flow = await workflows.create(owner(), {
    name: "Chase quiet quotes",
    triggerKind: "dwell",
    dwell: { shape: over.shape ?? "estimate_unanswered", afterDays: over.afterDays ?? 5 },
    steps: [TASK_STEP],
  });
  await workflows.setEnabled(owner(), { id: flow.id, enabled: true });
  return flow.id;
}

/** An estimate sent `daysAgo` days ago and never answered. */
async function quietEstimate(daysAgo: number, number = Math.floor(Math.random() * 1e6)) {
  const [row] = await raw<{ id: string }[]>`
    insert into public.estimate
      (organization_id, number, customer_id, property_id, status, sent_at)
    values (${ORG}, ${number}, ${customerId}, ${propertyId}, 'sent',
            now() - (${daysAgo} || ' days')::interval)
    returning id`;
  return row!.id;
}

/** Only this organization's results, so a stray fixture elsewhere cannot pass a test. */
const ours = (results: dwell.DwellResult[]) => results.filter((r) => r.organizationId === ORG);

run("waiting for something not to happen", () => {
  it("fires for a record that has been sitting there long enough", async () => {
    await defineDwell({ afterDays: 5 });
    await quietEstimate(7, 4001);

    const [result] = ours(await dwell.sweep(db()));
    expect(result!.matched).toBe(1);
    expect(result!.runs[0]!.status).toBe("succeeded");

    const [task] = await raw<{ title: string }[]>`
      select title from public.task where organization_id = ${ORG}`;
    // The placeholder is filled from the event, which is how a chase says
    // which quote it is about.
    expect(task!.title).toBe("Chase estimate 4001");
  });

  it("does not fire before the period is up", async () => {
    await defineDwell({ afterDays: 5 });
    await quietEstimate(2);

    const [result] = ours(await dwell.sweep(db()));
    expect(result!.matched).toBe(0);
    expect(await raw`select id from public.task where organization_id = ${ORG}`).toHaveLength(0);
  });

  it("chases each record once, ever", async () => {
    /**
     * THE ONE THAT MATTERS. A sweep runs every pass and the same estimate is
     * still unanswered on the next one, so without a key on the RECORD this
     * chases the same customer every few minutes until somebody turns the
     * automation off. Keying on the event would not do it: each sweep emits
     * a new event with a new id.
     */
    await defineDwell({ afterDays: 5 });
    await quietEstimate(7);

    await dwell.sweep(db());
    await dwell.sweep(db());
    await dwell.sweep(db());

    expect(await raw`select id from public.task where organization_id = ${ORG}`).toHaveLength(1);
    expect(await raw`select id from public.workflow_run where organization_id = ${ORG}`).toHaveLength(1);
  });

  it("stops once the record leaves the state", async () => {
    // An estimate somebody approved is not a quiet quote any more.
    await defineDwell({ afterDays: 5 });
    const id = await quietEstimate(7);
    await raw`update public.estimate set status = 'approved' where id = ${id}`;

    const [result] = ours(await dwell.sweep(db()));
    expect(result!.matched).toBe(0);
  });

  it("measures from when it entered the state, not from when it was touched", async () => {
    /**
     * `updated_at` is the tempting column and it is wrong: a customer opening
     * the estimate sets `viewed_at` and touches the row, so dwelling on
     * `updated_at` resets the clock every time they look at it without
     * deciding, which is exactly the customer worth chasing.
     */
    await defineDwell({ afterDays: 5 });
    const id = await quietEstimate(7);
    await raw`update public.estimate set status = 'viewed', viewed_at = now(),
              updated_at = now() where id = ${id}`;

    const [result] = ours(await dwell.sweep(db()));
    expect(result!.matched).toBe(1);
  });
});

run("what it will and will not wait on", () => {
  it("offers only the shapes with a timestamp that means what it says", async () => {
    // Every shape needs a column meaning "entered this state". Without one
    // the period is measured from whatever last touched the row.
    const keys = workflows.dwellShapes().map((s) => s.key);
    expect(keys).toContain("estimate_unanswered");
    expect(keys).toContain("invoice_overdue");
    expect(keys).toContain("job_not_invoiced");
  });

  it("refuses a shape this build does not have, when somebody saves it", async () => {
    await expect(workflows.create(owner(), {
      name: "Nonsense", triggerKind: "dwell",
      dwell: { shape: "phases_of_the_moon", afterDays: 5 }, steps: [TASK_STEP],
    })).rejects.toThrow(/no such thing to wait on/);
  });

  it("refuses a period that is not a number of days", async () => {
    await expect(workflows.create(owner(), {
      name: "Whenever", triggerKind: "dwell",
      dwell: { shape: "estimate_unanswered", afterDays: Number("five") }, steps: [TASK_STEP],
    })).rejects.toThrow(/not a number/);
  });

  it("refuses a period longer than a year", async () => {
    // Always somebody's units being wrong.
    await expect(workflows.create(owner(), {
      name: "Eventually", triggerKind: "dwell",
      dwell: { shape: "estimate_unanswered", afterDays: 500 }, steps: [TASK_STEP],
    })).rejects.toThrow(/units/);
  });

  it("names a shape it cannot read rather than silently doing nothing", async () => {
    // Saved before this build could refuse it, or edited in the database.
    const id = await defineDwell();
    await raw`update public.workflow set dwell = '{"shape":"gone","afterDays":5}'::jsonb
              where id = ${id}`;
    const [result] = ours(await dwell.sweep(db()));
    expect(result!.reason).toBe("unknown_shape");
  });

  it("says what it is waiting on, in words", async () => {
    const id = await defineDwell({ afterDays: 1 });
    const [summary] = (await workflows.list(owner())).filter((f) => f.id === id);
    expect(summary!.dwellText).toBe("An estimate nobody answered, after 1 day");
  });

  it("leaves a switched-off automation alone", async () => {
    const id = await defineDwell({ afterDays: 5 });
    await workflows.setEnabled(owner(), { id, enabled: false });
    await quietEstimate(7);
    expect(ours(await dwell.sweep(db()))).toHaveLength(0);
  });
});
