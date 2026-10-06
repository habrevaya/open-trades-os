import { getDb } from "@/lib/db";
import { TaxSection } from "@/app/(app)/pricebook/tax/TaxSection";
import { TaxRatesSection } from "@/app/(app)/settings/tax/TaxRates";
import { StepFrame, loadStep } from "../StepFrame";

export const dynamic = "force-dynamic";

/**
 * Step seven: the rates the company charges and which items are taxed. The
 * same forms as Settings, Sales tax and Price book, Sales tax, drawn here.
 */
export default async function TaxStep() {
  const { user, allowed } = await loadStep("tax");
  const ctx = { actor: user.actor, db: getDb() };
  return (
    <StepFrame stepKey="tax" user={user} allowed={allowed}
               intro="Write down the rate you charge and which items are taxed. Labour is not taxed in many states and parts usually are. A customer or an address with a different rate, or a customer who is exempt, is set on their page.">
      <TaxRatesSection ctx={ctx} timeZone={user.organizationTimezone} />
      <h2 className="mt-10 text-lg font-semibold">Which items are taxed</h2>
      <div className="mt-3"><TaxSection ctx={ctx} /></div>
    </StepFrame>
  );
}
