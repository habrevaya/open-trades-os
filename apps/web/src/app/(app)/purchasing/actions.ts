"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inventory, ConflictError, NotFoundError } from "@opentradesos/api/services";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

type Result = { done?: boolean; error?: string };

async function caught(
  fn: (context: Awaited<ReturnType<typeof ctx>>) => Promise<unknown>,
): Promise<Result> {
  try {
    await fn(await ctx());
    revalidatePath("/purchasing");
    return { done: true };
  } catch (error) {
    if (error instanceof ConflictError || error instanceof NotFoundError) {
      return { error: error.message };
    }
    throw error;
  }
}

export async function addVendor(_previous: unknown, form: FormData): Promise<Result> {
  return caught((context) => inventory.createVendor(context, {
    name: String(form.get("name") ?? ""),
    accountNumber: String(form.get("accountNumber") ?? ""),
    email: String(form.get("email") ?? ""),
    phone: String(form.get("phone") ?? ""),
  }));
}

/**
 * An order built from the suggestions a person ticked.
 *
 * Suggestions are advice and an order is a commitment, so nothing here places
 * one automatically. A system that did would be buying stock on the strength
 * of a reorder point nobody has revisited since the day it was typed.
 */
export async function placeOrder(_previous: unknown, form: FormData): Promise<Result> {
  const items = form.getAll("lineItem").map(String);
  const locations = form.getAll("lineLocation").map(String);
  const quantities = form.getAll("lineQuantity").map(String);
  const prices = form.getAll("linePrice").map(String);
  const picked = new Set(form.getAll("pick").map(String));

  const lines = items
    .map((itemId, i) => ({
      index: String(i),
      itemId,
      locationId: locations[i] ?? "",
      quantity: (quantities[i] ?? "").trim(),
      unitPrice: (prices[i] ?? "").trim(),
    }))
    .filter((line) => picked.has(line.index))
    .filter((line) => line.quantity !== "" && line.unitPrice !== "")
    .map(({ index: _index, ...line }) => line);

  if (lines.length === 0) {
    return { error: "Tick at least one line, and give it a quantity and a price." };
  }

  const first = lines[0]!;
  return caught((context) => inventory.createPurchaseOrder(context, {
    vendorId: String(form.get("vendorId") ?? ""),
    /**
     * The first picked line's location is the order's default, and every
     * line still carries its own. A vendor who drops half the delivery at
     * the shop and half onto a van is ordinary, and one address on the order
     * means somebody receives it all to the warehouse and transfers the rest,
     * or simply does not.
     */
    defaultLocationId: first.locationId,
    lines,
  }));
}

export async function advanceOrder(_previous: unknown, form: FormData): Promise<Result> {
  const status = String(form.get("status") ?? "");
  return caught((context) => inventory.setPurchaseOrderStatus(context, {
    id: String(form.get("id") ?? ""),
    status: status as Parameters<typeof inventory.setPurchaseOrderStatus>[1]["status"],
  }));
}
