"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { disposalFacilities, ConflictError } from "@opentradesos/api/services";
import { createDisposalFacility } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * DISPOSAL FACILITIES: the address, the week it takes loads, what it charges,
 * and the pin. Each through its service, so the refusals are the service's own.
 */

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The seven pairs of boxes as a list of days: a day with both filled is a day it takes loads. */
function hoursOf(form: FormData) {
  const hours: { day: number; opens: string; closes: string }[] = [];
  for (let day = 0; day < 7; day++) {
    const opens = field(form, `opens${day}`);
    const closes = field(form, `closes${day}`);
    if (!opens && !closes) continue;
    if (!opens || !closes) throw new ConflictError(`${DAYS[day]}: give both the time it opens and the time it closes, or leave both empty for a day it is closed.`);
    hours.push({ day, opens, closes });
  }
  return hours;
}

/**
 * The two boxes of closed days as a list: "2026-11-26 Thanksgiving" lines, and
 * "12-25 Christmas" lines that repeat every year (kept with the leap year 2000
 * so 02-29 is a real date). A line that is not a date is refused by the service
 * in words that name it.
 */
function holidaysOf(form: FormData) {
  const lines = (name: string) => String(form.get(name) ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const split = (line: string) => {
    const [date = "", ...rest] = line.split(/\s+/);
    return { date, name: rest.join(" ") || null };
  };
  return [
    ...lines("holidaysOnce").map((line) => ({ ...split(line), yearly: false })),
    ...lines("holidaysYearly").map((line) => {
      const { date, name } = split(line);
      return { date: /^\d{2}-\d{2}$/.test(date) ? `2000-${date}` : date, name, yearly: true };
    }),
  ];
}

/** What the form says about the rate, with a rate left empty meaning none recorded. */
function rateOf(form: FormData) {
  const basis = field(form, "feeBasis");
  const amount = field(form, "feeAmount")?.replace(/[$,\s]/g, "");
  const minimum = field(form, "minimumFee")?.replace(/[$,\s]/g, "");
  return {
    feeBasis: basis === "per_ton" ? ("per_ton" as const) : basis === "per_load" ? ("per_load" as const) : null,
    feeAmount: amount ?? null,
    minimumFee: minimum ?? null,
  };
}

export async function addFacilityAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const facility = await disposalFacilities.createFacility(await ctx(), parsed(createDisposalFacility.input, {
      name: field(form, "name") ?? "",
      addressLine1: field(form, "addressLine1") ?? null,
      city: field(form, "city") ?? null,
      state: field(form, "state") ?? null,
      postalCode: field(form, "postalCode") ?? null,
      hours: hoursOf(form),
      holidays: holidaysOf(form),
      ...rateOf(form),
      tipMinutes: Number(field(form, "tipMinutes") ?? 20),
    }));
    return { message: `Added ${facility.name}.${facility.address ? " It goes on the map shortly." : ""}` };
  });
  if (state?.done) revalidatePath("/fleet/containers/facilities");
  return state;
}

export async function changeFacilityAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await disposalFacilities.updateFacility(await ctx(), {
      id: String(form.get("id") ?? ""),
      addressLine1: field(form, "addressLine1") ?? null,
      city: field(form, "city") ?? null,
      state: field(form, "state") ?? null,
      postalCode: field(form, "postalCode") ?? null,
      hours: hoursOf(form),
      holidays: holidaysOf(form),
      ...rateOf(form),
      tipMinutes: Number(field(form, "tipMinutes") ?? 20),
    });
    return { message: "Saved." };
  });
  if (state?.done) revalidatePath("/fleet/containers/facilities");
  return state;
}

export async function defaultFacilityAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await disposalFacilities.updateFacility(await ctx(), { id: String(form.get("id") ?? ""), isDefault: true });
    return { message: "Days are planned through this one from now on." };
  });
  if (state?.done) revalidatePath("/fleet/containers/facilities");
  return state;
}

export async function closeFacilityAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await disposalFacilities.closeFacility(await ctx(), { id: String(form.get("id") ?? "") });
  });
  if (state?.done) revalidatePath("/fleet/containers/facilities");
  return state;
}

export async function pinFacilityAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const id = String(form.get("id") ?? "");
    if (form.get("clear") === "yes") {
      await disposalFacilities.unpinFacility(await ctx(), { id });
      return { message: "The pin is taken off. It goes back on the map from the address." };
    }
    const latitude = Number(field(form, "latitude"));
    const longitude = Number(field(form, "longitude"));
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new ConflictError("Give the latitude and the longitude of the gate, like 30.2672 and -97.7431.");
    }
    await disposalFacilities.pinFacility(await ctx(), { id, latitude, longitude });
    return { message: "Pinned." };
  });
  if (state?.done) revalidatePath("/fleet/containers/facilities");
  return state;
}
