import { type Money, allocate, compare, isPositive, isZero, money, multiply, round, split, zero } from "../money/index.js";
import { addDays } from "../time/index.js";

/**
 * WHAT A COMPANY PAYS A PERSON BESIDE THEIR HOURS
 *
 * What a person spent for the company and gets back, a flat allowance for a
 * day away, and how a customer's tip is shared between the people on a job.
 * Nothing here touches a database or a clock it was not handed, so every rule
 * can be tested without either.
 *
 * Money in a person's pocket is where a small company is most often unfair by
 * accident, so every refusal below is a sentence the person who typed the
 * figure can act on, and every default is the one that pays nobody anything
 * the company did not choose to pay.
 */

/* ------------------------------------------------------------ the settings */

/**
 * How a tip is shared between the people on the job it was left for.
 *
 *   even   everybody on the job's visits gets the same, to the cent. The way
 *          tips were always shared, and what a company that never chose gets.
 *   hours  in proportion to the hours each person was clocked in on the job.
 *   lead   the person marked as lead on the job's visits takes all of it.
 *   visit_hours
 *          in proportion to the hours each person was clocked in on the ONE
 *          visit the tip was for: the visit it was taken on, when it was
 *          taken on site; otherwise the job's visit finished most recently,
 *          which is the work the customer had just seen when they paid.
 */
export const TIP_SPLIT_RULES = ["even", "hours", "lead", "visit_hours"] as const;
export type TipSplitRule = (typeof TIP_SPLIT_RULES)[number];

export const TIP_SPLIT_LABEL: Record<TipSplitRule, string> = {
  even: "Evenly between everybody on the job",
  hours: "By the hours each person worked on the job",
  lead: "All to the lead on the job",
  visit_hours: "By the hours each person worked on the visit the tip was for",
};

/**
 * WHERE THE RULE A TIP WAS SHARED BY CAME FROM.
 *
 *   job         the job's own rule, set by the office for that one job.
 *   technician  a rule of a person's own, which everybody on the job who has
 *               one agrees on.
 *   company     the company's rule on Pay rules, which is what applies when
 *               neither of the above does.
 */
export const TIP_RULE_SOURCES = ["company", "job", "technician"] as const;
export type TipRuleSource = (typeof TIP_RULE_SOURCES)[number];

export interface TipRuleChoice {
  rule: TipSplitRule;
  source: TipRuleSource;
  /** Said when a rule of a person's own was passed over, empty otherwise. */
  note: string;
}

/**
 * WHICH RULE A TIP IS SHARED BY: the job's own rule first, then a rule of a
 * person's own, then the company's.
 *
 * A person's own rule is about tips they share in. When everybody on the job
 * who has one has the same one, it is used. When two people on the job have
 * different rules of their own, neither can be followed without going against
 * the other, so the company's rule is used and the tip says so: the
 * conservative reading, because the company's rule is the one everybody on
 * the job was told about.
 */
export function chooseTipRule(input: {
  company: TipSplitRule;
  job: TipSplitRule | null;
  /** The rules of their own that people on the job have. People with none are left out. */
  people: readonly { technicianId: string; rule: TipSplitRule }[];
}): TipRuleChoice {
  if (input.job) return { rule: input.job, source: "job", note: "" };
  const rules = [...new Set(input.people.map((p) => p.rule))];
  if (rules.length === 1) return { rule: rules[0]!, source: "technician", note: "" };
  if (rules.length > 1) {
    return {
      rule: input.company, source: "company",
      note: "People on this job have different tip rules of their own, so the company's rule was used.",
    };
  }
  return { rule: input.company, source: "company", note: "" };
}

/**
 * What the company pays for one mile driven in a vehicle of the person's own, from a day. A list of these,
 * oldest first, is the company's history of the rate: the one in force on a day is the latest that starts on
 * or before it.
 */
export interface MileageRate {
  /** The first day the rate applies, a company date. */
  from: string;
  /** Dollars for one mile, up to three decimals ("0.725"), because the tax authority's own rate has half cents. */
  perMile: string;
}

export interface PayExtras {
  /** The company's allowance for one day away, as dollars and cents. Null until somebody sets it. */
  perDiemRate: string | null;
  tipSplit: TipSplitRule;
}

