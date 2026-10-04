import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, sandbox as rules, customObjects as objectRules, type Actor } from "@opentradesos/core";
import { audit, inTenant, ConflictError, NotFoundError, type ServiceContext } from "./context";
import { createOrganization } from "./organizations";
import { memberActor } from "./session";
import { put } from "./files";
import * as customFields from "./custom-fields";
import * as customObjects from "./custom-objects";
import * as proposalTemplates from "./proposal-templates";
import * as workflows from "./workflows";
import { remember, replayed } from "./once";

/**
 * A SANDBOX: A PRACTICE COPY OF THE COMPANY'S CONFIGURATION
 *
 * An owner who wants to try an automation, a kind of record or a proposal
 * layout should not have to try it on real customers. A sandbox is a SECOND
 * COMPANY, a real tenant, holding a copy of this one's configuration and none
 * of its customers, with optional sample work whose names, streets, emails
 * and phone numbers are invented (core's `sampleCustomer`). Automations run
 * in it exactly as they would here, against the sample work.
 *
 * WHY A SECOND COMPANY AND NOT A FLAG ON RECORDS. Row level security already
 * guarantees that nothing in one company can read or write another, and that
 * guarantee is tested on every table. A sandbox flag on rows would be a
 * second boundary written by hand on every query, and the first query that
 * forgot it would put practice data on a real customer's invoice. As a
 * tenant, nothing tried in a sandbox can reach a real customer, because no
 * query in the sandbox can see one.
 *
 * WHAT IS COPIED: job types, custom fields, the company's kinds of record,
 * automations (every one switched off, so nothing runs until somebody turns
 * it on there), saved reports, and proposal layouts with their cover
 * photographs. WHAT IS NOT: customers, jobs, invoices, money, people other
 * than whoever made it, and every integration, so a sandbox has no texting
 * number, no email sender and no card processor and cannot send anything to
 * anybody but the people in it. Its name says "(sandbox)" wherever the
 * company's name is printed, and every screen says so in a band at the top.
 *
 * COPYING BACK is item by item, chosen, previewed and applied by the real
 * company's own services under the real company's permissions: a kind of
 * record, a custom field, a proposal layout, an automation. A copied back
 * automation arrives switched off when it is new, and as a new version when
 * one by that name exists, keeping whether it was on. A dry run shows what
 * it would do.
 *
 * One sandbox per company at a time. Throwing it away signs everybody out of
 * it and it is never opened again; its rows are left where they are, unread.
 */

/** Make the transaction's tenant another company, for the reads and writes of one step. */
async function enter(tx: Database, organizationId: string): Promise<void> {
  await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
}

async function orgRow(tx: Database, organizationId: string) {
  await enter(tx, organizationId);
  const [row] = await tx.select().from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  if (!row) throw new NotFoundError("Company");
  return row;
}

export interface SandboxStatus {
  /** True when the company signed in is itself a sandbox. */
  isSandbox: boolean;
  /** On a sandbox, the real company it was copied from. */
  production: { id: string; name: string } | null;
  /** On the real company, its sandbox, when it has one. */
  sandbox: { id: string; name: string; createdAt: Date } | null;
}

/**
 * Whether the company signed in is a sandbox, and which is the other half.
 *
 * Read by the band at the top of every screen, so it needs only the session:
 * every member of a sandbox is told they are in one, whatever they may do.
 */
