import * as m from "../money/index.js";

/**
 * A DISPOSAL FACILITY: WHEN IT TAKES A LOAD, AND WHAT IT CHARGES FOR ONE
 *
 * A landfill or a transfer station is not the yard. The truck has to reach it
 * while it is open, it weighs the load, and it charges for it by the ton or by
 * the load, which is the largest cost line in this trade. This is the pure
 * half: the week's hours and what a closed gate means in words, and the fee a
 * weighed load comes to under the facility's rate.
 *
 * HOURS ARE A WEEK, NOT A DAY. A transfer station open 7 to 4:30 on weekdays
 * and 8 to noon on Saturday is the ordinary case, and a single pair of times
 * cannot say it. A day not listed is a day it is closed. No hours at all means
 * the company has not recorded them, which is "unknown" and never "closed":
 * refusing every trip to a facility because nobody typed its hours would be
 * a planner that stops working the day somebody adds one.
 *
 * Holidays are not here. A facility closed for Thanksgiving looks open to this
 * on that Thursday, which the doc says.
 */

export interface DayHours {
  /** 0 is Sunday, as everywhere else in this product. */
  day: number;
  /** "07:00", local to the facility, which is the company's own zone. */
  opens: string;
  closes: string;
}

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** The day of the week of a calendar date, 0 for Sunday. */
export const weekdayOf = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay();

/** Minutes after midnight for "HH:MM", or null when it is not a time. */
export function minuteOf(clock: string): number | null {
  const found = CLOCK.exec(clock);
  return found ? Number(found[1]) * 60 + Number(found[2]) : null;
}

/** "7:00 AM", "12:00 PM" from minutes after midnight. */
export function clockWords(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const mm = minutes % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mm).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * The hours as typed, checked: each day once, a real time at each end, and
 * it opens before it closes. The sentence says which day is wrong, because a
 * seven day form with one bad row otherwise says only "invalid".
 */
export function checkHours(input: readonly DayHours[]):
  { ok: true; hours: DayHours[] } | { ok: false; message: string } {
  const seen = new Set<number>();
  for (const entry of input) {
    const name = WEEKDAYS[entry.day] ?? "That day";
    if (!Number.isInteger(entry.day) || entry.day < 0 || entry.day > 6) {
      return { ok: false, message: "A day of the week is 0 for Sunday to 6 for Saturday." };
    }
    if (seen.has(entry.day)) return { ok: false, message: `${name} is listed twice.` };
    seen.add(entry.day);
    const opens = minuteOf(entry.opens);
    const closes = minuteOf(entry.closes);
    if (opens === null || closes === null) {
      return { ok: false, message: `${name}: give the opening and closing time as hours and minutes, like 07:00 and 16:30.` };
    }
    if (closes <= opens) return { ok: false, message: `${name}: it has to close after it opens.` };
  }
  return { ok: true, hours: [...input].sort((a, b) => a.day - b.day) };
}

/** What a facility's hours say about one weekday: the minutes it opens and closes, or null when it is closed all day. */
export function openingOn(hours: readonly DayHours[], weekday: number): { opens: number; closes: number } | null {
  const entry = hours.find((h) => h.day === weekday);
  if (!entry) return null;
  const opens = minuteOf(entry.opens);
  const closes = minuteOf(entry.closes);
  return opens === null || closes === null ? null : { opens, closes };
}

/** The week in a line: "Mon to Fri 7:00 AM to 4:30 PM, Sat 8:00 AM to 12:00 PM". Empty hours say they are not recorded. */
export function hoursWords(hours: readonly DayHours[]): string {
  if (hours.length === 0) return "Hours not recorded";
  const short = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const sorted = [...hours].sort((a, b) => ((a.day + 6) % 7) - ((b.day + 6) % 7));
  const runs: { from: number; to: number; text: string }[] = [];
  for (const h of sorted) {
    const text = `${clockWords(minuteOf(h.opens) ?? 0)} to ${clockWords(minuteOf(h.closes) ?? 0)}`;
    const last = runs.at(-1);
    if (last && last.text === text && (last.to + 1) % 7 === h.day && h.day !== 1) last.to = h.day;
    else runs.push({ from: h.day, to: h.day, text });
  }
  return runs.map((r) => `${r.from === r.to ? short[r.from] : `${short[r.from]} to ${short[r.to]}`} ${r.text}`).join(", ");
}

/**
 * Whether the gate is open at a minute of a weekday, and the sentence when it
 * is not. Null when it is open, and null when no hours are recorded.
 *
 * The sentence names the facility, the time and day, and what its hours are,
 * so a dispatcher can tell a wrong plan from wrong hours on the record.
 */
export function closedWords(
  name: string, hours: readonly DayHours[], weekday: number, minute: number,
): string | null {
  if (hours.length === 0) return null;
  const open = openingOn(hours, weekday);
  const at = `${clockWords(Math.max(0, Math.round(minute)) % 1440)} on ${WEEKDAYS[weekday]}`;
  if (open === null) {
    return `${name} is closed on ${WEEKDAYS[weekday]}s. It is open ${hoursWords(hours)}. `
      + "If its hours are wrong, correct them on the facility.";
  }
  if (minute < open.opens || minute > open.closes) {
    return `${name} is closed at ${at}: it is open ${clockWords(open.opens)} to ${clockWords(open.closes)} that day. `
      + "If its hours are wrong, correct them on the facility.";
  }
  return null;
}

/* ---------------------------------------------------------------------- fee */

export type FeeBasis = "per_ton" | "per_load";

export interface FacilityRate {
  basis: FeeBasis;
  /** Per ton or per load, as a decimal string. */
  amount: string;
  /** What the facility charges at least for any load, when it has a minimum. */
  minimum: string | null;
}

export type FeeVerdict =
  | { ok: true; fee: string; why: string }
  | { ok: false; why: string };

/**
 * What the facility charges for a weighed load: the net tons at its per ton
 * rate, or its flat per load rate, and never less than its minimum when it
 * has one. Rounded once, at the end, so it reconciles against the facility's
 * own invoice. A per ton rate with no weight is not a fee of nothing: it says
 * what is missing.
 */
export function disposalFee(rate: FacilityRate | null, tons: string | null): FeeVerdict {
  if (rate === null) return { ok: false, why: "The facility has no rate recorded, so there is no fee to work out." };
  const floor = rate.minimum === null ? null : m.money(rate.minimum);
  if (rate.basis === "per_load") {
    let fee = m.money(rate.amount);
    let why = "the facility's price for a load";
    if (floor !== null && m.isNegative(m.subtract(fee, floor))) { fee = floor; why = "the facility's minimum for a load"; }
    return { ok: true, fee: m.toString(m.round(fee, 2)), why };
  }
  if (tons === null) {
    return { ok: false, why: "The facility charges by the ton and this load has no weight yet. Record the scale ticket first." };
  }
  const weight = Number(tons);
  if (!Number.isFinite(weight) || weight < 0) {
    return { ok: false, why: `"${tons}" is not a weight, so the fee cannot be worked out.` };
  }
  let fee = m.round(m.multiply(m.money(rate.amount), weight.toFixed(4)), 2);
  let why = `${weight} ton${weight === 1 ? "" : "s"} at ${m.toString(m.money(rate.amount))} a ton`;
  if (floor !== null && m.isNegative(m.subtract(fee, floor))) { fee = m.round(floor, 2); why = "the facility's minimum for a load"; }
  return { ok: true, fee: m.toString(fee), why };
}
