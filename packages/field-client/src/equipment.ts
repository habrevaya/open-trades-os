import { field } from "@opentradesos/core";
import type { FieldQueue } from "./queue";

/**
 * A UNIT RECORDED ON SITE
 *
 * The technician in front of a furnace types what is on its plate. The
 * phone queues it like everything else and the server decides what it is,
 * against the whole company's register, with the office's rules
 * (`field.decideSerial` in core): the same unit at this address is updated,
 * a serial on file anywhere else is held for the office to answer, and
 * anything new is added.
 *
 * The phone cannot see the register while it is offline, so it cannot ask
 * "is this the unit at Elm Street?" itself. What it can do is say, for the
 * technician who has been told and knows, that this is a different unit
 * with the same plate.
 */

export interface UnitOnSite {
  /** The visit it was recorded on, so a problem names whose job. */
  visitId: string;
  propertyId: string;
  /** furnace, condenser, water heater: how a technician finds it on a list. */
  category: string;
  manufacturer?: string | undefined;
  model?: string | undefined;
  serialNumber?: string | undefined;
  /** Where in the house: "attic, north end". */
  location?: string | undefined;
  /** The technician says this is not the unit on file elsewhere with the same serial. */
  differentUnit?: boolean | undefined;
}

/** What the server is sent, trimmed, with nothing empty in it. Refuses a unit with no category. */
export function equipmentPayload(unit: UnitOnSite): Record<string, unknown> {
  const text = (value: string | undefined, max = 200) => {
    const trimmed = value?.trim() ?? "";
    return trimmed === "" ? undefined : trimmed.slice(0, max);
  };
  const category = text(unit.category, 80);
  if (!category) throw new RangeError("Say what the unit is: a furnace, a condenser, a water heater.");
  const payload: Record<string, unknown> = { visitId: unit.visitId, propertyId: unit.propertyId, category };
  for (const [key, value] of [
    ["manufacturer", text(unit.manufacturer)], ["model", text(unit.model)],
    ["serialNumber", text(unit.serialNumber, 80)], ["location", text(unit.location)],
  ] as const) {
    if (value !== undefined) payload[key] = value;
  }
  if (unit.differentUnit === true && payload["serialNumber"] !== undefined) payload["serialElsewhereConfirmed"] = true;
  return payload;
}

/**
 * Whether two serials as typed are the same plate, the way the server will
 * match them: "ab-1234 x" is "AB1234X". For a screen that wants to say a
 * unit already on this visit's list is the one being typed.
 */
export function sameSerial(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const key = field.serialKey(a);
  return key !== "" && key === field.serialKey(b);
}

/** The unit, into the queue. */
export async function recordEquipment(queue: FieldQueue, unit: UnitOnSite) {
  return queue.enqueue({ kind: "equipment.record", payload: equipmentPayload(unit) });
}
