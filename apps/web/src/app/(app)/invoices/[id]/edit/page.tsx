import { notFound, redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { afterHours, billing, jobs, priceBook, taxRates, NotFoundError } from "@opentradesos/api/services";
import { assertCan, can, money } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { Composer, type ComposerLine } from "../../Composer";
import { saveDraft } from "../../actions";

export const dynamic = "force-dynamic";

const edit = (value: string) => money.edit(money.money(value, "USD"));

/** A line's discount less the part member pricing gave, or null when that leaves nothing. */
function handDiscount(line: { discountAmount: string; memberDiscountAmount?: string | undefined }): string | null {
  const hand = money.subtract(
    money.money(line.discountAmount, "USD"),
    money.money(line.memberDiscountAmount ?? "0", "USD"),
  );
  return money.isPositive(hand) ? money.toString(hand) : null;
}

/**
 * EDITING A DRAFT. An issued invoice is never edited, so this page sends one
 * back to the invoice, where voiding and raising another is offered instead.
 */
export default async function EditInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  assertCan(user.actor, "invoice:write");
  const ctx = { actor: user.actor, db: getDb() };
  const { id } = await params;

  const invoice = await billing.get(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  if (invoice.status !== "draft") redirect(`/invoices/${id}`);

  /**
   * The after hours or holiday rate, when one of the job's visits was booked
   * outside the hours, unless another of the job's invoices already has it.
   * Offered above the lines and added only when somebody presses for it.
   */
  const offers = invoice.jobId && can(user.actor, "pricebook:read") && can(user.actor, "job:read")
    ? await afterHours.offersForJob(ctx, { jobId: invoice.jobId, exceptInvoiceId: id })
    : [];
  const listed = can(user.actor, "pricebook:read")
    ? (await priceBook.list(ctx, { limit: 200, includeInactive: false })).data
      .map((item) => ({ id: item.id, name: item.name, price: item.price, taxable: item.taxable, versionId: item.versionId }))
    : [];
  const items = [
    ...listed,
    ...offers.map((o) => o.item).filter((item) => !listed.some((l) => l.id === item.id)),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const itemByVersion = new Map(listed.map((item) => [item.versionId, item.id]));

  /** Which job line each invoice line bills, so editing keeps the link. */
  const billed = invoice.jobId
    ? new Map((await jobs.lines(ctx, { id: invoice.jobId })).data
      .filter((line) => line.invoiceLineId)
      .map((line) => [line.invoiceLineId!, line.id]))
    : new Map<string, string>();

  /**
   * The manual line at the end is the adjustment, which the composer shows
   * in its own boxes: a discount as a negative amount, a charge as a
   * positive one, exactly as it was entered.
   */
  const last = invoice.lines.at(-1);
  const adjustment = last && last.origin === "manual"
    ? {
        name: last.name,
        amount: Number(last.discountAmount) > 0 ? `-${edit(last.discountAmount)}` : edit(last.unitPrice),
      }
    : undefined;
  const lines: ComposerLine[] = invoice.lines
    .filter((line) => !(adjustment && line === last))
    .map((line) => ({
      jobLineId: billed.get(line.id),
      priceBookItemId: line.priceBookItemVersionId && !billed.has(line.id)
        ? itemByVersion.get(line.priceBookItemVersionId)
        : undefined,
      name: line.name,
      quantity: edit(line.quantity),
      unitPrice: edit(line.unitPrice),
      /**
       * What somebody typed, without the member discount. The member part is
       * worked out again by the service when the draft is saved, so putting
       * it back in this box would take it off twice.
       */
      discountAmount: handDiscount(line) ? edit(handDiscount(line)!) : "",
      taxable: line.taxable,
    }));

  /**
   * The draft's sales tax as it was priced: a rate somebody chose for every
   * taxable line (or none) is shown chosen, so saving the draft keeps it;
   * anything else is worked out again for today when it is saved.
   */
  const jobProperty = invoice.jobId ? ((await jobs.get(ctx, { id: invoice.jobId })).propertyId as string | null) : null;
  const tax = await taxRates.picker(ctx, { customerId: invoice.customerId, propertyId: jobProperty, permission: "invoice:read" });
  const taxed = invoice.lines.filter((l) => l.taxable && l.origin !== "manual");
  const chosenIds = new Set(taxed.map((l) => (l.taxSource === "chosen" ? l.taxRateId ?? "none"
    : l.taxSource === "estimate" && l.taxRateId ? l.taxRateId : "")));
  const only = chosenIds.size === 1 ? [...chosenIds][0]! : "";
  const chosen = only === "none" || tax.choices.some((c) => c.id === only) ? only : "";

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href={`/invoices/${id}`}>Invoice {invoice.number}</Crumb>
      <h1 className="mt-1 text-xl font-semibold">Edit draft invoice {invoice.number}</h1>
      <Composer
        action={saveDraft}
        hidden={{ invoiceId: id }}
        lines={lines}
        items={items}
        submit="Save draft"
        draftable={false}
        offers={offers}
        adjustment={adjustment}
        memo={invoice.memo ?? undefined}
        dueOn={invoice.dueOn ?? undefined}
        purchaseOrderNumber={invoice.purchaseOrderNumber ?? undefined}
        tax={{ worked: tax.worked?.note ?? "", choices: tax.choices, chosen }}
      />
    </div>
  );
}
