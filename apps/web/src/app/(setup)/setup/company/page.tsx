import { getDb } from "@/lib/db";
import { branding, setup } from "@opentradesos/api/services";
import { Branding } from "@/app/(app)/settings/Branding";
import { CompanyDetails } from "@/app/(app)/settings/CompanyDetails";
import { Timezone } from "@/app/(app)/settings/Timezone";
import { StepFrame, loadStep } from "../StepFrame";

export const dynamic = "force-dynamic";

/**
 * Step one: what customers call you, what you are called on paper, how they
 * reach you, the zone your days run in, and how your documents look. All
 * three are the Settings screen's own forms, drawn here.
 */
export default async function CompanyStep() {
  const { user, allowed } = await loadStep("company");
  const ctx = { actor: user.actor, db: getDb() };
  const [details, brand] = allowed
    ? await Promise.all([setup.details(ctx), branding.current(ctx)])
    : [null, null];

  return (
    <StepFrame stepKey="company" user={user} allowed={allowed}>
      {details ? (
        <>
          <CompanyDetails details={details} />
          <Timezone current={details.timezone} />
          {brand ? (
            <Branding color={brand.color} on={brand.on} text={brand.text}
                      hasLogo={brand.hasLogo} hasFavicon={brand.hasFavicon} version={brand.version} />
          ) : null}
        </>
      ) : null}
    </StepFrame>
  );
}
