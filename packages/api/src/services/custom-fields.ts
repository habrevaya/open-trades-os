import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, customFields as rules, customObjects, type Permission } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, inTenant, audit, scopeOf,
  ConflictError, NotFoundError, UnprocessableError, type ServiceContext,
} from "./context";
import { estimateScopeFilter, invoiceScopeFilter, jobVisibility } from "./scope";

/**
 * THE FIELDS A COMPANY ADDED, WHICH NOTHING COULD DECLARE
 *
 * `custom_field_definition` was in the first migrations and no service ever
 * touched it. `customfield:write` was in the permission catalogue and nothing
 * asserted it. Meanwhile `customer`, `property` and `job` each carry a
 * `custom_fields` jsonb column that the services read and write freely.
 *
 * So the storage shipped and the meaning did not. A company could put
 * anything under any key on any row, and nothing anywhere said what the keys
 * were, what they were called, what shape a value was meant to be, or which
 * of them somebody was required to fill in. The symptom is not an error. It
 * is a screen with no custom fields on it above a database full of them, an
 * export with a column header of `wty_exp_2`, and two offices writing
 * `"yes"`, `true` and `"Y"` into the same field for a year before anybody
 * tries to count them.
 *
 * A DEFINITION IS THE ONLY THING THAT MAKES A CUSTOM FIELD A FIELD. Without
 * one there is a bag of strings. With one there is a label to draw, a type to
 * check against, and an answer to "what does this company track that we do
 * not".
 *
 * THE KEY IS THE JOIN, AND THERE IS NO FOREIGN KEY UNDER IT. The value lives
 * at `custom_fields -> key` on another table, matched by string. Nothing in
 * the database enforces that correspondence, which is why every rule in this
 * file is about protecting it: the definition and the data agree because this
 * service refuses to let them disagree, or they do not agree at all.
 *
 * WHERE IT IS ENFORCED. Not in here: `enforceWithin` below is the check,
 * and the customer, property and job services call it inside their own
 * create and update, under their own permission. The rule a save is held to
 * is narrower than the settings screen's on purpose, and `enforceWithin`
 * says how: only what the write changed is checked, so a record from before
 * a field existed, or before it became required, keeps saving.
 */

/* --------------------------------------------------------- what can carry one */

/**
 * The entities that have a `custom_fields` column, and therefore the only
 * ones a definition can be about.
 *
 * Closed, and refused rather than accepted and ignored. A definition on an
 * entity with nowhere to store a value is the worst possible failure here:
 * the field renders on the screen, somebody types into it, the save succeeds
 * because the save never looked, and the value is gone. Nobody reports that
 * as a bug, because from the outside it looks like it worked.
 *
 * This list grows when a table grows a `custom_fields` column, and not
 * before. The invoice, the estimate, the visit, the unit and the technician
 * grew one together, because "custom fields everywhere" was otherwise three
 * records out of the eight a company actually writes things down about.
 *
 * Beside these, a company's own kind of record (`object:<key>`, M29's custom
 * objects) holds its values in `custom_object_record.custom_fields`, one table
 * for every kind, told apart by the kind's id. See `targetOf`.
 */
