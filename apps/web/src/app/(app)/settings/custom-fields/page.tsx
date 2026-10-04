import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customFields } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { FieldManager } from "./FieldManager";

export const dynamic = "force-dynamic";

/**
 * The product's own records that carry fields. A company's own kinds of
 * record keep their fields on their own settings page, Settings, Kinds of
 * record, because a permit's fields are read beside what a permit is.
 */
const RECORDS: { key: string; label: string }[] = [
  { key: "customer", label: "Customers" },
  { key: "property", label: "Properties" },
  { key: "job", label: "Jobs" },
  { key: "estimate", label: "Estimates" },
  { key: "invoice", label: "Invoices" },
  { key: "visit", label: "Visits" },
  { key: "equipment", label: "Equipment" },
  { key: "technician", label: "Technicians" },
];

/**
 * SETTINGS, CUSTOM FIELDS
 *
 * The things a company tracks that this product does not: a gate code, a
 * plan name, the year a roof went on. A field is declared here on customers,
 * properties, jobs, estimates, invoices, visits, equipment or technicians,
 * and the record screens draw it, the saves check it, the lists filter by it
 * and the report builder groups by it.
 *
 * The key is what the value is stored under and never changes once made,
 * because thousands of stored values point at it by string; the label is
 * what people read and changes freely. Retiring a field keeps the values in
 * the records and says how many there are before it does, because a field
 * retired by mistake should be one somebody can define again and find their
 * data waiting.
 */
export default async function CustomFieldsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "settings:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Custom fields" />
        <Empty title="Settings are not part of your access">Somebody who can change roles can turn this on for you.</Empty>
      </div>
    );
  }

  const usage = await customFields.usage(ctx);
  const writes = can(user.actor, "customfield:write");

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <PageHeader title="Custom fields" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        What your company tracks that the product does not. Each field shows on the record&apos;s screen,
        is checked when it is saved, filters the list it is on, and is a column in the report builder.
        Fields on your own kinds of record are on <a href="/settings/records" className="underline underline-offset-4">Kinds of record</a>.
        {!writes ? " Changing them needs the Define custom fields permission." : ""}
      </p>

      <FieldManager records={RECORDS} usage={usage} writes={writes} />
    </div>
  );
}
