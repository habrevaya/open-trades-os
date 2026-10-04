import { and, asc, desc, eq, ilike, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, can, customObjects as rules, reporting, type Permission } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, scopeOf, decodeCursor, paginate,
  ConflictError, NotFoundError, UnprocessableError, type ServiceContext,
} from "./context";
import { refusingDuplicate } from "./duplicates";
import { definitionsWithin, enforceWithin, filterCondition } from "./custom-fields";
import { emit } from "./events";
import { jobVisibility } from "./scope";
import { remember, replayed } from "./once";

/**
 * A COMPANY'S OWN KINDS OF RECORD
 *
 * "Where do we keep the permits" was answered with a spreadsheet beside this
 * product, because nothing here could hold a list of something the product
 * had never heard of. A kind of record is that list: a name, its own fields,
 * what each one may point at (a customer, an address, a job, a unit) and who
 * may see and change one. Its list, its form and its page are drawn from the
 * definition; it is searchable, exported and imported as a CSV, in the
 * company's data export, a trigger and a condition for an automation, and a
 * dataset in the report builder.
 *
 * Its fields are ordinary custom field definitions on `object:<key>`, so
 * `custom-fields.ts` checks, filters and counts them by the same code it uses
 * for a customer's. Defining a kind and its fields needs `customfield:write`,
 * like any field.
 *
 * WHO SEES WHAT. Every record needs `record:read` to see and `record:write`
 * to change, which is the gate a role is built with and the one the API
 * publishes. A kind can narrow that further by naming a second permission
 * of its own for each (supplier rebates only for whoever may see job costs,
 * permits only for whoever may edit customers); by default it names the
 * gate itself, which adds nothing. Writing needs reading as well, because
 * somebody who may add a permit and may not see one would add it and then
 * be told it does not exist. And a record pointing at a customer is about that customer,
 * so somebody whose customers are narrowed (a technician sees the people they
 * have been sent to) sees a record when it is on a job they may see, when it
 * points at nothing of a customer's at all (the Monday truck inspection), or
 * when they wrote it. Without that last rule a technician's own permit
 * filing would vanish from their list the moment they saved it.
 */

type TypeRow = typeof schema.customObjectType.$inferSelect;
type RecordRow = typeof schema.customObjectRecord.$inferSelect;

/* ------------------------------------------------------------------ kinds */

function view(row: TypeRow) {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    pluralLabel: row.pluralLabel,
    description: row.description,
    titleLabel: row.titleLabel,
    links: row.links as rules.Link[],
    readPermission: row.readPermission,
    writePermission: row.writePermission,
    sortOrder: row.sortOrder,
  };
}
export type KindView = ReturnType<typeof view>;

function decided(input: rules.TypeInput): rules.TypeDefinition {
  const decision = rules.checkType(input);
  if (!decision.ok) {
    throw new UnprocessableError(
      decision.problems.length === 1 ? "That kind of record needs changing" : "That kind of record needs a few changes",
      decision.problems.map((message) => ({ path: "definition", message })),
    );
  }
  return decision.definition;
}

async function kindByKey(tx: Database, key: string): Promise<TypeRow> {
  const [row] = await tx.select().from(schema.customObjectType)
    .where(and(eq(schema.customObjectType.key, key), isNull(schema.customObjectType.deletedAt))).limit(1);
  if (!row) throw new NotFoundError("Kind of record");
  return row;
}

async function kindById(tx: Database, id: string): Promise<TypeRow> {
  const [row] = await tx.select().from(schema.customObjectType)
    .where(and(eq(schema.customObjectType.id, id), isNull(schema.customObjectType.deletedAt))).limit(1);
  if (!row) throw new NotFoundError("Kind of record");
  return row;
}

const canRead = (ctx: ServiceContext, kind: TypeRow) =>
  can(ctx.actor, "record:read") && can(ctx.actor, kind.readPermission as Permission);
const canWrite = (ctx: ServiceContext, kind: TypeRow) =>
  canRead(ctx, kind) && can(ctx.actor, "record:write") && can(ctx.actor, kind.writePermission as Permission);

async function withFields(tx: Database, ctx: ServiceContext, row: TypeRow) {
  return {
    ...view(row),
    fields: await definitionsWithin(tx, ctx.actor.organizationId, rules.entityTypeFor(row.key)),
    canRead: canRead(ctx, row),
    canWrite: canWrite(ctx, row),
  };
}

/**
 * Every kind the caller may read, in the company's order, each with its
 * fields. The list the navigation, the API and an agent are drawn from.
 */
export async function listKinds(ctx: ServiceContext) {
  return guardedRead(ctx, "record:read", async (tx) => {
    const rows = await tx.select().from(schema.customObjectType)
      .where(isNull(schema.customObjectType.deletedAt))
      .orderBy(asc(schema.customObjectType.sortOrder), asc(schema.customObjectType.label));
    const out = [];
    for (const row of rows.filter((kind) => canRead(ctx, kind))) out.push(await withFields(tx, ctx, row));
    return out;
  });
}

