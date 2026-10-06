import { messagingRegistration, type ServiceContext } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, TextField } from "@/components/ActionForm";
import { enumText } from "@/lib/labels";
import { recordBrand, setBrandStatus, recordCampaign } from "./registration-actions";

const TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  not_started: "neutral", submitted: "info", pending_review: "info", approved: "success", rejected: "danger", suspended: "danger",
};

/**
 * A2P 10DLC, WRITTEN DOWN
 *
 * Carriers in the US refuse business texts from a number with no registered
 * brand and campaign, and the review takes days to weeks, which is why the
 * setup wizard flags this step "start early". The registration itself is made
 * in the carrier's own portal (Twilio's, for most); this is where the company
 * records what it submitted and what came back.
 *
 * Recording one switches the check on: from then, a kind of text with no
 * approved campaign behind it is refused with the carrier's reason, rather
 * than sent and counted against the number. A company with nothing recorded
 * is not checked at all, because the registration may well exist in a portal
 * nobody has copied it from.
 */
export async function Registration({ ctx }: { ctx: ServiceContext }) {
  const brands = await messagingRegistration.list(ctx);
  const writes = can(ctx.actor, "settings:write");

  return (
    <section className="mt-8" aria-labelledby="ten-dlc">
      <h2 id="ten-dlc" className="text-base font-semibold">Texting registration (A2P 10DLC)</h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-700">
        Register your business and what you text about in your carrier&apos;s portal, then record it here. It
        takes days to weeks to be approved, so start it before you need it.
      </p>

      {brands.length === 0 ? (
        <p className="mt-3 text-sm text-ink-500">Nothing recorded, so texts are not checked against a registration.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {brands.map((brand) => (
            <li key={brand.id} className="rounded-md border border-steel-200 bg-canvas p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{brand.displayName}</span>
                <span className="text-sm text-ink-500">{brand.legalName}</span>
                <Chip tone={TONE[brand.status] ?? "neutral"}>{enumText(brand.status)}</Chip>
              </div>
              {brand.statusReason ? <p className="mt-1 text-sm text-red-600">{brand.statusReason}</p> : null}
              <ul className="mt-2 space-y-1 text-sm">
                {brand.campaigns.map((c) => (
                  <li key={c.id} className="text-ink-700">
                    {c.purpose === "marketing" ? "Marketing" : "Reminders and notices"}: {c.useCase}{" "}
                    <Chip tone={TONE[c.status] ?? "neutral"}>{enumText(c.status)}</Chip>
                  </li>
                ))}
              </ul>
              {writes ? (
                <div className="mt-3 flex flex-wrap items-start gap-6">
                  <ActionForm action={setBrandStatus} tone="quiet" submit="Record what the carrier said"
                              hidden={{ id: brand.id }} className="flex flex-wrap items-end gap-2">
                    <label className="text-sm">
                      <span className="block font-medium text-ink-700">Brand is now</span>
                      <select name="status" defaultValue={brand.status} className="mt-1 h-9 rounded border border-steel-300 px-2">
                        {messagingRegistration.REGISTRATION_STATUSES.map((s) => <option key={s} value={s}>{enumText(s)}</option>)}
                      </select>
                    </label>
                    <TextField label="Their reason, if refused" name="reason" maxLength={500} className="w-56" />
                  </ActionForm>
                  <ActionForm action={recordCampaign} tone="quiet" submit="Record a campaign"
                              hidden={{ brandId: brand.id }} className="flex flex-wrap items-end gap-2">
                    <label className="text-sm">
                      <span className="block font-medium text-ink-700">For</span>
                      <select name="purpose" defaultValue="transactional" className="mt-1 h-9 rounded border border-steel-300 px-2">
                        <option value="transactional">Reminders and notices</option>
                        <option value="marketing">Marketing</option>
                      </select>
                    </label>
                    <TextField label="Use case" name="useCase" required maxLength={100} placeholder="Customer care" className="w-48" />
                  </ActionForm>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {writes ? (
        <ActionForm action={recordBrand} submit="Record a brand" className="mt-4 grid max-w-3xl gap-3 sm:grid-cols-2">
          <TextField label="Legal name, as registered" name="legalName" required maxLength={200} />
          <TextField label="Name customers know you by" name="displayName" required maxLength={200} />
          <TextField label="Business type (optional)" name="entityType" maxLength={60} placeholder="Private company" />
          <TextField label="Last four of your EIN (optional)" name="taxIdLast4" maxLength={4} inputMode="numeric" />
          <TextField label="Website (optional)" name="website" maxLength={300} className="sm:col-span-2" />
        </ActionForm>
      ) : null}
    </section>
  );
}
