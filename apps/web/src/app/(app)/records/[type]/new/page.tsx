import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customObjects, customers, jobs, NotFoundError } from "@opentradesos/api/services";
import { PermissionError } from "@opentradesos/core";
import { ActionForm, TextField } from "@/components/ActionForm";
import { CustomFieldInputs } from "@/components/CustomFieldInputs";
import { Crumb } from "@/components/Detail";
import { PageHeader } from "@/components/Table";
import { createRecord } from "../../actions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ADD ONE, drawn from the kind's definition: its name, its fields, and what
 * it points at. Opened from a job, a customer, an address or a unit, it
 * carries that record in and goes back there when saved; opened from the
 * list, it asks for a job by number when the kind points at jobs.
 */
export default async function NewRecordPage({
  params, searchParams,
}: {
  params: Promise<{ type: string }>;
  searchParams: Promise<{ customerId?: string; propertyId?: string; jobId?: string; equipmentId?: string; back?: string }>;
}) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const { type } = await params;
  const query = await searchParams;
  const kind = await customObjects.getKind(ctx, { key: type }).catch((error: unknown) => {
    if (error instanceof NotFoundError || error instanceof PermissionError) notFound();
    throw error;
  });
  if (!kind.canWrite) notFound();

  const carried: Record<string, string> = {};
  for (const name of ["customerId", "propertyId", "jobId", "equipmentId"] as const) {
    const value = query[name];
    if (value && UUID.test(value)) carried[name] = value;
  }
  const job = carried["jobId"] ? await jobs.get(ctx, { id: carried["jobId"] }).catch(() => null) : null;
  const customer = carried["customerId"] && !job ? await customers.get(ctx, { id: carried["customerId"] }).catch(() => null) : null;
  const back = query.back && query.back.startsWith("/") && !query.back.startsWith("//") ? query.back : undefined;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <Crumb href={back ?? `/records/${type}`}>{back ? "Back" : kind.pluralLabel}</Crumb>
      <div className="mt-2"><PageHeader title={`Add a ${kind.label.toLowerCase()}`} /></div>
      {job ? <p className="mt-2 text-sm text-ink-700">On job {job.number}: {job.summary}</p> : null}
      {customer ? <p className="mt-2 text-sm text-ink-700">For {customer.name}</p> : null}
      <ActionForm action={createRecord} submit={`Add the ${kind.label.toLowerCase()}`}
                  hidden={{ type, ...carried, ...(back ? { back } : {}) }}>
        <TextField label={kind.titleLabel} name="title" required maxLength={200} />
        {kind.links.includes("job") && !carried["jobId"] ? (
          <TextField label="Job number (optional)" name="jobNumber" inputMode="numeric" pattern="[0-9]*" />
        ) : null}
        <CustomFieldInputs definitions={kind.fields} />
      </ActionForm>
    </div>
  );
}