/**
 * Every kind the company has defined, for the settings screen that defines
 * them: the same question as the custom field list, under the same
 * permission, with how many of each are on file.
 */
export async function definedKinds(ctx: ServiceContext) {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const rows = await tx.select().from(schema.customObjectType)
      .where(isNull(schema.customObjectType.deletedAt))
      .orderBy(asc(schema.customObjectType.sortOrder), asc(schema.customObjectType.label));
    const counts = new Map((await tx.execute<{ id: string; n: number }>(sql`
      select t.object_type_id as id, count(*)::int as n from public.custom_object_record t
      where t.deleted_at is null group by t.object_type_id`)).map((r) => [r.id, Number(r.n)] as const));
    const out = [];
    for (const row of rows) out.push({ ...(await withFields(tx, ctx, row)), records: counts.get(row.id) ?? 0 });
    return out;
  });
}

/** One kind with its fields, for whoever may read its records. */
export async function getKind(ctx: ServiceContext, input: { key: string }) {
  return guardedRead(ctx, "record:read", async (tx) => {
    const row = await kindByKey(tx, input.key);
    assertCan(ctx.actor, row.readPermission as Permission);
    return withFields(tx, ctx, row);
  });
}

/**
 * Define a kind. Its fields are added afterwards with the custom field
 * routes, on `object:<key>`, which is the same act as adding one to a
 * customer and is checked the same way.
 */
export async function defineKind(ctx: ServiceContext, input: rules.TypeInput) {
  return guardedWrite(ctx, "customfield:write", async (tx) => {
    const again = await replayed<KindView>(tx, ctx, "custom_object_type");
    if (again) return again;
    const definition = decided(input);
    const [row] = await refusingDuplicate(
      "custom_object_type_key_idx",
      `There is already a kind of record called "${definition.key}". Open that one, or give this one a different key.`,
      () => tx.insert(schema.customObjectType).values({
        organizationId: ctx.actor.organizationId,
        ...definition,
        createdByUserId: ctx.actor.userId,
      }).returning(),
    );
    await audit(tx, ctx, "custom_object_type.defined", "custom_object_type", row!.id, null, row!);
    const answer = view(row!);
    await remember(tx, ctx, "custom_object_type", row!.id, answer);
    return answer;
  });
}

/**
 * Change what a kind is called, what it points at and who may see it. NOT
 * ITS KEY: the key is written into every field definition and every saved
 * report and automation that mentions the kind, so a rename would orphan all
 * of them at once, exactly as a custom field's would.
 *
 * Taking a link away is refused while records still point that way, because
 * the records would keep pointing at something no screen offers any more.
 */
export async function updateKind(
  ctx: ServiceContext,
  input: { id: string } & { [K in keyof rules.TypeInput]?: rules.TypeInput[K] | undefined },
) {
  return guardedWrite(ctx, "customfield:write", async (tx) => {
    const before = await kindById(tx, input.id);
    if (input.key !== undefined && input.key.trim() !== before.key) {
      throw new ConflictError(
        `A kind of record's key cannot be changed. "${before.key}" is written into its fields and into every `
        + "report and automation that uses it. Change what it is called instead.",
      );
    }
    const definition = decided({
      key: before.key,
      label: input.label ?? before.label,
      pluralLabel: input.pluralLabel ?? before.pluralLabel,
      description: input.description === undefined ? before.description : input.description,
      titleLabel: input.titleLabel ?? before.titleLabel,
      links: input.links ?? before.links,
      readPermission: input.readPermission ?? before.readPermission,
      writePermission: input.writePermission ?? before.writePermission,
      sortOrder: input.sortOrder ?? before.sortOrder,
    });

    const dropped = (before.links as rules.Link[]).filter((link) => !definition.links.includes(link));
    for (const link of dropped) {
      const [row] = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from public.custom_object_record t
        where t.object_type_id = ${before.id} and t.deleted_at is null
          and ${sql.raw(`t.${LINK_COLUMN[link]}`)} is not null`);
      const n = Number(row?.n ?? 0);
      if (n > 0) {
        throw new ConflictError(
          `${n} ${n === 1 ? before.label.toLowerCase() : before.pluralLabel.toLowerCase()} still point at a `
          + `${rules.LINK_LABEL[link].toLowerCase()}. Take those off first, or keep the link.`,
        );
      }
    }

    const [after] = await tx.update(schema.customObjectType).set({
      label: definition.label,
      pluralLabel: definition.pluralLabel,
      description: definition.description,
      titleLabel: definition.titleLabel,
      links: definition.links,
      readPermission: definition.readPermission,
      writePermission: definition.writePermission,
      sortOrder: definition.sortOrder,
      updatedAt: new Date(),
    }).where(eq(schema.customObjectType.id, before.id)).returning();
    await audit(tx, ctx, "custom_object_type.updated", "custom_object_type", before.id, before, after!);
    return view(after!);
  });
}

/**
 * Retire a kind. Refused while it holds records unless `force`, and the
 * count is in the sentence, for the reason retiring a field says how many
 * values it orphans. Soft, so a kind retired by mistake is defined again
 * under the same key and its records and fields come back.
 */
export async function removeKind(ctx: ServiceContext, input: { id: string; force?: boolean | undefined }) {
  return guardedWrite(ctx, "customfield:write", async (tx) => {
    const before = await kindById(tx, input.id);
    const [row] = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from public.custom_object_record t
      where t.object_type_id = ${before.id} and t.deleted_at is null`);
    const held = Number(row?.n ?? 0);
    if (held > 0 && !input.force) {
      throw new ConflictError(
        `There ${held === 1 ? "is" : "are"} ${held} ${held === 1 ? before.label.toLowerCase() : before.pluralLabel.toLowerCase()} on file. `
        + "Retiring the kind hides them from every screen, report and export until it is defined again. "
        + "Retire it anyway if that is what you mean.",
      );
    }
    await tx.update(schema.customObjectType).set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.customObjectType.id, before.id));
    await audit(tx, ctx, "custom_object_type.removed", "custom_object_type", before.id, before, null);
    return { id: before.id, removed: true as const, recordsHidden: held };
  });
}

