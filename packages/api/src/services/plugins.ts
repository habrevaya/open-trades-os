import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  assertCan, can, holidays as holidayRules, permissionsFor, plugins as rules, reporting, time,
  type Permission,
} from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, scopeOf, timezoneOf,
  ConflictError, NotFoundError, UnprocessableError, type ServiceContext,
} from "./context";
import { definitionsWithin } from "./custom-fields";
import { jobScopeFilter } from "./scope";
import { weekOf } from "./after-hours";
import { holidaysForJob } from "./holidays";
import { catalogueFor } from "./report-company";
import { available as availableDatasets } from "./reports";
import { remember, replayed } from "./once";

/**
 * PLUGINS: WHAT A CONNECTED APPLICATION ADDED
 *
 * A plugin here is never code uploaded into this server. It is one of three
 * shapes of data an application registers through the API with its own
 * token, checked by core (`core/plugins`) before a row is written:
 *
 *   a JOB WORKFLOW for one job type: named stages over the job statuses the
 *   product already has, and what has to hold before a job leaves a stage;
 *
 *   a PRICING RULE from a closed set of four kinds, applied when lines are
 *   priced, after member pricing and before tax;
 *
 *   a REPORT TYPE cut from one of the report builder's datasets.
 *
 * WHO MAY. Only a connected application, acting with its own token, and
 * only with the permission a person would need to make the same change by
 * hand: `settings:write` for how jobs move, `pricebook:write` for prices,
 * `report:build` for reports. And it may only register what it could read
 * itself: a rule on customers' tags needs `customer:read`, a report needs
 * whatever its columns need. An application holds nothing its installer did
 * not, so this is the installer's authority, checked again at registration.
 *
 * VERSIONED LIKE AN AUTOMATION. Registering a key again is the next version,
 * every version is kept, and a priced line names the version that touched it.
 * Sending the same thing twice changes nothing, which is what makes a retry
 * safe without the application keeping state.
 *
 * ON ONLY WHILE ITS APPLICATION IS. Every read below joins the application
 * and asks that it is active, so turning an application off on Settings,
 * Applications turns off everything it added, at once, with no second step
 * to forget.
 *
 * AND ONLY WHILE THE COMPANY LEAVES IT ON. Somebody with `integration:write`
 * can turn one plugin off on its own (`/settings/apps/added`), and back on,
 * without turning the application off. It is a flag the company owns,
 * separate from the application's own removal: a new version the application
 * registers does not switch back on what the company stopped. Every read
 * asks for it through the one `inForce` condition, so a rule turned off
 * prices nothing, a workflow turned off gates nothing and a report type
 * turned off is not offered, all from the same row at the same moment.
 */

type PluginRow = typeof schema.appPlugin.$inferSelect;

/** On; turned off by the company; its application turned off; or removed by its application. */
export type PluginState = "on" | "turned_off" | "app_off" | "removed";

export interface PluginView {
  id: string;
  appId: string | null;
  appName: string;
  kind: rules.PluginKind;
  key: string;
  name: string;
  version: number;
  jobTypeId: string | null;
  definition: Record<string, unknown>;
  /** What it does, in one sentence. */
  summary: string;
  /** In force: its application is active, it has not been removed and the company has not turned it off. */
  on: boolean;
  /** Why it is not on, or that it is: the one word the screen draws a chip from. */
  state: PluginState;
  /** When the company turned it off, and who, and what they said. Null while it is on. */
  turnedOff: { at: string; by: string | null; reason: string | null } | null;
  retiredAt: string | null;
  registeredAt: string;
  changedAt: string;
}

/** A company holds at most this many of each kind, so pricing a line stays a short read. */
const MAX_PER_KIND = 50;

/* ------------------------------------------------------------ the caller */

/**
 * The application making this call. A person signed in is not one: plugins
 * are registered by an application with its own token, so the Applications
 * screen can always say which application added what. The same 404 as
 * `GET /v1/apps/me`, because there is no application behind a session.
 */
export function callingApp(ctx: ServiceContext): string {
  const agent = ctx.actor.agentId ?? ctx.agentId ?? "";
  if (!agent.startsWith("app:") || ctx.actor.roles.length > 0) {
    throw new NotFoundError("App behind this credential");
  }
  return agent.slice("app:".length);
}

async function activeApp(tx: Database, appId: string): Promise<{ id: string; name: string }> {
  const [app] = await tx.select({ id: schema.connectedApp.id, name: schema.connectedApp.name, status: schema.connectedApp.status })
    .from(schema.connectedApp).where(eq(schema.connectedApp.id, appId)).limit(1);
  if (!app || app.status !== "active") throw new NotFoundError("App behind this credential");
  return { id: app.id, name: app.name };
}

