import { getDb } from "@/lib/db";
import { branding, setup } from "@opentradesos/api/services";
import { ActionForm, TextField } from "@/components/ActionForm";
import { Branding } from "@/app/(app)/settings/Branding";
import { Timezone } from "@/app/(app)/settings/Timezone";
import { StepFrame, loadStep } from "../StepFrame";
import { saveCompany } from "../actions";

export const dynamic = "force-dynamic";

/**
 * Step one: what customers call you, what you are called on paper, the zone
 * your days run in, and how your documents look. The look and the zone are
 * the Settings screen's own forms, drawn here.
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
          <h2 className="text-base font-semibold">Names</h2>
          <ActionForm action={saveCompany} submit="Save the names" done="Saved." className="mt-3 grid gap-3 sm:grid-cols-2">
            <TextField label="What customers call you" name="name" defaultValue={details.name} required maxLength={120} />
            <TextField label="Legal name, if different (optional)" name="legalName" defaultValue={details.legalName ?? ""} maxLength={200} />
          </ActionForm>
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