export const ENTITY_TYPES = [
  "customer", "property", "job", "invoice", "estimate", "visit", "equipment", "technician",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** What each built in entity is called on a screen, for a refusal or a heading. */
export const ENTITY_LABEL: Record<EntityType, string> = {
  customer: "Customers",
  property: "Addresses",
  job: "Jobs",
  invoice: "Invoices",
  estimate: "Estimates",
  visit: "Visits",
  equipment: "Equipment",
  technician: "Technicians",
};

/**
 * The table behind each entity type.
 *
 * Every identifier below is interpolated from THIS map and never from input,
 * and `entityOf` is the only way in. That ordering is the whole safety
 * argument for the raw identifiers in the queries further down: a caller
 * cannot reach them with a string of their own, because a string of their
 * own is refused before a table name is ever chosen.
 */
const TABLE_OF: Record<EntityType, string> = {
  customer: "customer",
  property: "property",
  job: "job",
  invoice: "invoice",
  estimate: "estimate",
  visit: "visit",
  equipment: "equipment",
  technician: "technician",
};

/**
 * Who may read and who may change each built in entity's values, which are
 * that entity's OWN permissions: filling in a field on an invoice is editing
 * the invoice. A technician is a person on the team, read with `user:read`
 * and changed with `user:write`, as the team screen does.
 */
const READ_OF: Record<EntityType, Permission> = {
  customer: "customer:read", property: "property:read", job: "job:read",
  invoice: "invoice:read", estimate: "estimate:read", visit: "visit:read",
  equipment: "equipment:read", technician: "user:read",
};
const WRITE_OF: Record<EntityType, Permission> = {
  customer: "customer:write", property: "property:write", job: "job:write",
  invoice: "invoice:write", estimate: "estimate:write", visit: "visit:write",
  equipment: "equipment:write", technician: "user:write",
};

const isBuiltIn = (entityType: string): entityType is EntityType =>
  (ENTITY_TYPES as readonly string[]).includes(entityType);

/**
 * A built in entity or a kind of record's entity type, by its shape alone.
 * Whether the kind exists is `targetOf`'s question, asked of the database.
 */
function entityOf(entityType: string): string {
  if (isBuiltIn(entityType) || customObjects.keyOfEntityType(entityType) !== null) return entityType;
  throw new ConflictError(
    `"${entityType}" is not something this product can hold a custom field on. `
    + `One of: ${ENTITY_TYPES.join(", ")}, or one of the company's own kinds of record.`,
  );
}

/**
 * WHERE ONE ENTITY'S VALUES LIVE: a table from `TABLE_OF` (or the one table
 * every kind of record shares) and the condition that picks this entity's
 * rows out of it.
 *
 * For a kind of record the condition is its id, read here from the
 * company's own definitions; a key the company has not defined is refused
 * rather than treated as an empty kind, because a field defined on a kind
 * that does not exist is the "saved and gone" failure above.
 */
interface Target {
  entityType: string;
  table: string;
  rows: SQL;
  /** A kind of record's id, when it is one. */
  objectTypeId: string | null;
}

async function targetOf(tx: Database, organizationId: string, entityType: string): Promise<Target> {
  const entity = entityOf(entityType);
  if (isBuiltIn(entity)) return { entityType: entity, table: TABLE_OF[entity], rows: sql`true`, objectTypeId: null };
  const key = customObjects.keyOfEntityType(entity)!;
  const [kind] = await tx.select({ id: schema.customObjectType.id }).from(schema.customObjectType)
    .where(and(
      eq(schema.customObjectType.organizationId, organizationId),
      eq(schema.customObjectType.key, key),
      isNull(schema.customObjectType.deletedAt),
    )).limit(1);
  if (!kind) {
    throw new ConflictError(`There is no kind of record called "${key}" in this company. Define it first.`);
  }
  return {
    entityType: entity,
    table: "custom_object_record",
    rows: sql`t.object_type_id = ${kind.id}`,
    objectTypeId: kind.id,
  };
}

/* ---------------------------------------------------------------- the types */

/**
 * The closed vocabulary of what a custom field can be.
 *
 * Closed because an open one is the same as no type at all. `dataType` is
 * only worth a column if a screen can draw a control from it and this service
 * can refuse a value that contradicts it; a free string means the screen
 * falls back to a text box for everything it does not recognise, which is a
 * text box for everything, which is where this started.
 *
 * `date` is an ISO calendar date and deliberately not a timestamp. The value
 * lands in jsonb, where a `Date` does not survive the round trip, and a field
 * a company labels "Warranty expires" is a day rather than an instant. Two
 * offices writing `2026-03-01` and `2026-03-01T00:00:00-06:00` into the same
 * field produce two values that are never equal and sort against each other
 * wrongly, and neither one looks wrong on its own.
 */
export const DATA_TYPES = rules.DATA_TYPES;
export type DataType = rules.DataType;

/** The types whose whole meaning is the list of things they may be. */
const NEEDS_OPTIONS: DataType[] = ["select", "multiselect"];

/**
 * What a key is allowed to look like.
 *
 * Lowercase, starting with a letter, letters digits and underscores after
 * that. Three separate reasons, all of them about the key being a jsonb
 * object key rather than a label:
 *
 * It is CASE SENSITIVE in jsonb. `Warranty` and `warranty` are two different
 * fields that read as one on a screen and in an export header, and the office
 * that created the second one will never find out why half the rows are
 * blank.
 *
 * It is written into `custom_fields -> 'key'` and into export headers. A key
 * with a quote, a dot or a space in it makes both of those ambiguous, and the
 * ambiguity shows up as a filter that silently matches nothing.
 *
 * It is a STABLE IDENTIFIER, not a name. The label is the name, the label can
 * be changed freely, and the key is the thing thousands of stored rows point
 * at by string. See `update` for what a rename would cost.
 */
const KEY = /^[a-z][a-z0-9_]{0,63}$/;

/* ------------------------------------------------------------ the definition */

/**
 * `Partial`, but honest under `exactOptionalPropertyTypes`.
 *
 * A patch arrives from a JSON body, where an absent key and a key explicitly
 * set to undefined are the same answer to "did the caller name this field".
 * Plain `Partial` says `label?: string`, which refuses `string | undefined`
 * and makes every handler that forwards a decoded body fail to compile.
 */
type Patch<T> = { [K in keyof T]?: T[K] | undefined };

export interface DefinitionInput {
  entityType: string;
  key: string;
  label: string;
  dataType?: string | undefined;
  options?: string[] | undefined;
  required?: boolean | undefined;
  sortOrder?: number | undefined;
}

interface Normalised {
  entityType: string;
  key: string;
  label: string;
  dataType: DataType;
  options: string[];
  required: boolean;
  sortOrder: number;
}

function normalise(input: DefinitionInput): Normalised {
  const entityType = entityOf(input.entityType);
  const key = input.key.trim();
  const label = input.label.trim();
  const dataType = (input.dataType ?? "text").trim();

  if (!KEY.test(key)) {
    throw new ConflictError(
      `"${input.key}" is not a usable key. It has to start with a lowercase letter and hold only `
      + "lowercase letters, digits and underscores, because it is stored as a JSON key and printed "
      + "as an export column header rather than shown to anybody.",
    );
  }
  if (label === "") {
    throw new ConflictError(
      "A custom field needs a label. The key is what the value is stored under and the label is "
      + "what the person filling it in reads, and a field with no label is a blank box.",
    );
  }
  if (!(DATA_TYPES as readonly string[]).includes(dataType)) {
    throw new ConflictError(
      `"${dataType}" is not a type this product can draw or check. One of: ${DATA_TYPES.join(", ")}.`,
    );
  }

  const options = (input.options ?? [])
    .map((option) => option.trim())
    .filter((option) => option !== "");

  if (NEEDS_OPTIONS.includes(dataType as DataType) && options.length === 0) {
    /**
     * A choice field with nothing to choose from is not a strict field, it is
     * an impossible one: every value fails the "must be one of" check below,
     * so the field can never be filled in and a required one blocks the save
     * of the whole record. Refused here, where somebody is looking at the
     * form, rather than discovered by the first person who tries to save a
     * customer.
     */
    throw new ConflictError(
      `A ${dataType} field needs at least one option. With none, every value is rejected and the `
      + "field can never be filled in.",
    );
  }

  const unique = new Set(options);
  if (unique.size !== options.length) {
    throw new ConflictError(
      "Two of those options are the same. A duplicate makes one of them unselectable and neither "
      + "of them identifiable in a report.",
    );
  }

  const sortOrder = input.sortOrder ?? 0;
  if (!Number.isInteger(sortOrder)) {
    throw new ConflictError("Sort order is a whole number.");
  }

  return {
    entityType,
    key,
    label,
    dataType: dataType as DataType,
    options,
    required: input.required ?? false,
    sortOrder,
  };
}

/* ------------------------------------------------- checking a value by itself */

/**
 * What is wrong with one value, or null when nothing is.
 *
 * Absent and JSON null both mean "not filled in" and neither is a type
 * failure. Whether that is allowed is the `required` question, answered by
 * the caller, because a missing value and a wrong value are different things
 * to say to somebody.
 */
function valueProblem(definition: Pick<Normalised, "dataType" | "options">, value: unknown): string | null {
  return rules.valueProblem(definition, value);
}

/* ------------------------------------------------------- what the data holds */

/**
 * The distinct values already stored under one key.
 *
 * Used to answer the only question that matters before changing a definition:
 * does this change contradict something already written down. A definition
 * change is free when the answer is no and destroys data when the answer is
 * yes, and the two are indistinguishable from the patch alone.
 *
 * Distinct rather than every row, because the answer is about the SHAPE of
 * what is stored: a thousand rows holding "annual" are one fact, and a
 * refusal that lists a thousand identical values is a refusal nobody reads.
 *
 * The identifier is interpolated from `TABLE_OF` (or is the one table every
 * kind of record shares) after `entityOf` has already refused anything else,
 * by way of `targetOf`. The key and a kind's id are bound parameters.
 */
async function storedValues(
  tx: Database, organizationId: string, target: Target, key: string,
): Promise<unknown[]> {
  const rows = await tx.execute<{ value: unknown }>(sql`
    select distinct t.custom_fields -> ${key} as value
    from public.${sql.raw(`"${target.table}"`)} t
    where t.organization_id = ${organizationId}
      and ${target.rows}
      and t.deleted_at is null
      and t.custom_fields -> ${key} is not null
      and t.custom_fields -> ${key} <> 'null'::jsonb
  `);
  return rows.map((row) => row.value);
}

/** How many rows actually carry a value under a key. A definition nothing uses is worth seeing. */
async function rowsCarrying(
  tx: Database, organizationId: string, target: Target, key: string,
): Promise<number> {
  const [row] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n
    from public.${sql.raw(`"${target.table}"`)} t
    where t.organization_id = ${organizationId}
      and ${target.rows}
      and t.deleted_at is null
      and t.custom_fields -> ${key} is not null
      and t.custom_fields -> ${key} <> 'null'::jsonb
  `);
  return row?.n ?? 0;
}

/** Every key present in the data for an entity type, with how many rows carry it. */
async function keysInData(
  tx: Database, organizationId: string, target: Target,
): Promise<Map<string, number>> {
  const rows = await tx.execute<{ key: string; n: number }>(sql`
    select k.key as key, count(*)::int as n
    from public.${sql.raw(`"${target.table}"`)} t
    cross join lateral jsonb_object_keys(t.custom_fields) k(key)
    where t.organization_id = ${organizationId}
      and ${target.rows}
      and t.deleted_at is null
      and t.custom_fields -> k.key <> 'null'::jsonb
    group by k.key
  `);
  return new Map(rows.map((row) => [row.key, row.n]));
}

/** The live rows of an entity type, which is the denominator for a required field. */
async function rowCount(
  tx: Database, organizationId: string, target: Target,
): Promise<number> {
  const [row] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n
    from public.${sql.raw(`"${target.table}"`)} t
    where t.organization_id = ${organizationId} and ${target.rows} and t.deleted_at is null
  `);
  return row?.n ?? 0;
}