/**
 * Held to what the application may read. Each permission a definition reads
 * is asked for in turn, so the refusal is the ordinary 403 naming what is
 * missing, which is what the application has to ask the company for.
 */
function assertReads(ctx: ServiceContext, reads: readonly Permission[]): void {
  for (const permission of reads) assertCan(ctx.actor, permission);
}

/**
 * In force: not removed, not turned off by the company, and its application
 * active (or a sandbox's own copy, which has none). The one place "in force"
 * is written, so no read can forget one of the three.
 */
const inForce = () => and(
  isNull(schema.appPlugin.retiredAt),
  isNull(schema.appPlugin.disabledAt),
  or(isNull(schema.appPlugin.appId), eq(schema.connectedApp.status, "active")),
);

/* ------------------------------------------------------------- the views */

function summaryOf(row: Pick<PluginRow, "kind" | "definition">, jobTypeName?: string | null): string {
  const definition = row.definition as Record<string, unknown>;
  switch (row.kind) {
    case "job_workflow": {
      const stages = (definition["stages"] as rules.Stage[] | undefined) ?? [];
      return `Stages for ${jobTypeName ?? "a job type"} jobs: ${stages.map((s) => s.name).join(", ")}.`;
    }
    case "pricing_rule":
      return `${rules.describeRule(definition as unknown as rules.PricingRule)}.`;
    case "report_type": {
      const type = definition as unknown as rules.ReportType;
      return `A report type cut from ${type.base}, with ${type.measures.length} ${type.measures.length === 1 ? "number" : "numbers"}.`;
    }
  }
}

function stateOf(row: PluginRow, appStatus: string | null): PluginState {
  if (row.retiredAt !== null) return "removed";
  if (row.appId !== null && appStatus !== "active") return "app_off";
  return row.disabledAt !== null ? "turned_off" : "on";
}

function view(row: PluginRow, appStatus: string | null, jobTypeName?: string | null, disabledBy?: string | null): PluginView {
  return {
    id: row.id,
    appId: row.appId,
    appName: row.appName,
    kind: row.kind,
    key: row.key,
    name: row.name,
    version: row.version,
    jobTypeId: row.jobTypeId,
    definition: row.definition,
    summary: summaryOf(row, jobTypeName),
    on: stateOf(row, appStatus) === "on",
    state: stateOf(row, appStatus),
    turnedOff: row.disabledAt
      ? { at: row.disabledAt.toISOString(), by: disabledBy ?? null, reason: row.disabledReason }
      : null,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    registeredAt: row.createdAt.toISOString(),
    changedAt: row.updatedAt.toISOString(),
  };
}

async function viewsWithin(tx: Database, where: ReturnType<typeof and> | undefined): Promise<PluginView[]> {
  const rows = await tx.select({
    plugin: schema.appPlugin, appStatus: schema.connectedApp.status, jobType: schema.jobType.name, turnedOffBy: schema.user.name,
  })
    .from(schema.appPlugin)
    .leftJoin(schema.connectedApp, eq(schema.connectedApp.id, schema.appPlugin.appId))
    .leftJoin(schema.jobType, eq(schema.jobType.id, schema.appPlugin.jobTypeId))
    .leftJoin(schema.user, eq(schema.user.id, schema.appPlugin.disabledByUserId))
    .where(where)
    .orderBy(asc(schema.appPlugin.kind), asc(schema.appPlugin.name), asc(schema.appPlugin.createdAt));
  return rows.map((r) => view(r.plugin, r.appStatus, r.jobType, r.turnedOffBy));
}

/**
 * The plugins of these applications, for the Applications screen and
 * `GET /v1/apps`, removed ones included so what an application once changed
 * stays visible. Inside the caller's transaction, which has authorised it.
 */
export async function forAppsWithin(tx: Database, appIds: readonly string[]): Promise<Map<string, PluginView[]>> {
  const out = new Map<string, PluginView[]>();
  if (appIds.length === 0) return out;
  for (const plugin of await viewsWithin(tx, and(inArray(schema.appPlugin.appId, [...appIds])))) {
    out.set(plugin.appId!, [...(out.get(plugin.appId!) ?? []), plugin]);
  }
  return out;
}

/** What the calling application has registered here, removed ones included. */
export async function mine(ctx: ServiceContext): Promise<PluginView[]> {
  const appId = callingApp(ctx);
  return inTenant(ctx, async (tx) => {
    await activeApp(tx, appId);
    return viewsWithin(tx, and(eq(schema.appPlugin.appId, appId)));
  });
}

/* ----------------------------------------------------------- registering */

interface Registration {
  kind: rules.PluginKind;
  key: string;
  name: string;
  jobTypeId: string | null;
  definition: Record<string, unknown>;
}

