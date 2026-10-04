import type { setup } from "@opentradesos/api/services";
import { ActionForm, TextField } from "@/components/ActionForm";
import { saveCompanyDetails } from "./actions";

/**
 * WHAT THE COMPANY IS CALLED, AND HOW A CUSTOMER REACHES IT
 *
 * One form for the setup wizard's first step and for Settings, because they
 * are one record and two forms for it would be two places to forget a field.
 *
 * The phone, email and address are what a proposal, an invoice, a statement,
 * their PDFs and the top of every customer page print under the company's
 * name. Each is optional and printed only when it is set; the hint says that,
 * because an owner who leaves the address empty on purpose (a business run
 * from home) should know it stays off the paper.
 */
export function CompanyDetails({ details }: { details: setup.CompanyDetails }) {
  return (
    <section aria-label="Company details" className="mt-8 rounded-md border border-steel-200 p-4">
      <h2 className="font-medium text-ink-900">Company details</h2>
      <p className="mt-1 max-w-prose text-sm text-ink-500">
        Your phone, email and address are printed on proposals, invoices,
        statements and the pages your customers open. Leave any of them empty
        to keep it off.
      </p>
      <ActionForm action={saveCompanyDetails} submit="Save company details" done="Saved." className="mt-3 grid gap-3 sm:grid-cols-2">
        <TextField label="What customers call you" name="name" defaultValue={details.name} required maxLength={120} />
        <TextField label="Legal name, if different (optional)" name="legalName" defaultValue={details.legalName ?? ""} maxLength={200} />
        <TextField label="Phone customers call" name="phone" type="tel" autoComplete="tel" defaultValue={details.phone ?? ""} maxLength={40} />
        <TextField label="Email customers write to" name="email" type="email" autoComplete="email" defaultValue={details.email ?? ""} maxLength={254} />
        <TextField label="Street address" name="addressLine1" autoComplete="address-line1" defaultValue={details.addressLine1 ?? ""} maxLength={120} />
        <TextField label="Suite or unit (optional)" name="addressLine2" autoComplete="address-line2" defaultValue={details.addressLine2 ?? ""} maxLength={120} />
        <TextField label="Town or city" name="city" autoComplete="address-level2" defaultValue={details.city ?? ""} maxLength={120} />
        <div className="grid grid-cols-2 gap-3">
          <TextField label="State" name="state" autoComplete="address-level1" defaultValue={details.state ?? ""} maxLength={120} />
          <TextField label="ZIP code" name="postalCode" autoComplete="postal-code" defaultValue={details.postalCode ?? ""} maxLength={20} />
        </div>
      </ActionForm>
    </section>
  );
}
