import { getDb } from "@/lib/db";
import { ServiceAreaSection } from "@/app/(app)/settings/service-area/ServiceAreaSection";
import { StepFrame, loadStep } from "../StepFrame";

export const dynamic = "force-dynamic";

/** Step three: the postal codes you work and the trip charge to each. The Settings screen's own forms. */
export default async function ServiceAreaStep() {
  const { user, allowed } = await loadStep("service-area");
  return (
    <StepFrame stepKey="service-area" user={user} allowed={allowed}
               intro="A territory is a set of postal codes and what it costs to send somebody there. An address in no territory has no area and no trip charge.">
      <ServiceAreaSection ctx={{ actor: user.actor, db: getDb() }} />
    </StepFrame>
  );
}