function checkNaming(key: string, name: string): void {
  const issues: Array<{ path: string; message: string }> = [];
  if (!rules.KEY.test(key)) issues.push({ path: "key", message: "A key is lowercase letters, digits and underscores, starting with a letter." });
  if (name.trim().length === 0 || name.trim().length > 120) issues.push({ path: "name", message: "A name is 1 to 120 characters." });
  if (issues.length > 0) throw new UnprocessableError("That plugin cannot be registered", issues);
}

function refused(problems: string[], path: string): never {
  throw new UnprocessableError("That plugin cannot be registered", problems.map((message) => ({ path, message })));
}

/**
 * Two definitions the same, whatever order their keys are in. A stored
 * definition comes back from `jsonb` with its keys sorted, so comparing the
 * text as sent would make every retry a new version.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}
const sameJson = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * Write a registration: the first version, the next one, or nothing when it
 * is what is already in force. Audited either way it changes.
 */
async function write(
  tx: Database, ctx: ServiceContext, app: { id: string; name: string }, input: Registration,
): Promise<{ plugin: PluginRow; changed: boolean }> {
  const [existing] = await tx.select().from(schema.appPlugin)
    .where(and(
      eq(schema.appPlugin.appId, app.id),
      eq(schema.appPlugin.kind, input.kind),
      eq(schema.appPlugin.key, input.key),
    )).limit(1);

  if (existing && existing.retiredAt === null && existing.name === input.name.trim()
    && existing.jobTypeId === input.jobTypeId && sameJson(existing.definition, input.definition)) {
    return { plugin: existing, changed: false };
  }

  if (!existing || existing.retiredAt !== null) {
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(schema.appPlugin)
      .leftJoin(schema.connectedApp, eq(schema.connectedApp.id, schema.appPlugin.appId))
      .where(and(eq(schema.appPlugin.kind, input.kind), inForce())) as [{ count: number }];
    if (count >= MAX_PER_KIND) {
      throw new ConflictError(`This company already has ${MAX_PER_KIND} ${rules.PLUGIN_KIND_LABEL[input.kind].toLowerCase()}s in force. Remove one first.`);
    }
  }

  const now = new Date();
  const version = existing ? existing.version + 1 : 1;
  const values = {
    appName: app.name, name: input.name.trim(), jobTypeId: input.jobTypeId,
    version, definition: input.definition, retiredAt: null, updatedAt: now,
  };
  const [plugin] = existing
    ? await tx.update(schema.appPlugin).set(values).where(eq(schema.appPlugin.id, existing.id)).returning()
    : await tx.insert(schema.appPlugin).values({
      organizationId: ctx.actor.organizationId, appId: app.id, kind: input.kind, key: input.key, ...values,
    }).returning();
  await tx.insert(schema.appPluginVersion).values({
    organizationId: ctx.actor.organizationId, pluginId: plugin!.id, version,
    name: plugin!.name, definition: input.definition,
  });
  const shown = (row: PluginRow | undefined) => row
    ? { kind: row.kind, key: row.key, name: row.name, version: row.version, jobTypeId: row.jobTypeId, definition: row.definition, retiredAt: row.retiredAt }
    : null;
  await audit(tx, ctx, "plugin.registered", "app_plugin", plugin!.id, shown(existing), shown(plugin));
  return { plugin: plugin!, changed: true };
}

/**
 * Another application's plugin holding what this one wants (a job type's
 * workflow, a report type's name). While that application is on, refused in
 * words; once it is off, its plugin is removed, audited, and this one takes
 * the place, because an application turned off can never remove its own.
 */
async function takePlace(
  tx: Database, ctx: ServiceContext, appId: string, holder: { plugin: PluginRow; appStatus: string | null } | undefined, refusal: string,
): Promise<void> {
  if (!holder || holder.plugin.appId === appId) return;
  if (holder.plugin.appId === null || holder.appStatus === "active") {
    throw new ConflictError(holder.plugin.disabledAt
      ? `${refusal} The company has turned that one off, but it is still registered: only its application can remove it.`
      : refusal);
  }
  await tx.update(schema.appPlugin).set({ retiredAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.appPlugin.id, holder.plugin.id));
  await audit(tx, ctx, "plugin.retired", "app_plugin", holder.plugin.id,
    { retiredAt: null }, { retiredAt: new Date().toISOString(), because: "Its application is turned off and another took its place." });
}

