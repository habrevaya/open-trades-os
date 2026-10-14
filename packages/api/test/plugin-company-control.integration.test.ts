import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor, type Permission } from "@opentradesos/core";
import * as apps from "../src/services/apps";
import * as plugins from "../src/services/plugins";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as fields from "../src/services/custom-fields";
import * as priceBook from "../src/services/pricebook";
import * as billing from "../src/services/billing";
import * as reports from "../src/services/reports";
import * as sandbox from "../src/services/sandbox";
import { dispatch as http } from "../src/http/dispatch";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { resetOrg, seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE COMPANY CONTROLS EACH PLUGIN, NOT ONLY THE APPLICATION
 *
 * Turning an application off turns everything it added off, which is too
 * much when one discount is wrong. Somebody who may connect applications
 * (`integration:write`) turns one pricing rule, job workflow or report type
 * off on its own and back on. Off means what it always meant for an
 * application that is off: a rule prices nothing, a workflow stops gating,
 * a report type is not offered. The application stays on, its other work
 * carries on, and a new version it registers does not undo the company's
 * decision.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("plugin-control:org");
const USER = fixtureId("plugin-control:user");
const OTHER_ORG = fixtureId("plugin-control:other-org");
const OTHER_USER = fixtureId("plugin-control:other-user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (organizationId = ORG, userId = USER): ServiceContext => ({
  actor: { userId, organizationId, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });

const ALL = { customer: "all", job: "all", visit: "all", estimate: "all", invoice: "all" };

async function appWith(name: string, permissions: Permission[], organizationId = ORG, userId = USER) {
  const app = await apps.install(owner(organizationId, userId), { name, permissions, scopes: ALL });
  const { token } = await apps.issueToken(owner(organizationId, userId), { appId: app.id });
  const resolved = await apps.resolveToken(db(), token);
  return { id: app.id, ctx: (): ServiceContext => ({ actor: resolved!.actor, db: db() }) };
}

let installType = "";
let customerId = "";
let vipId = "";
let propertyId = "";
let itemId = "";

const stages = (gates: unknown[] = [{ kind: "field", key: "permit_number" }]) => [
  { key: "booked", name: "Booked", statuses: ["lead", "estimating", "scheduled"], gates },
  { key: "install", name: "Install", statuses: ["in_progress", "on_hold"] },
  { key: "done", name: "Done", statuses: ["completed", "invoiced", "paid", "cancelled"] },
];

async function installJob() {
  const job = await jobs.create(owner(), {
    customerId, propertyId, summary: "New furnace", tags: [], customFields: {}, jobTypeId: installType,
  });
  await raw`update public.job set status = 'scheduled' where id = ${job.id}`;
  return job.id;
}

const vipInvoice = () => billing.create(owner(), {
  customerId: vipId, draft: true,
  lines: [{ priceBookItemId: itemId, name: "Tune up", quantity: "1", unitPrice: "200.00", discountAmount: "0", taxable: false }],
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Plugin Control Co", slug: "plugin-control-co" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Other Plugin Control Co", slug: "plugin-control-other-co" });
  await raw`update public.organization set timezone = ${ZONE} where id in (${ORG}, ${OTHER_ORG})`;
  const [type] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name)
    values (${ORG}, 'Install') returning id`;
  installType = type!.id;
  await fields.define(owner(), { entityType: "job", key: "permit_number", label: "Permit number", dataType: "text" });
  customerId = (await customers.create(owner(), {
    type: "residential", name: "Ada Plain", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  })).id;
  vipId = (await customers.create(owner(), {
    type: "residential", name: "Vic Important", paymentTermsDays: 0, taxExempt: false, tags: ["VIP"], customFields: {},
  })).id;
  propertyId = (await properties.create(owner(), {
    address: { line1: "1 Control Way", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  })).id;
  itemId = (await priceBook.create(owner(), { kind: "service", code: "TUNE", name: "Tune up", price: "200.00", taxable: false })).id;
});

afterAll(async () => {
  if (!url) return;
  await dropSandboxes();
  await raw.end();
});

/** A sandbox is one per company, so each one a test makes is thrown away before the next. */
async function dropSandboxes() {
  const made = await raw<{ id: string }[]>`select id from public.organization where sandbox_of_organization_id = ${ORG}`;
  await raw`update public.organization set sandbox_organization_id = null where id = ${ORG}`;
  for (const row of made) await resetOrg(raw, row.id);
}

const auditOf = async (id: string) =>
  (await raw`select action from public.audit_log where entity_id = ${id} order by created_at`).map((r) => r["action"]);

run("a pricing rule turned off on its own", () => {
  let pricing: Awaited<ReturnType<typeof appWith>>;
  let vip = "";
  let floor = "";

  beforeAll(async () => {
    if (!url) return;
    pricing = await appWith("Pricer", ["pricebook:write", "customer:read", "job:read", "visit:read"]);
    vip = (await plugins.registerPricingRule(pricing.ctx(), {
      key: "vip", name: "VIP discount", rule: { kind: "customer_tag", tag: "vip", percent: "-10" },
    })).plugin.id;
    floor = (await plugins.registerPricingRule(pricing.ctx(), {
      key: "floor", name: "Minimum call out", rule: { kind: "minimum_charge", minimum: "250" },
    })).plugin.id;
  });

  it("prices nothing while it is off, and the application's other rule carries on", async () => {
    expect((await vipInvoice()).total).toBe("250.0000");

    const off = await plugins.switchPlugin(owner(), { id: vip, on: false, reason: "Wrong for this season" });
    expect(off.plugin).toMatchObject({
      on: false, state: "turned_off", name: "VIP discount",
      turnedOff: { reason: "Wrong for this season" },
    });
    const invoice = await vipInvoice();
    // The discount is gone and the minimum, which is still on, brings the 200 up to 250.
    expect(invoice.lines[0]!.pricingRules!.map((r) => r.name)).toEqual(["Minimum call out"]);
    expect(invoice.total).toBe("250.0000");

    await plugins.switchPlugin(owner(), { id: floor, on: false });
    const bare = await vipInvoice();
    expect(bare.total).toBe("200.0000");
    expect(bare.lines[0]!.pricingRules).toEqual([]);
  });

  it("is on again when the company says so, and the application was never off", async () => {
    await plugins.switchPlugin(owner(), { id: vip, on: true });
    const invoice = await vipInvoice();
    expect(invoice.lines[0]!.pricingRules!.map((r) => r.name)).toEqual(["VIP discount"]);
    expect(invoice.total).toBe("180.0000");
    const listed = (await apps.list(owner())).find((a) => a.id === pricing.id)!;
    expect(listed.status).toBe("active");
    expect(listed.plugins.map((p) => [p.key, p.state])).toEqual(expect.arrayContaining([["vip", "on"], ["floor", "turned_off"]]));
  });

  it("does not undo a price already written, and is audited with who and why", async () => {
    const before = await vipInvoice();
    await plugins.switchPlugin(owner(), { id: vip, on: false, reason: "  Stop it  " });
    const [stored] = await raw<{ total: string }[]>`select total from public.invoice where id = ${before.id}`;
    expect(stored!.total).toBe("180.0000");
    expect(await auditOf(vip)).toEqual(["plugin.registered", "plugin.turned_off", "plugin.turned_on", "plugin.turned_off"]);
    const [line] = await raw<{ after: { because: string }; actor: string }[]>`select after, actor_user_id as actor from public.audit_log
      where entity_id = ${vip} and action = 'plugin.turned_off' order by created_at desc limit 1`;
    expect(line!.after.because).toBe("Stop it");
    expect(line!.actor).toBe(USER);
    const [row] = await raw<{ disabled_by_user_id: string }[]>`select disabled_by_user_id from public.app_plugin where id = ${vip}`;
    expect(row!.disabled_by_user_id).toBe(USER);
  });

  it("is a no-op when it is already in the state asked for: no second audit line", async () => {
    const lines = (await auditOf(vip)).length;
    await plugins.switchPlugin(owner(), { id: vip, on: false });
    expect((await auditOf(vip)).length).toBe(lines);
    await plugins.switchPlugin(owner(), { id: vip, on: true });
    await plugins.switchPlugin(owner(), { id: vip, on: true });
    expect((await auditOf(vip)).length).toBe(lines + 1);
  });

  it("is not switched back on by a new version the application registers", async () => {
    await plugins.switchPlugin(owner(), { id: vip, on: false });
    const next = await plugins.registerPricingRule(pricing.ctx(), {
      key: "vip", name: "VIP discount", rule: { kind: "customer_tag", tag: "vip", percent: "-12" },
    });
    expect(next.plugin).toMatchObject({ version: 2, on: false, state: "turned_off" });
    expect((await vipInvoice()).lines[0]!.pricingRules!.map((r) => r.name)).not.toContain("VIP discount");
    // The application sees it for what it is.
    expect((await plugins.mine(pricing.ctx())).find((p) => p.key === "vip")).toMatchObject({ on: false, state: "turned_off" });
    await plugins.switchPlugin(owner(), { id: vip, on: true });
    expect((await vipInvoice()).lines[0]!.pricingRules!.map((r) => r.name)).toContain("VIP discount");
  });

  it("cannot be turned on once its application removed it, and says so", async () => {
    await plugins.retire(pricing.ctx(), { kind: "pricing_rule", key: "floor" });
    await expect(plugins.switchPlugin(owner(), { id: floor, on: true })).rejects.toThrow(/removed by Pricer/);
    await expect(plugins.switchPlugin(owner(), { id: floor, on: false })).rejects.toBeInstanceOf(ConflictError);
    expect((await plugins.companyList(owner())).find((p) => p.id === floor)).toMatchObject({ state: "removed", on: false });
  });

  it("is said to be off for the application too when the application is turned off underneath it", async () => {
    await plugins.switchPlugin(owner(), { id: vip, on: false });
    await apps.revoke(owner(), { id: pricing.id });
    expect((await plugins.companyList(owner())).find((p) => p.id === vip)).toMatchObject({ state: "app_off", on: false });
  });
});

run("a job workflow turned off on its own", () => {
  let flow: Awaited<ReturnType<typeof appWith>>;
  let flowId = "";

  beforeAll(async () => {
    if (!url) return;
    flow = await appWith("Installer", ["settings:write", "job:read", "visit:read"]);
    flowId = (await plugins.registerJobWorkflow(flow.ctx(), {
      key: "install_flow", name: "Install flow", jobTypeId: installType, stages: stages(),
    })).plugin.id;
  });

  it("stops gating and stops showing stages, and gates again when it is back on", async () => {
    const jobId = await installJob();
    await expect(jobs.update(owner(), { id: jobId, status: "in_progress" })).rejects.toThrow(/This job cannot leave "Booked" yet/);
    expect((await plugins.stagesOf(owner(), { id: jobId })).workflow).toMatchObject({ name: "Install flow" });

    await plugins.switchPlugin(owner(), { id: flowId, on: false, reason: "Too strict" });
    expect((await plugins.stagesOf(owner(), { id: jobId })).workflow).toBeNull();
    expect((await jobs.update(owner(), { id: jobId, status: "in_progress" })).status).toBe("in_progress");

    await plugins.switchPlugin(owner(), { id: flowId, on: true });
    const other = await installJob();
    await expect(jobs.update(owner(), { id: other, status: "in_progress" })).rejects.toThrow(/This job cannot leave "Booked" yet/);
    expect((await plugins.stagesOf(owner(), { id: other })).workflow).toMatchObject({ name: "Install flow" });
  });

  it("still holds the job type while it is off, so another application cannot quietly take its place", async () => {
    await plugins.switchPlugin(owner(), { id: flowId, on: false });
    const rival = await appWith("Rival", ["settings:write", "job:read", "visit:read"]);
    await expect(plugins.registerJobWorkflow(rival.ctx(), {
      key: "rival", name: "Rival", jobTypeId: installType, stages: stages([]),
    })).rejects.toThrow(/Installer already decides how Install jobs move.*turned that one off.*only its application can remove it/);
  });

  it("is not copied by a sandbox as though it were in force", async () => {
    const off = await sandbox.create(owner());
    expect(off.copied.jobWorkflows).toBe(0);
    await dropSandboxes();
    await plugins.switchPlugin(owner(), { id: flowId, on: true });
    const on = await sandbox.create(owner());
    expect(on.copied.jobWorkflows).toBe(1);
  });
});

run("a report type turned off on its own", () => {
  it("is not offered and does not run until it is back on", async () => {
    const reporter = await appWith("Reporter", ["report:build", "report:read", "job:read"]);
    const { plugin } = await plugins.registerReportType(reporter.ctx(), {
      key: "installs", label: "Install jobs", base: "jobs", dimensions: ["status"], measures: ["count"],
    });
    expect((await reports.available(owner())).some((d) => d.key === "app_installs")).toBe(true);

    await plugins.switchPlugin(owner(), { id: plugin.id, on: false });
    expect((await reports.available(owner())).some((d) => d.key === "app_installs")).toBe(false);
    await expect(reports.run(owner(), { dataset: "app_installs", dimensions: [], measures: ["count"] }))
      .rejects.toThrow(/no dataset called "app_installs"/);

    await plugins.switchPlugin(owner(), { id: plugin.id, on: true });
    expect((await reports.available(owner())).some((d) => d.key === "app_installs")).toBe(true);
    await expect(reports.run(owner(), { dataset: "app_installs", dimensions: [], measures: ["count"] })).resolves.toBeTruthy();
  });
});

run("who may, and what they are told", () => {
  let id = "";
  beforeAll(async () => {
    if (!url) return;
    const app = await appWith("Gatekeeper", ["pricebook:write", "customer:read"]);
    id = (await plugins.registerPricingRule(app.ctx(), {
      key: "gate", name: "Gate rule", rule: { kind: "customer_tag", tag: "gold", percent: "-5" },
    })).plugin.id;
  });

  it("needs integration:write to switch and integration:read to list", async () => {
    for (const roles of [["dispatcher"], ["technician"], ["csr"]] as Actor["roles"][]) {
      await expect(plugins.switchPlugin(as(roles), { id, on: false })).rejects.toBeInstanceOf(PermissionError);
    }
    const reader: ServiceContext = { actor: { userId: USER, organizationId: ORG, roles: [], grants: ["integration:read"] }, db: db() };
    await expect(plugins.switchPlugin(reader, { id, on: false })).rejects.toMatchObject({ permission: "integration:write" });
    expect((await plugins.companyList(reader)).some((p) => p.id === id)).toBe(true);
    await expect(plugins.companyList(as(["dispatcher"]))).rejects.toBeInstanceOf(PermissionError);
  });

  it("is not something an application can do to itself or to another", async () => {
    const app = await appWith("Meddler", ["pricebook:write", "customer:read"]);
    await expect(plugins.switchPlugin(app.ctx(), { id, on: false })).rejects.toBeInstanceOf(PermissionError);
  });

  it("cannot reach another company's plugin", async () => {
    await expect(plugins.switchPlugin(owner(OTHER_ORG, OTHER_USER), { id, on: false })).rejects.toBeInstanceOf(NotFoundError);
    expect((await plugins.companyList(owner(OTHER_ORG, OTHER_USER))).some((p) => p.id === id)).toBe(false);
  });

  it("answers a repeat of the same request with the first answer", async () => {
    const keyed: ServiceContext = { ...owner(), idempotencyKey: `plugin-control-${Date.now()}` };
    const first = await plugins.switchPlugin(keyed, { id, on: false, reason: "Once" });
    await plugins.switchPlugin(owner(), { id, on: true });
    const again = await plugins.switchPlugin(keyed, { id, on: false, reason: "Once" });
    expect(again).toEqual(first);
    // The replay did not switch it off a second time.
    expect((await plugins.companyList(owner())).find((p) => p.id === id)!.on).toBe(true);
  });

  it("is on the API: a list, a turn-off with a reason and a turn-on", async () => {
    const call = (method: string, path: string, body?: unknown) => http(new Request(`http://x${path}`, {
      method,
      headers: { "content-type": "application/json", "idempotency-key": `plugin-control-http-${Date.now()}-${Math.random()}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), { db: db(), resolveSession: async () => owner() });

    const listed = await call("GET", "/v1/app-plugins");
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { plugins: { id: string }[] }).plugins.some((p) => p.id === id)).toBe(true);

    const off = await call("POST", `/v1/app-plugins/${id}/turn-off`, { reason: "On the phone" });
    expect(off.status).toBe(201);
    expect(await off.json()).toMatchObject({ plugin: { id, on: false, state: "turned_off", turnedOff: { reason: "On the phone" } } });

    const on = await call("POST", `/v1/app-plugins/${id}/turn-on`, {});
    expect(on.status).toBe(201);
    expect(await on.json()).toMatchObject({ plugin: { id, on: true, state: "on", turnedOff: null } });

    const refused = await http(new Request(`http://x/v1/app-plugins/${id}/turn-off`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": `plugin-control-http-refused-${Date.now()}` }, body: "{}",
    }), { db: db(), resolveSession: async () => as(["dispatcher"]) });
    expect(refused.status).toBe(403);
  });
});
