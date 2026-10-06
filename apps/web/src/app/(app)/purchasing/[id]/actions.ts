"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inventory, landedCost, purchaseAcknowledgements, purchaseApprovals, purchaseOrderEmail } from "@opentradesos/api/services";
import {
  decidePurchaseOrder, editPurchaseOrder, emailPurchaseOrder, receivePurchaseOrder, recordLateLandedCost,
} from "@opentradesos/api/contracts";
import { inventory as inv } from "@opentradesos/core";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * ONE ORDER: changing it while it is a draft, deciding its approval step,
 * receiving a delivery against it with the freight that came on the truck,
 * a freight bill that came later, and emailing it to the vendor. Each is the
 * service's call through the route's own parsing.
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

const money = (value: string | undefined) => (value ?? "").replace(/[$,\s]/g, "");

/**
 * The order's lines as the form left them: each existing line with its new
 * quantity and price (0 takes it off), and a part added by number.
 */
export async function editAction(_previous: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("id") ?? "");
  const state = await attempt(form, async () => {
    const lines: { itemId?: string; partNumber?: string; locationId?: string; quantity: string; unitPrice?: string }[] = [];
    for (const lineId of form.getAll("lineId").map(String)) {
      const quantity = field(form, `quantity:${lineId}`) ?? "0";
      if (Number(quantity) === 0) continue;
      const price = money(field(form, `price:${lineId}`));
      lines.push({
        itemId: String(form.get(`item:${lineId}`) ?? ""),
        locationId: String(form.get(`location:${lineId}`) ?? ""),
        quantity,
        ...(price ? { unitPrice: price } : {}),
      });
    }
    const added = field(form, "addPart");
    if (added) {
      const price = money(field(form, "addPrice"));
      lines.push({ partNumber: added, quantity: field(form, "addQuantity") ?? "", ...(price ? { unitPrice: price } : {}) });
    }
    const result = await inventory.handlers.editPurchaseOrder(await ctx(), parsed(editPurchaseOrder.input, { id, lines }));
    return { message: `Saved. ${result.approval}` };
  });
  if (state?.done) refresh(id);
  return state;
}

/** A freight or duty bill for one delivery, with up to two charges as the bill shows them. */
export async function lateBillAction(_previous: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("id") ?? "");
  const state = await attempt(form, async () => {
    const descriptions = form.getAll("lateDescription").map((v) => String(v).trim());
    const amounts = form.getAll("lateAmount").map((v) => money(String(v)));
    const charges = descriptions
      .map((description, i) => ({ description, amount: amounts[i] ?? "" }))
      .filter((c) => c.description !== "" || c.amount !== "");
    const basis = field(form, "basis");
    const bill = await landedCost.recordLateBill(await ctx(), {
      receiptId: String(form.get("receiptId") ?? ""),
      ...parsed(recordLateLandedCost.input.omit({ id: true }), {
        charges, ...(basis ? { basis } : {}), reference: field(form, "reference") ?? null,
      }),
    });
    const jobs = bill.jobs.map((j) => `job ${j.jobNumber ?? ""}`.trim()).join(", ");
    return {
      message: `Spread ${Number(bill.total).toFixed(2)}: ${Number(bill.onShelf).toFixed(2)} onto parts on a shelf, `
        + `${Number(bill.onJobs).toFixed(2)} onto ${jobs || "no jobs"}, ${Number(bill.onGone).toFixed(2)} onto stock already gone.`,
    };
  });
  if (state?.done) refresh(id);
  return state;
}

/**
 * What the vendor said back, written down by hand from their reply. The
 * service decides what is refused: a draft that was never sent, a finished
 * order, a promise dated before the order went, and a repeat that says
 * nothing new.
 */
export async function replyAction(_previous: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("id") ?? "");
  const state = await attempt(form, async () => {
    const done = await purchaseAcknowledgements.record(await ctx(), {
      id,
      promisedOn: field(form, "promisedOn") ?? null,
      reference: field(form, "reference") ?? null,
      note: field(form, "note") ?? null,
    });
    return {
      message: done.promisedOn
        ? `Written down. They promised it by ${done.promisedOn}.`
        : "Written down. Add the day they promised it by when they give one.",
    };
  });
  if (state?.done) refresh(id);
  return state;
}
