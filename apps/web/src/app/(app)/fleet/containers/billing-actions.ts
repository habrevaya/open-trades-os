"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { rentalBilling } from "@opentradesos/api/services";
import { recordRentalCharge, scheduleRentalCollections } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * THE HIRE AFTER THE CAN HAS GONE OUT: collections onto the board, a charge
 * found on a haul, and the invoice. Each through its service and the route's
 * own parsing, and each says what it did, because none of them changes the
 * register in a way the eye catches.
 */

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function scheduleCollectionsAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const result = await rentalBilling.scheduleCollections(await ctx(), parsed(scheduleRentalCollections.input, {
      ...(field(form, "through") ? { through: field(form, "through") } : {}),
    }));
    const booked = result.scheduled.map((s) => `${s.assetIdentifier ?? "a can"} on ${s.collectOn} (job ${s.jobNumber})`);
    const skipped = result.skipped.map((s) => `${s.assetIdentifier ?? "a can"}: ${s.reason}`);
    return {
      message: [
        booked.length === 0 ? `Nothing else is due back by ${result.through}.` : `Put on the board: ${booked.join("; ")}.`,
        ...(skipped.length > 0 ? [`Left alone: ${skipped.join(" ")}`] : []),
      ].join(" "),
    };
  });
  if (state?.done) revalidatePath("/fleet/containers");
  return state;
}

export async function recordChargeAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const charge = await rentalBilling.recordCharge(await ctx(), {
      rentalId: String(form.get("rentalId") ?? ""),
      ...parsed(recordRentalCharge.input.omit({ id: true }), {
        kind: field(form, "kind"),
        priceBookItemId: field(form, "priceBookItemId") ?? null,
        description: field(form, "description") ?? null,
        ...(field(form, "quantity") ? { quantity: field(form, "quantity") } : {}),
        unitPrice: field(form, "unitPrice")?.replace(/[$,\s]/g, "") ?? null,
        note: field(form, "note") ?? null,
      }),
    });
    return { message: `Charged: ${charge.description}, ${Number(charge.amount).toFixed(2)}.` };
  });
  if (state?.done) revalidatePath("/fleet/containers");
  return state;
}

export async function removeChargeAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await rentalBilling.removeCharge(await ctx(), { id: String(form.get("id") ?? "") });
  });
  if (state?.done) revalidatePath("/fleet/containers");
  return state;
}

export async function invoiceHireAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const invoice = await rentalBilling.invoiceHire(await ctx(), { id: String(form.get("id") ?? "") });
    return { message: `Draft invoice ${invoice.invoiceNumber} raised for ${Number(invoice.total).toFixed(2)}, on Invoices to check and issue.` };
  });
  if (state?.done) revalidatePath("/fleet/containers");
  return state;
}