export async function current(ctx: ServiceContext): Promise<SandboxStatus> {
  return inTenant(ctx, async (tx) => {
    const here = await orgRow(tx, ctx.actor.organizationId);
    if (here.sandboxOfOrganizationId) {
      /**
       * The real company's name, through a function rather than a select,
       * because row level security hides another company's row from here.
       * The function answers only for the other half of this company's own
       * pair, and only its name and when it was made.
       */
      const [named] = await tx.execute<{ name: string | null }>(
        sql`select name from app.sandbox_pair(${here.sandboxOfOrganizationId}::uuid)`,
      );
      return {
        isSandbox: true,
        production: { id: here.sandboxOfOrganizationId, name: named?.name ?? "the real company" },
        sandbox: null,
      };
    }
    if (here.sandboxOrganizationId) {
      const [named] = await tx.execute<{ name: string | null; created_at: Date | null }>(
        sql`select name, created_at from app.sandbox_pair(${here.sandboxOrganizationId}::uuid)`,
      );
      return {
        isSandbox: false,
        production: null,
        sandbox: { id: here.sandboxOrganizationId, name: named?.name ?? "", createdAt: new Date(named?.created_at ?? Date.now()) },
      };
    }
    return { isSandbox: false, production: null, sandbox: null };
  });
}

/** The same, for the API and the settings screen, behind a permission. */
export async function status(ctx: ServiceContext) {
  assertCan(ctx.actor, "settings:read");
  return current(ctx);
}

/* ------------------------------------------------------------ making one */

export interface CreateInput {
  /** Sample customers, addresses and jobs, anonymised, from the most recent real jobs. */
  sampleData?: boolean | undefined;
}

export interface Created {
  sandboxOrganizationId: string;
  name: string;
  copied: {
    jobTypes: number; customFields: number; kinds: number; workflows: number; reports: number; proposalTemplates: number;
  };
  sampleJobs: number;
}

/**
 * MAKE THE SANDBOX, in one transaction: the company, its owner, the copied
 * configuration and the sample work, or none of it.
 */
