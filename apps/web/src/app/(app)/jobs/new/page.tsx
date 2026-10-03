import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customers, customFields, jobs, properties, acquisition, NotFoundError } from "@opentradesos/api/services";
import { assertCan } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { ActionForm, Select, TextArea, TextField } from "@/components/ActionForm";
import { VisitFields } from "@/components/VisitFields";
import { LeadSourceSelect } from "@/components/LeadSourceSelect";
import { CustomFieldInputs } from "@/components/CustomFieldInputs";
import { technicianChoices } from "@/lib/technicians";
import { todayIn } from "@/lib/dates";
import { bookJob } from "../actions";

export const dynamic = "force-dynamic";

/**
 * BOOK A JOB
 *
 * Reached from a customer, or from one of their addresses, which is where
 * the office is when the phone rings. Without a customer it asks for one
 * first, as a plain GET form, so the address list below is always this
 * customer's own.
 */
export default async function BookJobPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; property?: string }>;
}) {
  const user = await requireSetupUser();
  assertCan(user.actor, "job:write");
  const ctx = { actor: user.actor, db: getDb() };
  const { customer: customerId, property: propertyId } = await searchParams;

  if (!customerId) {
    const list = await customers.list(ctx, { limit: 100, includeInactive: false });
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 lg:px-6">
        <Crumb href="/jobs">Jobs</Crumb>
        <h1 className="mt-1 text-xl font-semibold">Book a job</h1>
        <form method="get" className="mt-6 flex flex-wrap items-end gap-3">
          <Select label="Customer" name="customer" className="block min-w-64 flex-1"
                  options={list.data.map((c) => ({ value: c.id, label: c.name }))} />
          <button type="submit"
                  className="inline-flex h-10 items-center rounded bg-ink-900 px-3.5 text-sm font-medium text-white">
            Continue
          </button>
        </form>
        <p className="mt-3 text-sm text-ink-500">
          New to you? <a href="/customers/new" className="underline underline-offset-4">Add the customer</a> first.
        </p>
      </div>
    );
  }

  const customer = await customers.get(ctx, { id: customerId }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const [addresses, types, technicians, sources, settings, jobFields] = await Promise.all([
    properties.list(ctx, { limit: 50, customerId }),
    jobs.listTypes(ctx, { includeInactive: false }),
    technicianChoices(ctx, user.organizationTimezone),
    acquisition.channelOptions(ctx),
    acquisition.getSettings(ctx),
    customFields.formFields(ctx, "job"),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <Crumb href={`/customers/${customerId}`}>{customer.name}</Crumb>
      <h1 className="mt-1 text-xl font-semibold">Book a job</h1>

      {addresses.data.length === 0 ? (
        <p className="mt-4 text-sm text-ink-700">
          {customer.name} has no address on file, and work happens somewhere.{" "}
          <a href={`/customers/${customerId}`} className="underline underline-offset-4">Add one on their page</a>{" "}
          first.
        </p>
      ) : (
        <ActionForm action={bookJob} submit="Book job" hidden={{ customerId }} className="mt-6 space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <Select
              label="Address" name="propertyId"
              defaultValue={propertyId}
              options={addresses.data.map((p) => ({
                value: p.id, label: [p.addressLine1, p.city].filter(Boolean).join(", "),
              }))}
            />
            <Select
              label="Job type" name="jobTypeId"
              options={[
                { value: "", label: "No type" },
                ...types.data.map((t) => ({ value: t.id, label: t.name })),
              ]}
            />
          </div>
          <TextField label="Summary" name="summary" required maxLength={300}
                     placeholder="No cooling upstairs" />
          <TextArea label="Customer said" name="customerComplaint" maxLength={5000} />
          {/*
            Left blank, the job is credited from what the customer already did:
            the call on a tracking number, the click that booked online. Chosen,
            it is recorded as what the office was told, beside that evidence
            rather than over it. Required only when the company says so, and
            then only when nothing was recorded for the customer at all.
          */}
          <LeadSourceSelect
            options={sources} required={settings.requireLeadSource && !customer.leadSource}
            label="Where this job came from"
            help={customer.leadSource
              ? "Leave it to credit what this customer already did. Choose one if they say otherwise."
              : "Leave it if they rang a tracking number: the call already says."}
          />
          <TextArea label="Description" name="description" maxLength={5000} />
          <CustomFieldInputs definitions={jobFields} legend="Your fields" />
          <VisitFields technicians={technicians} defaultDate={todayIn(user.organizationTimezone)}
                       optional legend="First visit" />
        </ActionForm>
      )}
    </div>
  );
}