/** The shared tail of every registration: the idempotency key, the answer. */
async function registering(
  ctx: ServiceContext, permission: Permission,
  body: (tx: Database, app: { id: string; name: string }) => Promise<{ plugin: PluginRow; changed: boolean }>,
): Promise<{ plugin: PluginView; changed: boolean }> {
  return guardedWrite(ctx, permission, async (tx) => {
    const appId = callingApp(ctx);
    const again = await replayed<{ plugin: PluginView; changed: boolean }>(tx, ctx, "app_plugin");
    if (again) return again;
    const app = await activeApp(tx, appId);
    const { plugin, changed } = await body(tx, app);
    const [jobType] = plugin.jobTypeId
      ? await tx.select({ name: schema.jobType.name }).from(schema.jobType).where(eq(schema.jobType.id, plugin.jobTypeId)).limit(1)
      : [];
    const answer = { plugin: view(plugin, "active", jobType?.name ?? null), changed };
    await remember(tx, ctx, "app_plugin", plugin.id, answer);
    return answer;
  });
}

export interface JobWorkflowInput {
  key: string;
  name: string;
  jobTypeId: string;
  stages: unknown;
}

/**
 * A JOB WORKFLOW, for one job type. `settings:write`, as defining how a
 * kind of work runs is setting the company up, and `job:read` (and
 * `visit:read` for a checklist gate) because every move asks the product to
 * read those for it.
 */
export async function registerJobWorkflow(ctx: ServiceContext, input: JobWorkflowInput) {
  return registering(ctx, "settings:write", async (tx, app) => {
    checkNaming(input.key, input.name);
    assertCan(ctx.actor, "job:read");
    const [type] = await tx.select().from(schema.jobType).where(eq(schema.jobType.id, input.jobTypeId)).limit(1);
    if (!type) throw new NotFoundError("Job type");
    const fields = await definitionsWithin(tx, ctx.actor.organizationId, "job");
    const checked = rules.checkJobWorkflow({ stages: input.stages }, {
      checklistItemIds: type.checklistTemplate.map((item) => item.id),
      fieldKeys: fields.map((field) => field.key),
    });
    if (!checked.ok) refused(checked.problems, "stages");
    assertReads(ctx, rules.workflowReads(checked.value));

    const [holder] = await tx.select({ plugin: schema.appPlugin, appStatus: schema.connectedApp.status })
      .from(schema.appPlugin)
      .leftJoin(schema.connectedApp, eq(schema.connectedApp.id, schema.appPlugin.appId))
      .where(and(
        eq(schema.appPlugin.kind, "job_workflow"), eq(schema.appPlugin.jobTypeId, type.id), isNull(schema.appPlugin.retiredAt),
        or(ne(schema.appPlugin.key, input.key), isNull(schema.appPlugin.appId), ne(schema.appPlugin.appId, app.id)),
      )).limit(1);
    await takePlace(tx, ctx, app.id, holder,
      `${holder?.plugin.appName ?? "Another application"} already decides how ${type.name} jobs move. Only one workflow per job type can be in force.`);
    if (holder && holder.plugin.appId === app.id) {
      throw new ConflictError(`Your workflow "${holder.plugin.name}" already decides how ${type.name} jobs move. Register it again under its own key, or remove it first.`);
    }
    return write(tx, ctx, app, {
      kind: "job_workflow", key: input.key, name: input.name, jobTypeId: type.id,
      definition: checked.value as unknown as Record<string, unknown>,
    });
  });
}

export interface PricingRuleInput {
  key: string;
  name: string;
  rule: unknown;
}

/**
 * A PRICING RULE. `pricebook:write`, as deciding what the company charges
 * is pricing; and the rule may only read what the application may read.
 */
export async function registerPricingRule(ctx: ServiceContext, input: PricingRuleInput) {
  return registering(ctx, "pricebook:write", async (tx, app) => {
    checkNaming(input.key, input.name);
    const types = await tx.select({ id: schema.jobType.id }).from(schema.jobType);
    const checked = rules.checkPricingRule(input.rule, { jobTypeIds: types.map((t) => t.id) });
    if (!checked.ok) refused(checked.problems, "rule");
    assertReads(ctx, rules.RULE_READS[checked.value.kind]);
    return write(tx, ctx, app, {
      kind: "pricing_rule", key: input.key, name: input.name, jobTypeId: null,
      definition: checked.value as unknown as Record<string, unknown>,
    });
  });
}

export interface ReportTypeInput {
  key: string;
  label: string;
  description?: string | undefined;
  base: string;
  dimensions?: string[] | undefined;
  measures: string[];
  filters?: unknown;
}

/**
 * A REPORT TYPE. `report:build`, as saving a report is; and the columns it
 * is built from are held to what the application may read, by the report
 * builder's own check, so it can never offer a column its maker could not
 * see. Whoever runs it later is held to the same columns again.
 */