export async function create(ctx: ServiceContext, input: CreateInput = {}): Promise<Created> {
  assertCan(ctx.actor, "sandbox:manage");
  return inTenant(ctx, async (tx) => {
    const again = await replayed<Created>(tx, ctx, "sandbox");
    if (again) return again;

    const production = await orgRow(tx, ctx.actor.organizationId);
    if (production.sandboxOfOrganizationId) {
      throw new ConflictError("This is a sandbox already. Make a sandbox from the real company.");
    }
    if (production.sandboxOrganizationId) {
      throw new ConflictError(
        "This company already has a sandbox. Open it, or throw it away first to start again from today's settings.",
      );
    }

    /* Everything to copy, read as the real company. */
    const jobTypes = await tx.select().from(schema.jobType);
    const fields = await tx.select().from(schema.customFieldDefinition).where(isNull(schema.customFieldDefinition.deletedAt));
    const kinds = await tx.select().from(schema.customObjectType).where(isNull(schema.customObjectType.deletedAt));
    const flows = await tx.select({ workflow: schema.workflow, version: schema.workflowVersion })
      .from(schema.workflow)
      .innerJoin(schema.workflowVersion, eq(schema.workflowVersion.id, schema.workflow.activeVersionId))
      .where(isNull(schema.workflow.deletedAt));
    const reports = await tx.select().from(schema.report).where(isNull(schema.report.deletedAt));
    const templates = await tx.select().from(schema.proposalTemplate).where(isNull(schema.proposalTemplate.deletedAt));
    const coverKeys = templates.map((t) => t.cover?.photoKey).filter((k): k is string => Boolean(k));
    const covers = coverKeys.length === 0 ? [] : await tx.select({ key: schema.storedFile.storageKey, bytes: schema.storedFile.bytes })
      .from(schema.storedFile).where(and(inArray(schema.storedFile.storageKey, coverKeys), isNull(schema.storedFile.deletedAt)));
    const recent = input.sampleData ? await tx.select({
      status: schema.job.status, summary: schema.job.summary, jobTypeId: schema.job.jobTypeId,
      city: schema.property.city, state: schema.property.state, postalCode: schema.property.postalCode,
    }).from(schema.job)
      .innerJoin(schema.property, eq(schema.property.id, schema.job.propertyId))
      .where(isNull(schema.job.deletedAt))
      .orderBy(desc(schema.job.createdAt))
      .limit(rules.MAX_SAMPLE) : [];

    /* The company itself, and its owner: the person making it. */
    const made = await createOrganization(tx, {
      name: rules.sandboxName(production.name),
      timezone: production.timezone,
      ownerUserId: ctx.actor.userId,
    });
    const sandboxId = made.organizationId;
    await tx.update(schema.organization).set({
      legalName: rules.sandboxName(production.legalName ?? production.name),
      currency: production.currency,
      brandColor: production.brandColor,
      primaryTrade: production.primaryTrade,
      settings: production.settings,
      /** Set up already: the wizard is for a real company's first day, and this one copies a real company's. */
      setupCompletedAt: new Date(),
      sandboxOfOrganizationId: production.id,
      updatedAt: new Date(),
    }).where(eq(schema.organization.id, sandboxId));

    /* Job types, with new ids, so templates and sample jobs can point at them. */
    const typeIds = new Map<string, string>();
    for (const type of jobTypes) {
      const id = randomUUID();
      typeIds.set(type.id, id);
      await tx.insert(schema.jobType).values({
        ...type, id, organizationId: sandboxId, businessUnitId: null, requiredAssetIds: [],
        createdAt: new Date(), updatedAt: new Date(),
      });
    }

    for (const kind of kinds) {
      await tx.insert(schema.customObjectType).values({
        ...kind, id: randomUUID(), organizationId: sandboxId, createdByUserId: ctx.actor.userId,
        createdAt: new Date(), updatedAt: new Date(),
      });
    }
    for (const field of fields) {
      await tx.insert(schema.customFieldDefinition).values({
        ...field, id: randomUUID(), organizationId: sandboxId, createdAt: new Date(), updatedAt: new Date(),
      });
    }

    const reportIds = new Map<string, string>();
    for (const saved of reports) {
      const id = randomUUID();
      reportIds.set(saved.id, id);
      await tx.insert(schema.report).values({
        ...saved, id, organizationId: sandboxId, createdByUserId: ctx.actor.userId,
        createdAt: new Date(), updatedAt: new Date(),
      });
    }

    /**
     * Automations, every one SWITCHED OFF, with a saved report a step emails
     * pointed at the sandbox's copy of it. Turning one on is a decision
     * somebody makes in the sandbox, having read it there.
     */
    for (const { workflow, version } of flows) {
      const id = randomUUID();
      const versionId = randomUUID();
      let steps = JSON.stringify(version.steps);
      for (const [from, to] of reportIds) steps = steps.replaceAll(`saved:${from}`, `saved:${to}`);
      await tx.insert(schema.workflow).values({
        organizationId: sandboxId, id, name: workflow.name, description: workflow.description,
        enabled: false, triggerKind: workflow.triggerKind, triggerEvents: workflow.triggerEvents,
        schedule: workflow.schedule, dwell: workflow.dwell, templateKey: workflow.templateKey,
        createdByUserId: ctx.actor.userId,
      });
      await tx.insert(schema.workflowVersion).values({
        id: versionId, organizationId: sandboxId, workflowId: id, version: 1,
        conditions: version.conditions, steps: JSON.parse(steps) as Record<string, unknown>[],
        requiredPermissions: version.requiredPermissions,
        publishedByUserId: ctx.actor.userId, publishedAt: new Date(),
      });
      await tx.update(schema.workflow).set({ activeVersionId: versionId }).where(eq(schema.workflow.id, id));
    }

    /** Proposal layouts, each cover photograph copied into the sandbox's own store. */
    const coverBytes = new Map(covers.map((c) => [c.key, c.bytes] as const));
    for (const template of templates) {
      let cover = template.cover;
      const key = cover?.photoKey;
      if (cover && key) {
        const bytes = coverBytes.get(key);
        cover = bytes
          ? { ...cover, photoKey: (await put(tx, sandboxId, { bytes: new Uint8Array(bytes), uploadedByUserId: ctx.actor.userId })).file.storageKey }
          : { ...cover, photoKey: null };
      }
      await tx.insert(schema.proposalTemplate).values({
        ...template, id: randomUUID(), organizationId: sandboxId, cover,
        jobTypeId: template.jobTypeId ? typeIds.get(template.jobTypeId) ?? null : null,
        createdByUserId: ctx.actor.userId, createdAt: new Date(), updatedAt: new Date(),
      });
    }

    /**
     * SAMPLE WORK, anonymised by construction: a numbered customer at an
     * invented street in the real job's town, the real job's type and a
     * status a sample can honestly have. Nothing billed, so nothing in the
     * sandbox's books pretends to be money.
     */
    let number = 0;
    for (const [index, job] of recent.entries()) {
      const person = rules.sampleCustomer(index, job);
      const [customer] = await tx.insert(schema.customer).values({
        organizationId: sandboxId, name: person.name, email: person.email, phone: person.phone, type: "residential",
      }).returning({ id: schema.customer.id });
      const [place] = await tx.insert(schema.property).values({
        organizationId: sandboxId, addressLine1: person.addressLine1,
        city: person.city ?? "Austin", state: person.state ?? "TX", postalCode: person.postalCode ?? "78701",
      }).returning({ id: schema.property.id });
      await tx.insert(schema.customerProperty).values({
        organizationId: sandboxId, customerId: customer!.id, propertyId: place!.id,
      });
      number += 1;
      const typeName = job.jobTypeId ? jobTypes.find((t) => t.id === job.jobTypeId)?.name : undefined;
      await tx.insert(schema.job).values({
        organizationId: sandboxId, number, customerId: customer!.id, propertyId: place!.id,
        summary: typeName ? `Sample ${typeName.toLowerCase()}` : `Sample job ${number}`,
        jobTypeId: job.jobTypeId ? typeIds.get(job.jobTypeId) ?? null : null,
        status: ["lead", "scheduled", "completed"].includes(job.status) ? job.status
          : ["invoiced", "paid"].includes(job.status) ? "completed" : "scheduled",
      });
    }

    const result: Created = {
      sandboxOrganizationId: sandboxId,
      name: rules.sandboxName(production.name),
      copied: {
        jobTypes: jobTypes.length, customFields: fields.length, kinds: kinds.length,
        workflows: flows.length, reports: reports.length, proposalTemplates: templates.length,
      },
      sampleJobs: number,
    };
    await audit(tx, { ...ctx, actor: { ...ctx.actor, organizationId: sandboxId } },
      "sandbox.created_from", "organization", sandboxId, null, { productionOrganizationId: production.id, ...result });

    /* And the real company remembers it, as itself. */
    await enter(tx, production.id);
    await tx.update(schema.organization).set({ sandboxOrganizationId: sandboxId, updatedAt: new Date() })
      .where(eq(schema.organization.id, production.id));
    await audit(tx, ctx, "sandbox.created", "organization", sandboxId, null, result);
    await remember(tx, ctx, "sandbox", sandboxId, result);
    return result;
  });
}

