"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ConflictError, deposits, estimates } from "@opentradesos/api/services";
import {
  createEstimate, sendEstimate, requestDeposit, convertEstimate, approveEstimate, declineEstimate,
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
    const input = parsed(createEstimate.input, {
      customerId: field(form, "customerId"),
      propertyId: field(form, "propertyId"),
      jobId: field(form, "jobId"),
      title: field(form, "title"),
      expiresOn: field(form, "expiresOn"),
      taxRate: rateFromPercent(field(form, "taxPercent")),
      options: optionsFromForm(form),
    });
    id = (await estimates.create(await ctx(), input)).id as string;
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
        if (sent.delivery.state === "refused") {
          throw new ConflictError(`Not sent. ${sent.delivery.error ?? ""} Nothing else changed.`);
        }
        if (channel === "link") {
          return {
            message: "Here is the link to give them. It opens once to approve and sign, and any earlier link stops working.",
            ...(sent.approvalUrl ? { link: sent.approvalUrl } : {}),
          };
        }
        return { message: `Sent ${channel === "email" ? "by email" : "by text"} to ${sent.delivery.destination}.` };
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
