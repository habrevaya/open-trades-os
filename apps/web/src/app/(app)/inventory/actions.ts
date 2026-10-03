"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inventory as inventoryService, stockUnits, ConflictError } from "@opentradesos/api/services";
import {
  issueStock, receiveStock, transferStock, setStockTracking, writeOffStockUnits, setTruckMinimum, restockTruck,
} from "@opentradesos/api/contracts";
import { inventory as inv } from "@opentradesos/core";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * EVERY STOCK MOVE FROM THE INVENTORY SCREENS, through the same services and
 * the same contract parsing as the API, so the screen is exactly as strict as
 * a scanner posting to `/v1/stock/*`. Nothing here decides anything: a part
 * tracked by serial that arrives without its numbers is refused by the
 * service, in its own words, and the boxes keep what was typed.
 */

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/** Serials or lots typed or scanned into one box, one per line or separated by commas. */
const unitsFrom = (form: FormData, name = "units") => {
  const numbers = inv.parseSerialList(String(form.get(name) ?? ""));
  return numbers.length === 0 ? undefined : numbers.map((number) => ({ number }));
};

const refresh = () => {
  revalidatePath("/inventory");
  revalidatePath("/inventory/serials");
  revalidatePath("/inventory/trucks");
};

export async function receiveStockAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const units = unitsFrom(form);
    const quantity = field(form, "quantity") ?? (units ? String(units.length) : "");
    await inventoryService.receive(await ctx(), parsed(receiveStock.input, {
      itemId: field(form, "itemId"),
      locationId: field(form, "locationId"),
      quantity,
      totalCost: (field(form, "totalCost") ?? "").replace(/[$,\s]/g, ""),
      ...(units ? { units } : {}),
    }));
    return { message: `Received ${quantity}${units ? `: ${units.map((u) => u.number).join(", ")}` : ""}.` };
  });
  if (state?.done) refresh();
  return state;
}

export async function transferStockAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const units = unitsFrom(form);
    const quantity = field(form, "quantity") ?? (units ? String(units.length) : "");
    await inventoryService.transfer(await ctx(), parsed(transferStock.input, {
      itemId: field(form, "itemId"),
      fromLocationId: field(form, "fromLocationId"),
      toLocationId: field(form, "toLocationId"),
      quantity,
      ...(units ? { units } : {}),
    }));
    return { message: `Moved ${quantity}.` };
  });
  if (state?.done) refresh();
  return state;
}

/**
 * A part used on a job, found by the job's number. A serialised unit can be
 * recorded as the customer's equipment at the job's address in the same go,
 * which is what lets it be traced from their basement back to the order.
 */
export async function useOnJobAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const context = await ctx();
    const number = Number(field(form, "jobNumber"));
    if (!Number.isInteger(number) || number < 1) throw new ConflictError("Give the job's number, as it is on the job.");
    const job = await stockUnits.jobByNumber(context, { number });
    const units = unitsFrom(form);
    const category = field(form, "installCategory");
    const install = category ? {
      category,
      ...(field(form, "installManufacturer") ? { manufacturer: field(form, "installManufacturer")! } : {}),
      ...(field(form, "installModel") ? { model: field(form, "installModel")! } : {}),
    } : undefined;
    const quantity = field(form, "quantity") ?? (units ? String(units.length) : "");
    await inventoryService.issue(context, parsed(issueStock.input, {
      itemId: field(form, "itemId"),
      locationId: field(form, "locationId"),
      jobId: job.id,
      quantity,
      ...(units ? { units: units.map((u) => ({ ...u, ...(install ? { installAs: install } : {}) })) } : {}),
    }));
    return { message: `Used ${quantity} on job ${job.number}${install ? `, recorded as the customer's ${install.category.toLowerCase()}` : ""}.` };
  });
  if (state?.done) refresh();
  return state;
}

export async function setTrackingAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const mode = field(form, "mode");
    await stockUnits.setTracking(await ctx(), parsed(setStockTracking.input, {
      itemId: field(form, "itemId"), mode: mode === "serial" || mode === "lot" ? mode : null,
    }));
  });
  if (state?.done) refresh();
  return state;
}

export async function writeOffAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const result = await stockUnits.writeOff(await ctx(), parsed(writeOffStockUnits.input, {
      itemId: field(form, "itemId"),
      locationId: field(form, "locationId"),
      reason: field(form, "reason") ?? "",
      units: unitsFrom(form) ?? [],
    }));
    return { message: `Wrote off ${result.written}.` };
  });
  if (state?.done) refresh();
  return state;
}

export async function setTruckMinimumAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await stockUnits.setTruckMinimum(await ctx(), parsed(setTruckMinimum.input, {
      itemId: field(form, "itemId"), locationId: field(form, "locationId"),
      minimum: field(form, "minimum"), target: field(form, "target"),
    }));
  });
  if (state?.done) refresh();
  return state;
}

export async function clearTruckMinimumAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await stockUnits.clearTruckMinimum(await ctx(), { id: String(form.get("id") ?? "") });
  });
  if (state?.done) refresh();
  return state;
}

export async function restockAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const units = unitsFrom(form);
    const result = await stockUnits.restock(await ctx(), parsed(restockTruck.input, {
      itemId: field(form, "itemId"), truckId: field(form, "truckId"),
      fromLocationId: field(form, "fromLocationId"), quantity: field(form, "quantity"),
      ...(units ? { units } : {}),
    }));
    return { message: `Moved ${result.moved} onto the truck.` };
  });
  if (state?.done) refresh();
  return state;
}