/**
 * THROW IT AWAY. Everybody in it is signed out of it (their membership there
 * stops being active, which is what resolving a session asks), it is marked
 * discarded so it can never be switched to again, and the real company
 * forgets it, so a new one can be made from today's settings.
 */
export async function discard(ctx: ServiceContext) {
  assertCan(ctx.actor, "sandbox:manage");
  return inTenant(ctx, async (tx) => {
    const production = await orgRow(tx, ctx.actor.organizationId);
    if (production.sandboxOfOrganizationId) {
      throw new ConflictError("Throw a sandbox away from the real company, not from inside it.");
    }
    const sandboxId = production.sandboxOrganizationId;
    if (!sandboxId) throw new NotFoundError("Sandbox");

    await enter(tx, sandboxId);
    await tx.update(schema.membership).set({ active: false, updatedAt: new Date() })
      .where(eq(schema.membership.organizationId, sandboxId));
    await tx.update(schema.organization).set({ sandboxDiscardedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.organization.id, sandboxId));

    await enter(tx, production.id);
    await tx.update(schema.organization).set({ sandboxOrganizationId: null, updatedAt: new Date() })
      .where(eq(schema.organization.id, production.id));
    await audit(tx, ctx, "sandbox.discarded", "organization", sandboxId, null, null);
    return { sandboxOrganizationId: sandboxId, discarded: true as const };
  });
}

