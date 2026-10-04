import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * CUSTOM FIELD DEFINITIONS
 *
 * `customer`, `property` and `job` have each carried a `custom_fields` jsonb
 * column since the first migration, and every service wrote to it freely
 * with nothing anywhere saying what the keys were, what they were called or
 * what shape a value was meant to be. The storage shipped and the meaning
 * did not.
 *
 * A DEFINITION IS WHAT MAKES A CUSTOM FIELD A FIELD: a label to draw, a type
 * to check against, and an answer to "what does this company track that we
 * do not". Without one there is a bag of strings, an export column headed
 * `wty_exp_2`, and two offices writing "yes", true and "Y" into the same
 * place for a year before anybody tries to count them.
 *
 * THE KEY IS THE JOIN AND THERE IS NO FOREIGN KEY UNDER IT. The value lives
 * at `custom_fields -> key` on another table, matched by string. That is why
 * the key cannot be changed once it exists, why removing a definition tells
 * you how many rows it orphans, and why `getCustomFieldUsage` exists at all:
 * the definitions and the data agree because these routes refuse to let them
 * disagree, or they do not agree.
 */

/**
 * The eight records with a `custom_fields` column, or one of the company's own
 * kinds of record as `object:<key>` (M29's custom objects).
 */
export const CustomFieldEntity = z.union([
  z.enum(["customer", "property", "job", "invoice", "estimate", "visit", "equipment", "technician"]),
  z.string().regex(/^object:[a-z][a-z0-9_]{0,47}$/, "A kind of record is object: and its key, like object:permit"),
]);

export const CustomFieldType = z.enum([
  "text", "number", "boolean", "date", "select", "multiselect",
]);

export const CustomFieldDefinition = z.object({
  id: Uuid,
  entityType: z.string(),
  /** Stable, lowercase, and the string thousands of stored rows point at. */
  key: z.string(),
  /** The name a person sees. Changeable, unlike the key. */
  label: z.string(),
  dataType: z.string(),
  options: z.array(z.string()),
  required: z.boolean(),
  sortOrder: z.number().int(),
});

/**
 * What a definition costs the records that already exist.
 *
 * Returned rather than refused. Marking a field required does not reach back
 * and fill it in, so a company with four thousand customers that turns one on
 * has four thousand incomplete records from that moment. That is usually
 * fine. Not being told is not.
 */
const WithBacklog = CustomFieldDefinition.extend({
  rowsWithValue: z.number().int(),
  /** Only meaningful on a required field. Zero otherwise. */
  rowsMissingValue: z.number().int(),
});

const Key = z.string().min(1).max(64);
const Label = z.string().min(1).max(200);
const Options = z.array(z.string().min(1).max(200)).max(200);

export const defineCustomField = defineRoute({
  method: "post",
  path: "/v1/custom-fields",
  summary: "Declare a field this company tracks",
  description:
    "Refused when the key is already defined on that entity, and refused when stored data already under that key contradicts the type being declared, because a definition that half the rows fail is worse than none. Comes back with how many records already hold a value and, on a required field, how many do not.",
  module: "M29",
  permissions: ["customfield:write"],
  /** A dry run says what the change would do to the records that hold values, and keeps nothing. */
  dryRun: true,
  idempotent: true,
  input: z.object({
    entityType: CustomFieldEntity,
    /**
     * Lowercase, starting with a letter. It is a jsonb object key and an
     * export column header rather than anything a person reads: jsonb is case
     * sensitive, so `Warranty` and `warranty` are two fields that look like
     * one, and the office that made the second never finds out why half the
     * rows are blank.
     */
    key: Key,
    label: Label,
    dataType: CustomFieldType.optional(),
    /** Required by select and multiselect, whose whole meaning is the list. */
    options: Options.optional(),
    required: z.boolean().optional(),
    sortOrder: z.number().int().min(-1000).max(1000).optional(),
  }),
  output: WithBacklog,
});

export const listCustomFields = defineRoute({
  method: "get",
  path: "/v1/custom-fields",
  summary: "Every field this company has declared",
  description:
    "Ordered by entity, then sort order, then key. The last term is not decoration: sort order defaults to zero on every row, so without it the order is whatever the heap returned and it changes between two reads of the same unedited screen.",
  module: "M29",
  permissions: ["settings:read"],
  input: z.object({ entityType: CustomFieldEntity.optional() }),
  output: z.object({ definitions: z.array(CustomFieldDefinition) }),
});

export const updateCustomField = defineRoute({
  method: "patch",
  path: "/v1/custom-fields/{id}",
  summary: "Change the label, the type, the options or whether it is required",
  description:
    "The key cannot be changed and neither can the entity. Every value stored under the old key is matched by that string and nothing else, so a rename orphans all of them at once: they stay in the database, stop being found, and read as deleted.",
  module: "M29",
  permissions: ["customfield:write"],
  /** A dry run says what the change would do to the records that hold values, and keeps nothing. */
  dryRun: true,
  idempotent: true,
  input: z.object({
    id: Uuid,
    label: Label.optional(),
    dataType: CustomFieldType.optional(),
    options: Options.optional(),
    required: z.boolean().optional(),
    sortOrder: z.number().int().min(-1000).max(1000).optional(),
  }),
  output: WithBacklog,
});