/* ---------------------------------------------------------------- records */

const LINK_COLUMN: Record<rules.Link, string> = {
  customer: "customer_id", property: "property_id", job: "job_id", equipment: "equipment_id",
};

export interface Links {
  customerId?: string | null | undefined;
  propertyId?: string | null | undefined;
  jobId?: string | null | undefined;
  equipmentId?: string | null | undefined;
}

/**
 * The records the caller may see, as a condition on `custom_object_record`.
 * See the header for why each of the three ways in is there. Also what a
 * report on a kind of record is scoped by, so the two cannot disagree.
 */
export function recordVisibility(ctx: ServiceContext): SQL | undefined {
  return visibility(ctx);
}

function visibility(ctx: ServiceContext): SQL | undefined {
  const customers = scopeOf(ctx, "customer");
  const jobs = scopeOf(ctx, "job");
  if (customers === "all" && jobs === "all") return undefined;
  const onVisibleJob = jobVisibility(jobs, ctx.actor, sql`${schema.customObjectRecord.jobId}`) ?? sql`false`;
  return or(
    eq(schema.customObjectRecord.createdByUserId, ctx.actor.userId),
    and(
      isNull(schema.customObjectRecord.customerId), isNull(schema.customObjectRecord.propertyId),
      isNull(schema.customObjectRecord.jobId), isNull(schema.customObjectRecord.equipmentId),
    ),
    and(sql`${schema.customObjectRecord.jobId} is not null`, onVisibleJob),
  );
}