/**
 * REFUSE A DEFINITION THAT CONTRADICTS WHAT IS ALREADY STORED.
 *
 * One rule covering three changes that look unrelated on a form and are the
 * same thing underneath:
 *
 *   Changing the type of a field that holds values. Every string under a
 *   field turned from text to number is invalid from that moment, all at
 *   once, and this service has no honest way to convert them: "12 months"
 *   is not a number and guessing 12 is inventing data.
 *
 *   Taking an option off a select. Every row already holding the removed
 *   option now holds a value that is not one of the options.
 *
 *   Adopting a key the data already uses. Somebody defines `warranty` as a
 *   date over eight hundred rows that have been storing free text in it.
 *
 * In all three the definition and the data disagree the instant the write
 * lands, and nothing tells anybody: the rows are still there, they simply
 * fail every check from then on, and the person who finds out is whoever next
 * tries to save an unrelated edit to that customer.
 *
 * It is checked against the values that EXIST rather than refused outright,
 * so the harmless version of each change stays easy. Retyping a field nobody
 * has filled in, or dropping an option nobody picked, goes through.
 *
 * The escape hatch is deliberate and is not a flag on this function: clear
 * the values, or define a new key and migrate. Both are visible acts. A
 * `force` here would be a single checkbox that invalidates a column of a
 * company's data with no record of what it used to say.
 */
async function assertFitsStoredData(
  tx: Database, organizationId: string, proposed: Normalised, target: Target,
): Promise<void> {
  const values = await storedValues(tx, organizationId, target, proposed.key);
  const offending = values
    .map((value) => ({ value, problem: valueProblem(proposed, value) }))
    .filter((entry) => entry.problem !== null);

  if (offending.length === 0) return;

  const shown = offending.slice(0, 5).map((entry) => JSON.stringify(entry.value)).join(", ");
  const more = offending.length > 5 ? `, and ${offending.length - 5} more` : "";
  throw new ConflictError(
    `${offending.length} value${offending.length === 1 ? "" : "s"} already stored under "${proposed.key}" `
    + `would not be valid as a ${proposed.dataType} field: ${shown}${more}. `
    + "Clear those values first, or define a new key and move the data, because changing this now "
    + "leaves every one of those rows failing validation with nothing on any screen saying why.",
  );
}

/* --------------------------------------------------------------- the service */

async function load(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.customFieldDefinition)
    .where(and(
      eq(schema.customFieldDefinition.id, id),
      eq(schema.customFieldDefinition.organizationId, organizationId),
      isNull(schema.customFieldDefinition.deletedAt),
    )).limit(1);
  if (!row) throw new NotFoundError("Custom field");
  return row;
}

/**
 * One definition per key per entity type, enforced here because nothing in
 * the database enforces it.
 *
 * There is no unique index on (organization, entity type, key), and a second
 * definition for the same key is not a duplicate row that somebody tidies up
 * later. It is two labels, two types and two required flags over ONE stored
 * value, and which of them a screen or a validator picks up is settled by
 * whichever the index happened to return first. A field that is required on
 * Tuesday and optional on Wednesday, with no edit in between.
 *
 * Scoped to live definitions, so a key that was removed can be defined again.
 */
async function assertKeyFree(
  tx: Database, organizationId: string, entityType: string, key: string, exceptId?: string,
): Promise<void> {
  const rows = await tx.select({ id: schema.customFieldDefinition.id })
    .from(schema.customFieldDefinition)
    .where(and(
      eq(schema.customFieldDefinition.organizationId, organizationId),
      eq(schema.customFieldDefinition.entityType, entityType),
      eq(schema.customFieldDefinition.key, key),
      isNull(schema.customFieldDefinition.deletedAt),
    ));
  if (rows.some((row) => row.id !== exceptId)) {
    throw new ConflictError(
      `"${key}" is already defined on ${entityType}. One key is one field: a second definition over `
      + "the same stored value means the label, the type and whether it is required are decided by "
      + "whichever row a query happened to read first.",
    );
  }
}

