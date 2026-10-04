import { asc, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { customObjects, type reporting } from "@opentradesos/core";
import { CATALOGUE } from "./report-catalogue";

/**
 * THE REPORT CATALOGUE, WITH THIS COMPANY'S OWN FIELDS AND RECORDS IN IT
 *
 * The catalogue that ships is the product's: jobs by status, invoices by
 * age. A company that added "Permit number" to its jobs and a kind of record
 * called "Truck inspection" wants to group jobs by the one and count the
 * other, and a report builder that cannot see either sends them back to a
 * spreadsheet. So the catalogue a report is resolved against is built per
 * company, from three things:
 *
 *   Each custom field on a record a dataset is about is a DIMENSION of that
 *   dataset (group by it, filter by it, a column of it), and a number field
 *   is also two MEASURES (its total and its average).
 *
 *   The fields of the records a row hangs off reach its dataset too, named
 *   for the record: "Customer: ...", "Address: ...", "Job: ...", "Unit: ..."
 *   and "Technician: ...", so "jobs by the customer's membership tier" and
 *   "visits where the address's gate type is Code" are reports.
 *
 *   Each kind of record is a DATASET of its own.
 *
 * STILL DATA, NEVER SQL FROM INPUT. Every fragment below is written here. A
 * field's key goes into a fragment only after matching the key pattern the
 * definitions are held to (lowercase letters, digits and underscores), so it
 * cannot close a quote; a kind's id is a uuid read from the database and
 * matched against the uuid pattern before it is written into the dataset's
 * `where`. Filter VALUES stay bound parameters, exactly as for every other
 * dimension.
 *
 * A value written under a definition's key before the definition existed can
 * be anything, so a number is read as a number only where the stored JSON IS
 * a number, and anything else counts as no value rather than failing the
 * whole report on one row somebody imported in 2023.
 */

const SAFE_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The prefix every kind of record's dataset key carries, so a dataset can be told apart from the product's. */
export const OBJECT_DATASET_PREFIX = "object_";

type Field = Pick<typeof schema.customFieldDefinition.$inferSelect, "key" | "label" | "dataType" | "entityType">;

/** The value of one field on a row, as text a report can group by, written by us. */
function valueSql(column: string, field: Field): string {
  const raw = `${column} -> '${field.key}'`;
  switch (field.dataType) {
    case "boolean":
      return `(case ${raw} when 'true'::jsonb then 'Yes' when 'false'::jsonb then 'No' end)`;
    case "multiselect":
      return `(select string_agg(v, ', ' order by v) from jsonb_array_elements_text(`
        + `case when jsonb_typeof(${raw}) = 'array' then ${raw} else '[]'::jsonb end) v)`;
    case "number":
      return `(case when jsonb_typeof(${raw}) = 'number' then (${column} ->> '${field.key}') end)`;
    default:
      return `nullif(${column} ->> '${field.key}', '')`;
  }
}

/** A number field as a number, or nothing. */
const numberSql = (column: string, key: string) =>
  `(case when jsonb_typeof(${column} -> '${key}') = 'number' then (${column} ->> '${key}')::numeric end)`;

const dimensionType = (dataType: string): reporting.Dimension["type"] =>
  dataType === "date" ? "date" : dataType === "number" ? "number" : "text";

function fieldDimensions(column: string, fields: readonly Field[], prefix: string, labelPrefix: string): reporting.Dimension[] {
  return fields.filter((f) => SAFE_KEY.test(f.key)).map((field) => ({
    key: `${prefix}${field.key}`,
    label: `${labelPrefix}${field.label}`,
    type: dimensionType(field.dataType),
    sql: valueSql(column, field),
  }));
}

function fieldMeasures(column: string, fields: readonly Field[]): reporting.Measure[] {
  return fields.filter((f) => f.dataType === "number" && SAFE_KEY.test(f.key)).flatMap((field) => [
    { key: `cf_${field.key}_sum`, label: `Total ${field.label}`, kind: "sum" as const, type: "number" as const, sql: numberSql(column, field.key) },
    { key: `cf_${field.key}_avg`, label: `Average ${field.label}`, kind: "avg" as const, type: "number" as const, sql: numberSql(column, field.key) },
  ]);
}

/**
 * Which record each dataset is a row of, so its own fields land on it.
 * The table is the dataset's own alias, as `Dataset.from` requires.
 */
const OWN: Record<string, { entity: string; column: string }> = {
  jobs: { entity: "job", column: "job.custom_fields" },
  profitability: { entity: "job", column: "job.custom_fields" },
  invoices: { entity: "invoice", column: "invoice.custom_fields" },
  estimates: { entity: "estimate", column: "estimate.custom_fields" },
  visits: { entity: "visit", column: "visit.custom_fields" },
};

/**
 * THE RECORDS A ROW HANGS OFF, AND THEIR FIELDS.
 *
 * A job is for a customer at an address; an invoice and an estimate are for
 * a job; a visit is a trip on a job by a technician; a call is from a
 * customer about a job. A company that put "Membership tier" on customers,
 * "Gate type" on addresses and "Permit status" on jobs wants every report
 * about any of those to be filtered and grouped by them, so each related
 * record's fields are dimensions of the dataset too, named for the record
 * ("Customer: Membership tier"), keyed with its own prefix, and read through
 * one subquery written here from a column of the dataset's own row.
 *
 * Each carries the permission that reads that record on its own, so a
 * dispatcher who may not open the staff file cannot group visits by a
 * technician's fields, or filter by one, either. The customer's fields
 * reached the job, invoice and estimate datasets before any of the others
 * did, with no permission of their own, and keep that.
 */
interface Related {
  entity: "customer" | "property" | "job" | "equipment" | "technician";
  prefix: string;
  labelPrefix: string;
  /** The related row's id, as an expression over the dataset's own row. */
  id: string;
  permission?: reporting.Dimension["permission"];
}

const CUSTOMER = (id: string): Related => ({ entity: "customer", prefix: "customer_cf_", labelPrefix: "Customer: ", id });
const ADDRESS = (id: string): Related => ({
  entity: "property", prefix: "address_cf_", labelPrefix: "Address: ", id, permission: "property:read",
});
const JOB = (id: string): Related => ({ entity: "job", prefix: "job_cf_", labelPrefix: "Job: ", id, permission: "job:read" });
const UNIT = (id: string): Related => ({
  entity: "equipment", prefix: "unit_cf_", labelPrefix: "Unit: ", id, permission: "equipment:read",
});
const TECHNICIAN = (id: string): Related => ({
  entity: "technician", prefix: "technician_cf_", labelPrefix: "Technician: ", id, permission: "user:read",
});

const TABLE_OF: Record<Related["entity"], string> = {
  customer: "public.customer", property: "public.property", job: "public.job",
  equipment: "public.equipment", technician: "public.technician",
};

/** The lead technician of a visit, the one the Technician grouping already names. */
const LEAD_TECHNICIAN = "(select a.technician_id from public.visit_assignment a where a.visit_id = visit.id and a.is_lead limit 1)";
const VISIT_JOB = (column: string) => `(select j.${column} from public.job j where j.id = visit.job_id)`;

const RELATED: Record<string, Related[]> = {
  jobs: [CUSTOMER("job.customer_id"), ADDRESS("job.property_id")],
  profitability: [CUSTOMER("job.customer_id"), ADDRESS("job.property_id")],
  invoices: [CUSTOMER("invoice.customer_id"), ADDRESS("invoice.property_id"), JOB("invoice.job_id")],
  estimates: [CUSTOMER("estimate.customer_id"), ADDRESS("estimate.property_id"), JOB("estimate.job_id")],
  visits: [
    JOB("visit.job_id"), CUSTOMER(VISIT_JOB("customer_id")), ADDRESS(VISIT_JOB("property_id")),
    TECHNICIAN(LEAD_TECHNICIAN),
  ],
  calls: [CUSTOMER("call.customer_id"), JOB("call.job_id")],
};

/** A related record's fields as dimensions of a dataset, each read through one subquery from its id. */
function relatedDimensions(related: Related, fields: readonly Field[]): reporting.Dimension[] {
  const column = `(select r.custom_fields from ${TABLE_OF[related.entity]} r where r.id = ${related.id})`;
  return fieldDimensions(column, fields, related.prefix, related.labelPrefix)
    .map((dimension) => (related.permission ? { ...dimension, permission: related.permission } : dimension));
}

const localDate = (instant: string) =>
  `to_char(${instant} at time zone coalesce((select o.timezone from public.organization o `
  + `where o.id = custom_object_record.organization_id), 'America/Chicago'), 'YYYY-MM-DD')`;

/**
 * One kind of record as a dataset: count them, group them by month, by who
 * they are for and by any of their fields, and total a number field.
 *
 * Its permission is the kind's own read permission, and every dimension and
 * measure also needs `record:read`, so a report asks for exactly what the
 * records' list does. Scope is the list's too: `reports.ts` applies the same
 * visibility the list uses to every dataset with this prefix.
 */
function kindDataset(
  kind: typeof schema.customObjectType.$inferSelect, fields: readonly Field[], on: (entity: string) => Field[],
): reporting.Dataset | null {
  if (!UUID.test(kind.id) || !customObjects.KEY.test(kind.key)) return null;
  const column = "custom_object_record.custom_fields";
  const gate = "record:read" as const;
  const links = kind.links as customObjects.Link[];
  /** What a record of this kind points at, and so whose fields its report can be filtered and grouped by. */
  const related: Related[] = [
    ...(links.includes("customer") ? [CUSTOMER("custom_object_record.customer_id")] : []),
    ...(links.includes("property") ? [ADDRESS("custom_object_record.property_id")] : []),
    ...(links.includes("job") ? [JOB("custom_object_record.job_id")] : []),
    ...(links.includes("equipment") ? [UNIT("custom_object_record.equipment_id")] : []),
  ];
  const linkDimensions: reporting.Dimension[] = [];
  if (links.includes("customer")) {
    linkDimensions.push({ key: "customer", label: "Customer", type: "text",
      sql: "(select c.name from public.customer c where c.id = custom_object_record.customer_id)" });
  }
  if (links.includes("job")) {
    linkDimensions.push({ key: "job_type", label: "Job type", type: "text",
      sql: "(select t.name from public.job j join public.job_type t on t.id = j.job_type_id where j.id = custom_object_record.job_id)" });
  }
  const withGate = <T extends { permission?: reporting.Dimension["permission"] }>(entry: T): T => ({ ...entry, permission: gate });
  return {
    key: `${OBJECT_DATASET_PREFIX}${kind.key}`,
    label: kind.pluralLabel,
    description: kind.description ?? `The company's own ${kind.pluralLabel.toLowerCase()}.`,
    from: "public.custom_object_record",
    where: `custom_object_record.object_type_id = '${kind.id}' and custom_object_record.deleted_at is null`,
    permission: kind.readPermission as reporting.Dataset["permission"],
    scope: "customer",
    dateColumn: "custom_object_record.created_at",
    records: {
      noun: kind.label.toLowerCase(), plural: kind.pluralLabel.toLowerCase(),
      id: "custom_object_record.id",
      label: "custom_object_record.title",
      href: `/records/${kind.key}/{id}`,
      orderBy: "custom_object_record.created_at",
      columns: [
        ...(links.includes("customer") ? [{
          key: "customer", label: "Customer", type: "text" as const,
          sql: "(select c.name from public.customer c where c.id = custom_object_record.customer_id)",
          link: { id: "custom_object_record.customer_id", href: "/customers/{id}" },
        }] : []),
        { key: "added", label: "Added", type: "date", sql: localDate("custom_object_record.created_at") },
      ],
    },
    dimensions: [
      withGate({ key: "month", label: "Month added", type: "date",
        sql: "to_char(date_trunc('month', custom_object_record.created_at), 'YYYY-MM')" } as reporting.Dimension),
      ...linkDimensions.map(withGate),
      ...fieldDimensions(column, fields, "", "").map(withGate),
      /**
       * The linked records' fields keep their own permission rather than
       * taking `record:read` from `withGate`, which would replace it.
       * `record:read` is still required: every measure here carries it, and
       * a report needs a measure.
       */
      ...related.flatMap((r) => relatedDimensions(r, on(r.entity))),
    ],
    measures: [
      withGate({ key: "count", label: kind.pluralLabel, kind: "count", type: "number" } as reporting.Measure),
      ...fieldMeasures(column, fields).map(withGate),
    ],
  };
}

/**
 * The catalogue as this company sees it: the product's datasets with the
 * company's fields added, then a dataset per kind of record. Read inside the
 * caller's transaction, under row level security, so it is this company's
 * fields and nobody else's.
 */
export async function catalogueFor(tx: Database, _organizationId: string): Promise<reporting.Dataset[]> {
  const fields = await tx.select({
    key: schema.customFieldDefinition.key,
    label: schema.customFieldDefinition.label,
    dataType: schema.customFieldDefinition.dataType,
    entityType: schema.customFieldDefinition.entityType,
  }).from(schema.customFieldDefinition)
    .where(isNull(schema.customFieldDefinition.deletedAt))
    .orderBy(asc(schema.customFieldDefinition.sortOrder), asc(schema.customFieldDefinition.key));
  const kinds = await tx.select().from(schema.customObjectType)
    .where(isNull(schema.customObjectType.deletedAt))
    .orderBy(asc(schema.customObjectType.sortOrder), asc(schema.customObjectType.label));
  if (fields.length === 0 && kinds.length === 0) return CATALOGUE;

  const on = (entity: string) => fields.filter((field) => field.entityType === entity);
  const extended = CATALOGUE.map((dataset) => {
    const own = OWN[dataset.key];
    const related = RELATED[dataset.key] ?? [];
    if (!own && related.length === 0) return dataset;
    return {
      ...dataset,
      dimensions: [
        ...dataset.dimensions,
        ...(own ? fieldDimensions(own.column, on(own.entity), "cf_", "") : []),
        ...related.flatMap((r) => relatedDimensions(r, on(r.entity))),
      ],
      measures: [...dataset.measures, ...(own ? fieldMeasures(own.column, on(own.entity)) : [])],
    };
  });

  const own = kinds
    .map((kind) => kindDataset(kind, on(customObjects.entityTypeFor(kind.key)), on))
    .filter((dataset): dataset is reporting.Dataset => dataset !== null);
  return [...extended, ...own];
}
