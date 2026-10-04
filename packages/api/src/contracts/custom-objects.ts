import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, pageOf } from "./common";
import { CustomFieldDefinition } from "./custom-fields";

/**
 * A COMPANY'S OWN KINDS OF RECORD
 *
 * Permits, warranty registrations, truck inspections: a list a company keeps
 * that this product never heard of, with its own fields, pointing at a
 * customer, an address, a job or a unit. The kind is defined here; its
 * fields are ordinary custom fields on `object:<key>` (`POST /v1/custom-fields`
 * with that entity type), held to every rule a field on a customer is.
 *
 * Every record passes `record:read` to be seen and `record:write` to be
 * changed. A kind can narrow either with a permission of its own, named on
 * its definition; such a kind's records refuse a caller who holds the gate
 * and not the kind's own permission, naming the one that is missing.
 */

const Key = z.string().min(1).max(48);
const Link = z.enum(["customer", "property", "job", "equipment"]);

const KindView = z.object({
  id: Uuid,
  /** Lowercase and permanent: it is written into every field and automation that uses the kind. */
  key: z.string(),
  label: z.string(),
  pluralLabel: z.string(),
  description: z.string().nullable(),
  /** What each record's name is called: "Permit number". */
  titleLabel: z.string(),
  links: z.array(Link),
  readPermission: z.string(),
  writePermission: z.string(),
  sortOrder: z.number().int(),
});

const KindWithFields = KindView.extend({
  fields: z.array(CustomFieldDefinition),
  canRead: z.boolean(),
  canWrite: z.boolean(),
});

const KindInput = {
  label: z.string().min(1).max(60),
  pluralLabel: z.string().max(60).optional(),
  description: z.string().max(500).nullable().optional(),
  titleLabel: z.string().max(60).optional(),
  links: z.array(Link).max(4).optional(),
  /** Any permission from the catalogue. Defaults to the gate itself, `record:read`. */
  readPermission: z.string().max(80).optional(),
  /** Any permission from the catalogue. Defaults to the gate itself, `record:write`. */
  writePermission: z.string().max(80).optional(),
  sortOrder: z.number().int().min(-1000).max(1000).optional(),
};

const Named = z.object({ id: Uuid, name: z.string() }).nullable();

const RecordView = z.object({
  id: Uuid,
  /** The kind's key. */
  type: z.string(),
  typeLabel: z.string(),
  title: z.string(),
  customFields: z.record(z.unknown()),
  customer: Named,
  property: Named,
  job: Named,
  equipment: Named,
  createdAt: z.date(),
  updatedAt: z.date(),
});

const LinkIds = {
  customerId: Uuid.nullable().optional(),
  propertyId: Uuid.nullable().optional(),
  /** A job carries its customer and address onto the record when the kind offers those links. */
  jobId: Uuid.nullable().optional(),
  equipmentId: Uuid.nullable().optional(),
};

export const listCustomObjects = defineRoute({
  method: "get",
  path: "/v1/custom-objects",
  summary: "The company's own kinds of record, with their fields",
  description:
    "Only the kinds the caller may read. Each carries its fields (ordinary custom field definitions on `object:<key>`) and whether the caller may add one.",
  module: "M29",
  permissions: ["record:read"],
  input: z.object({}),
  output: z.object({ kinds: z.array(KindWithFields) }),
});

export const getCustomObject = defineRoute({
  method: "get",
  path: "/v1/custom-objects/{key}",
  summary: "One kind of record and its fields",
  module: "M29",
  permissions: ["record:read"],
  input: z.object({ key: Key }),
  output: KindWithFields,
});

export const defineCustomObject = defineRoute({
  method: "post",
  path: "/v1/custom-objects",
  summary: "Define a kind of record the company keeps",
  description:
    "Its name, the plural, what each one's name is called, what it may point at and who may see and change one. Add its fields afterwards with `POST /v1/custom-fields` on entity type `object:<key>`. The key cannot be changed later. Every problem with the definition is returned at once.",
  module: "M29",
  permissions: ["customfield:write"],
  idempotent: true,
  dryRun: true,
  input: z.object({ key: Key, ...KindInput }),
  output: KindView,
});

export const updateCustomObject = defineRoute({
  method: "patch",
  path: "/v1/custom-objects/{id}",
  summary: "Change what a kind of record is called, what it points at or who may see it",
  description:
    "Not its key. Taking a link away is refused while records still point that way.",
  module: "M29",
  permissions: ["customfield:write"],
  idempotent: true,
  dryRun: true,
  input: z.object({ id: Uuid, ...KindInput, label: KindInput.label.optional() }),
  output: KindView,
});