export async function define(ctx: ServiceContext, input: DefinitionInput) {
  return guardedWrite(ctx, "customfield:write", async (tx) => {
    const proposed = normalise(input);
    const target = await targetOf(tx, ctx.actor.organizationId, proposed.entityType);
    await assertKeyFree(tx, ctx.actor.organizationId, proposed.entityType, proposed.key);
    await assertFitsStoredData(tx, ctx.actor.organizationId, proposed, target);

    const [row] = await tx.insert(schema.customFieldDefinition).values({
      organizationId: ctx.actor.organizationId,
      entityType: proposed.entityType,
      key: proposed.key,
      label: proposed.label,
      dataType: proposed.dataType,
      options: proposed.options,
      required: proposed.required,
      sortOrder: proposed.sortOrder,
    }).returning();

    await audit(tx, ctx, "custom_field.defined", "custom_field_definition", row!.id, null, row!);
    return withBacklog(tx, ctx.actor.organizationId, row!);
  });
}

/**
 * Edit a definition. NOT ITS KEY, AND NOT WHAT IT IS ABOUT.
 *
 * THE RENAME IS REFUSED, and this is the deliberate decision the rest of the
 * file is shaped around.
 *
 * The value lives at `custom_fields -> 'key'` on another table. There is no
 * foreign key, no cascade and no rename in the database: changing this row's
 * `key` from `warranty` to `warranty_expires` updates one row and touches
 * none of the thousands of rows storing a value, so every one of those values
 * is instantly orphaned. It is not lost, which is what makes it bad. It is
 * still sitting in the jsonb under the old key, invisible to the new
 * definition, reported as an unknown key by the validator, and blanked on
 * every screen. The company sees a column of empty cells and concludes the
 * data was deleted.
 *
 * Renaming the key AND rewriting every row would be a second option, and it
 * is not this one. It is an unbounded update over three tables inside a
 * request, it is not reversible, and it silently rewrites data the person
 * thought they were relabelling. The whole point of having a `label` column
 * separate from a `key` column is that the thing people actually want here,
 * which is to change what the field is CALLED, is free and lossless.
 *
 * So: the label changes, the key does not. To genuinely change the key,
 * define the new one, move the data, remove the old one. Three visible steps
 * that each leave a record, instead of one that does not.
 *
 * `entityType` is refused for the same reason. Moving a definition from
 * customer to job leaves every customer's stored value under a key nothing
 * defines any more, and defines a field on jobs that no job has ever held.
 */
export async function update(
  ctx: ServiceContext,
  input: Patch<DefinitionInput> & { id: string },
) {
  return guardedWrite(ctx, "customfield:write", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);

    if (input.key !== undefined && input.key.trim() !== before.key) {
      throw new ConflictError(
        `A custom field's key cannot be changed. Every value stored under "${before.key}" is matched `
        + "by that string and nothing else, so renaming it would orphan all of them at once: they stay "
        + "in the database, stop being found, and read as deleted. Change the label instead, or define "
        + "the new key, move the data and remove this one.",
      );
    }
    if (input.entityType !== undefined && input.entityType !== before.entityType) {
      throw new ConflictError(
        `A custom field cannot be moved from ${before.entityType} to ${input.entityType}. The values `
        + `stay on ${before.entityType} and would be left with no definition, and the field would appear `
        + `on ${input.entityType} having never been filled in.`,
      );
    }

    /**
     * Merged before validating, for the reason contacts and phone numbers
     * are: a patch that clears the options is unremarkable on its own and
     * leaves a select field nobody can ever fill in, which is exactly the
     * state `normalise` exists to refuse. A guard that reads only the patch
     * passes every field it was given and still writes the row it exists to
     * prevent.
     */
    const merged: DefinitionInput = {
      entityType: before.entityType,
      key: before.key,
      label: input.label ?? before.label,
      dataType: input.dataType ?? before.dataType,
      options: input.options ?? before.options,
      required: input.required ?? before.required,
      sortOrder: input.sortOrder ?? before.sortOrder,
    };
    const proposed = normalise(merged);
    const target = await targetOf(tx, ctx.actor.organizationId, proposed.entityType);
    await assertKeyFree(tx, ctx.actor.organizationId, proposed.entityType, proposed.key, before.id);
    await assertFitsStoredData(tx, ctx.actor.organizationId, proposed, target);

    const [after] = await tx.update(schema.customFieldDefinition).set({
      label: proposed.label,
      dataType: proposed.dataType,
      options: proposed.options,
      required: proposed.required,
      sortOrder: proposed.sortOrder,
      updatedAt: new Date(),
    }).where(eq(schema.customFieldDefinition.id, before.id)).returning();

    await audit(tx, ctx, "custom_field.updated", "custom_field_definition", before.id, before, after!);
    return withBacklog(tx, ctx.actor.organizationId, after!);
  });
}

/**
 * Take a field off, and say what that costs.
 *
 * Soft, so the definition that was in force when a value was written is still
 * readable afterwards, and so the audit row naming it resolves to something.
 *
 * REFUSED WHILE ROWS STILL CARRY A VALUE, unless the caller says otherwise.
 * Removing the definition does not remove the data: the values stay in the
 * jsonb, the screen stops drawing the field, and the validator starts
 * reporting them as unknown keys, so a company that removes a field in
 * settings finds out when an unrelated edit to a customer is refused. The
 * count is in the message because "this will orphan 812 values" is a
 * different decision from "this will orphan none", and a confirmation dialog
 * that cannot tell you which one you are in is not a confirmation.
 *
 * `force` is allowed rather than withheld, and reports what it did. A company
 * retiring a field they filled in for two years is entitled to retire it; the
 * thing they must not be able to do is retire it without being told.
 */
export async function remove(ctx: ServiceContext, input: { id: string; force?: boolean | undefined }) {
  return guardedWrite(ctx, "customfield:write", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);
    const target = await targetOf(tx, ctx.actor.organizationId, before.entityType);
    const carrying = await rowsCarrying(tx, ctx.actor.organizationId, target, before.key);

    if (carrying > 0 && !input.force) {
      throw new ConflictError(
        `${carrying} ${before.entityType} row${carrying === 1 ? "" : "s"} still hold a value for "${before.key}". `
        + "Removing the field does not remove those values: they stay in the record, stop being shown, "
        + "and start failing validation as an unknown key. Clear them first, or remove it anyway and "
        + "accept that.",
      );
    }

    const [after] = await tx.update(schema.customFieldDefinition)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.customFieldDefinition.id, before.id))
      .returning();

    await audit(tx, ctx, "custom_field.removed", "custom_field_definition", before.id, before, after!);
    return {
      id: before.id,
      removed: true as const,
      /** Values now sitting under a key nothing defines. Zero is the good answer. */
      orphanedValues: carrying,
    };
  });
}

