"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { rentalBilling, timezoneOf, inTenant, ConflictError } from "@opentradesos/api/services";
import { time } from "@opentradesos/core";
import { recordRentalCharge, scheduleRentalCollections, setRentalDispatch } from "@opentradesos/api/contracts";
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

const minutesOf = (clock: string) => {
  const [h, m] = clock.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * The time the customer agreed for the collection: a day and a window in the
 * company's own clock, turned into instants here, or cleared. A collection
 * already on the board moves with it, and the message says what happened.
 */
export async function collectionTimeAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const context = await ctx();
    const id = String(form.get("id") ?? "");
    if (form.get("clear") === "yes") {
      await rentalBilling.setCollectionTime(context, { id, start: null, end: null });
      return { message: "The agreed time is cleared. The collection goes on the day the hire runs out." };
    }
    const day = field(form, "day");
    const from = field(form, "from") ?? "08:00";
    const to = field(form, "to") ?? "17:00";
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ConflictError("Choose the day the customer agreed.");
    const zone = await inTenant(context, (tx) => timezoneOf(tx, context.actor.organizationId));
    const result = await rentalBilling.setCollectionTime(context, {
      id,
      start: time.instantOfLocal(day, minutesOf(from), zone).toISOString(),
      end: time.instantOfLocal(day, minutesOf(to), zone).toISOString(),
    });
    return {
      message: result.moved === "kept"
        ? "Agreed. The collection on the board moved to that time and kept its driver."
        : result.moved === "returned_to_board"
          ? "Agreed. The collection moved to that day and is back on the board for somebody to take."
          : "Agreed. The collection will be booked at that time.",
    };
  });
  if (state?.done) revalidatePath("/fleet/containers");
  return state;
}

/** How collections are booked and how a driver's day is ordered. */
export async function rentalDispatchAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await rentalBilling.setRentalDispatch(await ctx(), parsed(setRentalDispatch.input, {
      automaticCollections: form.get("automaticCollections") === "on",
      collectionLeadDays: Number(field(form, "collectionLeadDays") ?? 1),
      containersPerTruck: Number(field(form, "containersPerTruck") ?? 1),
      yardMinutes: Number(field(form, "yardMinutes") ?? 20),
    }));
    return { message: "Saved." };
  });
  if (state?.done) revalidatePath("/fleet/containers");
  return state;
}
