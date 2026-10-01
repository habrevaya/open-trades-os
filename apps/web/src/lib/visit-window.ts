import { time } from "@opentradesos/core";

/**
 * A VISIT'S WINDOW, FROM WHAT A PERSON TYPES
 *
 * The office types a day, the time the technician can arrive from, and how
 * long the arrival window is ("between nine and eleven"). Those are wall
 * clock values in the COMPANY's zone, never the server's or the browser's: a
 * dispatcher in Denver booking for a customer in Austin promises the
 * customer an Austin time, and reading it in any other zone books a
 * different appointment from the one said on the phone.
 *
 * Pure, so the arithmetic is tested without a form: a day and a time are
 * turned into an instant by the same function the agreements and timesheet
 * modules use, which already knows what to do with the hour that happens
 * twice when the clocks go back.
 */
export interface WindowInput {
  /** YYYY-MM-DD, from a date input. Empty means no visit yet. */
  date?: string | undefined;
  /** HH:MM, from a time input. */
  start?: string | undefined;
  /** How many hours the arrival window is. */
  windowHours?: string | undefined;
}

export type WindowResult =
  | { kind: "none" }
  | { kind: "window"; windowStart: string; windowEnd: string }
  | { kind: "invalid"; message: string };

export function windowFrom(input: WindowInput, timeZone: string): WindowResult {
  const date = input.date?.trim() ?? "";
  const start = input.start?.trim() ?? "";
  /**
   * No day is no visit, whatever the time box says: the time has a default,
   * and a person clearing the day to book a lead should not then be asked
   * to clear the time as well.
   */
  if (date === "") return { kind: "none" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { kind: "invalid", message: "Pick the day of the visit." };
  const match = /^(\d{1,2}):(\d{2})$/.exec(start);
  if (!match) return { kind: "invalid", message: "Say what time the technician can arrive from." };
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes >= 24 * 60 || Number(match[2]) >= 60) {
    return { kind: "invalid", message: "That is not a time of day." };
  }
  if (!time.wallTimeExists(date, minutes, timeZone)) {
    return { kind: "invalid", message: "The clocks go forward over that time, so it does not happen that day. Pick another." };
  }
  const hours = Number(input.windowHours ?? "2");
  if (!Number.isFinite(hours) || hours <= 0 || hours > 12) {
    return { kind: "invalid", message: "An arrival window is between a few minutes and twelve hours." };
  }
  const windowStart = time.instantOfLocal(date, minutes, timeZone);
  const windowEnd = new Date(windowStart.getTime() + hours * 3_600_000);
  return { kind: "window", windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() };
}

/** The arrival windows offered, in hours. */
export const WINDOW_HOURS = [
  { value: "1", label: "1 hour" },
  { value: "2", label: "2 hours" },
  { value: "3", label: "3 hours" },
  { value: "4", label: "4 hours" },
  { value: "8", label: "All day" },
] as const;
