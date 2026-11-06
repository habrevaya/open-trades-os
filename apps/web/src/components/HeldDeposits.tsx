import { billing, deposits, type ServiceContext } from "@opentradesos/api/services";
import { can, work } from "@opentradesos/core";
import { applyHeldDeposit, disposeOfDeposit } from "@/app/(app)/deposit-actions";
import { DepositsPanel, isHeld, type HeldDeposit, type OwingInvoice } from "./DepositsPanel";

/**
 * The deposits panel, read for one page: the customer's deposits (or one
 * estimate's), and the customer's issued invoices with money owing for
 * "Apply to an invoice". Nothing is read for somebody who may not read
 * deposits, and the invoices only for somebody who may apply one.
 */
export async function HeldDeposits({
  ctx, customerId, estimateId, invoice, back,
}: {
  ctx: ServiceContext;
  customerId: string;
  /** Only this estimate's deposits. */
  estimateId?: string;
  /** On an invoice page: held deposits go against this invoice alone. */
  invoice?: { id: string; number: number; numberPrefix: string | null; status: string; balance: string };
  back: string;
}) {
  if (!can(ctx.actor, "deposit:read")) return null;
  const allowed = {
    apply: can(ctx.actor, "deposit:collect") && can(ctx.actor, "invoice:write"),
    refund: can(ctx.actor, "deposit:refund"),
  };
  const read = (await deposits.list(ctx, estimateId ? { estimateId } : { customerId })).deposits as HeldDeposit[];
  /** On an invoice, the ones it could take and the ones it already took; the rest belong to other work. */
  const shown = invoice ? read.filter((d) => isHeld(d) || d.appliedInvoiceId === invoice.id) : read;
  if (shown.length === 0) return null;

  const owes = (status: string, balance: string) => (status === "open" || status === "partially_paid") && Number(balance) > 0;
  let invoices: OwingInvoice[] = [];
  if (!invoice && allowed.apply && can(ctx.actor, "invoice:read") && shown.some(isHeld)) {
    const page = await billing.list(ctx, { customerId, status: ["open", "partially_paid"], limit: 50 });
    invoices = page.data
      .filter((i) => i.customerId === customerId && owes(i.status, i.balance ?? "0"))
      .map((i) => ({ id: i.id, number: work.documentNumber(i.numberPrefix, i.number), balance: i.balance ?? "0" }));
  }
  const here = invoice && owes(invoice.status, invoice.balance)
    ? { id: invoice.id, number: work.documentNumber(invoice.numberPrefix, invoice.number), balance: invoice.balance }
    : undefined;

  return (
    <DepositsPanel
      deposits={shown}
      invoices={invoices}
      {...(here ? { here } : {})}
      allowed={invoice && !here ? { apply: false, refund: allowed.refund } : allowed}
      apply={applyHeldDeposit}
      dispose={disposeOfDeposit}
      back={back}
    />
  );
}
