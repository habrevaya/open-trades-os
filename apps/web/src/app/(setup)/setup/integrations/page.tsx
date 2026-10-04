import { getDb } from "@/lib/db";
import { IntegrationGroups } from "@/app/(app)/settings/integrations/IntegrationGroups";
import { StepFrame, loadStep } from "../StepFrame";

export const dynamic = "force-dynamic";

/** Step ten: the books. QuickBooks Online or Xero, through the Integrations screen's own forms. */
export default async function AccountingStep() {
  const { user, allowed } = await loadStep("integrations");
  return (
    <StepFrame stepKey="integrations" user={user} allowed={allowed}
               intro="Optional. Every invoice and payment goes into your books once this is connected and your accounts are mapped.">
      <IntegrationGroups ctx={{ actor: user.actor, db: getDb() }} only={["accounting"]} />
    </StepFrame>
  );
}
