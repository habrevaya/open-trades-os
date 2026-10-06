"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inventory, purchaseApprovals, purchaseOrderEmail } from "@opentradesos/api/services";
import { decidePurchaseOrder, emailPurchaseOrder, receivePurchaseOrder } from "@opentradesos/api/contracts";
import { inventory as inv } from "@opentradesos/core";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * ONE ORDER: deciding its approval step, receiving a delivery against it with
 * the freight that came on the truck, and emailing it to the vendor. Each is
 * the service's call through the route's own parsing.
 */

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });
const refresh = (id: string) => {
  revalidatePath(`/purchasing/${id}`);
  revalidatePath("/purchasing");
  revalidatePath("/inventory");
};

export async function decideAction(_previous: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("id") ?? "");
  const state = await attempt(form, async () => {
    const view = await purchaseApprovals.decide(await ctx(), parsed(decidePurchaseOrder.input, {
      id, decision: field(form, "decision"), note: field(form, "note") ?? null,
    }));
    return { message: view.sentence };
  });
  if (state?.done) refresh(id);
  return state;
}

/**
 * A delivery: each line's quantity as typed (blank lines did not arrive), the
 * serials for a tracked line, and the freight and fees on the vendor's bill.
 */
export async function receiveAction(_previous: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("id") ?? "");
  const state = await attempt(form, async () => {
    const lineIds = form.getAll("lineId").map(String);
    const lines = lineIds.map((lineId) => {
      const quantity = field(form, `quantity:${lineId}`);
      const numbers = inv.parseSerialList(String(form.get(`units:${lineId}`) ?? ""));
      return {
        lineId,
        quantity: quantity ?? (numbers.length > 0 ? String(numbers.length) : ""),
        ...(numbers.length > 0 ? { units: numbers.map((number) => ({ number })) } : {}),
      };
    }).filter((line) => line.quantity !== "" && line.quantity !== "0");
    const descriptions = form.getAll("chargeDescription").map((v) => String(v).trim());
    const amounts = form.getAll("chargeAmount").map((v) => String(v).trim().replace(/[$,\s]/g, ""));
    const charges = descriptions
      .map((description, i) => ({ description, amount: amounts[i] ?? "" }))
      .filter((c) => c.description !== "" || c.amount !== "");
    const result = await inventory.receivePurchaseOrder(await ctx(), {
      purchaseOrderId: id,
      ...parsed(receivePurchaseOrder.input.omit({ id: true }), {
        lines, charges, basis: field(form, "basis") ?? "value",
      }),
    });
    return {
      message: `Received. The order is ${result.status.replace(/_/g, " ")}`
        + `${Number(result.chargesTotal) > 0 ? `, with ${Number(result.chargesTotal).toFixed(2)} of charges spread into the cost` : ""}.`,
    };
  });
  if (state?.done) refresh(id);
  return state;
}

export async function emailAction(_previous: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("id") ?? "");
  const state = await attempt(form, async () => {
    const sent = await purchaseOrderEmail.emailOrder(await ctx(), parsed(emailPurchaseOrder.input, {
      id, to: field(form, "to") ?? null, message: field(form, "message") ?? null,
    }));
    return {
      message: sent.state === "queued"
        ? `Queued to ${sent.destination}. It leaves with the next pass of the outbox.`
        : `Not sent to ${sent.destination}: ${sent.explanation ?? "the mail path would not take it"}`,
    };
  });
  if (state?.done) refresh(id);
  return state;
}