/* ------------------------------------------------------ copying back */

/**
 * The settings a company holds that can be copied, each with what makes it
 * the same setting in another company and everything a copy would write.
 * Read as that company, inside the caller's transaction.
 */
async function settingsOf(tx: Database, organizationId: string): Promise<rules.SettingItem[]> {
  await enter(tx, organizationId);
  const items: rules.SettingItem[] = [];
  for (const kind of await tx.select().from(schema.customObjectType)
    .where(isNull(schema.customObjectType.deletedAt)).orderBy(asc(schema.customObjectType.sortOrder))) {
    items.push({
      kind: "custom_object", naturalKey: kind.key, label: kind.label,
      content: {
        label: kind.label, pluralLabel: kind.pluralLabel, description: kind.description, titleLabel: kind.titleLabel,
        links: kind.links, readPermission: kind.readPermission, writePermission: kind.writePermission, sortOrder: kind.sortOrder,
      },
    });
  }
  for (const field of await tx.select().from(schema.customFieldDefinition)
    .where(isNull(schema.customFieldDefinition.deletedAt)).orderBy(asc(schema.customFieldDefinition.sortOrder))) {
    items.push({
      kind: "custom_field", naturalKey: `${field.entityType}:${field.key}`,
      label: `${field.label} (${field.entityType.startsWith(objectRules.ENTITY_PREFIX) ? field.entityType.slice(objectRules.ENTITY_PREFIX.length) : field.entityType})`,
      content: { label: field.label, dataType: field.dataType, options: field.options, required: field.required, sortOrder: field.sortOrder },
    });
  }
  const typeNames = new Map((await tx.select({ id: schema.jobType.id, name: schema.jobType.name }).from(schema.jobType))
    .map((t) => [t.id, t.name] as const));
  const covers = new Map<string, string>();
  for (const template of await tx.select().from(schema.proposalTemplate).where(isNull(schema.proposalTemplate.deletedAt))) {
    const key = template.cover?.photoKey;
    if (key && !covers.has(key)) {
      const [file] = await tx.select({ sha: schema.storedFile.sha256 }).from(schema.storedFile)
        .where(eq(schema.storedFile.storageKey, key)).limit(1);
      covers.set(key, file?.sha ?? key);
    }
    items.push({
      kind: "proposal_template", naturalKey: template.name, label: template.name,
      content: {
        jobType: template.jobTypeId ? typeNames.get(template.jobTypeId) ?? null : null,
        isDefault: template.isDefault,
        cover: template.cover ? { ...template.cover, photoKey: key ? covers.get(key) ?? null : null } : null,
        sections: template.sections, showOptionPhotos: template.showOptionPhotos,
      },
    });
  }
  const reportNames = new Map((await tx.select({ id: schema.report.id, name: schema.report.name }).from(schema.report))
    .map((r) => [r.id, r.name] as const));
  for (const { workflow, version } of await tx.select({ workflow: schema.workflow, version: schema.workflowVersion })
    .from(schema.workflow)
    .innerJoin(schema.workflowVersion, eq(schema.workflowVersion.id, schema.workflow.activeVersionId))
    .where(isNull(schema.workflow.deletedAt))) {
    /** A saved report a step emails, by its name, because its id is different in the other company. */
    let steps = JSON.stringify(version.steps);
    for (const [id, name] of reportNames) steps = steps.replaceAll(`saved:${id}`, `report-named:${name}`);
    items.push({
      kind: "workflow", naturalKey: workflow.name, label: workflow.name,
      content: {
        description: workflow.description, triggerKind: workflow.triggerKind, triggerEvents: workflow.triggerEvents,
        schedule: workflow.schedule, dwell: workflow.dwell, conditions: version.conditions, steps: JSON.parse(steps),
      },
    });
  }
  return items;
}

