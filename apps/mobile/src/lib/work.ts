import type { DayPartAsked, DayReportField, PriceBookEntry } from "@opentradesos/field-client";

/**
 * THE WORK RECORDED ON A VISIT, WITHOUT THE SCREEN
 *
 * Small rules the visit screen applies before anything goes into the queue,
 * tested without a phone: how many of a part, which price book items match
 * what was typed, and which readings the office asked for are still empty.
 */

/**
 * A quantity typed with a thumb, as the decimal string a job line stores, or
 * null. Up to two places, because "1.5" hours of a part is a thing and
 * "1.333" is a typo.
 */
export function parseQuantity(typed: string): string | null {
  const text = typed.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  return /[1-9]/.test(text) ? text : null;
}

/**
 * Price book items that match what was typed: by code first, then by every
 * word in the name, so "cap 45" finds "Capacitor 45/5 MFD". At most `limit`,
 * because a phone list longer than a screen is a list nobody reads.
 */
export function searchPriceBook(items: readonly PriceBookEntry[], query: string, limit = 8): PriceBookEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const byCode = items.filter((i) => i.code && i.code.toLowerCase() === words.join(" "));
  const byName = items.filter((i) => !byCode.includes(i)
    && words.every((w) => i.name.toLowerCase().includes(w) || (i.code ?? "").toLowerCase().includes(w)));
  return [...byCode, ...byName].slice(0, limit);
}

/** The required readings with nothing in them, by label, said before the report is sent. */
export function missingReadings(fields: readonly Pick<DayReportField, "label" | "required" | "value">[]): string[] {
  return fields.filter((f) => f.required && (f.value === null || f.value.trim() === "")).map((f) => f.label);
}

/**
 * The tasks with the one a notice was about first, and what to say when it is
 * not among them. A task the phone does not hold yet (it was given to the
 * person a moment ago and the day has not been fetched) is `missing`, which the
 * screen says while a fetch is under way and turns into a way to open it in
 * the browser once it is not.
 */
export function withFocus<T extends { id: string }>(
  tasks: readonly T[], taskId: string | null,
): { focused: T | null; rest: T[]; missing: boolean } {
  const focused = taskId ? tasks.find((t) => t.id === taskId) ?? null : null;
  return { focused, rest: tasks.filter((t) => t !== focused), missing: taskId !== null && focused === null };
}

/**
 * A part asked for on the job, as the visit screen lists it: the words, then
 * where it is. "Waiting to send" while it is still on the phone, then with the
 * office until the office has put the job on hold for it against the order.
 */
export function partAskedLine(asked: Pick<DayPartAsked, "part" | "held" | "waiting">): string {
  const where = asked.waiting ? "waiting to send"
    : asked.held ? "ordered, and the job is on hold for it"
    : "with the office";
  return `${asked.part}: ${where}`;
}
