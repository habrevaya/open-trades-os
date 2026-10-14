"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { equipment, ConflictError } from "@opentradesos/api/services";
import { moveEquipment, updateEquipment } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";
import { parseAttributeLines } from "@/lib/unit-attributes";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/**
 * Correct a unit from its own page, through `equipment.update`, which is what
 * `PATCH /v1/equipment/{id}` runs, parsed by that route's own schema so the
 * screen is exactly as strict as the API.
 *
 * The form is filled in with what is on file, so a box left empty is a detail
 * taken off, as a null is on the route. The address is not here: changing it
 * is a move, which is its own form below, because the move record is what says
 * where the old work happened.
 *
 * What it is inside, and its free form details, are here too. The picker always
 * sends, so no choice there is taking it out of what it was inside; the details
 * are the lines in the box, with anything the box cannot show kept as it was
 * (`parseAttributeLines`). Nesting a unit inside itself, or inside something it
 * already holds, is refused by the service in words.
 */
export async function editUnit(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "id") ?? "";
  const state = await attempt(form, async () => {
    const current = await equipment.get(await ctx(), { id });
    const details = parseAttributeLines(field(form, "attributes") ?? "", current.attributes as Record<string, unknown>);
    if (!details.ok) throw new ConflictError(details.error);
    const input = parsed(updateEquipment.input, {
      id,
      parentEquipmentId: field(form, "parentEquipmentId") ?? null,
      attributes: details.attributes,
      category: field(form, "category"),
      tag: field(form, "tag") ?? null,
      manufacturer: field(form, "manufacturer") ?? null,
      model: field(form, "model") ?? null,
      serialNumber: field(form, "serialNumber") ?? null,
      location: field(form, "location") ?? null,
      installedOn: field(form, "installedOn") ?? null,
      installedByUs: form.get("installedByUs") === "on",
      warrantyPartsExpiresOn: field(form, "warrantyPartsExpiresOn") ?? null,
      warrantyLaborExpiresOn: field(form, "warrantyLaborExpiresOn") ?? null,
    });
    await equipment.update(await ctx(), {
      id: input.id,
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.tag !== undefined ? { tag: input.tag } : {}),
      ...(input.manufacturer !== undefined ? { manufacturer: input.manufacturer } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.serialNumber !== undefined ? { serialNumber: input.serialNumber } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.installedOn !== undefined ? { installedOn: input.installedOn } : {}),
      ...(input.installedByUs !== undefined ? { installedByUs: input.installedByUs } : {}),
      ...(input.warrantyPartsExpiresOn !== undefined ? { warrantyPartsExpiresOn: input.warrantyPartsExpiresOn } : {}),
      ...(input.warrantyLaborExpiresOn !== undefined ? { warrantyLaborExpiresOn: input.warrantyLaborExpiresOn } : {}),
      ...(input.parentEquipmentId !== undefined ? { parentEquipmentId: input.parentEquipmentId } : {}),
      ...(input.attributes !== undefined ? { attributes: input.attributes } : {}),
    });
    return { message: "Saved." };
  });
  revalidatePath(`/equipment/${id}`);
  return state;
}

/**
 * Move a unit to another address, through `equipment.move`, which is what
 * `POST /v1/equipment/{id}/move` runs. Only the reasons that mean it went
 * somewhere are offered; a unit that was replaced or taken away is retired
 * from the address's register.
 */
export async function moveUnit(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "id") ?? "";
  const state = await attempt(form, async () => {
    const input = parsed(moveEquipment.input, {
      id,
      reason: field(form, "reason"),
      toPropertyId: field(form, "toPropertyId"),
      movedOn: field(form, "movedOn"),
      notes: field(form, "notes"),
    });
    const done = await equipment.move(await ctx(), {
      id: input.id, reason: input.reason,
      ...(input.toPropertyId ? { toPropertyId: input.toPropertyId } : {}),
      ...(input.movedOn ? { movedOn: input.movedOn } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    });
    return {
      message: done.unitsMoved > 1
        ? `Moved, with the ${done.unitsMoved - 1} ${done.unitsMoved === 2 ? "unit" : "units"} inside it.`
        : "Moved.",
    };
  });
  revalidatePath(`/equipment/${id}`);
  return state;
}
