"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inventory as inventoryService, stockUnits, stockReturns, ConflictError } from "@opentradesos/api/services";
import {
  issueStock, receiveStock, transferStock, setStockTracking, writeOffStockUnits, setTruckMinimum, restockTruck,
  numberStockUnits, returnStockFromJob,
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
    const result = await stockUnits.setTracking(await ctx(), parsed(setStockTracking.input, {
      itemId: field(form, "itemId"), mode: mode === "serial" || mode === "lot" ? mode : null,
    }));
    /** Units already on hand stay without numbers until somebody reads their labels: say where. */
    return result.unnumbered.length === 0
      ? { message: "Saved." }
      : {
        message: `Saved. ${result.unnumbered.map((u) => `${u.quantity} at ${u.locationName}`).join(", ")} `
          + "still need their numbers before they can be moved. Give them below.",
      };
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

/**
 * Numbers for units already on the shelf: every label read at one place.
 * A lot can say how many with "LOT-4471 x 10" on its line.
 */
export async function numberUnitsAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const units = String(form.get("units") ?? "").split(/\n|,|;/).map((line) => line.trim()).filter((line) => line !== "")
      .map((line) => {
        const [number, quantity] = line.split(/\s+x\s+/i).map((part) => part.trim());
        return { number: number ?? "", ...(quantity ? { quantity } : {}) };
      });
    const result = await stockUnits.numberUnits(await ctx(), parsed(numberStockUnits.input, {
      itemId: field(form, "itemId"), locationId: field(form, "locationId"), units,
    }));
    return {
      message: [
        result.numbered.length > 0 ? `Numbered ${result.numbered.join(", ")}.` : "No new numbers.",
        result.alreadyHere.length > 0 ? `Already on file here: ${result.alreadyHere.join(", ")}.` : "",
        result.stillUnnumbered !== "0" ? `${result.stillUnnumbered} here still ${result.stillUnnumbered === "1" ? "has" : "have"} no number.` : "",
      ].filter(Boolean).join(" "),
    };
  });
  if (state?.done) refresh();
  return state;
}

/** A serialised unit back off a job, by its number, onto the shelf or truck chosen. */
export async function returnFromJobAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const result = await stockReturns.returnFromJob(await ctx(), parsed(returnStockFromJob.input, {
      itemId: field(form, "itemId"),
      locationId: field(form, "locationId"),
      numbers: inv.parseSerialList(String(form.get("units") ?? "")),
      note: field(form, "note") ?? null,
    }));
    const said = result.returned.map((r) => `${r.number}${r.jobNumber ? ` off job ${r.jobNumber}` : ""}`).join(", ");
    const kept = result.equipmentStillOnRecord.length > 0
      ? ` The customer's equipment record is still on their register: retire it there if the unit came out.`
      : "";
    return { message: `Back in stock: ${said}.${kept}` };
  });
  if (state?.done) refresh();
  return state;
}
