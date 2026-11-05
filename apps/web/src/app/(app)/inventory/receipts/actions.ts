"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { landedCost } from "@opentradesos/api/services";
import { recordStockLateLandedCost } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

const money = (value: string | undefined) => (value ?? "").replace(/[$,\s]/g, "");
const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/**
 * A freight or duty bill for stock that came without an order. The service
 * spreads it onto the pieces that arrived and follows them to the shelf, the
 * job or the loss they went to, and refuses what it cannot account for.
 */
export async function stockLateBillAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const descriptions = form.getAll("lateDescription").map((v) => String(v).trim());
    const amounts = form.getAll("lateAmount").map((v) => money(String(v)));
    const charges = descriptions
      .map((description, i) => ({ description, amount: amounts[i] ?? "" }))
      .filter((c) => c.description !== "" || c.amount !== "");
    const basis = field(form, "basis");
    const bill = await landedCost.recordLateBill(await ctx(), {
      stockReceiptId: String(form.get("stockReceiptId") ?? ""),
      ...parsed(recordStockLateLandedCost.input.omit({ id: true }), {
        charges, ...(basis ? { basis } : {}), reference: field(form, "reference") ?? null,
      }),
    });
    const jobs = bill.jobs.map((j) => `job ${j.jobNumber ?? ""}`.trim()).join(", ");
    return {
      message: `Spread ${Number(bill.total).toFixed(2)}: ${Number(bill.onShelf).toFixed(2)} onto parts on a shelf, `
        + `${Number(bill.onJobs).toFixed(2)} onto ${jobs || "no jobs"}, ${Number(bill.onGone).toFixed(2)} onto stock already gone.`,
    };
  });
  if (state?.done) {
    revalidatePath("/inventory/receipts");
    revalidatePath("/inventory");
  }
  return state;
}
