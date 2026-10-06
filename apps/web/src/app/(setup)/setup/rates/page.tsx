import { getDb } from "@/lib/db";
import { RatesSection } from "@/app/(app)/settings/holidays/RatesSection";
import { StepFrame, loadStep } from "../StepFrame";

export const dynamic = "force-dynamic";

/**
 * Step eight: the item charged for work booked outside the company's hours,
 * and the one on a holiday. Settings' own form, because that is where it is
 * changed after setup.
 */
export default async function RatesStep() {
  const { user, allowed } = await loadStep("rates");
  return (
    <StepFrame stepKey="rates" user={user} allowed={allowed}
               intro="Skip this if you charge the same at seven in the evening as at ten in the morning.">
      <RatesSection ctx={{ actor: user.actor, db: getDb() }} />
    </StepFrame>
  );
}
