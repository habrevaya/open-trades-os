"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { financing } from "@opentradesos/api/services";
import { sendFinancingLink } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/** Where the panel that posted this lives, so it shows the application straight away. */
function backTo(form: FormData): string {
  const invoiceId = field(form, "invoiceId");
  const estimateId = field(form, "estimateId");
  return invoiceId ? `/invoices/${invoiceId}` : estimateId ? `/estimates/${estimateId}` : "/invoices/financing";
}

/**
 * OFFER FINANCING, from an invoice or an estimate.
 *
 * Texted, emailed, or just the link to hand over. A text or email that could
 * not go is said in words beside the button, and the application stands,
 * because the customer can still be given the link another way.
 */
export async function offerFinancing(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const input = parsed(sendFinancingLink.input, {
      invoiceId: field(form, "invoiceId"),
      estimateId: field(form, "estimateId"),
      optionId: field(form, "optionId"),
      channel: field(form, "channel") ?? "link",
      to: field(form, "to"),
    });
    const sent = await financing.send(await ctx(), input);
    const lead = sent.reused ? "The customer's open application was used again. " : "";
    if (sent.delivery === null) {
      return { message: `${lead}Give the customer this link to apply.`, link: sent.application.applicationUrl };
    }
    if (sent.delivery.sent) {
      return { message: `${lead}${sent.delivery.channel === "sms" ? "Texted" : "Emailed"} to ${sent.application.sentTo}.` };
    }
    return {
      message: `${lead}Not sent: ${sent.delivery.reason} The application is open; give them this link instead.`,
      link: sent.application.applicationUrl,
    };
  });
  revalidatePath(backTo(form));
  return result;
}

/** Ask the lender where an application stands, for when a webhook never came. */
export async function checkFinancing(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const view = await financing.refresh(await ctx(), { applicationId: field(form, "applicationId") ?? "" });
    return { message: `The lender says: ${view.statusLabel.toLowerCase()}.` };
  });
  revalidatePath(backTo(form));
  revalidatePath("/invoices/financing");
  return result;
}
