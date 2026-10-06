import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as workflows from "../src/services/workflows";
import { emit } from "../src/services/events";
import { handleEvent, resume } from "../src/services/workflow-runner";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A TRADE PACK'S RECOMMENDED AUTOMATION, TURNED ON
 *
 * The HVAC pack declares one, as data: ring a new plan member to book their
 * first tune up. It is offered beside the product's four only to a company
 * that applied the pack, installed through the same path, labelled with its
 * key so a second press is refused, and runs like any other: the event, the
 * wait parked on the row, the question asked again, the task raised.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("packauto:org");
const USER = fixtureId("packauto:user");
const KEY = "hvac.book_first_tune_up";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (over: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"], ...over }, db: db(),
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Pack Heating", slug: "pack-heating" });
});

const applyHvac = () => raw`insert into public.trade_pack_application (organization_id, pack_id, version)
  values (${ORG}, 'hvac', 1)`;

run("a trade pack's recommended automation", () => {
  it("is offered only to a company that applied the pack, and refused to one that did not", async () => {
    expect((await workflows.recommended(owner())).map((t) => t.key)).not.toContain(KEY);
    await expect(workflows.installTemplate(owner(), { key: KEY })).rejects.toThrow(/has not applied/);

    await applyHvac();
    const offered = (await workflows.recommended(owner())).find((t) => t.key === KEY);
    expect(offered).toMatchObject({
      name: "Ring a new plan member to book their first tune up",
      pack: { id: "hvac", name: expect.any(String) },
      installed: null, blockedBy: null, onForNewCompanies: false,
      parameters: [expect.objectContaining({ key: "days", default: 7, min: 1, max: 60 })],
    });
    // The product's own four are still there, without a pack.
    expect((await workflows.recommended(owner())).filter((t) => t.pack === null)).toHaveLength(4);
  });

  it("installs an ordinary workflow, switched on, with the company's number, once", async () => {
    await applyHvac();
    await expect(workflows.installTemplate(owner(), { key: KEY, values: { days: 61 } }))
      .rejects.toThrow(/cannot be more than 60/);
    const installed = await workflows.installTemplate(owner(), { key: KEY, values: { days: 3 } });
    expect(installed).toMatchObject({ enabled: true, templateKey: KEY });
    const definition = await workflows.definition(owner(), { id: installed.id });
    expect(definition.steps.map((s) => s.kind)).toEqual(["wait", "stop_unless", "create_task"]);
    expect(definition.steps[0]!.config).toMatchObject({ days: 3 });
    expect((await workflows.recommended(owner())).find((t) => t.key === KEY)!.installed)
      .toMatchObject({ id: installed.id, enabled: true });
    await expect(workflows.installTemplate(owner(), { key: KEY })).rejects.toThrow(/already installed/);
  });

  it("runs: a plan sold, the wait, still active, and a call in the office queue", async () => {
    await applyHvac();
    await workflows.installTemplate(owner(), { key: KEY, values: { days: 2 } });
    const [customer] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name)
      values (${ORG}, 'Nora Member') returning id`;
    const [plan] = await raw<{ id: string }[]>`insert into public.agreement_plan (organization_id, name, price)
      values (${ORG}, 'Comfort Club', 180) returning id`;
    const [agreement] = await raw<{ id: string }[]>`insert into public.agreement
      (organization_id, plan_id, customer_id, status, started_on, price, billing_frequency)
      values (${ORG}, ${plan!.id}, ${customer!.id}, 'active', current_date, 180, 'annual') returning id`;
    const event = await inTenant(owner(), (tx) => emit(tx, owner(), {
      name: "agreement.sold", entityType: "agreement", entityId: agreement!.id,
      payload: { agreement: { id: agreement!.id, customerId: customer!.id, planName: "Comfort Club" } },
    }));

    const [summary] = await handleEvent(owner(), event.id);
    expect(summary).toMatchObject({ status: "waiting" });
    const done = await inTenant(owner(), (tx) => resume(tx, owner(), {
      runId: summary!.runId!, now: new Date(Date.now() + 2 * 86_400_000 + 60_000),
    }));
    expect(done).toMatchObject({ status: "succeeded" });
    const tasks = await raw`select title, queue from public.task where organization_id = ${ORG}`;
    expect(tasks).toEqual([{ title: "Book the first tune up on a new Comfort Club plan", queue: "office" }]);
  });
});
