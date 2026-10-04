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
 *   A customer's fields reach the datasets that hang off a customer, named
 *   "Customer: ..." so "jobs by the customer's membership tier" is a report.
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
 * Which record each dataset is a row of, and how to reach that row's
 * customer, so the right fields land on the right dataset. The table is the
 * dataset's own alias, as `Dataset.from` requires.
 */
const OWN: Record<string, { entity: string; column: string; customer: string | null }> = {
  jobs: { entity: "job", column: "job.custom_fields", customer: "job.customer_id" },
  profitability: { entity: "job", column: "job.custom_fields", customer: "job.customer_id" },
  invoices: { entity: "invoice", column: "invoice.custom_fields", customer: "invoice.customer_id" },
  estimates: { entity: "estimate", column: "estimate.custom_fields", customer: "estimate.customer_id" },
  visits: { entity: "visit", column: "visit.custom_fields", customer: null },
};

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
function kindDataset(kind: typeof schema.customObjectType.$inferSelect, fields: readonly Field[]): reporting.Dataset | null {
  if (!UUID.test(kind.id) || !customObjects.KEY.test(kind.key)) return null;
  const column = "custom_object_record.custom_fields";
  const gate = "record:read" as const;
  const links = kind.links as customObjects.Link[];
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
    if (!own) return dataset;
    const customerFields = own.customer ? on("customer") : [];
    return {
      ...dataset,
      dimensions: [
        ...dataset.dimensions,
        ...fieldDimensions(own.column, on(own.entity), "cf_", ""),
        ...(own.customer ? fieldDimensions(
          `(select c.custom_fields from public.customer c where c.id = ${own.customer})`,
          customerFields, "customer_cf_", "Customer: ",
        ) : []),
      ],
      measures: [...dataset.measures, ...fieldMeasures(own.column, on(own.entity))],
    };
  });

  const own = kinds
    .map((kind) => kindDataset(kind, on(customObjects.entityTypeFor(kind.key))))
    .filter((dataset): dataset is reporting.Dataset => dataset !== null);
  return [...extended, ...own];
}