export async function list(ctx: ServiceContext, input: { entityType?: string | undefined } = {}) {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const entityType = input.entityType === undefined ? undefined : entityOf(input.entityType);

    const rows = await tx.select().from(schema.customFieldDefinition)
      .where(and(
        eq(schema.customFieldDefinition.organizationId, ctx.actor.organizationId),
        isNull(schema.customFieldDefinition.deletedAt),
        ...(entityType ? [eq(schema.customFieldDefinition.entityType, entityType)] : []),
      ))
      /**
       * Sort order first, then key. `sortOrder` defaults to zero for every
       * row, so without the second term the order of a company's fields is
       * whatever the heap returned and it changes between two reads of the
       * same unedited settings screen.
       */
      .orderBy(
        asc(schema.customFieldDefinition.entityType),
        asc(schema.customFieldDefinition.sortOrder),
        asc(schema.customFieldDefinition.key),
      );

    return rows.map(shape);
  });
}

/**
 * WHAT IS DEFINED, AND WHAT IS ACTUALLY USED.
 *
 * Two questions a settings screen cannot answer from the definitions alone,
 * and both of them are about the join this file has no foreign key for.
 *
 * A DEFINITION NOTHING USES. Somebody added it, the office never filled it
 * in, and it has been taking up a row on every customer form since. Worth
 * seeing, because the cost of a field nobody fills in is paid on every record
 * anybody opens.
 *
 * A KEY NOTHING DEFINES. The opposite, and the more serious one: values sat
 * in `custom_fields` under keys with no label and no type for as long as this
 * table had no service, and an import or an integration can put one there
 * tomorrow. Those are real data that no screen shows and no export names.
 * Reporting them is how a company finds out what it has.
 */
export async function usage(ctx: ServiceContext, input: { entityType?: string | undefined } = {}) {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const only = input.entityType === undefined ? undefined : entityOf(input.entityType);
    /**
     * Every built in entity and every kind of record the company defined,
     * because a field on a permit nobody fills in costs exactly what one on a
     * customer does.
     */
    const kinds = only ? [] : await tx.select({ key: schema.customObjectType.key })
      .from(schema.customObjectType)
      .where(isNull(schema.customObjectType.deletedAt))
      .orderBy(asc(schema.customObjectType.sortOrder), asc(schema.customObjectType.key));
    const entityTypes: string[] = only
      ? [only]
      : [...ENTITY_TYPES, ...kinds.map((kind) => customObjects.entityTypeFor(kind.key))];

    const definitions = await tx.select().from(schema.customFieldDefinition)
      .where(and(
        eq(schema.customFieldDefinition.organizationId, ctx.actor.organizationId),
        isNull(schema.customFieldDefinition.deletedAt),
      ))
      .orderBy(
        asc(schema.customFieldDefinition.sortOrder),
        asc(schema.customFieldDefinition.key),
      );

    const report = [];
    for (const entityType of entityTypes) {
      const target = await targetOf(tx, ctx.actor.organizationId, entityType);
      const present = await keysInData(tx, ctx.actor.organizationId, target);
      const total = await rowCount(tx, ctx.actor.organizationId, target);
      const mine = definitions.filter((row) => row.entityType === entityType);

      const defined = mine.map((row) => ({
        ...shape(row),
        /** Rows holding something other than nothing. A JSON null is nothing. */
        rowsWithValue: present.get(row.key) ?? 0,
        /**
         * Only meaningful on a required field, and computed rather than
         * assumed: making a field required does not go back and fill it in,
         * so a company that turned one on last week has a backlog and no
         * screen would say how big.
         */
        rowsMissingValue: row.required ? total - (present.get(row.key) ?? 0) : 0,
      }));

      const definedKeys = new Set(mine.map((row) => row.key));
      const undefinedKeys = [...present.entries()]
        .filter(([key]) => !definedKeys.has(key))
        .map(([key, rows]) => ({ key, rowsWithValue: rows }))
        .sort((a, b) => b.rowsWithValue - a.rowsWithValue || a.key.localeCompare(b.key));

      report.push({ entityType, rows: total, defined, undefinedKeys });
    }

    return report;
  });
}

/**
 * The backlog a required field starts with, attached to the row it is about.
 *
 * Returned from `define` and `update` rather than refusing them. Making a
 * field required does not reach back and fill it in on the records that
 * already exist, so a company with four thousand customers that turns on a
 * required field has four thousand incomplete records from that moment. That
 * is usually FINE and occasionally exactly what they meant, so refusing it
 * would make the feature unusable on any company with history. What is not
 * fine is not being told.
 */
async function withBacklog(
  tx: Database, organizationId: string, row: typeof schema.customFieldDefinition.$inferSelect,
) {
  const target = await targetOf(tx, organizationId, row.entityType);
  const carrying = await rowsCarrying(tx, organizationId, target, row.key);
  return {
    ...shape(row),
    rowsWithValue: carrying,
    rowsMissingValue: row.required ? (await rowCount(tx, organizationId, target)) - carrying : 0,
  };
}

/* -------------------------------------------------------------- the checking */

export interface FieldProblem {
  key: string;
  problem: string;
}

/**
 * CHECK A BAG OF CUSTOM VALUES AGAINST WHAT THIS COMPANY DECLARED.
 *
 * Takes a transaction rather than a context, so the service doing the write
 * calls it INSIDE its own guarded transaction and under its own permission.
 * That is the same shape as `senderFor` in phone-numbers and `policyFor` in
 * reviews, and it is the only shape that works here: a technician completing
 * a job has `job:complete` and no business holding `settings:read`, so a
 * validator that checked a settings permission of its own would refuse the
 * write it was called to protect. The guarded entry point below is for a
 * screen asking the question on its own.
 *
 * EVERY PROBLEM AT ONCE, not the first one. A form with three bad fields
 * corrected one at a time is three round trips, and the third one is where
 * somebody gives up and types whatever gets past it.
 *
 * UNKNOWN KEYS ARE A PROBLEM, not something to ignore. A value under a key
 * nothing defines is stored, never shown and never exported, so accepting it
 * quietly is how a company spends a year filling in a field that does not
 * exist. This is also why this is not switched on in the customer, property
 * and job writes yet: those organizations already have such keys, and turning
 * it on without clearing them first refuses saves for data that was legal
 * when it was written.
 */