export const deleteCustomObject = defineRoute({
  method: "delete",
  path: "/v1/custom-objects/{id}",
  summary: "Retire a kind of record",
  description:
    "Refused while records of it are on file unless `force` is sent; the answer says how many were hidden. Defining the same key again brings them back.",
  module: "M29",
  permissions: ["customfield:write"],
  idempotent: true,
  dryRun: true,
  input: z.object({ id: Uuid, force: z.boolean().optional() }),
  output: z.object({ id: Uuid, removed: z.literal(true), recordsHidden: z.number().int() }),
});

export const listCustomRecords = defineRoute({
  method: "get",
  path: "/v1/custom-records",
  summary: "One kind's records, searched and filtered",
  description:
    "`q` searches the name and every value. `fieldKey` and `fieldValue` filter by one field the way the customer list does. The links narrow to one customer, address, job or unit.",
  module: "M29",
  permissions: ["record:read"],
  input: z.object({
    type: Key,
    q: z.string().max(200).optional(),
    fieldKey: z.string().max(64).optional(),
    fieldValue: z.string().max(200).optional(),
    customerId: Uuid.optional(),
    propertyId: Uuid.optional(),
    jobId: Uuid.optional(),
    equipmentId: Uuid.optional(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: pageOf(RecordView),
});

export const getCustomRecord = defineRoute({
  method: "get",
  path: "/v1/custom-records/{id}",
  summary: "One record, with its kind's fields",
  module: "M29",
  permissions: ["record:read"],
  input: z.object({ id: Uuid }),
  output: RecordView.extend({ kind: KindView, fields: z.array(CustomFieldDefinition), canWrite: z.boolean() }),
});

export const createCustomRecord = defineRoute({
  method: "post",
  path: "/v1/custom-records",
  summary: "Add a record of one of the company's own kinds",
  description:
    "Its name, its values and what it points at. Values are checked against the kind's fields, every refusal at once at `customFields.<key>`. Emits `record.created`, which an automation can trigger on.",
  module: "M29",
  permissions: ["record:read", "record:write"],
  idempotent: true,
  input: z.object({
    type: Key,
    title: z.string().max(200),
    customFields: z.record(z.unknown()).optional(),
    ...LinkIds,
  }),
  output: RecordView,
});

export const updateCustomRecord = defineRoute({
  method: "patch",
  path: "/v1/custom-records/{id}",
  summary: "Change a record",
  description:
    "Only what this changes is checked against the fields. Links left out stay; null takes one off. Emits `record.updated` with the values before and after, so an automation can wait for a field to change to something.",
  module: "M29",
  permissions: ["record:read", "record:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    title: z.string().max(200).optional(),
    customFields: z.record(z.unknown()).optional(),
    ...LinkIds,
  }),
  output: RecordView,
});

export const deleteCustomRecord = defineRoute({
  method: "delete",
  path: "/v1/custom-records/{id}",
  summary: "Remove a record",
  module: "M29",
  permissions: ["record:read", "record:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, removed: z.literal(true) }),
});

export const exportCustomRecords = defineRoute({
  method: "get",
  path: "/v1/custom-objects/{key}/export",
  summary: "A kind's records as a CSV",
  description:
    "Every record the caller may see, with each field by its label and what each points at by name and by id, so the file loads back with the import. A cell a spreadsheet would read as a formula is written as text.",
  module: "M29",
  permissions: ["record:read"],
  input: z.object({ key: Key }),
  output: z.object({ fileName: z.string(), rows: z.number().int(), csv: z.string() }),
});

export const importCustomRecords = defineRoute({
  method: "post",
  path: "/v1/custom-objects/{key}/import",
  summary: "Load a CSV of records, all of it or none of it",
  description:
    "Columns match a field by its key or its label, the name by what each one's name is called or `Title`, and links by id (`Customer id`, `Job id`) or a job by `Job number`. Every row goes through the same checks as one typed on the form; if any is refused nothing is written and every refusal is returned. Send a dry run first to check the file.",
  module: "M29",
  permissions: ["record:read", "record:write"],
  idempotent: true,
  dryRun: true,
  input: z.object({ key: Key, csv: z.string().max(5_000_000) }),
  output: z.object({ created: z.number().int(), ignoredColumns: z.array(z.string()) }),
});

export const customObjectRoutes = {
  listCustomObjects, getCustomObject, defineCustomObject, updateCustomObject, deleteCustomObject,
  listCustomRecords, getCustomRecord, createCustomRecord, updateCustomRecord, deleteCustomRecord,
  exportCustomRecords, importCustomRecords,
} as const;
