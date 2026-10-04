"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { directMail, ConflictError } from "@opentradesos/api/services";
import { createMailCampaign } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";
import { sourceFrom } from "@/lib/lead-source";
import { audienceFrom } from "../campaigns/rules";

/**
 * DIRECT MAIL, THROUGH ITS SERVICE
 *
 * The refusals are the service's: an audience with no rules, a placeholder
 * that would print as nothing, a design without each person's own address on
 * it, a send with no mail house or no return address.
 */

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function createMailing(_previous: FormState, form: FormData): Promise<FormState> {
  let id: string | null = null;
  const result = await attempt(form, async () => {
    const kind = field(form, "kind") === "letter" ? "letter" : "postcard";
    const tracking = sourceFrom(form, "tracking");
    if (tracking.channelId) {
      throw new ConflictError("Choose one of the channel's tracking campaigns, or leave it and one is made for this mailing. Responses are credited to a campaign, not to a whole channel.");
    }
    const input = parsed(createMailCampaign.input, {
      name: field(form, "name") ?? "",
      kind,
      ...(kind === "postcard" ? { size: field(form, "size") ?? "4x6" } : {}),
      audience: audienceFrom(form),
      ...(tracking.campaignId ? { acquisitionCampaignId: tracking.campaignId } : {}),
      front: field(form, "front") ?? "",
      ...(kind === "postcard" ? { back: field(form, "back") ?? "" } : {}),
      ...(field(form, "landingHeadline") ? { landingHeadline: field(form, "landingHeadline") } : {}),
      ...(field(form, "landingBody") ? { landingBody: field(form, "landingBody") } : {}),
      ...(field(form, "pricePerPiece") ? { pricePerPiece: field(form, "pricePerPiece") } : {}),
    });
    id = (await directMail.create(await ctx(), input)).id;
  });
  if (!id) return result;
  revalidatePath("/marketing/mail");
  redirect(`/marketing/mail/${id}`);
}

export async function sendMailing(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "id") ?? "";
  const result = await attempt(form, async () => {
    const report = await directMail.send(await ctx(), { id });
    return {
      message: `${report.sent} sent to the printer, ${report.skipped} skipped${report.pending > 0 ? `, ${report.pending} still to go (the rest go by themselves)` : ""}${report.refused + report.failed > 0 ? `, ${report.refused + report.failed} not taken` : ""}.`,
    };
  });
  revalidatePath(`/marketing/mail/${id}`);
  return result;
}

export async function cancelMailing(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "id") ?? "";
  const result = await attempt(form, async () => {
    await directMail.cancel(await ctx(), { id });
    return { message: "Stopped." };
  });
  revalidatePath(`/marketing/mail/${id}`);
  return result;
}