/**
 * The actor somebody is in the real company, from inside its sandbox: their
 * own membership there, today, with its own permissions. Copying back is
 * done by the real company's services as that person, so it can do nothing
 * there they could not do there themselves.
 */
export async function productionContext(ctx: ServiceContext): Promise<ServiceContext> {
  const actor = await inTenant(ctx, async (tx): Promise<Actor | null> => {
    const here = await orgRow(tx, ctx.actor.organizationId);
    if (!here.sandboxOfOrganizationId) return ctx.actor;
    await enter(tx, here.sandboxOfOrganizationId);
    return memberActor(tx, here.sandboxOfOrganizationId, ctx.actor.userId);
  });
  if (!actor) throw new NotFoundError("Company");
  return { ...ctx, actor };
}

/** What copying back could offer, and what each chosen item would do. Read from either company. */
export async function plan(ctx: ServiceContext, input: { items?: string[] | undefined } = {}) {
  const production = await productionContext(ctx);
  assertCan(production.actor, "sandbox:manage");
  return inTenant(production, async (tx) => {
    const row = await orgRow(tx, production.actor.organizationId);
    if (!row.sandboxOrganizationId) throw new NotFoundError("Sandbox");
    const inSandbox = await settingsOf(tx, row.sandboxOrganizationId);
    const inProduction = await settingsOf(tx, production.actor.organizationId);
    const everything = rules.planCopyBack(inSandbox, inProduction, inSandbox.map(rules.itemId));
    const chosen = input.items ? rules.planCopyBack(inSandbox, inProduction, input.items) : null;
    return {
      available: everything.items.map((item) => ({ ...item, id: rules.itemId(item) })),
      chosen: chosen ? chosen.items.map((item) => ({ ...item, id: rules.itemId(item) })) : null,
      unknown: chosen?.unknown ?? [],
    };
  });
}

/**
 * COPY THE CHOSEN SETTINGS BACK, all of them or none of them.
 *
 * One transaction around the real company's own services, each called as
 * the person copying, so every check those services make (a field that
 * would contradict stored values, a step the person may not publish, a
 * duplicate name) refuses here exactly as it would on that screen, and a
 * refusal of the fourth item takes the first three back with it. A dry run
 * of the route runs all of this and rolls it back.
 */
export async function copyBack(ctx: ServiceContext, input: { items: string[] }) {
  const production = await productionContext(ctx);
  assertCan(production.actor, "sandbox:manage");
  return production.db.transaction(async (raw) => {
    const outer = { ...production, db: raw as unknown as Database };
    return inTenant(outer, async (tx) => {
      const again = await replayed<{ applied: rules.CopyPlanItem[] }>(tx, outer, "sandbox_copy_back");
      if (again) return again;
      const row = await orgRow(tx, outer.actor.organizationId);
      if (!row.sandboxOrganizationId) throw new NotFoundError("Sandbox");
      const sandboxId = row.sandboxOrganizationId;
      const fromSandbox = await settingsOf(tx, sandboxId);
      const here = await settingsOf(tx, outer.actor.organizationId);
      await enter(tx, outer.actor.organizationId);
      const decided = rules.planCopyBack(fromSandbox, here, input.items);
      if (decided.unknown.length > 0) {
        throw new ConflictError(`The sandbox has nothing called ${decided.unknown.join(", ")}. Read the list again and choose from it.`);
      }
      if (decided.items.length === 0) throw new ConflictError("Choose at least one setting to copy back.");
      const inner = { ...outer, db: tx };
      const byId = new Map(fromSandbox.map((item) => [rules.itemId(item), item] as const));
      const existing = new Map(here.map((item) => [rules.itemId(item), item] as const));

      for (const step of decided.items) {
        if (step.action === "same") continue;
        const item = byId.get(rules.itemId(step))!;
        const content = item.content as Record<string, unknown>;
        await applyItem(tx, inner, sandboxId, item, content, existing.has(rules.itemId(step)));
      }
      await audit(tx, outer, "sandbox.copied_back", "organization", sandboxId, null, { items: decided.items });
      const answer = { applied: decided.items };
      await remember(tx, outer, "sandbox_copy_back", sandboxId, answer);
      return answer;
    });
  });
}

