import type { FieldQueue } from "./queue";

/**
 * WHEN A CONTAINER WAS PUT DOWN, AND WHEN ONE WAS EMPTIED
 *
 * The dumpster trade's turnaround is hours from a can emptied at the facility
 * to it placed on the next site, and both moments are the driver's: one at the
 * customer's kerb, one at the tipping floor, often with no signal. Each is a
 * tap on the stop, kept in the queue with the rest of the day and sent when
 * there is a signal. The hire is the subject and which moment is the field,
 * so tapping again replaces that time and leaves the other alone.
 */

export type HaulMoment = "placed" | "tipped";

/**
 * A clock time typed as "14:30" or "2:30 pm", on a day, as an instant in the
 * phone's own zone, or what is wrong in words. Empty means now.
 */
export function haulClock(typed: string, now: Date = new Date()): { ok: true; at: Date } | { ok: false; problem: string } {
  const text = typed.trim().toLowerCase();
  if (text === "") return { ok: true, at: now };
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!match) return { ok: false, problem: "Type the time like 14:30 or 2:30 pm, or leave it empty for now." };
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (match[3]) {
    if (hour < 1 || hour > 12) return { ok: false, problem: "With am or pm the hour is 1 to 12." };
    hour = (hour % 12) + (match[3] === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return { ok: false, problem: "That is not a time of day." };
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() > now.getTime() + 10 * 60_000) return { ok: false, problem: "That time has not come yet today." };
  return { ok: true, at };
}

/** Queue the moment a can was put down or emptied. */
export async function recordHaulTime(queue: FieldQueue, input: {
  rentalId: string; visitId: string; moment: HaulMoment; at: Date;
}) {
  return queue.enqueue({
    kind: "haul.time",
    subjectId: input.rentalId,
    payload: { field: input.moment, at: input.at.toISOString(), visitId: input.visitId },
  });
}