export async function registerReportType(ctx: ServiceContext, input: ReportTypeInput) {
  return registering(ctx, "report:build", async (tx, app) => {
    checkNaming(input.key, input.label);
    const catalogue = await catalogueFor(tx, ctx.actor.organizationId);
    const checked = rules.checkReportType({
      label: input.label, description: input.description, base: input.base,
      dimensions: input.dimensions ?? [], measures: input.measures, filters: input.filters,
    }, catalogue);
    if (!checked.ok) refused(checked.problems, "base");
    const decision = reporting.resolveReport(
      { dataset: checked.value.base, dimensions: checked.value.dimensions, measures: checked.value.measures, filters: checked.value.filters },
      catalogue, permissionsFor(ctx.actor),
    );
    if (!decision.ok && decision.reason === "missing_permission") assertReads(ctx, decision.permissions);
    if (!decision.ok) refused([reporting.explainRefusal(decision)], "base");

    const [holder] = await tx.select({ plugin: schema.appPlugin, appStatus: schema.connectedApp.status })
      .from(schema.appPlugin)
      .leftJoin(schema.connectedApp, eq(schema.connectedApp.id, schema.appPlugin.appId))
      .where(and(
        eq(schema.appPlugin.kind, "report_type"), eq(schema.appPlugin.key, input.key), isNull(schema.appPlugin.retiredAt),
        ne(schema.appPlugin.appId, app.id),
      )).limit(1);
    await takePlace(tx, ctx, app.id, holder,
      `${holder?.plugin.appName ?? "Another application"} already offers a report type under the key "${input.key}". Choose another key.`);
    return write(tx, ctx, app, {
      kind: "report_type", key: input.key, name: input.label, jobTypeId: null,
      definition: checked.value as unknown as Record<string, unknown>,
    });
  });
}

const RETIRE_PERMISSION: Record<rules.PluginKind, Permission> = {
  job_workflow: "settings:write",
  pricing_rule: "pricebook:write",
  report_type: "report:build",
};

/**
 * Removing one, by the application that registered it, under the same
 * permission it was registered with. Kept as a row (lines and saved reports
 * name it) and never in force again; registering the key again brings it
 * back as the next version. Removing one already removed changes nothing.
 */
export async function retire(ctx: ServiceContext, input: { kind: rules.PluginKind; key: string }): Promise<{ plugin: PluginView }> {
  return guardedWrite(ctx, RETIRE_PERMISSION[input.kind], async (tx) => {
    const appId = callingApp(ctx);
    await activeApp(tx, appId);
    const [row] = await tx.select().from(schema.appPlugin)
      .where(and(eq(schema.appPlugin.appId, appId), eq(schema.appPlugin.kind, input.kind), eq(schema.appPlugin.key, input.key)))
      .limit(1);
    if (!row) throw new NotFoundError(rules.PLUGIN_KIND_LABEL[input.kind]);
    if (row.retiredAt !== null) return { plugin: view(row, "active") };
    const [after] = await tx.update(schema.appPlugin).set({ retiredAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.appPlugin.id, row.id)).returning();
    await audit(tx, ctx, "plugin.retired", "app_plugin", row.id, { retiredAt: null }, { retiredAt: after!.retiredAt });
    return { plugin: view(after!, "active") };
  });
}

/* ------------------------------------------- the company's own control */

/**
 * EVERYTHING EVERY CONNECTED APPLICATION ADDED, for the company that let
 * them in: the list on `/settings/apps/added` and `GET /v1/app-plugins`.
 * Removed ones are kept in the list, said to be removed, because a priced
 * line or a saved report may still name one; a sandbox's own copy of a
 * workflow, which has no application, is listed too.
 */
export async function companyList(ctx: ServiceContext): Promise<PluginView[]> {
  return guardedRead(ctx, "integration:read", (tx) => viewsWithin(tx, undefined));
}

/** What the screen and the audit line say, short, from whatever somebody typed. */
const REASON_MAX = 300;

/**
 * TURN ONE PLUGIN OFF, OR BACK ON, WITHOUT TURNING ITS APPLICATION OFF.
 *
 * `integration:write`, the permission that lets an application in and takes
 * it out: deciding which of what it added still runs is the same decision at
 * a finer grain, and a company that wants one pricing rule to stop should not
 * have to lose the application's other work to do it.
 *
 * WHAT OFF MEANS is whatever `inForce` says, everywhere at once: a rule
 * prices nothing from the next estimate or invoice priced (a document already
 * priced is not repriced, as with a rule an application removes), a workflow
 * stops gating and stops showing its stages, a report type is no longer a
 * dataset (a report saved on it stops running until it is back on, as when
 * its application is off). Nothing the plugin already did is undone.
 *
 * A REMOVED PLUGIN CANNOT BE TURNED ON: its application took it away, and
 * only its application can register it again. Switching one that is already
 * in the state asked for changes nothing and writes nothing, so a retry or a
 * second person pressing the same button is not a second audit line.
 */