export async function validateWithin(
  tx: Database,
  organizationId: string,
  entityType: string,
  customFields: Record<string, unknown>,
): Promise<FieldProblem[]> {
  const entity = entityOf(entityType);

  const definitions = await tx.select().from(schema.customFieldDefinition)
    .where(and(
      eq(schema.customFieldDefinition.organizationId, organizationId),
      eq(schema.customFieldDefinition.entityType, entity),
      isNull(schema.customFieldDefinition.deletedAt),
    ));

  const problems: FieldProblem[] = [];
  const byKey = new Map(definitions.map((row) => [row.key, row]));

  for (const key of Object.keys(customFields)) {
    if (!byKey.has(key)) {
      problems.push({
        key,
        problem: `is not a custom field defined on ${entity}, so nothing would ever show it back`,
      });
    }
  }

  for (const definition of definitions) {
    const value = customFields[definition.key];
    const missing = value === null || value === undefined
      || (typeof value === "string" && value.trim() === "")
      || (Array.isArray(value) && value.length === 0);

    if (missing) {
      if (definition.required) {
        problems.push({ key: definition.key, problem: `${definition.label} is required` });
      }
      continue;
    }

    const problem = valueProblem(
      { dataType: definition.dataType as DataType, options: definition.options },
      value,
    );
    if (problem) problems.push({ key: definition.key, problem: `${definition.label} ${problem}` });
  }

  return problems.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The same check, refused rather than reported.
 *
 * What a service calls when it wants the write to stop. Separate from
 * `validateWithin` because a screen highlighting three fields and a save
 * refusing the record want the same answer in two different shapes, and a
 * function that throws cannot give you the list.
 */
export async function assertValidWithin(
  tx: Database,
  organizationId: string,
  entityType: string,
  customFields: Record<string, unknown>,
): Promise<void> {
  const problems = await validateWithin(tx, organizationId, entityType, customFields);
  if (problems.length === 0) return;
  throw new ConflictError(
    problems.map((problem) => `"${problem.key}" ${problem.problem}`).join(". ") + ".",
  );
}

/**
 * Ask the question from outside a write.
 *
 * `settings:read` rather than a permission every role holds, because this is
 * the settings surface asking what the rules are: "here is a draft of a
 * record, tell me what is wrong with it". The enforcement path is
 * `validateWithin`, above, which runs inside the write it protects and under
 * that write's own permission. A technician saving a job is never routed
 * through here.
 */
export async function validate(
  ctx: ServiceContext,
  entityType: string,
  customFields: Record<string, unknown>,
) {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const problems = await validateWithin(tx, ctx.actor.organizationId, entityType, customFields);
    return { valid: problems.length === 0, problems };
  });
}

function shape(row: typeof schema.customFieldDefinition.$inferSelect) {
  return {
    id: row.id,
    entityType: row.entityType,
    key: row.key,
    label: row.label,
    dataType: row.dataType,
    options: row.options,
    required: row.required,
    sortOrder: row.sortOrder,
  };
}

/**
 * THE CHECK THE SAVE PATH ACTUALLY RUNS, WHICH IS NARROWER THAN THE ONE A
 * SCREEN ASKS FOR.
 *
 * `validateWithin` above answers "is this record's custom data correct", and
 * refuses a key nothing defines, which is right for a settings screen asking
 * the question. Running exactly that inside `customer.update` would have
 * broken every organization in the product on the day it shipped: the jsonb
 * columns have been writable with no definitions since the first migration,
 * so every company's existing records are full of keys nothing defines, and
 * the first save of an untouched legacy customer would have been refused for
 * data that was legal when it was written and that the person saving did not
 * touch.
 *
 * So the write path enforces two things and not the third:
 *
 *   REFUSED   a value that contradicts a definition this company declared.
 *   REFUSED   a required field this write left empty.
 *   ALLOWED   a key nothing defines.
 *
 * The third is not ignored, it is REPORTED, by `usage`, which is the screen
 * that exists to answer "what is in our data that nothing describes". A
 * company finds those and clears them at a time they choose, rather than
 * discovering them one refused save at a time on a Tuesday morning.
 *
 * AND ONLY ON WHAT THIS WRITE CHANGED. `previous` is the bag as it was
 * stored, absent on a create. A key whose value is identical to what was
 * already there is not checked, so nobody is ever refused for data they did
 * not touch: a definition added today does not retroactively make yesterday's
 * records unsaveable. Typing a new bad value into the same field is a
 * different act and is refused.
 *
 * On a create every key is new, and a required field left empty on a create
 * IS refused. That is what required means, and the company turned it on
 * deliberately.
 */
export async function enforceWithin(
  tx: Database,
  organizationId: string,
  entityType: string,
  next: Record<string, unknown>,
  previous?: Record<string, unknown> | undefined,
  /** Where the bag sits in the request, for the refusal's paths. */
  at = "customFields",
): Promise<void> {
  const entity = entityOf(entityType);

  /**
   * DRIVEN BY THE DEFINITIONS, NEVER BY THE KEYS IN THE RECORD, which is the
   * whole of why a company that has declared nothing is left exactly where
   * it was before this file existed: there is nothing to check, so nothing
   * is refused, and their column stays the free bag it always was.
   */
  const definitions = await tx.select().from(schema.customFieldDefinition)
    .where(and(
      eq(schema.customFieldDefinition.organizationId, organizationId),
      eq(schema.customFieldDefinition.entityType, entity),
      isNull(schema.customFieldDefinition.deletedAt),
    ));

  const refusals = rules.checkChanged(definitions, next, previous);
  if (refusals.length === 0) return;

  /**
   * ONE SENTENCE PER FIELD, each at `customFields.<key>`, so an API client
   * can put each one beside the box it is about and a screen can say all of
   * them at once. Unprocessable rather than a conflict: nothing about the
   * record's state is in the way, the values are wrong.
   */
  throw new UnprocessableError(
    refusals.length === 1 ? "A custom field needs changing" : "Some custom fields need changing",
    refusals.map((refusal) => ({ path: `${at}.${refusal.key}`, message: refusal.message })),
  );
}

