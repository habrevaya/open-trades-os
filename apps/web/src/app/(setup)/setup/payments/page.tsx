import { getDb } from "@/lib/db";
import { IntegrationGroups } from "@/app/(app)/settings/integrations/IntegrationGroups";
import { StepFrame, loadStep } from "../StepFrame";

export const dynamic = "force-dynamic";

/**
 * Step eight: a card processor, through the Integrations screen's own
 * connect form. Stripe's own review of a new account is why it is flagged to
 * start early.
 */
export default async function PaymentsStep() {
  const { user, allowed } = await loadStep("payments");
  return (
    <StepFrame stepKey="payments" user={user} allowed={allowed}
               intro="Stripe reviews a new account before it pays out, which can take a few days. Connect it now even if you are not ready to take cards.">
      <IntegrationGroups ctx={{ actor: user.actor, db: getDb() }} only={["payments"]} />
    </StepFrame>
  );
}
