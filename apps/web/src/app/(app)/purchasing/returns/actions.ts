"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { stockReturns } from "@opentradesos/api/services";
import { createVendorReturn, recordVendorCredit } from "@opentradesos/api/contracts";
import { inventory as inv } from "@opentradesos/core";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * SENDING UNITS BACK TO A VENDOR, and recording the credit when it comes,
 * through the services and the routes' own parsing.
 */

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });
const money = (value: string | undefined) => (value ?? "").replace(/[$,\s]/g, "");
const refresh = () => {
  revalidatePath("/purchasing/returns");
  revalidatePath("/inventory");
  revalidatePath("/inventory/serials");
};

export async function createReturnAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const numbers = inv.parseSerialList(String(form.get("units") ?? ""));
    const credit = money(field(form, "creditExpected"));
    const made = await stockReturns.createVendorReturn(await ctx(), parsed(createVendorReturn.input, {
      vendorId: field(form, "vendorId"),
      itemId: field(form, "itemId"),
      locationId: field(form, "locationId"),
      ...(numbers.length > 0 ? { units: numbers.map((number) => ({ number })) } : {}),
      quantity: field(form, "quantity") ?? null,
      reason: field(form, "reason") ?? "",
      reference: field(form, "reference") ?? null,
      creditExpected: credit || null,
    }));
    return { message: `Return ${made.number} to ${made.vendorName}: ${Number(made.creditExpected).toFixed(2)} of credit expected.` };
  });
  if (state?.done) refresh();
  return state;
}

export async function recordCreditAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const view = await stockReturns.recordVendorCredit(await ctx(), parsed(recordVendorCredit.input, {
      id: String(form.get("id") ?? ""),
      amount: money(field(form, "amount")),
      reference: field(form, "reference") ?? null,
    }));
    return { message: `Credit of ${Number(view.creditReceived).toFixed(2)} recorded on return ${view.number}.` };
  });
  if (state?.done) refresh();
  return state;
}