export async function switchPlugin(
  ctx: ServiceContext, input: { id: string; on: boolean; reason?: string | undefined },
): Promise<{ plugin: PluginView }> {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const again = await replayed<{ plugin: PluginView }>(tx, ctx, "app_plugin_switch");
    if (again) return again;
    const [row] = await tx.select({ plugin: schema.appPlugin, appStatus: schema.connectedApp.status })
      .from(schema.appPlugin)
      .leftJoin(schema.connectedApp, eq(schema.connectedApp.id, schema.appPlugin.appId))
      .where(eq(schema.appPlugin.id, input.id)).limit(1);
    if (!row) throw new NotFoundError("Plugin");
    const before = row.plugin;
    if (before.retiredAt !== null) {
      throw new ConflictError(
        `${before.name} was removed by ${before.appName}, so there is nothing to turn ${input.on ? "on" : "off"}. `
        + "It comes back only if the application registers it again.",
      );
    }
    const reason = input.reason?.trim() ? input.reason.trim().slice(0, REASON_MAX) : null;
    const already = input.on ? before.disabledAt === null : before.disabledAt !== null;
    let after = before;
    if (!already) {
      const now = new Date();
      [after] = await tx.update(schema.appPlugin).set(input.on
        ? { disabledAt: null, disabledByUserId: null, disabledReason: null, updatedAt: now }
        : { disabledAt: now, disabledByUserId: ctx.actor.userId, disabledReason: reason, updatedAt: now })
        .where(eq(schema.appPlugin.id, before.id)).returning() as [PluginRow];
      const shown = (r: PluginRow) => ({ name: r.name, kind: r.kind, key: r.key, app: r.appName, turnedOffAt: r.disabledAt, because: r.disabledReason });
      await audit(tx, ctx, input.on ? "plugin.turned_on" : "plugin.turned_off", "app_plugin", before.id, shown(before), shown(after));
    }
    const [by] = after.disabledByUserId
      ? await tx.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, after.disabledByUserId)).limit(1)
      : [];
    const [jobType] = after.jobTypeId
      ? await tx.select({ name: schema.jobType.name }).from(schema.jobType).where(eq(schema.jobType.id, after.jobTypeId)).limit(1)
      : [];
    const answer = { plugin: view(after, row.appStatus, jobType?.name ?? null, by?.name ?? null) };
    await remember(tx, ctx, "app_plugin_switch", after.id, answer);
    return answer;
  });
}

/* ------------------------------------------------- job workflows, in use */

export interface ActiveWorkflow {
  id: string;
  name: string;
  appName: string;
  version: number;
  workflow: rules.JobWorkflow;
}

/** The workflow in force for each of these job types, inside the caller's transaction. */
export async function workflowsWithin(tx: Database, jobTypeIds: readonly string[]): Promise<Map<string, ActiveWorkflow>> {
  const out = new Map<string, ActiveWorkflow>();
  const ids = [...new Set(jobTypeIds)];
  if (ids.length === 0) return out;
  const rows = await tx.select({ plugin: schema.appPlugin })
    .from(schema.appPlugin)
    .leftJoin(schema.connectedApp, eq(schema.connectedApp.id, schema.appPlugin.appId))
    .where(and(
      eq(schema.appPlugin.kind, "job_workflow"), inArray(schema.appPlugin.jobTypeId, ids), isNotNull(schema.appPlugin.jobTypeId),
      inForce(),
    ));
  for (const { plugin } of rows) {
    out.set(plugin.jobTypeId!, {
      id: plugin.id, name: plugin.name, appName: plugin.appName, version: plugin.version,
      workflow: plugin.definition as unknown as rules.JobWorkflow,
    });
  }
  return out;
}

type JobFacts = Pick<typeof schema.job.$inferSelect, "id" | "jobTypeId" | "customFields">;

/** What the gates ask about one job: its visits' ticked items and its own fields. */
async function gateFactsWithin(tx: Database, organizationId: string, job: JobFacts, fields: Record<string, unknown>): Promise<rules.GateFacts> {
  const [type] = job.jobTypeId
    ? await tx.select({ checklist: schema.jobType.checklistTemplate }).from(schema.jobType).where(eq(schema.jobType.id, job.jobTypeId)).limit(1)
    : [];
  const visits = await tx.select({ checklist: schema.visit.checklist }).from(schema.visit)
    .where(and(eq(schema.visit.jobId, job.id), ne(schema.visit.status, "cancelled")));
  const done = new Set(visits.flatMap((v) => v.checklist.filter((item) => item.doneAt !== null).map((item) => item.id)));
  const definitions = await definitionsWithin(tx, organizationId, "job");
  const filled = new Set(Object.entries(fields).filter(([, value]) => rules.holdsValue(value)).map(([key]) => key));
  const itemLabels = new Map((type?.checklist ?? []).map((item) => [item.id, item.label]));
  const fieldLabels = new Map(definitions.map((d) => [d.key, d.label]));
  return {
    done, filled,
    checklistLabel: (id) => itemLabels.get(id) ?? id,
    fieldLabel: (key) => fieldLabels.get(key) ?? key,
  };
}

