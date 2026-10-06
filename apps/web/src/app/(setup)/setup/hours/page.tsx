import { getDb } from "@/lib/db";
import { BookingSections } from "@/app/(app)/booking/BookingSections";
import { StepFrame, loadStep } from "../StepFrame";

export const dynamic = "force-dynamic";

/**
 * Step four: which days you are open and the arrival windows customers pick
 * from, and which job types the public may book online. The Online booking
 * screen's own forms, because that is what reads them.
 */
export default async function HoursStep() {
  const { user, allowed } = await loadStep("hours");
  return (
    <StepFrame stepKey="hours" user={user} allowed={allowed}>
      <BookingSections ctx={{ actor: user.actor, db: getDb() }} />
    </StepFrame>
  );
}