/**
 * The fields a form for one kind of record draws, in the order the company
 * set, under that record's OWN read permission.
 *
 * Not `list`, which is the settings surface and needs `settings:read`: an
 * office manager adding a customer has to see the boxes the company declared
 * whether or not they may change the declarations, or the first they hear of
 * a required field is the refusal.
 */
export async function formFields(ctx: ServiceContext, entityType: string) {
  const entity = entityOf(entityType);
  if (isBuiltIn(entity)) {
    return guardedRead(ctx, READ_OF[entity], (tx) => definitionsWithin(tx, ctx.actor.organizationId, entity));
  }
  /**
   * A kind of record's own read permission, which the company chose on its
   * definition. Read first, then asserted, inside one transaction.
   */
  assertCan(ctx.actor, "record:read");
  return inTenant(ctx, async (tx) => {
    const key = customObjects.keyOfEntityType(entity)!;
    const [kind] = await tx.select({ readPermission: schema.customObjectType.readPermission })
      .from(schema.customObjectType)
      .where(and(eq(schema.customObjectType.key, key), isNull(schema.customObjectType.deletedAt))).limit(1);
    if (!kind) throw new NotFoundError("Kind of record");
    assertCan(ctx.actor, kind.readPermission as Permission);
    return definitionsWithin(tx, ctx.actor.organizationId, entity);
  });
}

/** One entity's definitions in the company's order, inside a transaction the caller holds and has authorised. */
export async function definitionsWithin(tx: Database, organizationId: string, entityType: string) {
  const rows = await tx.select().from(schema.customFieldDefinition)
    .where(and(
      eq(schema.customFieldDefinition.organizationId, organizationId),
      eq(schema.customFieldDefinition.entityType, entityType),
      isNull(schema.customFieldDefinition.deletedAt),
    ))
    .orderBy(asc(schema.customFieldDefinition.sortOrder), asc(schema.customFieldDefinition.key));
  return rows.map(shape);
}

/* ---------------------------------------------- the five that grew a column */

/**
 * THE RECORDS WHOSE FIELDS ARE SAVED HERE RATHER THAN BY THEIR OWN UPDATE.
 *
 * A customer, an address and a job carry their fields through their own
 * create and update, which were already the paths every screen used. The
 * invoice, the estimate, the visit, the unit and the technician grew a
 * column later, and their writes are each guarded by rules that have nothing
 * to do with a custom field: an issued invoice's lines are frozen, a sent
 * estimate is hashed, a visit moves on the board under its own permission.
 * Threading a field through each of those would make "may I fill in the
 * permit number" depend on "may I change the price".
 *
 * So the fields have one write of their own, under the RECORD'S write
 * permission and its scope (a technician fills in a field on a visit they
 * were on, not on anybody's), held to the same check every other write is:
 * only what this write changed, every refusal at once.
 */
export const VALUE_ENTITIES = ["invoice", "estimate", "visit", "equipment", "technician"] as const;
export type ValueEntity = (typeof VALUE_ENTITIES)[number];

/** The record's stored values, if the caller may see it, inside their scope. */
async function valuesOf(
  tx: Database, ctx: ServiceContext, entityType: ValueEntity, id: string,
): Promise<Record<string, unknown> | null> {
  switch (entityType) {
    case "invoice": {
      const [row] = await tx.select({ values: schema.invoice.customFields }).from(schema.invoice)
        .where(and(eq(schema.invoice.id, id), isNull(schema.invoice.deletedAt),
          invoiceScopeFilter(scopeOf(ctx, "invoice"), ctx.actor))).limit(1);
      return row?.values ?? null;
    }
    case "estimate": {
      const [row] = await tx.select({ values: schema.estimate.customFields }).from(schema.estimate)
        .where(and(eq(schema.estimate.id, id), isNull(schema.estimate.deletedAt),
          estimateScopeFilter(scopeOf(ctx, "estimate"), ctx.actor))).limit(1);
      return row?.values ?? null;
    }
    case "visit": {
      const [row] = await tx.select({ values: schema.visit.customFields }).from(schema.visit)
        .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
        .where(and(eq(schema.visit.id, id), isNull(schema.job.deletedAt),
          jobVisibility(scopeOf(ctx, "visit"), ctx.actor, sql`${schema.job.id}`))).limit(1);
      return row?.values ?? null;
    }
    case "equipment": {
      const [row] = await tx.select({ values: schema.equipment.customFields }).from(schema.equipment)
        .where(and(eq(schema.equipment.id, id), isNull(schema.equipment.deletedAt))).limit(1);
      return row?.values ?? null;
    }
    case "technician": {
      const [row] = await tx.select({ values: schema.technician.customFields }).from(schema.technician)
        .where(eq(schema.technician.id, id)).limit(1);
      return row?.values ?? null;
    }
  }
}

async function writeValues(tx: Database, entityType: ValueEntity, id: string, values: Record<string, unknown>) {
  const set = { customFields: values, updatedAt: new Date() };
  switch (entityType) {
    case "invoice": await tx.update(schema.invoice).set(set).where(eq(schema.invoice.id, id)); return;
    case "estimate": await tx.update(schema.estimate).set(set).where(eq(schema.estimate.id, id)); return;
    case "visit": await tx.update(schema.visit).set(set).where(eq(schema.visit.id, id)); return;
    case "equipment": await tx.update(schema.equipment).set(set).where(eq(schema.equipment.id, id)); return;
    case "technician": await tx.update(schema.technician).set(set).where(eq(schema.technician.id, id)); return;
  }
}

const NOUN: Record<ValueEntity, string> = {
  invoice: "Invoice", estimate: "Estimate", visit: "Visit", equipment: "Unit", technician: "Technician",
};

/**
 * Save the fields on one of the five.
 *
 * `values` is the whole bag as the caller wants it to be. A key the company
 * has not defined is kept as it is (never refused on save, as everywhere
 * else); the screens build the bag on top of what is stored, so nothing they
 * do not draw is lost.
 */
export async function setValues(
  ctx: ServiceContext,
  input: { entityType: ValueEntity; id: string; values: Record<string, unknown> },
) {
  if (!(VALUE_ENTITIES as readonly string[]).includes(input.entityType)) {
    throw new ConflictError(`Fields on ${input.entityType} are saved with that record's own update.`);
  }
  assertCan(ctx.actor, READ_OF[input.entityType]);
  return guardedWrite(ctx, WRITE_OF[input.entityType], async (tx) => {
    const before = await valuesOf(tx, ctx, input.entityType, input.id);
    if (before === null) throw new NotFoundError(NOUN[input.entityType]);
    await enforceWithin(tx, ctx.actor.organizationId, input.entityType, input.values, before);
    await writeValues(tx, input.entityType, input.id, input.values);
    await audit(tx, ctx, `${input.entityType}.custom_fields_saved`, input.entityType, input.id,
      { customFields: before }, { customFields: input.values });
    return { id: input.id, customFields: input.values };
  });
}