/**
 * HOLD A MOVE TO THE GATES OF THE JOB TYPE'S WORKFLOW.
 *
 * Called by `jobs.update`, the move a person or an application asks for,
 * with the fields as they will be after the same update, so filling in the
 * permit number and moving the job on can be one save. The moves the
 * product makes itself because something happened (a visit booked, the
 * last visit finished, an invoice issued, paid or voided) do not come
 * through here: they record a fact, and refusing a fact leaves the job
 * saying something that is not true.
 */
export async function assertMoveWithin(
  tx: Database, ctx: ServiceContext, job: JobFacts & { status: string }, to: string, fields: Record<string, unknown>,
): Promise<void> {
  if (!job.jobTypeId || to === job.status) return;
  const active = (await workflowsWithin(tx, [job.jobTypeId])).get(job.jobTypeId);
  if (!active) return;
  if (rules.gatesToPass(active.workflow, job.status, to).length === 0) return;
  const facts = await gateFactsWithin(tx, ctx.actor.organizationId, job, fields);
  const refusal = rules.moveRefusal(active.workflow, job.status, to, facts);
  if (refusal) throw new ConflictError(refusal);
}

export interface StagesView {
  workflow: { id: string; name: string; appName: string; version: number } | null;
  stages: Array<{
    key: string;
    name: string;
    statuses: string[];
    current: boolean;
    gates: Array<{ kind: "checklist" | "field"; label: string; met: boolean | null }>;
  }>;
}

/**
 * A job's stages, for its page and `GET /v1/jobs/{id}/stages`: where it is,
 * and what each stage waits on, met or not. A checklist gate is shown as
 * not known (`met: null`) to somebody who may not read visits, because
 * whether an item is ticked is a fact about a visit.
 */
export async function stagesOf(ctx: ServiceContext, input: { id: string }): Promise<StagesView> {
  return guardedRead(ctx, "job:read", async (tx) => {
    const [job] = await tx.select().from(schema.job)
      .where(and(eq(schema.job.id, input.id), isNull(schema.job.deletedAt), jobScopeFilter(scopeOf(ctx, "job"), ctx.actor)))
      .limit(1);
    if (!job) throw new NotFoundError("Job");
    if (!job.jobTypeId) return { workflow: null, stages: [] };
    const active = (await workflowsWithin(tx, [job.jobTypeId])).get(job.jobTypeId);
    if (!active) return { workflow: null, stages: [] };
    const facts = await gateFactsWithin(tx, ctx.actor.organizationId, job, job.customFields);
    const seesVisits = can(ctx.actor, "visit:read");
    const here = rules.stageOf(active.workflow, job.status)?.index ?? -1;
    return {
      workflow: { id: active.id, name: active.name, appName: active.appName, version: active.version },
      stages: active.workflow.stages.map((stage, index) => ({
        key: stage.key,
        name: stage.name,
        statuses: stage.statuses,
        current: index === here,
        gates: stage.gates.map((gate) => ({
          kind: gate.kind,
          label: gate.kind === "checklist" ? facts.checklistLabel(gate.itemId) : facts.fieldLabel(gate.key),
          met: gate.kind === "checklist" && !seesVisits ? null : rules.gateMet(gate, facts),
        })),
      })),
    };
  });
}

/** The stage name of each job, for the board, or null where its type has no workflow in force. */
export async function stageNamesWithin(
  tx: Database, jobs: ReadonlyArray<{ jobId: string; jobTypeId: string | null; status: string }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const active = await workflowsWithin(tx, jobs.map((j) => j.jobTypeId).filter((id): id is string => id !== null));
  if (active.size === 0) return out;
  for (const job of jobs) {
    const workflow = job.jobTypeId ? active.get(job.jobTypeId) : undefined;
    const stage = workflow ? rules.stageOf(workflow.workflow, job.status) : null;
    if (stage) out.set(job.jobId, stage.stage.name);
  }
  return out;
}

/* -------------------------------------------------- pricing rules, in use */

/** The rules in force, oldest first, which is the order within each step of core's order. */
export async function pricingRulesWithin(tx: Database): Promise<rules.ActiveRule[]> {
  const rows = await tx.select({ plugin: schema.appPlugin })
    .from(schema.appPlugin)
    .leftJoin(schema.connectedApp, eq(schema.connectedApp.id, schema.appPlugin.appId))
    .where(and(eq(schema.appPlugin.kind, "pricing_rule"), inForce()))
    .orderBy(asc(schema.appPlugin.createdAt), asc(schema.appPlugin.id));
  return rows.map(({ plugin }) => ({
    id: plugin.id, name: plugin.name, appName: plugin.appName, version: plugin.version,
    rule: plugin.definition as unknown as rules.PricingRule,
  }));
}

