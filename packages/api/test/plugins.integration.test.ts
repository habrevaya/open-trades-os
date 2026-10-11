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
import * as estimates from "../src/services/estimates";
import * as reports from "../src/services/reports";
import * as dispatch from "../src/services/dispatch";
import * as sandbox from "../src/services/sandbox";
import { ConflictError, NotFoundError, UnprocessableError, type ServiceContext } from "../src/services/context";
import { companyToday, resetOrg, seedOrg, testDb, fixtureId } from "./helpers";

/**
 * WHAT A CONNECTED APPLICATION MAY ADD, AND WHAT IT MAY NOT
 *
 * A plugin is data an application registers with its own token: a job
 * workflow, a pricing rule, a report type. The refusals come first, because
 * they are the promise a company relies on when it lets an application in:
 * an application cannot add what it was not given the permission for, it
 * cannot reach another company, and it cannot register a rule or a report
 * that reads something its installer did not let it read. Then what each
 * one does once registered, and that turning the application off turns all
 * of it off.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("plugins:org");
const USER = fixtureId("plugins:user");
const OTHER_ORG = fixtureId("plugins:other-org");
const OTHER_USER = fixtureId("plugins:other-user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (organizationId = ORG, userId = USER): ServiceContext => ({
  actor: { userId, organizationId, roles: ["owner"] as Actor["roles"] }, db: db(),
});

const ALL = { customer: "all", job: "all", visit: "all", estimate: "all", invoice: "all" };

/** An application installed by the owner and the actor its token produces. */
async function appWith(name: string, permissions: Permission[], organizationId = ORG, userId = USER) {
  const app = await apps.install(owner(organizationId, userId), { name, permissions, scopes: ALL });
  const { token } = await apps.issueToken(owner(organizationId, userId), { appId: app.id });
  const resolved = await apps.resolveToken(db(), token);
  return { id: app.id, ctx: (): ServiceContext => ({ actor: resolved!.actor, db: db() }) };
}

let installType = "";
let serviceType = "";
let customerId = "";
let vipId = "";
let propertyId = "";
let itemId = "";
let otherType = "";

const stages = (gates: unknown[] = [{ kind: "checklist", itemId: "permit" }, { kind: "field", key: "permit_number" }]) => [
  { key: "booked", name: "Booked", statuses: ["lead", "estimating", "scheduled"], gates },
  { key: "install", name: "Install", statuses: ["in_progress", "on_hold"] },
  { key: "done", name: "Done", statuses: ["completed", "invoiced", "paid", "cancelled"] },
];

/** A job of the install type, scheduled, with one visit today carrying the type's checklist. */
async function installJob(organizationId = ORG, type = installType) {
  const job = await jobs.create(owner(organizationId), {
    customerId, propertyId, summary: "New furnace", tags: [], customFields: {}, jobTypeId: type,
  });
  await raw`update public.job set status = 'scheduled' where id = ${job.id}`;
  const [visit] = await raw<{ id: string }[]>`insert into public.visit
    (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes, checklist)
    values (${organizationId}, ${job.id}, 'scheduled',
            (${`${companyToday()}T10:00`}::timestamp at time zone ${ZONE}),
            (${`${companyToday()}T12:00`}::timestamp at time zone ${ZONE}), 120,
            ${JSON.stringify([{ id: "permit", label: "Permit pulled", required: true, doneAt: null }])}::jsonb)
    returning id`;
  return { jobId: job.id, visitId: visit!.id };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Plugin Co", slug: "plugins-co" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Other Plugin Co", slug: "plugins-other-co" });
  await raw`update public.organization set timezone = ${ZONE} where id in (${ORG}, ${OTHER_ORG})`;

  const [type] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name, checklist_template)
    values (${ORG}, 'Install', ${JSON.stringify([{ id: "permit", label: "Permit pulled", required: true }])}::jsonb) returning id`;
  installType = type!.id;
  const [service] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name)
    values (${ORG}, 'Service call') returning id`;
  serviceType = service!.id;
  const [other] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name, checklist_template)
    values (${OTHER_ORG}, 'Install', ${JSON.stringify([{ id: "permit", label: "Permit pulled", required: true }])}::jsonb) returning id`;
  otherType = other!.id;

  await fields.define(owner(), { entityType: "job", key: "permit_number", label: "Permit number", dataType: "text" });

  const customer = await customers.create(owner(), {
    type: "residential", name: "Ada Plain", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const vip = await customers.create(owner(), {
    type: "residential", name: "Vic Important", paymentTermsDays: 0, taxExempt: false, tags: ["VIP"], customFields: {},
  });
  vipId = vip.id;
  const property = await properties.create(owner(), {
    address: { line1: "1 Plugin Way", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  propertyId = property.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${vipId}, ${propertyId})`;
  itemId = (await priceBook.create(owner(), { kind: "service", code: "TUNE", name: "Tune up", price: "200.00", taxable: false })).id;
});

