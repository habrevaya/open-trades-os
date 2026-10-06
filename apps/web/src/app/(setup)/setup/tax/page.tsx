import { getDb } from "@/lib/db";
import { TaxSection } from "@/app/(app)/pricebook/tax/TaxSection";
import { StepFrame, loadStep } from "../StepFrame";

export const dynamic = "force-dynamic";

/** Step seven: which items are taxed and under which class. The rate is set on each document. */
export default async function TaxStep() {
  const { user, allowed } = await loadStep("tax");
  return (
    <StepFrame stepKey="tax" user={user} allowed={allowed}
               intro="Labour is not taxed in many states and material usually is. The rate itself is set on the invoice or estimate, because rates belong to where the work is done.">
      <TaxSection ctx={{ actor: user.actor, db: getDb() }} />
    </StepFrame>
  );
}
