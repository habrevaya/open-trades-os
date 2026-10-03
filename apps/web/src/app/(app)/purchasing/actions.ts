"use server";

import { refused, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inventory, ConflictError, NotFoundError } from "@opentradesos/api/services";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

type Result = NonNullable<FormState>;

async function caught(
  form: FormData,
  fn: (context: Awaited<ReturnType<typeof ctx>>) => Promise<unknown>,
): Promise<Result> {
  try {
    await fn(await ctx());
    revalidatePath("/purchasing");
    return { done: true };
  } catch (error) {
    if (error instanceof ConflictError || error instanceof NotFoundError) {
      return refused(form, error.message);
    }
    throw error;
  }
}

export async function addVendor(_previous: unknown, form: FormData): Promise<Result> {
  return caught(form, (context) => inventory.createVendor(context, {
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
    .filter((line) => line.quantity !== "")
    /** An empty price is the vendor's own on record, looked up by the service. */
    .map(({ index: _index, unitPrice, ...line }) => ({ ...line, ...(unitPrice !== "" ? { unitPrice } : {}) }));

  if (lines.length === 0) {
    return refused(form, "Tick at least one line, and give it a quantity.");
  }

  const first = lines[0]!;
  return caught(form, (context) => inventory.createPurchaseOrder(context, {
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
  return caught(form, (context) => inventory.setPurchaseOrderStatus(context, {
    id: String(form.get("id") ?? ""),
    status: status as Parameters<typeof inventory.setPurchaseOrderStatus>[1]["status"],
  }));
}

/**
 * An order written line by line from part numbers, each looked up for the
 * chosen vendor by the service rather than trusted from the screen.
 */
export async function orderParts(_previous: unknown, form: FormData): Promise<Result> {
  const parts = form.getAll("partNumber").map((v) => String(v).trim());
  const quantities = form.getAll("partQuantity").map((v) => String(v).trim());
  const prices = form.getAll("partPrice").map((v) => String(v).trim().replace(/[$,\s]/g, ""));
  const lines = parts
    .map((partNumber, i) => ({ partNumber, quantity: quantities[i] ?? "", unitPrice: prices[i] ?? "" }))
    .filter((line) => line.partNumber !== "")
    .map((line) => ({
      partNumber: line.partNumber,
      quantity: line.quantity === "" ? "1" : line.quantity,
      ...(line.unitPrice !== "" ? { unitPrice: line.unitPrice } : {}),
    }));
  if (lines.length === 0) return refused(form, "Give at least one part number.");
  const locationId = String(form.get("locationId") ?? "");
  return caught(form, (context) => inventory.createPurchaseOrder(context, {
    vendorId: String(form.get("vendorId") ?? ""),
    defaultLocationId: locationId,
    lines: lines.map((line) => ({ ...line, locationId })),
  }));
}
