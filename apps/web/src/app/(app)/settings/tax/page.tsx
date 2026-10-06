import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { PageHeader } from "@/components/Table";
import { TaxRatesSection } from "./TaxRates";

export const dynamic = "force-dynamic";

/**
 * SETTINGS → SALES TAX
 *
 * The rates the company charges, its usual one, and whether it charges any.
 * Which items are taxed is on Price book, Sales tax; a customer's exemption
 * and a customer's or address's own rate are on their pages.
 */
export default async function SalesTaxSettingsPage() {
  const user = await requireSetupUser();
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Sales tax" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        The rates you charge. Each invoice and estimate charges the rate for the job&rsquo;s address, else the
        customer&rsquo;s, else your usual one, on the lines that are taxable, at the percentage in force on its date.
        Which items are taxable is set on <a href="/pricebook/tax" className="underline underline-offset-4">Price book, Sales tax</a>.
      </p>
      <div className="mt-6">
        <TaxRatesSection ctx={{ actor: user.actor, db: getDb() }} timeZone={user.organizationTimezone} />
      </div>
    </div>
  );
}
