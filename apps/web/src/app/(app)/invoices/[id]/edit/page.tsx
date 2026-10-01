import { notFound, redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { billing, jobs, priceBook, NotFoundError } from "@opentradesos/api/services";
import { assertCan, can, money } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { Composer, type ComposerLine } from "../../Composer";
import { saveDraft } from "../../actions";

export const dynamic = "force-dynamic";

const edit = (value: string) => money.edit(money.money(value, "USD"));

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

  const items = can(user.actor, "pricebook:read")
    ? (await priceBook.list(ctx, { limit: 200, includeInactive: false })).data
      .map((item) => ({ id: item.id, name: item.name, price: item.price, taxable: item.taxable, versionId: item.versionId }))
      .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  const itemByVersion = new Map(items.map((item) => [item.versionId, item.id]));

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
      discountAmount: Number(line.discountAmount) > 0 ? edit(line.discountAmount) : "",
      taxable: line.taxable,
    }));

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
        adjustment={adjustment}
        memo={invoice.memo ?? undefined}
        dueOn={invoice.dueOn ?? undefined}
        purchaseOrderNumber={invoice.purchaseOrderNumber ?? undefined}
      />
    </div>
  );
}
