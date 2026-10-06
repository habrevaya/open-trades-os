import { notFound, redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customObjects, NotFoundError } from "@opentradesos/api/services";
import { PermissionError } from "@opentradesos/core";
import { ActionForm, TextField } from "@/components/ActionForm";
import { CustomFieldInputs, customFieldText } from "@/components/CustomFieldInputs";
import { Crumb, Fact, Facts } from "@/components/Detail";
import { PageHeader } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { removeRecord, updateRecord } from "../../actions";
import { RecordsPanel } from "@/components/RecordsPanel";

export const dynamic = "force-dynamic";

/**
 * ONE RECORD: what it points at, its values, and changing or removing it.
 * Read only for somebody who may see the kind and not change it.
 */
export default async function RecordPage({ params }: { params: Promise<{ type: string; id: string }> }) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const { type, id } = await params;
  const record = await customObjects.getRecord(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError || error instanceof PermissionError) notFound();
    throw error;
  });
  /**
   * Opened by id from somewhere that knows only that it is one of the
   * company's records (a task an automation raised about it): sent on to the
   * address its kind gives it.
   */
  if (record.type !== type) redirect(`/records/${record.type}/${id}`);
  const kind = record.kind;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href={`/records/${type}`}>{kind.pluralLabel}</Crumb>
      <div className="mt-2"><PageHeader title={`${kind.label} ${record.title}`} /></div>
      <Facts>
        <Fact label="Customer">{record.customer ? <a href={`/customers/${record.customer.id}`} className="underline underline-offset-4">{record.customer.name}</a> : null}</Fact>
        <Fact label="Address">{record.property ? <a href={`/properties/${record.property.id}`} className="underline underline-offset-4">{record.property.name}</a> : null}</Fact>
        <Fact label="Job">{record.job ? <a href={`/jobs/${record.job.id}`} className="underline underline-offset-4">{record.job.name}</a> : null}</Fact>
        <Fact label="Unit">{record.equipment ? <a href={`/equipment/${record.equipment.id}`} className="underline underline-offset-4">{record.equipment.name}</a> : null}</Fact>
        {kind.links.includes("invoice") ? (
          <Fact label="Invoice">{record.invoice ? <a href={`/invoices/${record.invoice.id}`} className="underline underline-offset-4">{record.invoice.name}</a> : null}</Fact>
        ) : null}
        {kind.links.includes("membership") ? (
          <Fact label="Person">{record.membership ? <a href={`/people/${record.membership.id}`} className="underline underline-offset-4">{record.membership.name}</a> : null}</Fact>
        ) : null}
        {kind.links.includes("record") ? (
          <Fact label="Points at">
            {record.record ? (record.record.type
              ? <a href={`/records/${record.record.type}/${record.record.id}`} className="underline underline-offset-4">{record.record.name}</a>
              : "A record you cannot open") : null}
          </Fact>
        ) : null}
        <Fact label="Added">{formatIn(record.createdAt, user.organizationTimezone)}</Fact>
      </Facts>

      {record.canWrite ? (
        <section className="mt-8" aria-labelledby="record-edit">
          <h2 id="record-edit" className="text-base font-semibold">Change it</h2>
          <ActionForm action={updateRecord} submit="Save" hidden={{ id }} done="Saved.">
            <TextField label={kind.titleLabel} name="title" required maxLength={200} defaultValue={record.title} />
            <CustomFieldInputs definitions={record.fields} values={record.customFields} />
          </ActionForm>
          <ActionForm action={removeRecord} tone="danger" submit={`Remove this ${kind.label.toLowerCase()}`}
                      hidden={{ id, type }} className="mt-6" />
        </section>
      ) : (
        <dl className="mt-8 grid gap-3 text-sm sm:grid-cols-2">
          {record.fields.map((f) => (
            <div key={f.key}>
              <dt className="text-ink-500">{f.label}</dt>
              <dd>{customFieldText(f, record.customFields[f.key]) || "Not said"}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* The records of other kinds that point at this one: a truck's inspections. */}
      <RecordsPanel ctx={ctx} link="record" id={id} back={`/records/${type}/${id}`} />
    </div>
  );
}