/* ------------------------------------------------------------ filtering by one */

/**
 * A condition matching the records whose field `key` holds `value`, for a list
 * filtered by a custom field ("every customer whose Gate code is set to...",
 * "every customer on the Annual plan").
 *
 * THE KEY MUST BE DECLARED. A filter on a key nothing defines matches nothing
 * for a reason nobody can see, and a typo in an address bar would read as
 * "no customers on the Annual plan". Refused in words instead.
 *
 * THE MATCH FOLLOWS THE TYPE, because the stored shape does. A yes or no
 * field stores JSON true or false and is matched as one, so "true" the string
 * is not mistaken for it. A number is compared as a number, so 5 matches a
 * stored 5.0. A field with several choices stores a list and matches a
 * record holding the choice among its others. Free text matches anywhere in
 * the value, ignoring case, because that is what somebody typing into a
 * filter box means. Everything else (a single choice, a date) is the value
 * exactly.
 *
 * The value is always bound as a parameter. The key is interpolated only
 * after it has been found among the company's own definitions, which are
 * themselves held to the key pattern above, and even then as a bound value
 * rather than as SQL.
 */
export async function filterCondition(
  tx: Database, organizationId: string, entityType: string, key: string, value: string,
  column: SQL,
): Promise<SQL> {
  const entity = entityOf(entityType);
  const noun = isBuiltIn(entity) ? entity : "record";
  const [definition] = await tx.select().from(schema.customFieldDefinition)
    .where(and(
      eq(schema.customFieldDefinition.organizationId, organizationId),
      eq(schema.customFieldDefinition.entityType, entity),
      eq(schema.customFieldDefinition.key, key),
      isNull(schema.customFieldDefinition.deletedAt),
    )).limit(1);
  if (!definition) {
    throw new ConflictError(
      `There is no ${noun} field called "${key}" to filter by. Choose one of the fields the company has set up.`,
    );
  }

  const wanted = value.trim();
  if (wanted === "") throw new ConflictError(`Say what ${definition.label} should be.`);

  switch (definition.dataType) {
    case "boolean": {
      const truth = /^(true|yes)$/i.test(wanted) ? true : /^(false|no)$/i.test(wanted) ? false : null;
      if (truth === null) throw new ConflictError(`${definition.label} is a yes or no field. Filter by yes or no.`);
      return sql`(${column} -> ${key}) = ${truth ? "true" : "false"}::jsonb`;
    }
    case "number": {
      if (!/^-?\d+(\.\d+)?$/.test(wanted)) {
        throw new ConflictError(`${definition.label} is a number. Filter by a number.`);
      }
      return sql`(${column} -> ${key}) = to_jsonb(${wanted}::numeric)`;
    }
    case "multiselect":
      return sql`(${column} -> ${key}) @> jsonb_build_array(${wanted}::text)`;
    case "text":
      return sql`(${column} ->> ${key}) ilike ${`%${wanted.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`;
    default:
      return sql`(${column} ->> ${key}) = ${wanted}`;
  }
}

/**
 * The same, for a list asked for by `fieldKey` and `fieldValue`: both halves
 * or neither, because a key with no value is a filter with nothing to match,
 * and saying so beats returning every record as though it had been applied.
 * Undefined when the list was not asked to filter.
 */
export async function listFilter(
  tx: Database, organizationId: string, entityType: string,
  input: { fieldKey?: string | undefined; fieldValue?: string | undefined }, column: SQL,
): Promise<SQL | undefined> {
  if ((input.fieldKey === undefined) !== (input.fieldValue === undefined)) {
    throw new ConflictError("Filtering by a custom field needs both the field and the value to look for.");
  }
  if (input.fieldKey === undefined || input.fieldValue === undefined) return undefined;
  return filterCondition(tx, organizationId, entityType, input.fieldKey, input.fieldValue, column);
}

/* ------------------------------------------------------------- the routes */

export const handlers = {
  defineCustomField: (ctx: ServiceContext, input: DefinitionInput) => define(ctx, input),

  listCustomFields: async (
    ctx: ServiceContext, input: { entityType?: string | undefined },
  ) => ({ definitions: await list(ctx, input) }),

  updateCustomField: (
    ctx: ServiceContext, input: Patch<DefinitionInput> & { id: string },
  ) => update(ctx, input),

  deleteCustomField: (
    ctx: ServiceContext, input: { id: string; force?: boolean | undefined },
  ) => remove(ctx, input),

  getCustomFieldUsage: async (
    ctx: ServiceContext, input: { entityType?: string | undefined },
  ) => ({ report: await usage(ctx, input) }),

  /**
   * Takes the bag as one field rather than as the body, because the body is
   * also where `entityType` is. A route whose whole input was the record
   * could not carry both without reserving a key, and a reserved key on a
   * feature whose entire subject is arbitrary keys is a trap.
   */
  validateCustomFields: (
    ctx: ServiceContext,
    input: { entityType: string; customFields: Record<string, unknown> },
  ) => validate(ctx, input.entityType, input.customFields),

  setInvoiceCustomFields: (ctx: ServiceContext, input: { id: string; customFields: Record<string, unknown> }) =>
    setValues(ctx, { entityType: "invoice", id: input.id, values: input.customFields }),
  setEstimateCustomFields: (ctx: ServiceContext, input: { id: string; customFields: Record<string, unknown> }) =>
    setValues(ctx, { entityType: "estimate", id: input.id, values: input.customFields }),
  setVisitCustomFields: (ctx: ServiceContext, input: { id: string; customFields: Record<string, unknown> }) =>
    setValues(ctx, { entityType: "visit", id: input.id, values: input.customFields }),
  setEquipmentCustomFields: (ctx: ServiceContext, input: { id: string; customFields: Record<string, unknown> }) =>
    setValues(ctx, { entityType: "equipment", id: input.id, values: input.customFields }),
  setTechnicianCustomFields: (ctx: ServiceContext, input: { id: string; customFields: Record<string, unknown> }) =>
    setValues(ctx, { entityType: "technician", id: input.id, values: input.customFields }),
} as const;
