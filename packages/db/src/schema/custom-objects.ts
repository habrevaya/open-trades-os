import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { pk, timestamps } from "./_shared";
import { organization, user } from "./tenancy";
import { customer, property, equipment } from "./crm";
import { job } from "./work";

/**
 * A COMPANY'S OWN KIND OF RECORD
 *
 * Custom fields answer "what else do we write down about a customer". This
 * answers the next question every company with a few years behind it asks:
 * "where do we keep the permits", or the warranty registrations, or the
 * Monday truck inspection. None of those is a field on a job. Each is a list
 * of its own, with its own columns, that sometimes points at a customer, an
 * address, a job or a unit, and which somebody has been keeping in a
 * spreadsheet beside this product.
 *
 * THE FIELDS ARE ORDINARY CUSTOM FIELD DEFINITIONS, on the entity type
 * `object:<key>`. Every rule M29 already enforces about a field (the closed
 * types, the immutable key, a change refused when it contradicts what is
 * stored, every refusal at once) applies to a field on a permit for free,
 * because it is the same code reading the same table. A second field system
 * for objects would be a second set of rules, and the second set is the one
 * that forgets to refuse "soon" in a date.
 *
 * THE KEY IS AS IMMUTABLE AS A FIELD'S, for the same reason: it is written
 * into every field definition's entity type, every event payload and every
 * report a company saved. Its labels change freely.
 */
export const customObjectType = pgTable("custom_object_type", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** `permit`, `truck_inspection`. Lowercase, and never changed once made. */
  key: text("key").notNull(),
  /** One of them: "Permit". */
  label: text("label").notNull(),
  /** Several: "Permits". Asked for rather than guessed, because English plurals are not a suffix. */
  pluralLabel: text("plural_label").notNull(),
  description: text("description"),
  /**
   * What each record's name is called on its form and its list: "Permit
   * number", "Van". Every record has one, because a list of rows nobody can
   * tell apart is not a list anybody uses.
   */
  titleLabel: text("title_label").notNull().default("Name"),
  /**
   * Which of the product's records one of these may point at: any of
   * `customer`, `property`, `job` and `equipment`. A permit points at a job
   * and an address; a truck inspection points at nothing of the customer's.
   */
  links: jsonb("links").$type<string[]>().notNull().default([]),
  /**
   * WHO MAY SEE THEM AND WHO MAY CHANGE THEM, as permissions from the
   * catalogue rather than a list of roles. A role is something a company
   * edits and invents; a permission is what every role, preset or custom, is
   * made of, so naming one here works for a role made next year. Defaults
   * are `record:read` and `record:write`.
   */
  readPermission: text("read_permission").notNull().default("record:read"),
  writePermission: text("write_permission").notNull().default("record:write"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  /**
   * One key is one kind of record. Partial on `deleted_at`, because retiring
   * `permit` and defining it again later is a company changing its mind, and
   * the old field definitions under `object:permit` come back with it.
   */
  keyIdx: uniqueIndex("custom_object_type_key_idx").on(t.organizationId, t.key)
    .where(sql`${t.deletedAt} is null`),
}));

/**
 * ONE OF THEM: a permit, a registration, an inspection.
 *
 * The values live in `custom_fields`, named like every other table's so the
 * one implementation of checking, filtering and counting a custom field
 * reaches these rows exactly as it reaches a customer's.
 *
 * The links are real foreign keys, set null on delete: a permit outlives the
 * job being removed, and says so by pointing at nothing, rather than
 * disappearing with it.
 */
export const customObjectRecord = pgTable("custom_object_record", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  objectTypeId: uuid("object_type_id").notNull().references(() => customObjectType.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
  customerId: uuid("customer_id").references(() => customer.id, { onDelete: "set null" }),
  propertyId: uuid("property_id").references(() => property.id, { onDelete: "set null" }),
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
  equipmentId: uuid("equipment_id").references(() => equipment.id, { onDelete: "set null" }),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  typeIdx: index("custom_object_record_type_idx").on(t.organizationId, t.objectTypeId, t.createdAt),
  jobIdx: index("custom_object_record_job_idx").on(t.jobId),
  customerIdx: index("custom_object_record_customer_idx").on(t.customerId),
  propertyIdx: index("custom_object_record_property_idx").on(t.propertyId),
  equipmentIdx: index("custom_object_record_equipment_idx").on(t.equipmentId),
}));
