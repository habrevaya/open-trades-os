import { customObjects, type ServiceContext } from "@opentradesos/api/services";
import { customFieldText } from "@/components/CustomFieldInputs";

/**
 * THE COMPANY'S OWN RECORDS ON A JOB, A CUSTOMER, AN ADDRESS, A UNIT, AN
 * INVOICE, A PERSON OR ANOTHER RECORD
 *
 * One section per kind of record that can point here and that this person
 * may read: its records, each with its first two fields, and "Add one" for
 * somebody who may. Nothing at all when the company has defined no kind that
 * points at this record, because an empty heading is a heading with nothing
 * under it.
 */
export async function RecordsPanel({
  ctx, link, id, back,
}: {
  ctx: ServiceContext;
  link: "customer" | "property" | "job" | "equipment" | "invoice" | "membership" | "record";
  id: string;
  /** This page, so adding one comes back here. */
  back: string;
}) {
  const groups = await customObjects.recordsFor(ctx, { link, id });
  if (groups.length === 0) return null;
  const param = {
    customer: "customerId", property: "propertyId", job: "jobId", equipment: "equipmentId",
    invoice: "invoiceId", membership: "membershipId", record: "linkedRecordId",
  }[link];
  return (
    <>
      {groups.map(({ kind, records, fields, canWrite }) => (
        <section key={kind.key} className="mt-8" aria-labelledby={`records-${kind.key}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id={`records-${kind.key}`} className="text-base font-semibold">{kind.pluralLabel}</h2>
            {canWrite ? (
              <a href={`/records/${kind.key}/new?${param}=${id}&back=${encodeURIComponent(back)}`}
                 className="text-sm underline underline-offset-4">
                Add a {kind.label.toLowerCase()}
              </a>
            ) : null}
          </div>
          {records.length === 0 ? (
            <p className="mt-2 text-sm text-ink-500">None yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-steel-200 rounded-md border border-steel-200 text-sm">
              {records.map((record) => (
                <li key={record.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 py-2">
                  <a href={`/records/${kind.key}/${record.id}`} className="font-medium underline underline-offset-4">{record.title}</a>
                  {fields.slice(0, 2).map((f) => {
                    const text = customFieldText(f, record.customFields[f.key]);
                    return text ? <span key={f.key} className="text-ink-700">{f.label}: {text}</span> : null;
                  })}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </>
  );
}
