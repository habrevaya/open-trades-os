"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { rentalBilling } from "@opentradesos/api/services";
import { applyScaleTickets, previewScaleTickets } from "@opentradesos/api/contracts";
import { parsed, refusalOf, refused, type FormState } from "@/lib/actions";

export type TicketState = (NonNullable<FormState> & {
  preview?: Awaited<ReturnType<typeof rentalBilling.previewTickets>>;
  applied?: Awaited<ReturnType<typeof rentalBilling.applyTickets>>;
}) | null;

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/** `POST /v1/scale-tickets/preview`: which haul each ticket weighed, with nothing written. */
export async function previewTicketsAction(_previous: TicketState, form: FormData): Promise<TicketState> {
  try {
    const preview = await rentalBilling.previewTickets(await ctx(), parsed(previewScaleTickets.input, { csv: String(form.get("csv") ?? "") }));
    return { preview };
  } catch (error) {
    const message = refusalOf(error);
    if (message === null) throw error;
    return refused(form, message);
  }
}

/** `POST /v1/scale-tickets/apply`, less every line the person unticked, worked out again inside the write. */
export async function applyTicketsAction(_previous: TicketState, form: FormData): Promise<TicketState> {
  try {
    const kept = new Set(form.getAll("keep").map(String));
    const skipLines = form.getAll("line").map(String).filter((line) => !kept.has(line)).map(Number);
    const applied = await rentalBilling.applyTickets(await ctx(),
      parsed(applyScaleTickets.input, { csv: String(form.get("csv") ?? ""), skipLines }));
    revalidatePath("/fleet/containers");
    return { done: true, applied };
  } catch (error) {
    const message = refusalOf(error);
    if (message === null) throw error;
    return refused(form, message);
  }
}
