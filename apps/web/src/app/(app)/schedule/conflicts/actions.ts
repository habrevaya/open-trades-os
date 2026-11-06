"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ConflictError, equipment, fieldOps } from "@opentradesos/api/services";
import { moveEquipment, resolveConflict } from "@opentradesos/api/contracts";
import { assertCan } from "@opentradesos/core";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });
const PATH = "/schedule/conflicts";

/** What the phone sent with a unit it was not allowed to add, read back from the conflict itself. */
async function heldUnit(c: Awaited<ReturnType<typeof ctx>>, id: string) {
  const { data } = await fieldOps.conflicts(c, { limit: 200, includeResolved: false });
  const conflict = data.find((d) => d.id === id);
  if (!conflict) throw new ConflictError("That conflict is not waiting any more. Somebody may have dealt with it.");
  if (conflict.kind !== "equipment.record") throw new ConflictError("That conflict is not about a unit.");
  return conflict.payload;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/**
 * THE FIELD CONFLICTS LIST'S ANSWERS.
 *
 * `resolve` is `POST /v1/field/conflicts/{id}/resolve` (`visit:write`), with
 * the note the office typed. The two answers to a unit the phone could not add
 * do the office's own call first and then resolve, and both permissions are
 * checked before anything is written, so nobody is left with a unit moved and
 * the conflict still waiting because they could do one and not the other:
 *
 *   move  `POST /v1/equipment/{id}/move` (`equipment:write`): the unit on file
 *         is the one the technician found, so it moves here with its history.
 *   add   `POST /v1/equipment` (`equipment:write`) with the details the phone
 *         sent, confirmed as a different unit with the same serial.
 */
export async function actOnConflict(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "id") ?? "";
  const result = await attempt(form, async () => {
    const c = await ctx();
    const op = field(form, "op");
    const note = field(form, "note");
    if (op === "move" || op === "add") {
      assertCan(c.actor, "visit:write");
      assertCan(c.actor, "equipment:write");
    }
    switch (op) {
      case "resolve":
        await fieldOps.resolve(c, parsed(resolveConflict.input, { id, ...(note ? { note } : {}) }));
        return { message: "Marked as dealt with." };
      case "move": {
        const payload = await heldUnit(c, id);
        const propertyId = text(payload["propertyId"]);
        if (!propertyId) throw new ConflictError("The phone named no address for that unit.");
        await equipment.move(c, parsed(moveEquipment.input, {
          id: field(form, "equipmentId"), reason: "relocated", toPropertyId: propertyId,
          notes: "Found here by the technician. Moved from the field conflicts list.",
        }));
        await fieldOps.resolve(c, parsed(resolveConflict.input, {
          id, note: note ?? "The unit on file was moved to this address.",
        }));
        return { message: "Moved here, and marked as dealt with." };
      }
      case "add": {
        const payload = await heldUnit(c, id);
        const propertyId = text(payload["propertyId"]);
        if (!propertyId) throw new ConflictError("The phone named no address for that unit.");
        const attributes = payload["attributes"];
        await equipment.register(c, {
          propertyId,
          category: text(payload["category"]) ?? "other",
          manufacturer: text(payload["manufacturer"]),
          model: text(payload["model"]),
          serialNumber: text(payload["serialNumber"]),
          location: text(payload["location"]),
          ...(attributes && typeof attributes === "object" ? { attributes: attributes as Record<string, unknown> } : {}),
          serialElsewhereConfirmed: true,
        });
        await fieldOps.resolve(c, parsed(resolveConflict.input, {
          id, note: note ?? "Added as a different unit with the same serial.",
        }));
        return { message: "Added at this address, and marked as dealt with." };
      }
      default:
        throw new Error("Unknown conflict operation");
    }
  });
  revalidatePath(PATH);
  return result;
}