afterAll(async () => {
  if (!url) return;
  const made = await raw<{ id: string }[]>`select id from public.organization where sandbox_of_organization_id = ${ORG}`;
  await raw`update public.organization set sandbox_organization_id = null where id = ${ORG}`;
  for (const row of made) await resetOrg(raw, row.id);
  await raw.end();
});

/* ------------------------------------------------------------------ refusals */

run("an application without the permission", () => {
  it("cannot register a job workflow without settings:write", async () => {
    const app = await appWith("Reader", ["job:read", "visit:read"]);
    await expect(plugins.registerJobWorkflow(app.ctx(), {
      key: "install_flow", name: "Install flow", jobTypeId: installType, stages: stages(),
    })).rejects.toMatchObject({ name: "PermissionError", permission: "settings:write" });
  });

  it("cannot register a pricing rule without pricebook:write, nor a report type without report:build", async () => {
    const app = await appWith("Reader", ["job:read", "customer:read", "report:read"]);
    await expect(plugins.registerPricingRule(app.ctx(), {
      key: "vip", name: "VIP", rule: { kind: "customer_tag", tag: "VIP", percent: "-10" },
    })).rejects.toMatchObject({ permission: "pricebook:write" });
    await expect(plugins.registerReportType(app.ctx(), {
      key: "installs", label: "Installs", base: "jobs", measures: ["count"],
    })).rejects.toMatchObject({ permission: "report:build" });
  });

  it("is not a person: an owner signed in cannot register one, because the screen has to say which application added what", async () => {
    await expect(plugins.registerJobWorkflow(owner(), {
      key: "install_flow", name: "Install flow", jobTypeId: installType, stages: stages(),
    })).rejects.toBeInstanceOf(NotFoundError);
    await expect(plugins.mine(owner())).rejects.toBeInstanceOf(NotFoundError);
  });
});