/** One setting, written into the real company by its own service. */
async function applyItem(
  tx: Database, ctx: ServiceContext, sandboxId: string, item: rules.SettingItem,
  content: Record<string, unknown>, exists: boolean,
) {
  switch (item.kind) {
    case "custom_object": {
      const input = {
        label: content["label"] as string, pluralLabel: content["pluralLabel"] as string,
        description: content["description"] as string | null, titleLabel: content["titleLabel"] as string,
        links: content["links"] as string[], readPermission: content["readPermission"] as string,
        writePermission: content["writePermission"] as string, sortOrder: content["sortOrder"] as number,
      };
      if (!exists) { await customObjects.defineKind(ctx, { key: item.naturalKey, ...input }); return; }
      await enter(tx, ctx.actor.organizationId);
      const [kind] = await tx.select({ id: schema.customObjectType.id }).from(schema.customObjectType)
        .where(and(eq(schema.customObjectType.key, item.naturalKey), isNull(schema.customObjectType.deletedAt))).limit(1);
      await customObjects.updateKind(ctx, { id: kind!.id, ...input });
      return;
    }
    case "custom_field": {
      const at = item.naturalKey.lastIndexOf(":");
      const entityType = item.naturalKey.slice(0, at);
      const key = item.naturalKey.slice(at + 1);
      const input = {
        label: content["label"] as string, dataType: content["dataType"] as string, options: content["options"] as string[],
        required: content["required"] as boolean, sortOrder: content["sortOrder"] as number,
      };
      if (!exists) { await customFields.define(ctx, { entityType, key, ...input }); return; }
      await enter(tx, ctx.actor.organizationId);
      const [field] = await tx.select({ id: schema.customFieldDefinition.id }).from(schema.customFieldDefinition)
        .where(and(eq(schema.customFieldDefinition.entityType, entityType), eq(schema.customFieldDefinition.key, key),
          isNull(schema.customFieldDefinition.deletedAt))).limit(1);
      await customFields.update(ctx, { id: field!.id, ...input });
      return;
    }
    case "proposal_template": {
      await enter(tx, ctx.actor.organizationId);
      const jobTypeName = content["jobType"] as string | null;
      const [type] = jobTypeName
        ? await tx.select({ id: schema.jobType.id }).from(schema.jobType).where(eq(schema.jobType.name, jobTypeName)).limit(1)
        : [];
      if (jobTypeName && !type) {
        throw new ConflictError(`"${item.label}" belongs to the job type ${jobTypeName}, which the real company does not have.`);
      }
      /** The cover photograph, carried over as bytes into the real company's own store. */
      let cover = content["cover"] as { headline: string; intro: string | null; photoKey: string | null } | null;
      if (cover?.photoKey) {
        await enter(tx, sandboxId);
        const [file] = await tx.select({ bytes: schema.storedFile.bytes }).from(schema.storedFile)
          .where(eq(schema.storedFile.sha256, cover.photoKey)).limit(1);
        await enter(tx, ctx.actor.organizationId);
        cover = file
          ? { ...cover, photoKey: (await put(tx, ctx.actor.organizationId, { bytes: new Uint8Array(file.bytes), uploadedByUserId: ctx.actor.userId })).file.storageKey }
          : { ...cover, photoKey: null };
      }
      const [found] = exists
        ? await tx.select({ id: schema.proposalTemplate.id }).from(schema.proposalTemplate)
          .where(and(eq(schema.proposalTemplate.name, item.naturalKey), isNull(schema.proposalTemplate.deletedAt))).limit(1)
        : [];
      await proposalTemplates.save(ctx, {
        ...(found ? { id: found.id } : {}),
        name: item.naturalKey,
        jobTypeId: type?.id ?? null,
        isDefault: content["isDefault"] as boolean,
        layout: { cover, sections: content["sections"], showOptionPhotos: content["showOptionPhotos"] },
      });
      return;
    }
    case "workflow": {
      await enter(tx, ctx.actor.organizationId);
      let steps = JSON.stringify(content["steps"]);
      for (const saved of await tx.select({ id: schema.report.id, name: schema.report.name }).from(schema.report)
        .where(isNull(schema.report.deletedAt))) {
        steps = steps.replaceAll(`report-named:${saved.name}`, `saved:${saved.id}`);
      }
      if (steps.includes("report-named:")) {
        throw new ConflictError(`"${item.label}" emails a saved report the real company does not have. Save that report there first.`);
      }
      const definition: workflows.WorkflowInput = {
        name: item.naturalKey,
        ...(content["description"] ? { description: content["description"] as string } : {}),
        triggerKind: content["triggerKind"] as workflows.WorkflowInput["triggerKind"],
        ...((content["triggerEvents"] as string[]).length > 0 ? { triggerEvents: content["triggerEvents"] as string[] } : {}),
        ...(content["schedule"] ? { schedule: content["schedule"] as string } : {}),
        ...(content["dwell"] ? { dwell: content["dwell"] as { shape: string; afterDays: number } } : {}),
        conditions: content["conditions"] as workflows.WorkflowInput["conditions"] ?? {},
        steps: JSON.parse(steps) as workflows.WorkflowInput["steps"],
      };
      const [found] = exists
        ? await tx.select({ id: schema.workflow.id }).from(schema.workflow)
          .where(and(eq(schema.workflow.name, item.naturalKey), isNull(schema.workflow.deletedAt))).limit(1)
        : [];
      if (found) await workflows.publish(ctx, { id: found.id, ...definition });
      else await workflows.create(ctx, definition);
      return;
    }
  }
}

