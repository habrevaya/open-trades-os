import { taxRates, type ServiceContext } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { saveCustomerTax } from "./tax-actions";

/**
 * WHAT THIS CUSTOMER IS CHARGED IN SALES TAX
 *
 * Exempt, on a certificate whose number and last day are recorded, because a
 * sale billed exempt on a lapsed certificate is tax the company still owes;
 * or a rate of their own, charged where the address names none. The line
 * above the form says what an invoice to them today is charged and why.
 */
export async function SalesTax({ ctx, customer }: {
  ctx: ServiceContext;
  customer: {
    id: string; taxExempt: boolean; taxExemptCertificate?: string | null | undefined;
    taxExemptExpiresOn?: string | null | undefined; taxRateId?: string | null | undefined;
  };
}) {
  const picker = await taxRates.picker(ctx, { customerId: customer.id, propertyId: null, permission: "customer:read" });
  const said = picker.worked?.note ?? "";
  if (!can(ctx.actor, "customer:write")) {
    return <p className="mt-4 text-sm text-ink-700"><span className="font-medium">Sales tax:</span> {said}</p>;
  }
  const named = customer.taxRateId && !picker.choices.some((c) => c.id === customer.taxRateId)
    ? [{ value: customer.taxRateId, label: "A rate no longer in use" }] : [];
  return (
    <section aria-label="Sales tax" className="mt-6">
      <h2 className="text-sm font-semibold">Sales tax</h2>
      <p className="mt-1 text-sm text-ink-700">Today: {said}</p>
      <ActionForm action={saveCustomerTax} submit="Save sales tax" tone="quiet" hidden={{ customerId: customer.id }}
                  className="mt-2 grid max-w-3xl gap-3 sm:grid-cols-2">
        <Select label="Exempt from sales tax" name="taxExempt" defaultValue={customer.taxExempt ? "yes" : "no"} options={[
          { value: "no", label: "No, they pay sales tax" },
          { value: "yes", label: "Yes, on an exemption certificate" },
        ]} />
        <Select label="Their rate" name="taxRateId" defaultValue={customer.taxRateId ?? ""} options={[
          { value: "", label: "The address's, or your usual rate" },
          ...picker.choices.map((c) => ({ value: c.id, label: c.label })),
          ...named,
        ]} />
        <TextField label="Certificate number" name="taxExemptCertificate" defaultValue={customer.taxExemptCertificate ?? ""} maxLength={100} />
        <TextField label="Certificate good until" name="taxExemptExpiresOn" type="date" defaultValue={customer.taxExemptExpiresOn ?? ""} />
      </ActionForm>
      <p className="mt-1 text-xs text-ink-500">
        After the certificate&rsquo;s last day they are taxed again, because tax not collected on a lapsed certificate is
        still owed. An address with its own rate wins over theirs.
      </p>
    </section>
  );
}
