"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ads, ConflictError } from "@opentradesos/api/services";
import { mapPlatformCampaign as mapRoute, retryConversionSend as retryRoute } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * THE AD PLATFORMS SCREEN'S BUTTONS, THROUGH THE SERVICES
 *
 * Pull now, map a campaign, try a send again. Each goes through the handler
 * the API serves, so the permission and the refusals are the API's: pulling
 * and mapping are `adspend:write`, and a send that already reached the
 * platform is refused rather than sent twice.
 */

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function pullNow(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const outcome = await ads.handlers.syncMarketingPlatform(await ctx(), { provider: field(form, "provider") ?? "" });
    const failed = outcome.runs.find((r) => r.error);
    if (failed) throw new ConflictError(failed.error!);
    const said = outcome.runs.map((r) =>
      r.entity === "spend" ? `${r.written} spend day${r.written === 1 ? "" : "s"}`
        : r.entity === "leads" ? `${r.written} new lead${r.written === 1 ? "" : "s"}`
          : `${r.written} job${r.written === 1 ? "" : "s"} sent`);
    return { message: said.length > 0 ? `Done: ${said.join(", ")}.` : "Nothing to do." };
  });
  revalidatePath("/marketing/platforms");
  return result;
}

export async function mapCampaign(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const input = parsed(mapRoute.input, { id: field(form, "id") ?? "", campaignId: field(form, "campaignId") ?? null });
    const done = await ads.handlers.mapPlatformCampaign(await ctx(), input);
    return { message: done.moved === 0 ? "Saved." : `Saved, and ${done.moved} day${done.moved === 1 ? "" : "s"} of spend moved with it.` };
  });
  revalidatePath("/marketing/platforms");
  revalidatePath("/marketing");
  return result;
}

export async function retrySend(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    await ads.handlers.retryConversionSend(await ctx(), parsed(retryRoute.input, { id: field(form, "id") ?? "" }));
    return { message: "It goes again on the next pass, decided afresh." };
  });
  revalidatePath("/marketing/platforms/sends");
  return result;
}