/* ---------------------------------------------------- moving between them */

/**
 * Point the session at the other half: the sandbox from the real company, or
 * back. Through a function in the database, because the session table is not
 * the application's to write, and the function itself checks that this
 * person is an active member of where they are going and that it really is
 * this company's sandbox or the company this sandbox was copied from.
 */
export async function switchTo(db: Database, tokenHash: string, organizationId: string): Promise<boolean> {
  const [row] = await db.execute<{ ok: boolean }>(
    sql`select app.switch_session_organization(${tokenHash}, ${organizationId}::uuid) as ok`,
  );
  return row?.ok === true;
}

/* ------------------------------------------------------------ the routes */

export const handlers = {
  getSandbox: async (ctx: ServiceContext) => {
    const found = await status(ctx);
    return { ...found, sandbox: found.sandbox ? { ...found.sandbox, createdAt: found.sandbox.createdAt.toISOString() } : null };
  },
  createSandbox: (ctx: ServiceContext, input: { sampleData?: boolean | undefined }) => create(ctx, input),
  discardSandbox: (ctx: ServiceContext) => discard(ctx),
  getSandboxCopyPlan: (ctx: ServiceContext) => plan(ctx),
  copyBackFromSandbox: (ctx: ServiceContext, input: { items: string[] }) => copyBack(ctx, input),
} as const;
