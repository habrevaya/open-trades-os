"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ConflictError, customFields, deposits, estimateExpiry, estimates } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { customFieldsFrom } from "@/lib/custom-field-form";
import {
  createEstimate, sendEstimate, requestDeposit, convertEstimate, approveEstimate, declineEstimate, extendEstimateExpiry,
} from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";
import { optionsFromForm, rateFromPercent } from "@/lib/estimate-form";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/**
 * WRITING AN ESTIMATE FROM THE OFFICE: `POST /v1/estimates`, made by the
 * composer, priced by the service (a price book line takes the book's
 * price), refused in the service's words.
 */
export async function writeEstimate(_previous: FormState, form: FormData): Promise<FormState> {
  let id: string | null = null;
  const result = await attempt(form, async () => {
    const c = await ctx();
    const definitions = can(c.actor, "estimate:read") ? await customFields.formFields(c, "estimate") : [];
    const input = parsed(createEstimate.input, {
      customerId: field(form, "customerId"),
      propertyId: field(form, "propertyId"),
      jobId: field(form, "jobId"),
      customFields: customFieldsFrom(form, definitions),
      title: field(form, "title"),
      expiresOn: field(form, "expiresOn"),
      /**
       * Blank leaves it to the company's rates for this customer and address;
       * a figure typed, nought included, is charged as typed.
       */
      ...(field(form, "taxPercent") ? { taxRate: rateFromPercent(field(form, "taxPercent")) } : {}),
      options: optionsFromForm(form),
    });
    // A person is writing this one, so the company's required fields are asked for.
    id = (await estimates.create(c, input, { requireFields: true })).id as string;
  });
  if (!id) return result;
  redirect(`/estimates/${id}`);
}

/**
 * Everything done to an estimate once written, named by `op`, each the call
 * its API route makes: hand over the approval link, ask for a deposit,
 * record a yes or a no taken by phone, and turn an approved one into work.
 */
export async function actOnEstimate(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "estimateId") ?? "";
  const op = field(form, "op");
  const c = await ctx();
  let jobId: string | null = null;
  const result = await attempt(form, async () => {
    switch (op) {
      case "send": {
        /**
         * By email or text through the same consent gate as every message,
         * or the link alone to hand over. A refusal (they replied STOP, no
         * sender connected) is not an error: it is recorded on the estimate
         * and said here in the transport's own words.
         */
        const channel = field(form, "channel") ?? "email";
        const sent = await estimates.send(c, parsed(sendEstimate.input, {
          id, channel, to: field(form, "to"), message: field(form, "message"),
          expiresInDays: Number(field(form, "expiresInDays") ?? "30"),
        }));
        const by = (one: string) => (one === "email" ? "by email" : "by text");
        const went = sent.deliveries.filter((d) => d.state !== "refused");
        if (went.length === 0) {
          const reasons = sent.deliveries.map((d) => d.error).filter(Boolean).join(" ");
          throw new ConflictError(`Not sent. ${reasons} Nothing else changed.`);
        }
        if (channel === "link") {
          return {
            message: "Here is the link to give them. It opens once to approve and sign, and any earlier link stops working.",
            ...(sent.approvalUrl ? { link: sent.approvalUrl } : {}),
          };
        }
        /**
         * By both at once, one channel can be refused while the other goes.
         * The estimate is sent, and the refusal is said beside it rather
         * than lost, because "they never got the text" changes who rings them.
         */
        const notSent = sent.deliveries.filter((d) => d.state === "refused")
          .map((d) => ` Not sent ${by(d.channel)}: ${d.error ?? "refused"}`).join("");
        return {
          message: `Sent ${went.map((d) => `${by(d.channel)} to ${d.destination}`).join(" and ")}.${notSent}`,
        };
      }
      case "deposit": {
        const amount = field(form, "amount")?.replace(/[$,\s]/g, "");
        const percent = field(form, "percent")?.replace(/[%\s]/g, "");
        await deposits.request(c, parsed(requestDeposit.input, {
          customerId: field(form, "customerId"), estimateId: id,
          ...(amount ? { amount } : {}),
          ...(!amount && percent ? { percent: String(Number(percent) / 100) } : {}),
        }));
        return { message: "Deposit asked for. The customer is taken to pay it when they approve." };
      }
      case "approve":
        await estimates.approve(c, parsed(approveEstimate.input, {
          id, optionId: field(form, "optionId"), signerName: field(form, "signerName"),
          capturedVia: field(form, "capturedVia"), selectedLineIds: form.getAll("selectedLineIds"),
        }));
        return undefined;
      case "decline":
        await estimates.decline(c, parsed(declineEstimate.input, { id, reason: field(form, "reason") }));
        return undefined;
      case "convert": {
        const converted = await estimates.convert(c, parsed(convertEstimate.input, {
          id, createJob: true, createInvoice: form.get("createInvoice") === "1",
        }));
        jobId = converted.jobId;
        return undefined;
      }
      default:
        throw new Error(`Unknown estimate operation ${String(op)}`);
    }
  });
  if (jobId) redirect(`/jobs/${jobId}`);
  revalidatePath(`/estimates/${id}`);
  return result;
}

/**
 * GIVING THE CUSTOMER LONGER: `POST /v1/estimates/{id}/expiry`. Only the date
 * moves, later, with the reason kept; the service says whether the link they
 * were sent works until then or needs sending again. The follow up starts
 * again from today unless the office ticks "Leave the follow up alone".
 */
export async function extendEstimate(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "estimateId") ?? "";
  const result = await attempt(form, async () => {
    /** The follow up starts again from today unless the office ticked "Leave the follow up alone". */
    const restartFollowUp = field(form, "leaveFollowUpAlone") === undefined;
    const input = parsed(extendEstimateExpiry.input, {
      id, expiresOn: field(form, "expiresOn"), reason: field(form, "reason"), restartFollowUp,
    });
    const given = await estimateExpiry.extend(await ctx(), input);
    const linkSaid = given.linkExpiresAt
      ? "Done. The link they were sent works until then."
      : "Done. They have no working link, so send the estimate again for one.";
    return {
      message: restartFollowUp
        ? `${linkSaid} The follow up counts its days from today.`
        : `${linkSaid} The follow up was left alone.`,
    };
  });
  revalidatePath(`/estimates/${id}`);
  return result;
}
