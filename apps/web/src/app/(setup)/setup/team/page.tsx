import { getDb } from "@/lib/db";
import { can } from "@opentradesos/core";
import { TeamSection } from "@/app/(app)/settings/team/TeamSection";
import { BranchesSection } from "@/app/(app)/settings/branches/BranchesSection";
import { StepFrame, loadStep } from "../StepFrame";

export const dynamic = "force-dynamic";

/**
 * Step five: who works here. Branches come first on the page and are
 * optional: a company with a second shop sets them up before inviting, so
 * each person can be put in theirs as they are invited.
 */
export default async function TeamStep() {
  const { user, allowed } = await loadStep("team");
  const ctx = { actor: user.actor, db: getDb() };
  return (
    <StepFrame stepKey="team" user={user} allowed={allowed}>
      {can(user.actor, "settings:read") ? (
        <details className="mb-8">
          <summary className="cursor-pointer text-base font-semibold">More than one shop? Branches (optional)</summary>
          <p className="mt-2 max-w-prose text-sm text-ink-700">
            A branch is a part of the company whose managers see their own work. Skip this if you run one shop.
          </p>
          <div className="mt-3"><BranchesSection ctx={ctx} compact /></div>
        </details>
      ) : null}
      <TeamSection ctx={ctx} />
    </StepFrame>
  );
}