run("an application reaching another company", () => {
  it("cannot hang a workflow on another company's job type, or see or remove another company's plugins", async () => {
    const ours = await appWith("Ours", ["settings:write", "job:read", "visit:read"]);
    await plugins.registerJobWorkflow(ours.ctx(), {
      key: "reach_test", name: "Reach test", jobTypeId: installType, stages: stages([]),
    });
    const theirs = await appWith("Theirs", ["settings:write", "job:read", "visit:read"], OTHER_ORG, OTHER_USER);

    await expect(plugins.registerJobWorkflow(theirs.ctx(), {
      key: "reach_test", name: "Reach test", jobTypeId: installType, stages: stages([]),
    })).rejects.toThrow(/Job type/);
    expect(await plugins.mine(theirs.ctx())).toEqual([]);
    await expect(plugins.retire(theirs.ctx(), { kind: "job_workflow", key: "reach_test" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(plugins.stagesOf(theirs.ctx(), { id: (await installJob()).jobId })).rejects.toBeInstanceOf(NotFoundError);

    // Its own company's job type is its own business, and leaves this company's untouched.
    const own = await plugins.registerJobWorkflow(theirs.ctx(), {
      key: "reach_test", name: "Theirs", jobTypeId: otherType, stages: stages([]),
    });
    expect(own.plugin.on).toBe(true);
    expect((await plugins.mine(ours.ctx())).find((p) => p.key === "reach_test")!.name).toBe("Reach test");

    await plugins.retire(ours.ctx(), { kind: "job_workflow", key: "reach_test" });
  });
});

run("a rule or report that reads what the installer did not give", () => {
  it("refuses a rule on customers' tags from an application that may not read customers", async () => {
    const app = await appWith("Prices only", ["pricebook:write"]);
    await expect(plugins.registerPricingRule(app.ctx(), {
      key: "vip", name: "VIP", rule: { kind: "customer_tag", tag: "VIP", percent: "-10" },
    })).rejects.toMatchObject({ name: "PermissionError", permission: "customer:read" });
    // A minimum charge reads nothing beyond the document, so the same application may register one.
    const ok = await plugins.registerPricingRule(app.ctx(), {
      key: "min_probe", name: "Probe", rule: { kind: "minimum_charge", minimum: "1" },
    });
    expect(ok.changed).toBe(true);
    await plugins.retire(app.ctx(), { kind: "pricing_rule", key: "min_probe" });
  });

  it("refuses a time rule from an application that may not read visits, and a checklist gate likewise", async () => {
    const app = await appWith("Partial", ["pricebook:write", "settings:write", "job:read"]);
    await expect(plugins.registerPricingRule(app.ctx(), {
      key: "evening", name: "Evening", rule: { kind: "time_window", window: "outside_hours", percent: "50" },
    })).rejects.toMatchObject({ permission: "visit:read" });
    await expect(plugins.registerJobWorkflow(app.ctx(), {
      key: "install_flow", name: "Install flow", jobTypeId: installType, stages: stages(),
    })).rejects.toMatchObject({ permission: "visit:read" });
  });

  it("refuses a report type on money from an application that may not read the company's finances", async () => {
    const app = await appWith("Reports", ["report:build", "report:read", "invoice:read"]);
    await expect(plugins.registerReportType(app.ctx(), {
      key: "money", label: "Money", base: "invoices", measures: ["count"],
    })).rejects.toMatchObject({ name: "PermissionError", permission: "report.financial:read" });
  });

  it("refuses what core cannot read in words, every problem at once", async () => {
    const app = await appWith("Sloppy", ["settings:write", "job:read", "visit:read", "pricebook:write", "customer:read"]);
    const refusal = await plugins.registerJobWorkflow(app.ctx(), {
      key: "sloppy", name: "Sloppy", jobTypeId: installType,
      stages: [
        { key: "a", name: "A", statuses: ["lead", "waiting"], gates: [{ kind: "checklist", itemId: "nope" }] },
        { key: "b", name: "B", statuses: ["paid"] },
      ],
    }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(UnprocessableError);
    const said = (refusal as UnprocessableError).issues.map((i) => i.message).join(" ");
    expect(said).toMatch(/"waiting", which is not a job status/);
    expect(said).toMatch(/not on this job type's checklist/);
    expect(said).toMatch(/Not placed: estimating/);
    await expect(plugins.registerPricingRule(app.ctx(), {
      key: "code", name: "Code", rule: { kind: "formula", expression: "price * 2" },
    })).rejects.toBeInstanceOf(UnprocessableError);
  });
});

/* ----------------------------------------------------------- job workflows */

run("a job workflow", () => {
  it("is versioned, a repeat changes nothing, and every registration is audited", async () => {
    const app = await appWith("Flows", ["settings:write", "job:read", "visit:read"]);
    const first = await plugins.registerJobWorkflow(app.ctx(), {
      key: "versions", name: "Versions", jobTypeId: serviceType, stages: stages([]),
    });
    expect(first).toMatchObject({ changed: true, plugin: { version: 1, kind: "job_workflow", on: true } });
    const again = await plugins.registerJobWorkflow(app.ctx(), {
      key: "versions", name: "Versions", jobTypeId: serviceType, stages: stages([]),
    });
    expect(again).toMatchObject({ changed: false, plugin: { version: 1 } });
    const next = await plugins.registerJobWorkflow(app.ctx(), {
      key: "versions", name: "Versions, renamed", jobTypeId: serviceType, stages: stages([]),
    });
    expect(next).toMatchObject({ changed: true, plugin: { version: 2, name: "Versions, renamed" } });
    const kept = await raw`select version from public.app_plugin_version where plugin_id = ${first.plugin.id} order by version`;
    expect(kept.map((r) => r["version"])).toEqual([1, 2]);
    const audited = await raw`select action from public.audit_log where entity_id = ${first.plugin.id} order by created_at`;
    expect(audited.map((r) => r["action"])).toEqual(["plugin.registered", "plugin.registered"]);

    // One workflow per job type: another application's is refused while this one is on.
    const rival = await appWith("Rival", ["settings:write", "job:read", "visit:read"]);
    await expect(plugins.registerJobWorkflow(rival.ctx(), {
      key: "rival", name: "Rival", jobTypeId: serviceType, stages: stages([]),
    })).rejects.toThrow(/Flows already decides how Service call jobs move/);
    await plugins.retire(app.ctx(), { kind: "job_workflow", key: "versions" });
  });

  it("refuses a move past a gate not met, in words, and lets it through once the gates hold", async () => {
    const app = await appWith("Installer", ["settings:write", "job:read", "visit:read"]);
    await plugins.registerJobWorkflow(app.ctx(), { key: "install_flow", name: "Install flow", jobTypeId: installType, stages: stages() });
    const { jobId, visitId } = await installJob();

    await expect(jobs.update(owner(), { id: jobId, status: "in_progress" })).rejects.toThrow(
      'This job cannot leave "Booked" yet: tick "Permit pulled" on a visit and fill in "Permit number" on the job.',
    );
    // Skipping straight to completed is held at the same gates.
    await expect(jobs.update(owner(), { id: jobId, status: "completed" })).rejects.toBeInstanceOf(ConflictError);
    // Cancelling never is.
    const { jobId: other } = await installJob();
    await jobs.update(owner(), { id: other, status: "cancelled" });

    const before = await plugins.stagesOf(owner(), { id: jobId });
    expect(before.workflow).toMatchObject({ name: "Install flow", appName: "Installer", version: 1 });
    expect(before.stages.map((s) => [s.name, s.current])).toEqual([["Booked", true], ["Install", false], ["Done", false]]);
    expect(before.stages[0]!.gates).toEqual([
      { kind: "checklist", label: "Permit pulled", met: false },
      { kind: "field", label: "Permit number", met: false },
    ]);

    // Filling in the field in the same save counts; the checklist still holds it.
    await expect(jobs.update(owner(), { id: jobId, status: "in_progress", customFields: { permit_number: "P-1" } }))
      .rejects.toThrow('This job cannot leave "Booked" yet: tick "Permit pulled" on a visit.');
    await raw`update public.visit set checklist = ${JSON.stringify([{ id: "permit", label: "Permit pulled", required: true, doneAt: new Date().toISOString() }])}::jsonb
      where id = ${visitId}`;
    const moved = await jobs.update(owner(), { id: jobId, status: "in_progress", customFields: { permit_number: "P-1" } });
    expect(moved.status).toBe("in_progress");
    // Going back is never held.
    await jobs.update(owner(), { id: jobId, status: "on_hold" });
    const after = await plugins.stagesOf(owner(), { id: jobId });
    expect(after.stages.find((s) => s.current)!.name).toBe("Install");
  });

  it("shows each job's stage on the board", async () => {
    const { jobId } = await installJob();
    const board = await dispatch.board(owner(), { date: companyToday() });
    const card = board.unassigned.find((v) => v.jobNumber > 0 && v.stage !== undefined && v.id && v.summary === "New furnace");
    expect(card?.stage).toBe("Booked");
    expect(jobId).toBeTruthy();
  });

  it("is copied by the sandbox, standing on its own there with the sandbox's job type", async () => {
    const made = await sandbox.create(owner());
    expect(made.copied.jobWorkflows).toBe(1);
    const [copy] = await raw<{ app_id: string | null; app_name: string; job_type: string; definition: { stages: unknown[] } }[]>`
      select p.app_id, p.app_name, t.name as job_type, p.definition from public.app_plugin p
      join public.job_type t on t.id = p.job_type_id
      where p.organization_id = ${made.sandboxOrganizationId}`;
    expect(copy).toMatchObject({ app_id: null, app_name: "Installer", job_type: "Install" });
    expect(copy!.definition.stages).toHaveLength(3);
  });

  it("is off once its application is turned off, and is listed under it on Settings, Applications", async () => {
    const [{ id: appId }] = await raw<{ id: string }[]>`select app_id as id from public.app_plugin
      where organization_id = ${ORG} and key = 'install_flow' and retired_at is null`;
    const listed = (await apps.list(owner())).find((a) => a.id === appId)!;
    expect(listed.plugins.map((p) => [p.key, p.on])).toContainEqual(["install_flow", true]);

    await apps.revoke(owner(), { id: appId });
    const { jobId } = await installJob();
    const moved = await jobs.update(owner(), { id: jobId, status: "in_progress" });
    expect(moved.status).toBe("in_progress");
    expect((await plugins.stagesOf(owner(), { id: jobId })).workflow).toBeNull();
    const off = (await apps.list(owner())).find((a) => a.id === appId)!;
    expect(off.plugins.map((p) => [p.key, p.on])).toContainEqual(["install_flow", false]);

    // And another application may now take its place for the job type.
    const next = await appWith("Next installer", ["settings:write", "job:read", "visit:read"]);
    const taken = await plugins.registerJobWorkflow(next.ctx(), {
      key: "install_flow", name: "Install flow", jobTypeId: installType, stages: stages([]),
    });
    expect(taken.plugin.on).toBe(true);
    await plugins.retire(next.ctx(), { kind: "job_workflow", key: "install_flow" });
  });
});

/* ----------------------------------------------------------- pricing rules */

run("a pricing rule", () => {
  let pricing: Awaited<ReturnType<typeof appWith>>;

  beforeAll(async () => {
    if (!url) return;
    pricing = await appWith("Pricer", ["pricebook:write", "customer:read", "job:read", "visit:read"]);
  });

  it("takes money off a tagged customer's price book lines after member pricing, and the line says so", async () => {
    await plugins.registerPricingRule(pricing.ctx(), {
      key: "vip", name: "VIP discount", rule: { kind: "customer_tag", tag: "vip", percent: "-10" },
    });
    const invoice = await billing.create(owner(), {
      customerId: vipId, draft: true,
      lines: [
        { priceBookItemId: itemId, name: "Tune up", quantity: "1", unitPrice: "200.00", discountAmount: "0", taxable: false },
        { name: "Typed price", quantity: "1", unitPrice: "50.00", discountAmount: "0", taxable: false },
      ],
    });
    expect(invoice.lines[0]).toMatchObject({ unitPrice: "200.0000", discountAmount: "20.0000" });
    expect(invoice.lines[0]!.pricingRules).toEqual([expect.objectContaining({
      name: "VIP discount", appName: "Pricer", version: 1, kind: "customer_tag", amount: "-20.0000", unitPriceBefore: "200.0000",
    })]);
    // A price somebody typed is left as typed.
    expect(invoice.lines[1]).toMatchObject({ discountAmount: "0.0000", pricingRules: [] });
    expect(invoice.total).toBe("230.0000");

    // Not for a customer without the tag.
    const plain = await billing.create(owner(), {
      customerId, draft: true,
      lines: [{ priceBookItemId: itemId, name: "Tune up", quantity: "1", unitPrice: "200.00", discountAmount: "0", taxable: false }],
    });
    expect(plain.total).toBe("200.0000");
  });

  it("brings a small job up to a minimum charge last, raising the price, and records the new version", async () => {
    await plugins.registerPricingRule(pricing.ctx(), {
      key: "minimum", name: "Minimum call out", rule: { kind: "minimum_charge", minimum: "250" },
    });
    await plugins.registerPricingRule(pricing.ctx(), {
      key: "vip", name: "VIP discount", rule: { kind: "customer_tag", tag: "vip", percent: "-15" },
    });
    const invoice = await billing.create(owner(), {
      customerId: vipId, draft: true,
      lines: [{ priceBookItemId: itemId, name: "Tune up", quantity: "1", unitPrice: "200.00", discountAmount: "0", taxable: false }],
    });
    expect(invoice.total).toBe("250.0000");
    expect(invoice.lines[0]!.pricingRules!.map((r) => [r.name, r.version, r.amount])).toEqual([
      ["VIP discount", 2, "-30.0000"],
      ["Minimum call out", 1, "80.0000"],
    ]);
    expect(invoice.lines[0]).toMatchObject({ unitPrice: "280.0000", discountAmount: "30.0000" });
    await plugins.retire(pricing.ctx(), { kind: "pricing_rule", key: "minimum" });
  });

  it("prices an estimate the same way, and the invoice it becomes carries the rules with the price", async () => {
    const created = await estimates.create(owner(), {
      customerId: vipId, propertyId,
      options: [{
        name: "Tune up", isRecommended: true,
        lines: [{ priceBookItemId: itemId, name: "Tune up", quantity: "1", unitPrice: "200.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false }],
      }],
    }) as unknown as { id: string; options: Array<{ id: string; total: string; lines: Array<{ discountAmount: string; pricingRules: unknown[] }> }> };
    const option = created.options[0]!;
    expect(option.total).toBe("170.0000");
    expect(option.lines[0]!.pricingRules).toHaveLength(1);

    await raw`update public.estimate set status = 'approved', selected_option_id = ${option.id} where id = ${created.id}`;
    const converted = await estimates.convert(owner(), { id: created.id, createJob: true, createInvoice: true });
    const invoice = await billing.get(owner(), { id: converted.invoiceId! });
    expect(invoice.lines[0]!.pricingRules).toEqual([expect.objectContaining({ name: "VIP discount", amount: "-30.0000" })]);
    expect(invoice.total).toBe("170.0000");
  });

  it("is not applied once its application is turned off", async () => {
    await apps.revoke(owner(), { id: pricing.id });
    const invoice = await billing.create(owner(), {
      customerId: vipId, draft: true,
      lines: [{ priceBookItemId: itemId, name: "Tune up", quantity: "1", unitPrice: "200.00", discountAmount: "0", taxable: false }],
    });
    expect(invoice.total).toBe("200.0000");
    expect(invoice.lines[0]!.pricingRules).toEqual([]);
  });
});

/* ------------------------------------------------------------ report types */

run("a report type", () => {
  let reporter: Awaited<ReturnType<typeof appWith>>;

  beforeAll(async () => {
    if (!url) return;
    reporter = await appWith("Reporter", ["report:build", "report:read", "job:read"]);
  });

  it("appears as a dataset of its own, counting only what its filters keep, scoped like its base", async () => {
    await jobs.create(owner(), { customerId, propertyId, summary: "Not an install", tags: [], customFields: {}, jobTypeId: serviceType });
    const registered = await plugins.registerReportType(reporter.ctx(), {
      key: "installs", label: "Install jobs", base: "jobs", dimensions: ["status"], measures: ["count"],
      filters: [{ dimension: "job_type", op: "eq", value: "Install" }],
    });
    expect(registered.plugin).toMatchObject({ kind: "report_type", on: true, name: "Install jobs" });

    const offered = await reports.available(owner());
    expect(offered.find((d) => d.key === "app_installs")).toMatchObject({ label: "Install jobs", dimensions: [{ key: "status", label: "Status" }] });

    const result = await reports.run(owner(), { dataset: "app_installs", dimensions: [], measures: ["count"] });
    const [installs] = await raw<{ n: number }[]>`select count(*)::int as n from public.job
      where organization_id = ${ORG} and job_type_id = ${installType} and deleted_at is null`;
    expect(Number(result.rows[0]!["count"])).toBe(installs!.n);

    // Whoever runs it needs what its base needs.
    const reader: ServiceContext = { actor: { userId: USER, organizationId: ORG, roles: [], grants: ["report:read"] }, db: db() };
    await expect(reports.run(reader, { dataset: "app_installs", dimensions: [], measures: ["count"] })).rejects.toThrow(/job:read/);
    // And a column the type does not offer is not there.
    await expect(reports.run(owner(), { dataset: "app_installs", dimensions: ["customer"], measures: ["count"] }))
      .rejects.toThrow(/Not available/);
  });

  it("refuses a key another application already uses", async () => {
    const rival = await appWith("Rival reports", ["report:build", "report:read", "job:read"]);
    await expect(plugins.registerReportType(rival.ctx(), {
      key: "installs", label: "Mine", base: "jobs", measures: ["count"],
    })).rejects.toThrow(/Reporter already offers a report type under the key "installs"/);
  });

  it("is gone from the report builder once its application is turned off", async () => {
    await apps.revoke(owner(), { id: reporter.id });
    expect((await reports.available(owner())).some((d) => d.key === "app_installs")).toBe(false);
    await expect(reports.run(owner(), { dataset: "app_installs", dimensions: [], measures: ["count"] }))
      .rejects.toThrow(/no dataset called "app_installs"/);
  });
});

run("what an application can read back", () => {
  it("lists only its own plugins, removed ones included", async () => {
    const app = await appWith("Lister", ["settings:write", "job:read", "pricebook:write"]);
    await plugins.registerPricingRule(app.ctx(), { key: "floor", name: "Floor", rule: { kind: "minimum_charge", minimum: "99" } });
    await plugins.retire(app.ctx(), { kind: "pricing_rule", key: "floor" });
    const mine = await plugins.mine(app.ctx());
    expect(mine.map((p) => [p.key, p.on, p.retiredAt !== null])).toEqual([["floor", false, true]]);
    // Removing it again changes nothing.
    expect((await plugins.retire(app.ctx(), { kind: "pricing_rule", key: "floor" })).plugin.on).toBe(false);
    await expect(plugins.retire(app.ctx(), { kind: "report_type", key: "floor" })).rejects.toBeInstanceOf(PermissionError);
  });
});
