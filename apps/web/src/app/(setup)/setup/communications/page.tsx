import { getDb } from "@/lib/db";
import { IntegrationGroups } from "@/app/(app)/settings/integrations/IntegrationGroups";
import { Registration } from "@/app/(app)/settings/integrations/Registration";
import { StepFrame, loadStep } from "../StepFrame";

export const dynamic = "force-dynamic";

/**
 * Step nine: a texting provider and a mail sender, through the Integrations
 * screen's own forms, and the A2P 10DLC registration written down. Phone
 * numbers themselves are on Settings, once a carrier is connected.
 */
export default async function CommunicationsStep() {
  const { user, allowed } = await loadStep("communications");
  const ctx = { actor: user.actor, db: getDb() };
  return (
    <StepFrame stepKey="communications" user={user} allowed={allowed}
               intro={<>Once texting is connected, add or buy your numbers under <a href="/settings" className="underline underline-offset-4">Settings</a>.</>}>
      <IntegrationGroups ctx={ctx} only={["messaging", "email"]} />
      <Registration ctx={ctx} />
    </StepFrame>
  );
}