/** Everything the company chose beside hours: the above, what one mile is paid and the places a day away is worth something else. */
export interface PaySettings extends PayExtras {
  /** Oldest first, one per starting day. Empty until somebody sets one, which means no mileage is paid. */
  mileageRates: MileageRate[];
  /** Places with a day rate of their own. Empty until somebody adds one, which leaves every day away at the one rate above. */
  perDiemPlaces: PerDiemPlace[];
}

/**
 * Read the settings blob. Anything hand edited into nonsense reads as the
 * defaults, which pay nobody a per diem and split tips as they always were.
 */
export function readPayExtras(raw: unknown): PayExtras {
  const blob = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const rate = typeof blob["perDiemRate"] === "string" && checkPerDiemRate(blob["perDiemRate"]).ok
    ? (checkPerDiemRate(blob["perDiemRate"]) as { ok: true; rate: string }).rate
    : null;
  const rule = TIP_SPLIT_RULES.find((r) => r === blob["tipSplit"]) ?? "even";
  return { perDiemRate: rate, tipSplit: rule };
}

/** The whole blob: `readPayExtras` and the mileage rates, each read as defaults when they are nonsense. */
export function readPaySettings(raw: unknown): PaySettings {
  const blob = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return { ...readPayExtras(raw), mileageRates: readMileageRates(blob["mileageRates"]), perDiemPlaces: readPerDiemPlaces(blob["perDiemPlaces"]) };
}

/**
 * The rates in the settings blob. A line that is not a rate is dropped rather than read as a guess, two lines
 * for one day keep the first, and the answer is oldest first so a reader can take the last one that has begun.
 */
export function readMileageRates(raw: unknown): MileageRate[] {
  const found = new Map<string, MileageRate>();
  for (const line of Array.isArray(raw) ? raw : []) {
    const entry = line && typeof line === "object" ? line as Record<string, unknown> : {};
    if (typeof entry["from"] !== "string" || typeof entry["perMile"] !== "string") continue;
    const checked = checkMileageRate({ from: entry["from"], perMile: entry["perMile"] });
    if (checked.ok && !found.has(checked.rate.from)) found.set(checked.rate.from, checked.rate);
  }
  return [...found.values()].sort((a, b) => a.from.localeCompare(b.from));
}

/** The most a day away can be. A figure past this is a typing slip, and a slip here is paid daily. */
export const MAX_PER_DIEM = "1000.00";

export type RateCheck = { ok: true; rate: string } | { ok: false; reason: string };

export function checkPerDiemRate(value: string): RateCheck {
  const typed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(typed)) {
    return { ok: false, reason: "Say the rate for one day away in dollars and cents, like 75.00." };
  }
  const rate = round(money(typed), 2);
  if (!isPositive(rate)) return { ok: false, reason: "A day away has to be paid more than nothing. Leave the rate empty to pay none." };
  if (compare(rate, money(MAX_PER_DIEM)) > 0) {
    return { ok: false, reason: `A day away of more than ${MAX_PER_DIEM} is most likely a slip of the keys. Check the amount.` };
  }
  return { ok: true, rate: `${rate.amount / 10000n}.${String((rate.amount % 10000n) / 100n).padStart(2, "0")}` };
}

/* ------------------------------------------------------------ mileage */

/** The most one mile can be paid. Past this is a typing slip (72 for 0.72), and a slip here is paid on every claim. */
export const MAX_MILEAGE_RATE = "3.000";

/** The most one claim may be, so a typed odometer reading is a slip and not a thousand dollars. */
export const MAX_MILES = "2000.0";

/** The earliest day a rate may start from. Earlier is a typing slip in the year. */
export const EARLIEST_MILEAGE_DAY = "2000-01-01";

const isDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`))
  && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

export type MileageRateCheck = { ok: true; rate: MileageRate } | { ok: false; reason: string };

/** A rate somebody typed: what one mile is paid, from the day it starts. */
export function checkMileageRate(input: { from: string; perMile: string }): MileageRateCheck {
  const typed = input.perMile.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,3})?$/.test(typed)) {
    return { ok: false, reason: "Say what one mile is paid in dollars, like 0.70 or 0.725." };
  }
  const rate = money(typed);
  if (!isPositive(rate)) return { ok: false, reason: "A mile has to be paid more than nothing. Take the rate off to pay none." };
  if (compare(rate, money(MAX_MILEAGE_RATE)) > 0) {
    return { ok: false, reason: `A mile of more than ${MAX_MILEAGE_RATE} is most likely a slip of the keys, like 72 for 0.72. Check the amount.` };
  }
  if (!isDay(input.from)) return { ok: false, reason: "Say the first day the rate applies." };
  if (input.from < EARLIEST_MILEAGE_DAY) return { ok: false, reason: "That day is too long ago to be right. Check the year." };
  /** Three decimals always, so "0.7" and "0.700" are one rate and a line reads the same wherever it is shown. */
  const [whole, fraction = ""] = typed.split(".");
  return { ok: true, rate: { from: input.from, perMile: `${whole}.${fraction.padEnd(3, "0")}` } };
}

/**
 * The company's rates with a new one in them, or why not. A rate for a day that already has one is refused,
 * not replaced: claims already worked out keep the rate they were worked out at, so quietly changing a line
 * would leave the list saying something the money does not. Take the wrong one off and add the right one.
 */
export function addMileageRate(
  rates: readonly MileageRate[], input: { from: string; perMile: string },
): { ok: true; rates: MileageRate[] } | { ok: false; reason: string } {
  const checked = checkMileageRate(input);
  if (!checked.ok) return checked;
  if (rates.some((r) => r.from === checked.rate.from)) {
    return { ok: false, reason: `There is already a rate from ${checked.rate.from}. Take it off first if it is wrong.` };
  }
  return { ok: true, rates: [...rates, checked.rate].sort((a, b) => a.from.localeCompare(b.from)) };
}

/** The rates without the one that starts on a day, or why not. */
export function removeMileageRate(
  rates: readonly MileageRate[], from: string,
): { ok: true; rates: MileageRate[] } | { ok: false; reason: string } {
  if (!rates.some((r) => r.from === from)) return { ok: false, reason: `There is no rate from ${from}.` };
  return { ok: true, rates: rates.filter((r) => r.from !== from) };
}

/** The rate in force on a day: the latest one that starts on or before it. Null when none has started. */
export function mileageRateOn(rates: readonly MileageRate[], day: string): MileageRate | null {
  let found: MileageRate | null = null;
  for (const rate of rates) if (rate.from <= day && (found === null || rate.from > found.from)) found = rate;
  return found;
}

/**
 * Where the rate a claim was worked out at came from: a vehicle's own line, the line for the kind of work the
 * claim's job is (its job type), a person's own line, or the company's.
 */
export type MileageRateSource = "vehicle" | "work" | "person" | "company";

/**
 * The rate for a mile on a day, narrowest first: the vehicle's line in force that day, else the line for the kind
 * of work the claim's job is, else the person's, else the company's.
 *
 * WHY THAT ORDER. The vehicle is what was driven, and a vehicle that costs more or less to run is the most
 * particular fact about a mile. The kind of work is what the drive was for (a trailer to an install, a long run to
 * a commercial site), particular to this claim. A person's own line is a standing arrangement for all their
 * driving, so it gives way to both. The company's rate is everybody's, last.
 *
 * A vehicle, a kind of work or a person with lines but none started by the day is passed over, not refused, so
 * adding a rate from next month changes nothing before it. Null when nothing at all has started.
 */
export function resolveMileageRate(
  day: string,
  lines: {
    vehicle?: readonly MileageRate[] | undefined;
    work?: readonly MileageRate[] | undefined;
    person?: readonly MileageRate[] | undefined;
    company: readonly MileageRate[];
  },
): { rate: MileageRate; source: MileageRateSource } | null {
  const vehicle = mileageRateOn(lines.vehicle ?? [], day);
  if (vehicle) return { rate: vehicle, source: "vehicle" };
  const work = mileageRateOn(lines.work ?? [], day);
  if (work) return { rate: work, source: "work" };
  const person = mileageRateOn(lines.person ?? [], day);
  if (person) return { rate: person, source: "person" };
  const company = mileageRateOn(lines.company, day);
  return company ? { rate: company, source: "company" } : null;
}

export type MilesCheck = { ok: true; miles: string } | { ok: false; reason: string };

/** The miles somebody typed, to a tenth, written the way they are kept ("12.0"). */
export function checkMiles(value: string): MilesCheck {
  const typed = value.trim();
  if (!/^\d+(\.\d)?$/.test(typed)) return { ok: false, reason: "Say the miles driven, to a tenth, like 18 or 18.4." };
  const miles = money(typed);
  if (!isPositive(miles)) return { ok: false, reason: "The miles have to be more than nothing." };
  if (compare(miles, money(MAX_MILES)) > 0) {
    return { ok: false, reason: `That is more than ${MAX_MILES} miles for one claim. Check the number, or ask the office.` };
  }
  const [whole, fraction = ""] = typed.split(".");
  return { ok: true, miles: `${whole}.${fraction.padEnd(1, "0")}` };
}

/**
 * What the miles are worth at the rate, to the cent, the half cent rounded up: 12.5 miles at 0.725 is
 * 9.0625, paid as 9.06. Kept on the claim with the rate, so a rate changed later never reprices it.
 */
export function mileageAmount(miles: string, perMile: string): Money {
  return round(multiply(money(perMile), miles), 2);
}

/* ------------------------------------------------- a day away, by place */

/** What one day away at a place is worth, from a day. The place's own history, like the mileage rate's. */
export interface PerDiemRate {
  /** The first day the rate applies, a company date. */
  from: string;
  /** Dollars and cents for one day, the same shape as the company's one rate. */
  perDay: string;
}

/**
 * A place with a day rate of its own.
 *
 * A name always, and a city, a state or both when the place is a town or a state rather than a
 * region the company names itself ("Gulf coast", "Out of state"). Only a place with a city is ever
 * picked for a job by itself, from the job's address; a state alone, or a name alone, is picked by
 * a person. A place is retired rather than deleted: days already recorded keep its name and what
 * they were worked out at, and the list says it is no longer used.
 */
export interface PerDiemPlace {
  /** Made when the place is added and never reused, so a retired place and a new one of the same name are two. */
  id: string;
  name: string;
  /** Two letters, upper case, or null. */
  state: string | null;
  city: string | null;
  /** Oldest first, one per starting day. A place with none pays no day away. */
  rates: PerDiemRate[];
  retired: boolean;
}

export const MAX_PLACE_NAME = 80;

/** The same town however it was typed: case, spaces and a trailing full stop do not make a different one. */
const townKey = (value: string) => value.trim().replace(/\.$/, "").replace(/\s+/g, " ").toLowerCase();

export type RateLineCheck = { ok: true; line: PerDiemRate } | { ok: false; reason: string };

/** One line of a place's history: what a day is worth from the day it starts. */
export function checkPerDiemRateLine(input: { from: string; perDay: string }): RateLineCheck {
  const rate = checkPerDiemRate(input.perDay);
  if (!rate.ok) return rate;
  if (!isDay(input.from)) return { ok: false, reason: "Say the first day the rate applies." };
  if (input.from < EARLIEST_MILEAGE_DAY) return { ok: false, reason: "That day is too long ago to be right. Check the year." };
  return { ok: true, line: { from: input.from, perDay: rate.rate } };
}

export type PlaceCheck =
  | { ok: true; name: string; state: string | null; city: string | null }
  | { ok: false; reason: string };

/** What was typed for a place, tidied: the name, and a state of two letters or a city when given. */
export function checkPerDiemPlace(input: { name: string; state?: string | null | undefined; city?: string | null | undefined }): PlaceCheck {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name === "") return { ok: false, reason: "Give the place a name, like Austin or Out of state." };
  if (name.length > MAX_PLACE_NAME) return { ok: false, reason: `Keep the name of a place to ${MAX_PLACE_NAME} letters.` };
  const typedState = input.state?.trim() ?? "";
  if (typedState !== "" && !/^[A-Za-z]{2}$/.test(typedState)) {
    return { ok: false, reason: "Say the state as two letters, like TX, or leave it empty." };
  }
  const city = (input.city?.trim() ?? "").replace(/\s+/g, " ");
  if (city.length > MAX_PLACE_NAME) return { ok: false, reason: `Keep the city to ${MAX_PLACE_NAME} letters.` };
  return { ok: true, name, state: typedState === "" ? null : typedState.toUpperCase(), city: city === "" ? null : city };
}

/**
 * The places in the settings blob. Anything that is not a place, or has a name two places share, is
 * dropped rather than guessed at, and the rates of each are read the way mileage rates are: a line
 * that is not a rate goes, two for one day keep the first, and the answer is oldest first.
 */
export function readPerDiemPlaces(raw: unknown): PerDiemPlace[] {
  const found: PerDiemPlace[] = [];
  const ids = new Set<string>();
  for (const line of Array.isArray(raw) ? raw : []) {
    const entry = line && typeof line === "object" ? line as Record<string, unknown> : {};
    if (typeof entry["id"] !== "string" || entry["id"] === "" || ids.has(entry["id"]) || typeof entry["name"] !== "string") continue;
    const place = checkPerDiemPlace({
      name: entry["name"],
      state: typeof entry["state"] === "string" ? entry["state"] : null,
      city: typeof entry["city"] === "string" ? entry["city"] : null,
    });
    if (!place.ok) continue;
    const rates = new Map<string, PerDiemRate>();
    for (const rate of Array.isArray(entry["rates"]) ? entry["rates"] : []) {
      const r = rate && typeof rate === "object" ? rate as Record<string, unknown> : {};
      if (typeof r["from"] !== "string" || typeof r["perDay"] !== "string") continue;
      const checked = checkPerDiemRateLine({ from: r["from"], perDay: r["perDay"] });
      if (checked.ok && !rates.has(checked.line.from)) rates.set(checked.line.from, checked.line);
    }
    ids.add(entry["id"]);
    found.push({
      id: entry["id"], name: place.name, state: place.state, city: place.city,
      rates: [...rates.values()].sort((a, b) => a.from.localeCompare(b.from)),
      retired: entry["retired"] === true,
    });
  }
  return found;
}

type PlacesResult = { ok: true; places: PerDiemPlace[] } | { ok: false; reason: string };

const sameName = (a: string, b: string) => townKey(a) === townKey(b);

/** The places with a new one, or why not. Two places in use cannot share a name, because the list is read by name. */
export function addPerDiemPlace(
  places: readonly PerDiemPlace[],
  input: { name: string; state?: string | null | undefined; city?: string | null | undefined; from: string; perDay: string },
  id: string,
): PlacesResult {
  const place = checkPerDiemPlace(input);
  if (!place.ok) return place;
  const line = checkPerDiemRateLine(input);
  if (!line.ok) return line;
  if (places.some((p) => !p.retired && sameName(p.name, place.name))) {
    return { ok: false, reason: `There is already a place called ${place.name}. Add a rate to it, or give this one another name.` };
  }
  return { ok: true, places: [...places, { id, name: place.name, state: place.state, city: place.city, rates: [line.line], retired: false }] };
}

/** The places with a rate added to one of them. A day that already has a rate is refused, not replaced, as a mileage rate is. */
export function addPerDiemPlaceRate(
  places: readonly PerDiemPlace[], id: string, input: { from: string; perDay: string },
): PlacesResult {
  const place = places.find((p) => p.id === id);
  if (!place) return { ok: false, reason: "That place is not on the list." };
  if (place.retired) return { ok: false, reason: `${place.name} is no longer used, so it cannot be given a rate.` };
  const line = checkPerDiemRateLine(input);
  if (!line.ok) return line;
  if (place.rates.some((r) => r.from === line.line.from)) {
    return { ok: false, reason: `${place.name} already has a rate from ${line.line.from}. Take it off first if it is wrong.` };
  }
  const rates = [...place.rates, line.line].sort((a, b) => a.from.localeCompare(b.from));
  return { ok: true, places: places.map((p) => (p.id === id ? { ...p, rates } : p)) };
}

/** The places with the rate that starts on a day taken off one of them. */
export function removePerDiemPlaceRate(places: readonly PerDiemPlace[], id: string, from: string): PlacesResult {
  const place = places.find((p) => p.id === id);
  if (!place) return { ok: false, reason: "That place is not on the list." };
  if (!place.rates.some((r) => r.from === from)) return { ok: false, reason: `${place.name} has no rate from ${from}.` };
  return { ok: true, places: places.map((p) => (p.id === id ? { ...p, rates: p.rates.filter((r) => r.from !== from) } : p)) };
}

/** What a day at a place is worth on a day: the latest rate that starts on or before it. Null when none has started. */
export function perDiemRateOn(place: Pick<PerDiemPlace, "rates">, day: string): string | null {
  let found: PerDiemRate | null = null;
  for (const rate of place.rates) if (rate.from <= day && (found === null || rate.from > found.from)) found = rate;
  return found?.perDay ?? null;
}

export type PlaceMatch =
  | { kind: "one"; place: PerDiemPlace }
  | { kind: "none" }
  | { kind: "several"; places: PerDiemPlace[] };

/**
 * Which place a job's address is in, for a day away recorded without one chosen.
 *
 * Only a place with a CITY is matched, and only on the city (without caring about case or spacing)
 * and, when the place gives a state, the state. A place with a state alone or a name alone is for
 * a person to choose, because "the job is in Texas" does not say which of two Texas places a
 * person was in. Nothing is guessed from a near miss: "Austin" does not match "Austin Heights".
 * Two places that both match are `several`, which the caller turns into a question.
 */
export function placeForAddress(
  places: readonly PerDiemPlace[], address: { city: string; state: string },
): PlaceMatch {
  const city = townKey(address.city);
  const state = address.state.trim().toUpperCase();
  const matches = places.filter((p) => !p.retired && p.city !== null && townKey(p.city) === city
    && (p.state === null || p.state === state));
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "one", place: matches[0]! };
  return { kind: "several", places: matches };
}

/* ------------------------------------------------------------ an expense */

/** More than this is not something to put on a phone: it is a purchase the office makes. */
export const MAX_EXPENSE = "10000.00";

/** How far back a receipt may be dated. Older than this is a different conversation with the office. */
export const EXPENSE_BACK_DAYS = 120;

export type ExpenseCheck =
  | { ok: true; amount: Money; description: string }
  | { ok: false; reason: string };

/**
 * Whether what somebody typed can be an expense.
 *
 * `today` is the company's date, handed in, so a receipt dated tomorrow is
 * refused by the company's calendar rather than the server's.
 */
export function checkExpense(input: { amount: string; spentOn: string; today: string; description: string }): ExpenseCheck {
  const typed = input.amount.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(typed)) {
    return { ok: false, reason: "Say what you paid in dollars and cents, like 42.50." };
  }
  const amount = round(money(typed), 2);
  if (!isPositive(amount)) return { ok: false, reason: "An expense has to be more than nothing." };
  if (compare(amount, money(MAX_EXPENSE)) > 0) {
    return { ok: false, reason: `That is more than ${MAX_EXPENSE}. Ask the office to buy it, or to pay you back another way.` };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.spentOn) || Number.isNaN(Date.parse(`${input.spentOn}T00:00:00Z`))) {
    return { ok: false, reason: "Say the day you paid it." };
  }
  if (input.spentOn > input.today) return { ok: false, reason: "That day has not happened yet." };
  if (input.spentOn < addDays(input.today, -EXPENSE_BACK_DAYS)) {
    return { ok: false, reason: `That is more than ${EXPENSE_BACK_DAYS} days ago. Ask the office to pay it back.` };
  }
  const description = input.description.trim().replace(/\s+/g, " ");
  if (description === "") return { ok: false, reason: "Say what it was for, so the office knows what it is paying back." };
  if (description.length > 300) return { ok: false, reason: "Say what it was for in a few words. The most it takes is 300 letters." };
  return { ok: true, amount, description };
}

/** The most days one entry may cover, so a typed year is a slip and not a thousand allowances. */
export const MAX_PER_DIEM_DAYS = 31;

/** Every day from the first to the last, both included, or why not. */
export function daysAway(from: string, to: string): { ok: true; days: string[] } | { ok: false; reason: string } {
  const valid = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
  if (!valid(from) || !valid(to)) return { ok: false, reason: "Say the first and last day away." };
  if (to < from) return { ok: false, reason: "The last day is before the first. Put the earlier day first." };
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    days.push(day);
    if (days.length > MAX_PER_DIEM_DAYS) {
      return { ok: false, reason: `That is more than ${MAX_PER_DIEM_DAYS} days. Record a month at a time.` };
    }
  }
  return { ok: true, days };
}

/* --------------------------------------------------------- a cash tip kept */

/** More than this is not a tip, and is recorded as a payment. Said the same on the phone. */
export const MAX_CASH_TIP = "10000.00";

export type TipAmountCheck = { ok: true; amount: Money } | { ok: false; reason: string };

/**
 * What the office typed as a cash tip. Zero is allowed only when asked for,
 * because the way a tip that was never given comes off somebody's pay is a
 * correction to nothing, and a new tip of nothing is a slip.
 */
export function checkTipAmount(value: string, options: { allowZero?: boolean } = {}): TipAmountCheck {
  const typed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(typed)) return { ok: false, reason: "Say the tip in dollars and cents, like 20 or 20.50." };
  const amount = round(money(typed), 2);
  if (!isPositive(amount) && !(options.allowZero && isZero(amount))) {
    return { ok: false, reason: "A tip has to be more than nothing." };
  }
  if (compare(amount, money(MAX_CASH_TIP)) > 0) return { ok: false, reason: "That is more than a tip. Record it as a payment instead." };
  return { ok: true, amount };
}

/* ------------------------------------------------------------ tip shares */

export interface TipPerson {
  technicianId: string;
  /** Seconds clocked in on the job, closed punches only. Zero when none are recorded. */
  seconds: number;
  /** Seconds clocked in on the one visit the tip was for, for `visit_hours`. Zero when none, or no visit. */
  visitSeconds?: number;
  /** Marked as lead on at least one of the job's visits. */
  isLead: boolean;
}

export interface TipSplit {
  shares: { technicianId: string; amount: Money }[];
  /** The rule that actually produced the shares, which is "even" when the chosen one had nothing to go on. */
  rule: TipSplitRule;
  /**
   * Said in words when the chosen rule could not be followed, empty when it
   * could. Kept on every share so nobody has to guess why a split was even.
   */
  note: string;
}

/**
 * Share one tip between the people on a job, by the company's rule.
 *
 * A rule with nothing to go on does NOT hand the tip to nobody or to the
 * wrong person: no hours recorded, or no lead marked, falls back to an even
 * split and says so. The alternatives are a tip with no owner, which sits as a
 * liability until somebody notices, and a guess at who deserved it.
 *
 * Sorted by id before anything is shared, so the odd cent lands on the same
 * person for the same inputs, and a person with no share is left out rather
 * than written as zero.
 */
export function splitTipByRule(rule: TipSplitRule, tip: Money, people: readonly TipPerson[]): TipSplit {
  const byId = new Map<string, TipPerson>();
  for (const person of people) {
    const seen = byId.get(person.technicianId);
    byId.set(person.technicianId, seen
      ? {
        ...seen, isLead: seen.isLead || person.isLead, seconds: Math.max(seen.seconds, person.seconds),
        visitSeconds: Math.max(seen.visitSeconds ?? 0, person.visitSeconds ?? 0),
      }
      : person);
  }
  const everybody = [...byId.values()].sort((a, b) => a.technicianId.localeCompare(b.technicianId));
  if (everybody.length === 0 || isZero(tip)) return { shares: [], rule, note: "" };

  const evenly = (among: TipPerson[]) => {
    const parts = split(tip, among.length, 2);
    return among.map((p, i) => ({ technicianId: p.technicianId, amount: parts[i] ?? zero(tip.currency) }));
  };

  if (rule === "lead") {
    const leads = everybody.filter((p) => p.isLead);
    if (leads.length === 0) {
      return {
        shares: evenly(everybody), rule: "even",
        note: "No lead is marked on this job, so the tip was split evenly between everybody on it.",
      };
    }
    return {
      shares: evenly(leads), rule: "lead",
      note: leads.length > 1 ? "More than one person is marked as lead, so the tip was split evenly between them." : "",
    };
  }

  if (rule === "hours" || rule === "visit_hours") {
    const onVisit = rule === "visit_hours";
    const secondsOf = (p: TipPerson) => (onVisit ? p.visitSeconds ?? 0 : p.seconds);
    const worked = everybody.filter((p) => secondsOf(p) > 0);
    if (worked.length === 0) {
      return {
        shares: evenly(everybody), rule: "even",
        note: onVisit
          ? "No hours were recorded on the visit this tip was for, so the tip was split evenly between everybody on the job."
          : "No hours were recorded on this job, so the tip was split evenly between everybody on it.",
      };
    }
    const parts = allocate(tip, worked.map((p) => String(Math.round(secondsOf(p)))), 2);
    return {
      shares: worked.map((p, i) => ({ technicianId: p.technicianId, amount: parts[i] ?? zero(tip.currency) }))
        .filter((s) => !isZero(s.amount)),
      rule,
      note: worked.length < everybody.length
        ? onVisit
          ? "Somebody on the job has no hours recorded on the visit this tip was for, so they have no share of this tip."
          : "Somebody on the job has no hours recorded on it, so they have no share of this tip."
        : "",
    };
  }

  return { shares: evenly(everybody), rule: "even", note: "" };
}
