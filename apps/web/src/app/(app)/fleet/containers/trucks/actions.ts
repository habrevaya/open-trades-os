"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { trucks } from "@opentradesos/api/services";
import { createTruckKind } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * KINDS OF TRUCK: what each carries, which sizes it lifts and how long the yard
 * takes it, and which kind each vehicle is. Each through its service, so the
 * refusals are the service's own.
 */

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/** "10, 20 and 30" or "10 20 30" as the sizes a truck lifts. */
const sizesOf = (text: string | undefined): number[] =>
  (text ?? "").split(/[^0-9.]+/).filter((part) => part !== "").map(Number);

export async function addKindAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const kind = await trucks.createKind(await ctx(), parsed(createTruckKind.input, {
      name: field(form, "name") ?? "",
      containersCarried: Number(field(form, "containersCarried") ?? 1),
      containerSizes: sizesOf(field(form, "containerSizes")),
      yardMinutes: Number(field(form, "yardMinutes") ?? 20),
    }));
    return { message: `Added ${kind.name}. Give it to a truck below.` };
  });
  if (state?.done) revalidatePath("/fleet/containers/trucks");
  return state;
}

export async function changeKindAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await trucks.updateKind(await ctx(), {
      id: String(form.get("id") ?? ""),
      containersCarried: Number(field(form, "containersCarried") ?? 1),
      containerSizes: sizesOf(field(form, "containerSizes")),
      yardMinutes: Number(field(form, "yardMinutes") ?? 20),
    });
    return { message: "Saved." };
  });
  if (state?.done) revalidatePath("/fleet/containers/trucks");
  return state;
}

export async function retireKindAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await trucks.retireKind(await ctx(), { id: String(form.get("id") ?? "") });
  });
  if (state?.done) revalidatePath("/fleet/containers/trucks");
  return state;
}

export async function truckKindAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const kindId = field(form, "truckKindId");
    const truck = await trucks.setTruckKind(await ctx(), { assetId: String(form.get("assetId") ?? ""), truckKindId: kindId ?? null });
    return { message: kindId ? `${truck.label} is planned on that kind.` : `${truck.label} is planned on the company's figures.` };
  });
  if (state?.done) revalidatePath("/fleet/containers/trucks");
  return state;
}