/** What a record looks like to a screen, an export and an automation: its kind, its name, its values, what it points at. */
async function shapeRecords(tx: Database, kind: TypeRow, rows: RecordRow[]) {
  const ids = <K extends keyof RecordRow>(key: K) =>
    [...new Set(rows.map((row) => row[key]).filter((v): v is NonNullable<RecordRow[K]> => Boolean(v)))] as string[];
  const customers = ids("customerId");
  const properties = ids("propertyId");
  const jobs = ids("jobId");
  const units = ids("equipmentId");
  const names = new Map<string, string>();
  if (customers.length > 0) {
    for (const c of await tx.select({ id: schema.customer.id, name: schema.customer.name })
      .from(schema.customer).where(inArray(schema.customer.id, customers))) names.set(c.id, c.name);
  }
  if (properties.length > 0) {
    for (const p of await tx.select({ id: schema.property.id, line1: schema.property.addressLine1, city: schema.property.city })
      .from(schema.property).where(inArray(schema.property.id, properties))) {
      names.set(p.id, [p.line1, p.city].filter(Boolean).join(", "));
    }
  }
  if (jobs.length > 0) {
    for (const j of await tx.select({ id: schema.job.id, number: schema.job.number, summary: schema.job.summary })
      .from(schema.job).where(inArray(schema.job.id, jobs))) {
      names.set(j.id, `Job ${j.number}${j.summary ? `: ${j.summary}` : ""}`);
    }
  }
  if (units.length > 0) {
    for (const e of await tx.select({
      id: schema.equipment.id, category: schema.equipment.category, manufacturer: schema.equipment.manufacturer,
      model: schema.equipment.model, tag: schema.equipment.tag,
    }).from(schema.equipment).where(inArray(schema.equipment.id, units))) {
      names.set(e.id, [e.tag, e.manufacturer, e.model].filter(Boolean).join(" ") || e.category);
    }
  }
  const named = (id: string | null) => (id ? { id, name: names.get(id) ?? "" } : null);
  return rows.map((row) => ({
    id: row.id,
    type: kind.key,
    typeLabel: kind.label,
    title: row.title,
    customFields: row.customFields,
    customer: named(row.customerId),
    property: named(row.propertyId),
    job: named(row.jobId),
    equipment: named(row.equipmentId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}
export type RecordView = Awaited<ReturnType<typeof shapeRecords>>[number];

/**
 * The record as an automation reads it. `record.type` is the kind's key and
 * `record.fields` every value by its key, which is what a condition names:
 * "record.type is permit and record.fields.status changed to approved".
 */
function eventShape(kind: TypeRow, row: RecordRow) {
  return {
    id: row.id,
    type: kind.key,
    typeLabel: kind.label,
    title: row.title,
    fields: row.customFields,
    customerId: row.customerId,
    propertyId: row.propertyId,
    jobId: row.jobId,
    equipmentId: row.equipmentId,
  };
}

/** Read a kind for a record operation, and hold the caller to its own narrowing. The gate is the caller's. */
async function kindFor(tx: Database, ctx: ServiceContext, key: string, write: boolean): Promise<TypeRow> {
  const kind = await kindByKey(tx, key);
  assertCan(ctx.actor, kind.readPermission as Permission);
  if (write) assertCan(ctx.actor, kind.writePermission as Permission);
  return kind;
}

/** The gate every record operation passes first: `record:write` to change, and reading with it. */
function gate(ctx: ServiceContext, write: boolean) {
  if (write) assertCan(ctx.actor, "record:write");
  assertCan(ctx.actor, "record:read");
}

/**
 * THE LINKS A WRITE ASKED FOR, CHECKED AND FILLED IN.
 *
 * A link the kind does not offer is refused, in words, rather than stored
 * where no screen would show it. A linked record has to exist in this
 * company. And a job carries its customer and its address: a permit put on a
 * job is on that customer's page and that address's too, without anybody
 * picking them a second time, when the kind offers those links.
 */
async function resolveLinks(tx: Database, ctx: ServiceContext, kind: TypeRow, wanted: Links, previous?: Links) {
  const offered = kind.links as rules.Link[];
  const next: Required<{ [K in keyof Links]: string | null }> = {
    customerId: previous?.customerId ?? null,
    propertyId: previous?.propertyId ?? null,
    jobId: previous?.jobId ?? null,
    equipmentId: previous?.equipmentId ?? null,
  };
  const issues: { path: string; message: string }[] = [];
  const pairs: [rules.Link, keyof Links][] = [
    ["customer", "customerId"], ["property", "propertyId"], ["job", "jobId"], ["equipment", "equipmentId"],
  ];
  for (const [link, key] of pairs) {
    const value = wanted[key];
    if (value === undefined) continue;
    if (value !== null && !offered.includes(link)) {
      issues.push({ path: key, message: `A ${kind.label.toLowerCase()} does not point at a ${rules.LINK_LABEL[link].toLowerCase()}.` });
      continue;
    }
    next[key] = value;
  }

  if (next.jobId && wanted.jobId !== undefined) {
    const [job] = await tx.select({ id: schema.job.id, customerId: schema.job.customerId, propertyId: schema.job.propertyId })
      .from(schema.job)
      .where(and(eq(schema.job.id, next.jobId), isNull(schema.job.deletedAt),
        jobVisibility(scopeOf(ctx, "job"), ctx.actor, sql`${schema.job.id}`))).limit(1);
    if (!job) issues.push({ path: "jobId", message: "That job is not one you can see." });
    else {
      if (offered.includes("customer") && wanted.customerId === undefined) next.customerId = job.customerId;
      if (offered.includes("property") && wanted.propertyId === undefined && job.propertyId) next.propertyId = job.propertyId;
    }
  }
  if (next.customerId && wanted.customerId !== undefined) {
    const [found] = await tx.select({ id: schema.customer.id }).from(schema.customer)
      .where(and(eq(schema.customer.id, next.customerId), isNull(schema.customer.deletedAt))).limit(1);
    if (!found) issues.push({ path: "customerId", message: "There is no such customer." });
  }
  if (next.propertyId && wanted.propertyId !== undefined) {
    const [found] = await tx.select({ id: schema.property.id }).from(schema.property)
      .where(and(eq(schema.property.id, next.propertyId), isNull(schema.property.deletedAt))).limit(1);
    if (!found) issues.push({ path: "propertyId", message: "There is no such address." });
  }
  if (next.equipmentId && wanted.equipmentId !== undefined) {
    const [found] = await tx.select({ id: schema.equipment.id }).from(schema.equipment)
      .where(and(eq(schema.equipment.id, next.equipmentId), isNull(schema.equipment.deletedAt))).limit(1);
    if (!found) issues.push({ path: "equipmentId", message: "There is no such unit." });
  }
  return { links: next, issues };
}

export interface ListRecordsInput {
  type: string;
  q?: string | undefined;
  fieldKey?: string | undefined;
  fieldValue?: string | undefined;
  customerId?: string | undefined;
  propertyId?: string | undefined;
  jobId?: string | undefined;
  equipmentId?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

/**
 * One kind's records, newest first, searched and filtered.
 *
 * The search is the name and every value, ignoring case, because somebody
 * looking for "the permit for Elm Street" types the street, not the field it
 * is in.
 */
export async function listRecords(ctx: ServiceContext, input: ListRecordsInput) {
  gate(ctx, false);
  return inTenant(ctx, async (tx) => {
    const kind = await kindFor(tx, ctx, input.type, false);
    if ((input.fieldKey === undefined) !== (input.fieldValue === undefined)) {
      throw new ConflictError("Filtering by a field needs both the field and the value to look for.");
    }
    const byField = input.fieldKey !== undefined && input.fieldValue !== undefined
      ? await filterCondition(tx, ctx.actor.organizationId, rules.entityTypeFor(kind.key),
        input.fieldKey, input.fieldValue, sql`${schema.customObjectRecord.customFields}`)
      : undefined;
    const q = input.q?.trim();
    const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const cursor = decodeCursor(input.cursor);

    const rows = await tx.select().from(schema.customObjectRecord)
      .where(and(
        eq(schema.customObjectRecord.objectTypeId, kind.id),
        isNull(schema.customObjectRecord.deletedAt),
        visibility(ctx),
        pattern ? or(
          ilike(schema.customObjectRecord.title, pattern),
          sql`${schema.customObjectRecord.customFields}::text ilike ${pattern}`,
        ) : undefined,
        byField,
        input.customerId ? eq(schema.customObjectRecord.customerId, input.customerId) : undefined,
        input.propertyId ? eq(schema.customObjectRecord.propertyId, input.propertyId) : undefined,
        input.jobId ? eq(schema.customObjectRecord.jobId, input.jobId) : undefined,
        input.equipmentId ? eq(schema.customObjectRecord.equipmentId, input.equipmentId) : undefined,
        cursor ? lt(schema.customObjectRecord.createdAt, new Date(cursor)) : undefined,
      ))
      .orderBy(desc(schema.customObjectRecord.createdAt))
      .limit(limit + 1);
    const page = paginate(rows, limit, (row) => row.createdAt.toISOString());
    return { ...page, data: await shapeRecords(tx, kind, page.data) };
  });
}

/**
 * Every record pointing at one customer, address, job or unit, grouped by
 * kind, for the panel on that record's page. Only the kinds the caller may
 * read and which offer that link, each with whether they may add one there.
 */
export async function recordsFor(ctx: ServiceContext, input: { link: rules.Link; id: string }) {
  /** Nothing to show rather than a refusal: the panel sits on a page the caller may already read. */
  if (!can(ctx.actor, "record:read")) return [];
  return inTenant(ctx, async (tx) => {
    const kinds = (await tx.select().from(schema.customObjectType)
      .where(isNull(schema.customObjectType.deletedAt))
      .orderBy(asc(schema.customObjectType.sortOrder), asc(schema.customObjectType.label)))
      .filter((kind) => (kind.links as string[]).includes(input.link) && canRead(ctx, kind));
    const column = {
      customer: schema.customObjectRecord.customerId, property: schema.customObjectRecord.propertyId,
      job: schema.customObjectRecord.jobId, equipment: schema.customObjectRecord.equipmentId,
    }[input.link];
    const out = [];
    for (const kind of kinds) {
      const rows = await tx.select().from(schema.customObjectRecord)
        .where(and(
          eq(schema.customObjectRecord.objectTypeId, kind.id), eq(column, input.id),
          isNull(schema.customObjectRecord.deletedAt), visibility(ctx),
        ))
        .orderBy(desc(schema.customObjectRecord.createdAt)).limit(50);
      out.push({
        kind: view(kind),
        canWrite: canWrite(ctx, kind),
        fields: await definitionsWithin(tx, ctx.actor.organizationId, rules.entityTypeFor(kind.key)),
        records: await shapeRecords(tx, kind, rows),
      });
    }
    return out;
  });
}

async function loadRecord(tx: Database, ctx: ServiceContext, id: string) {
  const [row] = await tx.select().from(schema.customObjectRecord)
    .where(and(eq(schema.customObjectRecord.id, id), isNull(schema.customObjectRecord.deletedAt), visibility(ctx))).limit(1);
  if (!row) throw new NotFoundError("Record");
  const kind = await kindById(tx, row.objectTypeId);
  return { row, kind };
}

export async function getRecord(ctx: ServiceContext, input: { id: string }) {
  gate(ctx, false);
  return inTenant(ctx, async (tx) => {
    const { row, kind } = await loadRecord(tx, ctx, input.id);
    assertCan(ctx.actor, kind.readPermission as Permission);
    const [shaped] = await shapeRecords(tx, kind, [row]);
    return {
      ...shaped!,
      kind: view(kind),
      fields: await definitionsWithin(tx, ctx.actor.organizationId, rules.entityTypeFor(kind.key)),
      canWrite: canWrite(ctx, kind),
    };
  });
}

export interface RecordInput extends Links {
  type: string;
  title: string;
  customFields?: Record<string, unknown> | undefined;
}

/** The body of a create, inside a transaction the caller holds, so an import is this exact path once per row. */
async function createWithin(tx: Database, ctx: ServiceContext, kind: TypeRow, input: RecordInput, at = "") {
  const issues: { path: string; message: string }[] = [];
  const titleProblem = rules.titleProblem(kind.titleLabel, input.title);
  if (titleProblem) issues.push({ path: `${at}title`, message: titleProblem });
  const resolved = await resolveLinks(tx, ctx, kind, input);
  issues.push(...resolved.issues.map((issue) => ({ ...issue, path: `${at}${issue.path}` })));
  const values = input.customFields ?? {};
  try {
    await enforceWithin(tx, ctx.actor.organizationId, rules.entityTypeFor(kind.key), values, undefined, `${at}customFields`);
  } catch (error) {
    if (!(error instanceof UnprocessableError)) throw error;
    issues.push(...error.issues);
  }
  if (issues.length > 0) {
    throw new UnprocessableError(issues.length === 1 ? "That needs changing" : "Some things need changing", issues);
  }

  const [row] = await tx.insert(schema.customObjectRecord).values({
    organizationId: ctx.actor.organizationId,
    objectTypeId: kind.id,
    title: input.title.trim(),
    customFields: values,
    customerId: resolved.links.customerId,
    propertyId: resolved.links.propertyId,
    jobId: resolved.links.jobId,
    equipmentId: resolved.links.equipmentId,
    createdByUserId: ctx.actor.userId,
  }).returning();
  await emit(tx, ctx, {
    name: "record.created", entityType: "custom_object_record", entityId: row!.id,
    payload: { record: eventShape(kind, row!) },
  });
  await audit(tx, ctx, "custom_object_record.created", "custom_object_record", row!.id, null, row!);
  return row!;
}

export async function createRecord(ctx: ServiceContext, input: RecordInput) {
  gate(ctx, true);
  return inTenant(ctx, async (tx) => {
    const kind = await kindFor(tx, ctx, input.type, true);
    const again = await replayed<RecordView>(tx, ctx, "custom_object_record");
    if (again) return again;
    const row = await createWithin(tx, ctx, kind, input);
    const [shaped] = await shapeRecords(tx, kind, [row]);
    await remember(tx, ctx, "custom_object_record", row.id, shaped!);
    return shaped!;
  });
}

/**
 * Change a record. Only what the write changed is checked against the
 * fields, so a record from before a field became required still saves, as
 * everywhere else in M29. Links not named are left as they are; a null takes
 * one off.
 */
export async function updateRecord(
  ctx: ServiceContext,
  input: Links & { id: string; title?: string | undefined; customFields?: Record<string, unknown> | undefined },
) {
  gate(ctx, true);
  return inTenant(ctx, async (tx) => {
    const { row: before, kind } = await loadRecord(tx, ctx, input.id);
    assertCan(ctx.actor, kind.readPermission as Permission);
    assertCan(ctx.actor, kind.writePermission as Permission);

    const issues: { path: string; message: string }[] = [];
    if (input.title !== undefined) {
      const problem = rules.titleProblem(kind.titleLabel, input.title);
      if (problem) issues.push({ path: "title", message: problem });
    }
    const resolved = await resolveLinks(tx, ctx, kind, input, before);
    issues.push(...resolved.issues);
    const values = input.customFields ?? before.customFields;
    try {
      await enforceWithin(tx, ctx.actor.organizationId, rules.entityTypeFor(kind.key), values, before.customFields);
    } catch (error) {
      if (!(error instanceof UnprocessableError)) throw error;
      issues.push(...error.issues);
    }
    if (issues.length > 0) {
      throw new UnprocessableError(issues.length === 1 ? "That needs changing" : "Some things need changing", issues);
    }

    const [after] = await tx.update(schema.customObjectRecord).set({
      title: input.title !== undefined ? input.title.trim() : before.title,
      customFields: values,
      customerId: resolved.links.customerId,
      propertyId: resolved.links.propertyId,
      jobId: resolved.links.jobId,
      equipmentId: resolved.links.equipmentId,
      updatedAt: new Date(),
    }).where(eq(schema.customObjectRecord.id, before.id)).returning();
    await emit(tx, ctx, {
      name: "record.updated", entityType: "custom_object_record", entityId: before.id,
      payload: { record: eventShape(kind, after!) }, previous: { record: eventShape(kind, before) },
    });
    await audit(tx, ctx, "custom_object_record.updated", "custom_object_record", before.id, before, after!);
    const [shaped] = await shapeRecords(tx, kind, [after!]);
    return shaped!;
  });
}

/** Remove a record. Soft, with the audit line, so "who deleted the permit" has an answer. */
export async function removeRecord(ctx: ServiceContext, input: { id: string }) {
  gate(ctx, true);
  return inTenant(ctx, async (tx) => {
    const { row, kind } = await loadRecord(tx, ctx, input.id);
    assertCan(ctx.actor, kind.readPermission as Permission);
    assertCan(ctx.actor, kind.writePermission as Permission);
    await tx.update(schema.customObjectRecord).set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.customObjectRecord.id, row.id));
    await audit(tx, ctx, "custom_object_record.removed", "custom_object_record", row.id, row, null);
    return { id: row.id, removed: true as const };
  });
}

/* --------------------------------------------------------------- CSV */

/**
 * A KIND'S RECORDS AS A SPREADSHEET, every one the caller may see.
 *
 * The name, every field by its label, what each points at by name AND by
 * id, and when it was added. The ids are there so the file reads back: an
 * import matches a customer by id because a name is not unique, and an
 * export that could not be imported again would be a report rather than a
 * copy. Written by the report CSV writer, so a cell that would be a formula
 * in a spreadsheet is not one.
 */
export async function exportCsv(ctx: ServiceContext, input: { type: string }) {
  gate(ctx, false);
  return inTenant(ctx, async (tx) => {
    const kind = await kindFor(tx, ctx, input.type, false);
    const fields = await definitionsWithin(tx, ctx.actor.organizationId, rules.entityTypeFor(kind.key));
    const rows = await tx.select().from(schema.customObjectRecord)
      .where(and(eq(schema.customObjectRecord.objectTypeId, kind.id), isNull(schema.customObjectRecord.deletedAt), visibility(ctx)))
      .orderBy(asc(schema.customObjectRecord.createdAt));
    const shaped = await shapeRecords(tx, kind, rows);
    const links = kind.links as rules.Link[];
    const columns: reporting.CsvColumn[] = [
      { key: "title", label: kind.titleLabel, type: "text" },
      ...fields.map((field) => ({ key: `f_${field.key}`, label: field.label, type: field.dataType === "number" ? "number" : "text" })),
      ...links.flatMap((link) => [
        { key: `${link}`, label: rules.LINK_LABEL[link], type: "text" },
        { key: `${link}_id`, label: `${link} id`, type: "text" },
      ]),
      { key: "created", label: "Added", type: "text" },
    ];
    const out = shaped.map((record) => {
      const line: Record<string, string | number | null> = { title: record.title, created: record.createdAt.toISOString().slice(0, 10) };
      for (const field of fields) {
        const value = record.customFields[field.key];
        line[`f_${field.key}`] = field.dataType === "number" && typeof value === "number" ? value : rules.cellText(field, value);
      }
      for (const link of links) {
        const linked = record[link];
        line[link] = linked?.name ?? "";
        line[`${link}_id`] = linked?.id ?? "";
      }
      return line;
    });
    await audit(tx, ctx, "custom_object_record.exported", "custom_object_type", kind.id, null, { rows: out.length });
    return { fileName: `${kind.pluralLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`, rows: out.length, csv: reporting.toCsv(columns, out) };
  });
}

/**
 * A SPREADSHEET OF THEM, LOADED: ALL OF IT OR NONE OF IT.
 *
 * Every row goes through the same create as one typed on the form, so a date
 * column holding "soon" is refused with the sentence the form would give,
 * at `rows.<n>.customFields.<key>`. If any row is refused, nothing is
 * written and every refusal is listed: half a spreadsheet loaded is a
 * spreadsheet nobody can load again without making duplicates of the half
 * that went in.
 *
 * A dry run (`x-otos-dry-run`, or the screen's "Check the file") runs exactly
 * this and rolls it back.
 */
export async function importCsv(ctx: ServiceContext, input: { type: string; csv: string }) {
  gate(ctx, true);
  return inTenant(ctx, async (tx) => {
    const kind = await kindFor(tx, ctx, input.type, true);
    const again = await replayed<{ created: number; ignoredColumns: string[] }>(tx, ctx, "custom_object_import");
    if (again) return again;
    const fields = await definitionsWithin(tx, ctx.actor.organizationId, rules.entityTypeFor(kind.key));
    const [header, ...body] = rules.parseCsv(input.csv);
    if (!header) throw new ConflictError("That file is empty.");
    const columns = rules.importColumns(header, kind.titleLabel, fields);
    if (!columns) {
      throw new ConflictError(
        `There is no column for each one's ${kind.titleLabel.toLowerCase()}. Head a column "${kind.titleLabel}" or "Title".`,
      );
    }
    if (body.length === 0) throw new ConflictError("That file has a header and no rows.");
    if (body.length > 5000) throw new ConflictError("Load at most five thousand rows at a time.");

    const jobNumbers = columns.links.job_number === undefined ? new Map<number, string>()
      : new Map((await tx.select({ id: schema.job.id, number: schema.job.number }).from(schema.job)
        .where(isNull(schema.job.deletedAt))).map((job) => [job.number, job.id] as const));

    const issues: { path: string; message: string }[] = [];
    let created = 0;
    for (const [index, cells] of body.entries()) {
      const n = index + 2;
      const cell = (at: number | undefined) => (at === undefined ? "" : (cells[at] ?? "").trim());
      const values: Record<string, unknown> = {};
      for (const field of fields) {
        const at = columns.fields.get(field.key);
        if (at === undefined) continue;
        const value = rules.cellValue(field, cells[at] ?? "");
        if (value !== undefined) values[field.key] = value;
      }
      const links: Links = {};
      for (const link of rules.LINKS) {
        const value = cell(columns.links[link]);
        if (value) (links as Record<string, string>)[`${link}Id`] = value;
      }
      const number = cell(columns.links.job_number);
      if (number) {
        const id = /^\d+$/.test(number) ? jobNumbers.get(Number(number)) : undefined;
        if (!id) { issues.push({ path: `rows.${n}.jobNumber`, message: `Row ${n}: there is no job ${number}.` }); continue; }
        links.jobId = id;
      }
      for (const [key, value] of Object.entries(links)) {
        if (value && !/^[0-9a-f-]{36}$/i.test(String(value))) {
          issues.push({ path: `rows.${n}.${key}`, message: `Row ${n}: "${String(value)}" is not an id.` });
          delete (links as Record<string, unknown>)[key];
        }
      }
      try {
        await tx.transaction(async (savepoint) => {
          await createWithin(savepoint as unknown as Database, ctx, kind,
            { type: kind.key, title: cell(columns.title), customFields: values, ...links }, `rows.${n}.`);
        });
        created += 1;
      } catch (error) {
        if (!(error instanceof UnprocessableError)) throw error;
        issues.push(...error.issues.map((issue) => ({ path: issue.path, message: `Row ${n}: ${issue.message}` })));
      }
    }
    if (issues.length > 0) {
      throw new UnprocessableError(
        `Nothing was loaded. ${issues.length === 1 ? "One thing" : `${issues.length} things`} in the file need changing first.`,
        issues,
      );
    }
    const answer = { created, ignoredColumns: columns.ignored };
    await remember(tx, ctx, "custom_object_import", kind.id, answer);
    return answer;
  });
}

/**
 * A job by the number people say out loud, for a form that asks for one.
 * Null when there is no such job or the caller may not see it.
 */
export async function jobByNumber(ctx: ServiceContext, input: { number: number }) {
  return guardedRead(ctx, "job:read", async (tx) => {
    const [job] = await tx.select({ id: schema.job.id }).from(schema.job)
      .where(and(eq(schema.job.number, input.number), isNull(schema.job.deletedAt),
        jobVisibility(scopeOf(ctx, "job"), ctx.actor, sql`${schema.job.id}`))).limit(1);
    return job?.id ?? null;
  });
}

/* ------------------------------------------------------------ the routes */

type Patch<T> = { [K in keyof T]?: T[K] | undefined };

export const handlers = {
  listCustomObjects: async (ctx: ServiceContext) => ({ kinds: await listKinds(ctx) }),
  getCustomObject: (ctx: ServiceContext, input: { key: string }) => getKind(ctx, input),
  defineCustomObject: (ctx: ServiceContext, input: rules.TypeInput) => defineKind(ctx, input),
  updateCustomObject: (ctx: ServiceContext, input: { id: string } & Patch<rules.TypeInput>) => updateKind(ctx, input),
  deleteCustomObject: (ctx: ServiceContext, input: { id: string; force?: boolean | undefined }) => removeKind(ctx, input),
  listCustomRecords: (ctx: ServiceContext, input: ListRecordsInput) => listRecords(ctx, input),
  getCustomRecord: (ctx: ServiceContext, input: { id: string }) => getRecord(ctx, input),
  createCustomRecord: (ctx: ServiceContext, input: RecordInput) => createRecord(ctx, input),
  updateCustomRecord: (
    ctx: ServiceContext,
    input: Links & { id: string; title?: string | undefined; customFields?: Record<string, unknown> | undefined },
  ) => updateRecord(ctx, input),
  deleteCustomRecord: (ctx: ServiceContext, input: { id: string }) => removeRecord(ctx, input),
  exportCustomRecords: (ctx: ServiceContext, input: { key: string }) => exportCsv(ctx, { type: input.key }),
  importCustomRecords: (ctx: ServiceContext, input: { key: string; csv: string }) => importCsv(ctx, { type: input.key, csv: input.csv }),
} as const;