export const deleteCustomField = defineRoute({
  method: "delete",
  path: "/v1/custom-fields/{id}",
  summary: "Retire a field",
  description:
    "Refused while records still hold a value for it, because removing the definition does not remove the values: they stay in the record and stop being shown. Send force to remove it anyway. The answer says how many values were orphaned, and zero is the good answer.",
  module: "M29",
  permissions: ["customfield:write"],
  /** A dry run says what the change would do to the records that hold values, and keeps nothing. */
  dryRun: true,
  idempotent: true,
  input: z.object({
    id: Uuid,
    /**
     * Allowed rather than withheld. A company retiring a field they filled in
     * for two years is entitled to retire it; what they must not be able to
     * do is retire it without being told.
     */
    force: z.boolean().optional(),
  }),
  output: z.object({
    id: Uuid,
    removed: z.literal(true),
    orphanedValues: z.number().int(),
  }),
});

export const getCustomFieldUsage = defineRoute({
  method: "get",
  path: "/v1/custom-fields/usage",
  summary: "What is defined, and what is actually in the data",
  description:
    "Two questions the definitions alone cannot answer. A field nobody fills in costs a row on every form anybody opens. A key nothing defines is real data that no screen shows and no export names, and an import can put one there tomorrow.",
  module: "M29",
  permissions: ["settings:read"],
  input: z.object({ entityType: CustomFieldEntity.optional() }),
  output: z.object({
    report: z.array(z.object({
      entityType: z.string(),
      /** Live records of that kind, the denominator for everything below. */
      rows: z.number().int(),
      defined: z.array(WithBacklog),
      /** Values sitting under keys with no label and no type. */
      undefinedKeys: z.array(z.object({
        key: z.string(),
        rowsWithValue: z.number().int(),
      })),
    })),
  }),
});

export const validateCustomFields = defineRoute({
  method: "post",
  path: "/v1/custom-fields/validate",
  summary: "Check a draft record's custom values before saving it",
  description:
    "Every problem at once rather than the first, because a form with three bad fields corrected one at a time is three round trips and the third is where somebody types whatever gets past it. This is the question a screen asks; the save path runs its own check.",
  module: "M29",
  permissions: ["settings:read"],
  /** A question, asked twice, with the same answer. Nothing is written. */
  idempotent: true,
  input: z.object({
    entityType: CustomFieldEntity,
    customFields: z.record(z.unknown()),
  }),
  output: z.object({
    valid: z.boolean(),
    problems: z.array(z.object({ key: z.string(), problem: z.string() })),
  }),
});


/**
 * THE FIELDS ON AN INVOICE, AN ESTIMATE, A VISIT, A UNIT OR A TECHNICIAN.
 *
 * A customer, an address and a job carry theirs on their own create and
 * update. These five grew a column later, and each one's own write is
 * guarded by rules about money or the board that have nothing to do with a
 * custom field, so filling in a field has one route per record of its own,
 * under that record's write permission and its scope. The bag is the whole
 * set as it should be: send what is there plus what changed.
 */
const SetValuesInput = z.object({ id: Uuid, customFields: z.record(z.unknown()) });
const SetValuesOutput = z.object({ id: Uuid, customFields: z.record(z.unknown()) });
const setValuesRoute = (
  entity: string, path: string, read: "invoice:read" | "estimate:read" | "visit:read" | "equipment:read" | "user:read",
  write: "invoice:write" | "estimate:write" | "visit:write" | "equipment:write" | "user:write",
) => defineRoute({
  method: "put",
  path,
  summary: `Save the company's own fields on ${entity}`,
  description:
    "Only what this changes is checked against the definitions: a value contradicting its type or options, or a required field left empty, is refused with one sentence per field at `customFields.<key>`. A key nothing defines is kept as sent.",
  module: "M29",
  permissions: [read, write],
  idempotent: true,
  input: SetValuesInput,
  output: SetValuesOutput,
});

export const setInvoiceCustomFields = setValuesRoute("an invoice", "/v1/invoices/{id}/custom-fields", "invoice:read", "invoice:write");
export const setEstimateCustomFields = setValuesRoute("an estimate", "/v1/estimates/{id}/custom-fields", "estimate:read", "estimate:write");
export const setVisitCustomFields = setValuesRoute("a visit", "/v1/visits/{id}/custom-fields", "visit:read", "visit:write");
export const setEquipmentCustomFields = setValuesRoute("a unit", "/v1/equipment/{id}/custom-fields", "equipment:read", "equipment:write");
export const setTechnicianCustomFields = setValuesRoute("a technician", "/v1/technicians/{id}/custom-fields", "user:read", "user:write");

export const customFieldRoutes = {
  defineCustomField, listCustomFields, updateCustomField,
  deleteCustomField, getCustomFieldUsage, validateCustomFields,
  setInvoiceCustomFields, setEstimateCustomFields, setVisitCustomFields,
  setEquipmentCustomFields, setTechnicianCustomFields,
} as const;
