import { money, rates } from "@opentradesos/core";

/**
 * THE CONTRACT SCREENS' FORMS, AS THE SERVICES TAKE THEM
 *
 * A rate card is typed by an office manager reading a client's schedule: a
 * percentage as a percentage, a time as a time, a list of prices pasted from
 * a spreadsheet. The services take fractions, minutes and rows. This is the
 * one place the two meet, pulled out of the server actions so it can be
 * tested, because a markup of "25" read as twenty five hundred per cent is
 * exactly the size of mistake that looks too obvious to test.
 */

export type Read = (name: string) => string | null;

const text = (read: Read, name: string): string => (read(name) ?? "").trim();

/** "50" or "50%" as a per cent, to the fraction a service takes: "0.5000". */
export function fractionOf(percent: string): string | null {
  const cleaned = percent.replace(/%/g, "").trim();
  if (cleaned === "") return null;
  if (!/^\d+(\.\d+)?$/.test(cleaned)) throw new Error(`"${percent}" is not a percentage.`);
  return money.toString(money.divide(money.money(cleaned), "100"));
}

/** A stored fraction as the per cent a person typed: "0.035000" reads "3.5". The point moves; nothing rounds. */
export function percentOf(rate: string): string {
  const [whole = "0", frac = ""] = rate.split(".");
  const digits = frac.padEnd(2, "0");
  const rest = digits.slice(2).replace(/0+$/, "");
  return `${Number(`${whole}${digits.slice(0, 2)}`)}${rest ? `.${rest}` : ""}`;
}

/** "17:30" as minutes past midnight. */
export function minutesOf(clock: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes <= 1440 ? minutes : null;
}

/** Minutes past midnight as "07:30", for a time input. */
export const clockOf = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

export const LABOUR_ROWS = 6;
export const MARKUP_ROWS = 4;
export const SLA_ROWS = 4;

/**
 * The rules form, as the card terms service takes them.
 *
 * Rows with no rate are skipped, so the empty rows a form always shows do
 * not become rates of nothing. Everything else is passed on as typed and
 * the service decides whether it is acceptable.
 */
export function cardTermsFromForm(read: Read) {
  const labourRates = [];
  for (let i = 0; i < LABOUR_ROWS; i += 1) {
    const rate = text(read, `rate${i}`);
    if (rate === "") continue;
    const minimum = text(read, `minimum${i}`);
    const increment = text(read, `increment${i}`);
    labourRates.push({
      jobTypeId: text(read, `trade${i}`) || null,
      band: (text(read, `band${i}`) || "standard") as rates.LabourBand,
      hourlyRate: rate,
      minimumMinutes: minimum === "" ? null : Number(minimum),
      incrementMinutes: increment === "" ? null : Number(increment),
    });
  }
  const materialMarkup = [];
  for (let i = 0; i < MARKUP_ROWS; i += 1) {
    const percent = fractionOf(text(read, `markup${i}`));
    if (percent === null) continue;
    const upTo = text(read, `upTo${i}`);
    materialMarkup.push({ upToCost: upTo === "" ? null : upTo, percent });
  }
  const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => read(`day${d}`) === "on");
  const start = minutesOf(text(read, "standardStart"));
  const end = minutesOf(text(read, "standardEnd"));
  const holidays = text(read, "holidays").split(/[\s,]+/).filter(Boolean);
  const trip = text(read, "tripCharge");
  return {
    labourRates,
    materialMarkup,
    tripCharge: trip === "" ? null : trip,
    standardDays: days,
    ...(start !== null ? { standardStartMinute: start } : {}),
    ...(end !== null ? { standardEndMinute: end } : {}),
    holidays,
  };
}

/**
 * A card's price list, pasted one line at a time:
 *
 *   CAP-45, Run capacitor supplied and fitted, 175.00
 *   CAP-45, Run capacitor, 175.00, 45      (allowing 45 minutes)
 *
 * The code is matched to one of our items when we have one with that code,
 * which makes it a deliberate mapping, and kept as the client's own code when
 * we do not. Tabs work as well as commas, because the schedule usually comes
 * out of a spreadsheet.
 */
export function cardLinesFromText(
  body: string, ourCodes: ReadonlyMap<string, string>,
): Array<{ externalCode: string | null; priceBookItemId: string | null; description: string; price: string; allowedMinutes: number | null }> {
  const amount = /^\$?\d+(\.\d+)?$/;
  return body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split(line.includes("\t") ? "\t" : ",").map((p) => p.trim());
    const code = parts.shift() ?? "";
    /**
     * Read from the end, because a description has commas in it ("motor,
     * supplied and fitted") and a price never does. Two numbers at the end
     * are the price and the minutes the card allows.
     */
    const minutes = parts.length >= 3 && /^\d+$/.test(parts[parts.length - 1]!) && amount.test(parts[parts.length - 2]!)
      ? parts.pop()! : "";
    const price = parts.pop() ?? "";
    const description = parts.join(", ");
    const itemId = ourCodes.get(code.toUpperCase()) ?? null;
    return {
      externalCode: itemId ? null : code || null,
      priceBookItemId: itemId,
      description: description || code,
      price: price.replace(/[$\s]/g, ""),
      allowedMinutes: minutes === "" ? null : Number(minutes),
    };
  });
}

/** The SLA rows of the contract form, as the contract service takes them. */
export function slaTermsFromForm(read: Read) {
  const terms: Array<{ kind: string; minutes: number; priority?: string }> = [];
  for (let i = 0; i < SLA_ROWS; i += 1) {
    const kind = text(read, `slaKind${i}`);
    const hours = text(read, `slaHours${i}`);
    if (kind === "" || hours === "") continue;
    const priority = text(read, `slaPriority${i}`);
    terms.push({
      kind,
      minutes: Math.round(Number(hours) * 60),
      ...(priority ? { priority } : {}),
    });
  }
  return terms;
}
