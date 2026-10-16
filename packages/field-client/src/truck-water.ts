import type { FieldQueue } from "./queue";

/**
 * THE FRESH WATER A TRUCK USED TODAY, READ BY ITS DRIVER
 *
 * The trash bin trade's fresh water per stop is a truck's water over its
 * stops, per truck, because one truck drifting upward is a nozzle or a burner
 * going. The driver reads the tank at the end of the day (or the fill meter)
 * and records it here, with no signal if need be. One figure per truck per
 * day: recording it again replaces it, and the later reading stands.
 */

/** No truck carries this much in a day; the server refuses it too. */
export const MOST_GALLONS_IN_A_DAY = 5000;

/** The gallons as typed, checked the way the server checks them, or what is wrong in words. */
export function checkGallons(typed: string): { ok: true; gallons: string } | { ok: false; problem: string } {
  const text = typed.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return { ok: false, problem: "Type the gallons as a number, for example 410." };
  if (Number(text) > MOST_GALLONS_IN_A_DAY) {
    return { ok: false, problem: `${text} gallons is more than a truck uses in a day. Check the figure and type it again.` };
  }
  return { ok: true, gallons: text };
}

/**
 * Queue a day's reading for a truck. The day is the reading's `field`, so a
 * second reading of the same day supersedes the first on the server and a
 * reading of another day does not.
 */
export async function recordWater(queue: FieldQueue, input: { assetId: string; onDay: string; gallons: string; at?: Date | undefined }) {
  return queue.enqueue({
    kind: "truck.water",
    subjectId: input.assetId,
    occurredAt: input.at ?? new Date(),
    payload: { field: input.onDay, onDay: input.onDay, gallons: input.gallons },
  });
}
