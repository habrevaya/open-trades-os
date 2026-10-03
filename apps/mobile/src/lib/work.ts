import type { DayReportField, PriceBookEntry } from "@opentradesos/field-client";

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
