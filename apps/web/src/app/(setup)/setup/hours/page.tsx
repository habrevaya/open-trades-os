import { getDb } from "@/lib/db";
import { BookingSections } from "@/app/(app)/booking/BookingSections";
import { HolidaysSection } from "@/app/(app)/settings/holidays/HolidaysSection";
import { StepFrame, loadStep } from "../StepFrame";

export const dynamic = "force-dynamic";

/**
 * Step four: which days you are open and the arrival windows customers pick
 * from, and which job types the public may book online. The Online booking
 * screen's own forms, because that is what reads them, and the holiday list
 * from Settings, because it is the rest of the answer to "when are you open".
 */
export default async function HoursStep() {
  const { user, allowed } = await loadStep("hours");
  return (
    <StepFrame stepKey="hours" user={user} allowed={allowed}>
      <BookingSections ctx={{ actor: user.actor, db: getDb() }} />
      <h2 className="mt-10 font-medium text-ink-900">Holidays</h2>
      <div className="mt-2">
        <HolidaysSection ctx={{ actor: user.actor, db: getDb() }} timezone={user.organizationTimezone} />
      </div>
    </StepFrame>
  );
}
