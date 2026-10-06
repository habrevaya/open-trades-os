import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { afterHours, customers, jobs, priceBook, NotFoundError } from "@opentradesos/api/services";
import { assertCan, can, money } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { Composer, type ComposerLine } from "../Composer";
import { raiseInvoice } from "../actions";

export const dynamic = "force-dynamic";

/**
 * A NEW INVOICE, from a job or for a customer.
 *
 * From a job, it opens with everything used on the job that is still
 * unbilled and billable, each row keeping the job line it bills. The office
 * adds the call-out fee, the labour, a discount, and sends it.
 */
export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; customer?: string }>;
}) {
  const user = await requireSetupUser();
  assertCan(user.actor, "invoice:write");
  const ctx = { actor: user.actor, db: getDb() };
  const { job: jobId, customer } = await searchParams;

  const job = jobId
    ? await jobs.get(ctx, { id: jobId }).catch((error: unknown) => {
        if (error instanceof NotFoundError) notFound();
        throw error;
      })
    : null;
  const customerId = job?.customerId ?? customer;
  if (!customerId) notFound();
  const who = await customers.get(ctx, { id: customerId }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  const unbilled: ComposerLine[] = job
    ? (await jobs.lines(ctx, { id: job.id })).data
      .filter((line) => !line.invoiceLineId && !line.nonBillableReason)
      .map((line) => ({
        jobLineId: line.id,
        name: line.name,
        quantity: money.edit(money.money(line.quantity, "USD")),
        unitPrice: money.edit(money.money(line.unitPrice, "USD")),
        discountAmount: "",
        taxable: line.taxable,
      }))
    : [];
  /** The after hours or holiday rate, when one of the job's visits was booked outside the hours. Offered, not added. */
  const offers = job && can(user.actor, "pricebook:read") && can(user.actor, "job:read") ? await afterHours.offersForJob(ctx, { jobId: job.id }) : [];
  const listed = can(user.actor, "pricebook:read")
    ? (await priceBook.list(ctx, { limit: 200, includeInactive: false })).data
      .map((item) => ({ id: item.id, name: item.name, price: item.price, taxable: item.taxable }))
    : [];
  const items = [...listed, ...offers.map((o) => o.item).filter((item) => !listed.some((l) => l.id === item.id))]
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href={job ? `/jobs/${job.id}` : `/customers/${customerId}`}>
        {job ? `Job ${job.number}` : who.name}
      </Crumb>
      <h1 className="mt-1 text-xl font-semibold">New invoice for {who.name}</h1>
      {job && (
        <p className="mt-1 text-sm text-ink-700">
          {job.summary}
          {unbilled.length > 0 ? ". What was used on the job and not yet billed is already on it." : null}
        </p>
      )}
      <Composer
        action={raiseInvoice}
        hidden={{ customerId, ...(job ? { jobId: job.id } : {}) }}
        lines={unbilled}
        items={items}
        submit="Create invoice"
        offers={offers}
      />
    </div>
  );
}
