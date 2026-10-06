"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { billing, invoiceDelivery } from "@opentradesos/api/services";
import { createInvoice, updateInvoice, sendInvoice } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";
import { linesFromForm } from "@/lib/invoice-form";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/**
 * RAISING AN INVOICE FROM THE OFFICE
 *
 * `POST /v1/invoices`, made by the composer. The lines are parsed by the
 * route's own schema, the service prices them (the price book's price wins
 * over anything typed for a linked item), and a refusal (over the client's
 * authorisation, a part already billed, rework billed to the customer) is
 * the service's sentence under the form.
 */
export async function raiseInvoice(_previous: FormState, form: FormData): Promise<FormState> {
  let id: string | null = null;
  const adjustment = adjustmentFrom(form);
  const result = await attempt(form, async () => {
    const input = parsed(createInvoice.input, {
      customerId: field(form, "customerId"),
      jobId: field(form, "jobId"),
      draft: form.get("draft") === "1",
      dueOn: field(form, "dueOn"),
      memo: field(form, "memo"),
      purchaseOrderNumber: field(form, "purchaseOrderNumber"),
      lines: linesFromForm(form),
      ...taxRateFrom(form),
      ...(adjustment ? { adjustment } : {}),
    });
    id = (await billing.create(await ctx(), input)).id;
  });
  if (!id) return result;
  redirect(`/invoices/${id}`);
}

/** Saving a draft's new lines and details. Issued invoices are refused by the service. */
export async function saveDraft(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "invoiceId") ?? "";
  const adjustment = adjustmentFrom(form);
  const result = await attempt(form, async () => {
    const input = parsed(updateInvoice.input, {
      id,
      lines: linesFromForm(form),
      ...taxRateFrom(form),
      ...(adjustment ? { adjustment } : {}),
      dueOn: field(form, "dueOn") ?? null,
      memo: field(form, "memo") ?? null,
      purchaseOrderNumber: field(form, "purchaseOrderNumber") ?? null,
    });
    await billing.updateDraft(await ctx(), input);
  });
  if (result?.error) return result;
  redirect(`/invoices/${id}`);
}

/** The composer's sales tax choice: worked out (nothing sent), none (null), or one of the company's rates. */
function taxRateFrom(form: FormData): { taxRateId?: string | null } {
  const chosen = field(form, "taxRateId");
  if (!chosen) return {};
  return { taxRateId: chosen === "none" ? null : chosen };
}

function adjustmentFrom(form: FormData): { name: string; amount: string } | undefined {
  const amount = field(form, "adjustmentAmount");
  if (!amount) return undefined;
  return { name: field(form, "adjustmentName") ?? (amount.startsWith("-") ? "Discount" : "Adjustment"), amount };
}

/**
 * Everything done TO an invoice once it exists, one action named by `op`,
 * each the service call its API route makes: issue a draft, delete a draft,
 * send it, void it, write it off. The permissions are the service's: a
 * person without `invoice:writeoff` is refused there, in words.
 */
export async function actOnInvoice(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "invoiceId") ?? "";
  const op = field(form, "op");
  const c = await ctx();
  let deleted = false;
  const result = await attempt(form, async () => {
    switch (op) {
      case "issue":
        await billing.issue(c, { id });
        return;
      case "delete":
        await billing.deleteDraft(c, { id });
        deleted = true;
        return;
      case "void":
        await billing.voidInvoice(c, { id, reason: field(form, "reason") ?? "" });
        return;
      case "write-off":
        await billing.writeOff(c, { id, reason: field(form, "reason") ?? "" });
        return;
      case "send": {
        const to = field(form, "to");
        const channel = field(form, "channel") === "portal_link" ? "portal_link" as const : "email" as const;
        const input = parsed(sendInvoice.input, {
          invoiceId: id, channel,
          ...(to ? { to } : {}),
          ...(form.get("resend") === "1" ? { resend: true } : {}),
          ...(field(form, "note") ? { note: field(form, "note") } : {}),
        });
        const sent = await invoiceDelivery.send(c, input);
        return {
          message: sent.state === "refused"
            ? `Not sent: ${(sent.explanation ?? sent.reason ?? "the mail system refused it").replace(/\.$/, "")}. `
              + "The attempt is recorded; hand them the link instead."
            : sent.channel === "portal_link"
              ? "Here is the link to give them. It opens the invoice and takes payment."
              : `Emailed to ${sent.destination}.`,
          ...(sent.portalUrl ? { link: sent.portalUrl } : {}),
        };
      }
      default:
        throw new Error(`Unknown invoice operation ${String(op)}`);
    }
  });
  if (deleted) redirect("/invoices");
  revalidatePath(`/invoices/${id}`);
  return result;
}