/**
 * What the rules ask about a sale. The customer is the one whose work it
 * is (the job's, when there is a job, as sales tax decides it), and the
 * time is the start of the window of the job's first visit not cancelled,
 * in the company's zone, as the after hours rate counts it.
 */
async function ruleFactsWithin(
  tx: Database, organizationId: string, sale: { customerId: string; jobId: string | null }, active: readonly rules.ActiveRule[],
): Promise<rules.RuleFacts> {
  const [job] = sale.jobId
    ? await tx.select({ customerId: schema.job.customerId, jobTypeId: schema.job.jobTypeId })
      .from(schema.job).where(eq(schema.job.id, sale.jobId)).limit(1)
    : [];
  const [customer] = await tx.select({ tags: schema.customer.tags }).from(schema.customer)
    .where(eq(schema.customer.id, job?.customerId ?? sale.customerId)).limit(1);

  let work: rules.RuleFacts["work"] = null;
  if (sale.jobId && active.some((r) => r.rule.kind === "time_window")) {
    const [visit] = await tx.select({ windowStart: schema.visit.windowStart }).from(schema.visit)
      .where(and(eq(schema.visit.jobId, sale.jobId), ne(schema.visit.status, "cancelled"), isNotNull(schema.visit.windowStart)))
      .orderBy(asc(schema.visit.windowStart)).limit(1);
    if (visit?.windowStart) {
      const zone = await timezoneOf(tx, organizationId);
      const date = time.dateIn(visit.windowStart, zone);
      const minute = time.minutesInDay(visit.windowStart, zone);
      const outsideHours = active.some((r) => r.rule.window === "outside_hours")
        ? holidayRules.bookedAt({ week: await weekOf(tx), holidays: await holidaysForJob(tx, organizationId, sale.jobId), date, minute }).outsideHours
        : false;
      work = { dayOfWeek: new Date(`${date}T00:00:00Z`).getUTCDay(), minute, outsideHours };
    }
  }
  return { customerTags: customer?.tags ?? [], jobTypeId: job?.jobTypeId ?? null, work };
}

/**
 * The rules applied to a document's lines, inside the transaction pricing
 * it, or null when no rule is in force (so the caller leaves its lines
 * exactly as they were). Never refuses: a rule that does not hold for this
 * sale does nothing, and an application being off means its rules are not
 * read at all.
 */
export async function applyRulesWithin(
  tx: Database, organizationId: string, sale: { customerId: string; jobId: string | null }, lines: readonly rules.RuleLine[],
): Promise<rules.RuledLine[] | null> {
  const active = await pricingRulesWithin(tx);
  if (active.length === 0 || lines.length === 0) return null;
  const facts = await ruleFactsWithin(tx, organizationId, sale, active);
  return rules.applyPricingRules(lines, active, facts);
}

/* ----------------------------------------------------------- the routes */

export const handlers = {
  listPlugins: async (ctx: ServiceContext) => ({ plugins: await mine(ctx) }),
  listAppPlugins: async (ctx: ServiceContext) => ({ plugins: await companyList(ctx) }),
  turnPluginOff: (ctx: ServiceContext, input: { id: string; reason?: string | undefined }) =>
    switchPlugin(ctx, { id: input.id, on: false, ...(input.reason !== undefined ? { reason: input.reason } : {}) }),
  turnPluginOn: (ctx: ServiceContext, input: { id: string }) => switchPlugin(ctx, { id: input.id, on: true }),
  registerJobWorkflow: (ctx: ServiceContext, input: JobWorkflowInput) => registerJobWorkflow(ctx, input),
  retireJobWorkflow: (ctx: ServiceContext, input: { key: string }) => retire(ctx, { kind: "job_workflow", key: input.key }),
  registerPricingRule: (ctx: ServiceContext, input: PricingRuleInput) => registerPricingRule(ctx, input),
  retirePricingRule: (ctx: ServiceContext, input: { key: string }) => retire(ctx, { kind: "pricing_rule", key: input.key }),
  registerReportType: (ctx: ServiceContext, input: ReportTypeInput) => registerReportType(ctx, input),
  retireReportType: (ctx: ServiceContext, input: { key: string }) => retire(ctx, { kind: "report_type", key: input.key }),
  getJobStages: (ctx: ServiceContext, input: { id: string }) => stagesOf(ctx, input),
  /**
   * The report builder's catalogue as the caller may use it, which is what
   * a report type is built from. `reports.available` filters by what the
   * caller holds and asks for nothing itself, so the gate is here.
   */
  listReportDatasets: async (ctx: ServiceContext) => {
    assertCan(ctx.actor, "report:read");
    return { datasets: await availableDatasets(ctx) };
  },
} as const;
