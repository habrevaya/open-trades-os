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
 * HOLIDAYS ARE A LIST OF DAYS. A transfer station shut on Thanksgiving is shut
 * on that Thursday whatever its week says, and a day on the list wins over the
 * hours, even for a facility whose hours nobody has recorded: a person who
 * typed a closure knows it. A holiday can repeat every year, because a landfill
 * keeps Christmas every year and nobody should retype it each January.
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

/* ----------------------------------------------------------------- holidays */

/** A day a facility is shut whatever its week says. */
export interface FacilityHoliday {
  /** The calendar date, "2026-11-26". For a yearly one, the year it was first typed. */
  date: string;
  /** What it is, "Thanksgiving", for the sentence that says why a facility was skipped. */
  name: string | null;
  /** Shut on this month and day every year, rather than on this date alone. */
  yearly: boolean;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function realDate(date: string): boolean {
  const found = DATE.exec(date);
  if (!found) return false;
  const when = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(when.getTime()) && when.toISOString().slice(0, 10) === date;
}

/**
 * The holidays as typed, checked: a real date each, a name that is short, and
 * no day twice (a yearly one counts as its month and day, so "Dec 25 every
 * year" and "Dec 25 2026" are the same closure said twice). The sentence says
 * which one is wrong.
 */
export function checkHolidays(input: readonly FacilityHoliday[]):
  { ok: true; holidays: FacilityHoliday[] } | { ok: false; message: string } {
  if (input.length > 60) return { ok: false, message: "A facility can keep up to 60 holidays. Remove ones that have passed." };
  const cleaned: FacilityHoliday[] = [];
  for (const entry of input) {
    if (!realDate(entry.date)) {
      return { ok: false, message: `${entry.date || "A holiday"} is not a date. Give it as year, month and day, like 2026-11-26.` };
    }
    const name = entry.name?.trim() || null;
    if (name !== null && name.length > 80) return { ok: false, message: `${entry.date}: the name is at most 80 letters.` };
    /**
     * The same closure said twice: the same date, or a month and day that a
     * yearly one already covers (or that this yearly one covers), however
     * the two were typed.
     */
    const twice = cleaned.some((other) => other.date === entry.date
      || ((other.yearly || entry.yearly) && other.date.slice(5) === entry.date.slice(5)));
    if (twice) return { ok: false, message: `${entry.date} is listed twice.` };
    cleaned.push({ date: entry.date, name, yearly: entry.yearly });
  }
  return { ok: true, holidays: cleaned.sort((a, b) => a.date.localeCompare(b.date)) };
}

/** The holiday a facility keeps on a calendar date, or null. */
export function holidayOn(holidays: readonly FacilityHoliday[], date: string): FacilityHoliday | null {
  return holidays.find((h) => h.date === date || (h.yearly && h.date.slice(5) === date.slice(5))) ?? null;
}

/**
 * Whether the gate is open at a minute of a date, and the sentence when it is
 * not: a holiday first, because it beats the week, then the week's hours as
 * `closedWords` says them. Null when it is open, and null when it keeps no
 * holiday that day and records no hours.
 */
export function closedOnWords(
  name: string, hours: readonly DayHours[], holidays: readonly FacilityHoliday[], date: string, minute: number,
): string | null {
  const holiday = holidayOn(holidays, date);
  if (holiday) {
    return `${name} is closed on ${WEEKDAYS[weekdayOf(date)]} ${date}${holiday.name ? ` for ${holiday.name}` : ""}. `
      + "If that is wrong, take the day off the facility's holidays.";
  }
  return closedWords(name, hours, weekdayOf(date), minute);
}

/** Why a facility is shut all day on a date, in a few words, or null when its hours keep it open that day. */
export function shutAllDayWhy(hours: readonly DayHours[], holidays: readonly FacilityHoliday[], date: string): string | null {
  const holiday = holidayOn(holidays, date);
  if (holiday) return holiday.name ? `closed for ${holiday.name}` : "closed for a holiday it keeps";
  if (hours.length > 0 && openingOn(hours, weekdayOf(date)) === null) return `closed on ${WEEKDAYS[weekdayOf(date)]}s`;
  return null;
}

/* ----------------------------------------------------- which facility, why */

/** What `routing.pickFacility` says about a run, as far as the words need it. */
export interface FacilityChoiceFacts {
  basis: "only_one" | "nearest_open" | "opens_soonest" | "cheapest_open" | "none_open";
  driveMinutes: number;
  others: readonly {
    key: string; driveMinutes: number;
    standing: "open" | "opens_later" | "closed_by_then" | "closed_all_day" | "does_not_take";
    opensAt: number | null; closesAt: number | null;
    refuses?: readonly string[] | undefined; feeCents?: number | undefined;
  }[];
  feeCents?: number | undefined;
  fees?: { weighed: true; hourCents: number } | { weighed: false; why: "no_hour_cost" }
    | { weighed: false; why: "fee_unknown"; unknown: readonly string[] } | undefined;
  notTaken?: readonly string[] | undefined;
}

/** "yard waste", "yard waste and tyres", "brush, tyres and concrete". */
function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * WHY A HAUL GOES WHERE IT GOES, in a dispatcher's words: which facility, how
 * far, and what was passed over and for what reason. A day's plan that sent a
 * can to a farther landfill with no reason given would be taken for a mistake.
 * When the fee was weighed it says each one's fee; when it could not be, it
 * says why, so nobody reads a choice by time as a choice by price.
 */
export function chosenWords(
  name: string, choice: FacilityChoiceFacts,
  describe: (key: string) => { name: string; shutWhy: string | null },
): string {
  const drive = `${Math.max(0, Math.round(choice.driveMinutes))} min by road`;
  const fee = choice.feeCents !== undefined ? `, ${centsWords(choice.feeCents)} to tip` : "";
  const notTaken = choice.notTaken && choice.notTaken.length > 0 ? choice.notTaken : null;
  const head = notTaken
    ? `No facility on the map takes everything on the truck. ${name} is the nearest, ${drive}, and does not take ${listWords(notTaken)}, so the run is refused.`
    : {
      only_one: `${name} is the only facility on the map, ${drive}.`,
      nearest_open: `${name} is the nearest one open when the truck gets there, ${drive}${fee}.`,
      opens_soonest: `None is open yet when the truck gets there. ${name} opens first, ${drive}${fee}, so the truck waits at its gate.`,
      cheapest_open: `${name} costs the least all told${fee}, ${drive}.`,
      none_open: `Every facility is shut when the truck would get there. ${name} is the nearest, ${drive}, so the run is refused.`,
    }[choice.basis];
  const weighed = choice.fees?.weighed === true;
  const passed = choice.others.flatMap((o) => {
    const who = describe(o.key);
    if (o.standing === "does_not_take") {
      return notTaken ? [] : [`${who.name} does not take ${listWords(o.refuses ?? [])}.`];
    }
    if (o.standing === "closed_all_day") return [`${who.name} is ${who.shutWhy ?? "closed that day"}.`];
    if (o.standing === "closed_by_then") {
      return [`${who.name} would be closed by then${o.closesAt !== null ? ` (it closes at ${clockWords(o.closesAt)})` : ""}.`];
    }
    if (weighed && o.feeCents !== undefined) {
      return [`${who.name} is ${Math.max(0, Math.round(o.driveMinutes))} min by road and would charge ${centsWords(o.feeCents)}.`];
    }
    if (o.standing === "opens_later" && choice.basis !== "opens_soonest") {
      return [`${who.name} does not open until ${o.opensAt !== null ? clockWords(o.opensAt) : "later"}.`];
    }
    return [];
  });
  const fartherOpen = choice.basis === "nearest_open" && !weighed && choice.others.some((o) => o.standing === "open");
  const tail = !choice.fees ? []
    : choice.fees.weighed
      ? [`Fees are weighed beside time, at ${centsWords(choice.fees.hourCents)} an hour of the truck.`]
      : choice.fees.why === "no_hour_cost"
        ? ["Fees are not weighed, because what an hour of the truck costs is not set under Collections and the truck."]
        : [`Fees are not weighed, because ${listWords(choice.fees.unknown.map((k) => describe(k).name))} cannot say what this load would cost.`];
  return [head, ...passed, ...(fartherOpen ? ["The others are farther."] : []), ...tail].join(" ");
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

/* ------------------------------------------------------- what it takes, by material */

/**
 * WHAT A FACILITY TAKES, AND WHAT IT CHARGES FOR EACH.
 *
 * A landfill takes mixed debris and refuses tyres; a green waste yard takes
 * brush and nothing else; a concrete crusher takes rubble and charges by the
 * load. A truck sent to a facility that turns its load away has driven there
 * for nothing, so a facility can list the materials it takes, each with its
 * own rate when it has one.
 *
 * AN EMPTY LIST IS "NOT RECORDED", NOT "TAKES NOTHING". The same rule as the
 * hours: a planner that left out every facility whose materials nobody typed
 * would stop working the day somebody adds the first one. A material with no
 * rate of its own is charged at the facility's general rate.
 *
 * Material names are compared with case and spacing ignored, so "Yard waste"
 * on the facility and "yard  waste" on a hire are the same thing; anything
 * else is a different material, and nothing guesses that "brush" is yard
 * waste.
 */
export interface FacilityMaterial {
  /** The material as the company names it: "Yard waste". */
  material: string;
  /** What it is charged by, when it has a rate of its own. */
  feeBasis: FeeBasis | null;
  /** Per ton or per load, as a decimal string. */
  feeAmount: string | null;
}

/** A material's name as it is compared: case and spacing ignored. */
export const materialKey = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, " ");

const AMOUNT = /^\d+(\.\d{1,4})?$/;

/**
 * The list as typed, checked: a name each, no material twice, a rate that has
 * both what it is charged by and how much, and at most forty. The sentence
 * names the material that is wrong.
 */
export function checkMaterials(input: readonly FacilityMaterial[]):
  { ok: true; materials: FacilityMaterial[] } | { ok: false; message: string } {
  if (input.length > 40) return { ok: false, message: "A facility can list up to 40 materials." };
  const seen = new Set<string>();
  const cleaned: FacilityMaterial[] = [];
  for (const entry of input) {
    const material = entry.material.trim().replace(/\s+/g, " ");
    if (material === "") return { ok: false, message: "Each material it takes needs a name, like Yard waste." };
    if (material.length > 100) return { ok: false, message: `${material.slice(0, 40)}: a material's name is at most 100 letters.` };
    if (seen.has(materialKey(material))) return { ok: false, message: `${material} is listed twice.` };
    seen.add(materialKey(material));
    if ((entry.feeBasis === null) !== (entry.feeAmount === null)) {
      return { ok: false, message: `${material}: a rate needs both what it is charged by (a ton or a load) and how much.` };
    }
    if (entry.feeAmount !== null && !AMOUNT.test(entry.feeAmount)) {
      return { ok: false, message: `${material}: the rate is an amount of money, like 38.00.` };
    }
    cleaned.push({
      material, feeBasis: entry.feeBasis,
      feeAmount: entry.feeAmount === null ? null : m.toString(m.money(entry.feeAmount)),
    });
  }
  return { ok: true, materials: cleaned };
}

/** Whether a facility takes a material. A load of no known material, or a facility whose list nobody recorded, is never turned away. */
export function takesMaterial(materials: readonly FacilityMaterial[], material: string | null): boolean {
  if (material === null || materialKey(material) === "" || materials.length === 0) return true;
  return materials.some((entry) => materialKey(entry.material) === materialKey(material));
}

/**
 * The rate a load of a material is charged at: its own, when the facility
 * lists one for it, otherwise the facility's general rate. The facility's
 * minimum applies to any load either way.
 */
export function rateForMaterial(
  materials: readonly FacilityMaterial[], general: FacilityRate | null, material: string | null,
): FacilityRate | null {
  const own = material === null ? undefined
    : materials.find((entry) => materialKey(entry.material) === materialKey(material));
  if (own && own.feeBasis !== null && own.feeAmount !== null) {
    return { basis: own.feeBasis, amount: own.feeAmount, minimum: general?.minimum ?? null };
  }
  return general;
}

/**
 * What a facility would charge to tip some full cans, each a load of its own
 * material and expected weight, in cents. Not ok, with the reason, when any
 * one of them cannot be worked out: a fee that leaves a can out is not the
 * fee, and comparing it with another facility's would favour the one that
 * knows less.
 */
export function feeForLoads(
  materials: readonly FacilityMaterial[], general: FacilityRate | null,
  loads: readonly { material: string | null; tons: string | null }[],
): { ok: true; cents: number } | { ok: false; why: string } {
  let total = m.zero();
  for (const load of loads) {
    const verdict = disposalFee(rateForMaterial(materials, general, load.material), load.tons);
    if (!verdict.ok) return { ok: false, why: verdict.why };
    total = m.add(total, m.money(verdict.fee));
  }
  return { ok: true, cents: Number(m.round(total, 2).amount / 100n) };
}

/** Cents as money in words: 12050 is "120.50". */
export function centsWords(cents: number): string {
  const whole = Math.trunc(Math.abs(cents) / 100);
  const part = Math.abs(cents) % 100;
  return `${cents < 0 ? "-" : ""}${whole.toLocaleString("en-US")}.${String(part).padStart(2, "0")}`;
}

/** One line of the list in words: "Yard waste, 38.00 a ton", or the name alone when it is charged the general rate. */
export function materialLine(entry: FacilityMaterial): string {
  if (entry.feeBasis === null || entry.feeAmount === null) return entry.material;
  return `${entry.material}, ${Number(entry.feeAmount).toFixed(2)} ${entry.feeBasis === "per_ton" ? "a ton" : "a load"}`;
}

/**
 * The list as a person types it, one material a line: "Yard waste", or
 * "Yard waste, 38.00 a ton", or "Concrete, 120 a load". A line that is not
 * that shape is refused with how to write it, never read as a guess.
 */
export function parseMaterialLines(text: string):
  { ok: true; materials: FacilityMaterial[] } | { ok: false; message: string } {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const parsed: FacilityMaterial[] = [];
  for (const line of lines) {
    const priced = /^(.*?)[,:]\s*\$?(\d+(?:\.\d{1,4})?)\s*(?:a|per|\/)\s*(ton|load)s?\.?$/i.exec(line);
    if (priced) {
      parsed.push({
        material: priced[1]!, feeBasis: priced[3]!.toLowerCase() === "ton" ? "per_ton" : "per_load", feeAmount: priced[2]!,
      });
      continue;
    }
    if (/\d/.test(line) && /[,:]/.test(line)) {
      return {
        ok: false,
        message: `"${line}" is not a material and a rate. Write it as Yard waste, 38.00 a ton, or Concrete, 120 a load, or the name alone.`,
      };
    }
    parsed.push({ material: line, feeBasis: null, feeAmount: null });
  }
  return checkMaterials(parsed);
}
