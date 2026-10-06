"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { marketplaceLeads, leadEmails } from "@opentradesos/api/services";
import { connectLeadMarketplace, sendLeadOfferMessage } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";
import { sourceFrom } from "@/lib/lead-source";

/**
 * THE MARKETPLACES AND THE LEAD INBOX, THROUGH THEIR SERVICES
 *
 * Each action parses with the route's own schema and decides nothing; the
 * refusals (a token name that is plainly the token, a reply to a lead from a
 * marketplace that takes none) are the services' sentences.
 */

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function connectMarketplace(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const input = parsed(connectLeadMarketplace.input, {
      platform: field(form, "platform"),
      ...(field(form, "displayName") ? { displayName: field(form, "displayName") } : {}),
      ...sourceFrom(form, "channel"),
      ...(field(form, "businessId") ? { businessId: field(form, "businessId") } : {}),
      ...(field(form, "apiTokenRef") ? { apiTokenRef: field(form, "apiTokenRef") } : {}),
      ...(field(form, "webhookSecretRef") ? { webhookSecretRef: field(form, "webhookSecretRef") } : {}),
    });
    const made = await marketplaceLeads.connectMarketplace(await ctx(), input);
    const where = `Give ${made.displayName} the address ending ${made.webhookPath}.`;
    return made.password
      ? {
        message: `${where} Keep the password below in your secret store as ${made.webhookSecretRef}, and give ${made.displayName} the same password.`,
        secret: { value: made.password, caption: "The password it posts with. It is shown once: copy it now." },
      }
      : { message: where };
  });
  revalidatePath("/marketing/leads/connectors");
  return result;
}

export async function replyToLead(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "id") ?? "";
  const result = await attempt(form, async () => {
    const input = parsed(sendLeadOfferMessage.input, { id, body: field(form, "body") ?? "" });
    const sent = await marketplaceLeads.sendOfferMessage(await ctx(), input);
    return { message: sent.state === "sent" ? "Sent." : `Not sent: ${sent.error ?? "the marketplace did not take it."}` };
  });
  revalidatePath(`/marketing/leads/${id}`);
  return result;
}

export async function rotateLeadInbox(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const view = await leadEmails.rotateInbox(await ctx());
    return { message: view.address ? `The lead inbox is now ${view.address}. Change your forwarding rules to it.` : "Rotated." };
  });
  revalidatePath("/marketing/leads/connectors");
  return result;
}
