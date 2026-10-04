import * as m from "../money/index.js";
import * as time from "../time/index.js";
import { splitRecords } from "../catalogue/index.js";
import { containerDays } from "./index.js";

/**
 * THE REST OF A HIRE: GETTING IT BACK, AND GETTING PAID FOR IT
 *
 * `index.ts` is the arithmetic of a hire that has happened: container days
 * and the two meters. This is what an operator does with it afterwards, and
 * each of the three is a place the trade loses money in a way nothing on a
 * screen shows:
 *
 *   A HIRE DUE BACK THAT NOBODY COLLECTS. The can is owed back on the last
 *   day the price covers, and until something puts the collection on a
 *   driver's route it sits there earning days nobody may ever bill.
 *
 *   A PERIOD AND METERS NOBODY INVOICES. `bill` says what the meters read;
 *   this says what lines an invoice for the hire carries.
 *
 *   A SCALE TICKET RETYPED BY HAND. The facility sends a file of every load
 *   it weighed. Retyping a month of them is how 2.4 tons becomes 4.2.
 *
 * Pure, like the rest of this directory: dates and rows in, decisions out.
 */

/* --------------------------------------------------------------- collection */

/**
 * The day a hire is due back: the last calendar day its price covers, in the
 * company's timezone. A seven day hire delivered on the first is due back on
 * the seventh, because the first counts as a container day however late in
 * the afternoon the can was dropped. Null for a standing hire with no
 * included period, which is never "due back" on its own.
 */
export function collectionDueOn(deliveredAt: Date, includedDays: number | null, zone: string): string | null {
  if (includedDays === null) return null;
  let day = time.dateIn(deliveredAt, zone);
  for (let i = 1; i < Math.max(1, includedDays); i += 1) day = time.nextDay(day);
  return day;
}

export interface OpenHire {
  readonly id: string;
  readonly deliveredAt: Date | null;
  readonly includedDays: number | null;
  /** A collection already on the board for it. */
  readonly collectionVisitId: string | null;
}

export interface CollectionToSchedule {
  readonly rentalId: string;
  readonly dueOn: string;
  /** The day to put it on: the day it is due, or today when it is already late. */
  readonly collectOn: string;
  readonly daysLate: number;
}

export type CollectionSkip = { rentalId: string; reason: string };

/**
 * Which open hires to put on the route, up to and including `through`.
 *
 * A hire already given a collection is skipped, which is what makes running
 * the scheduler twice put one stop on the board rather than two. A hire with
 * no included period is skipped with the reason, because a standing can on a
 * commercial site goes back when the customer says so, not when a date
 * arrives.
 */
export function collectionsDue(input: {
  hires: readonly OpenHire[];
  through: string;
  today: string;
  zone: string;
}): { schedule: CollectionToSchedule[]; skipped: CollectionSkip[] } {
  const schedule: CollectionToSchedule[] = [];
  const skipped: CollectionSkip[] = [];
  for (const hire of input.hires) {
    if (hire.deliveredAt === null) {
      skipped.push({ rentalId: hire.id, reason: "It has no delivery date, so nothing says when it is due back." });
      continue;
    }
    const dueOn = collectionDueOn(hire.deliveredAt, hire.includedDays, input.zone);
    if (dueOn === null) {
      skipped.push({ rentalId: hire.id, reason: "It is a standing hire with no included period. It goes back when the customer asks." });
      continue;
    }
    if (dueOn > input.through) continue;
    if (hire.collectionVisitId !== null) {
      skipped.push({ rentalId: hire.id, reason: "A collection is already on the board for it." });
      continue;
    }
    const collectOn = dueOn < input.today ? input.today : dueOn;
    const daysLate = dueOn < input.today
      ? containerDays(time.startOfDayIn(dueOn, input.zone), time.startOfDayIn(input.today, input.zone), input.zone) - 1
      : 0;
    schedule.push({ rentalId: hire.id, dueOn, collectOn, daysLate });
  }
  schedule.sort((a, b) => a.collectOn.localeCompare(b.collectOn) || a.dueOn.localeCompare(b.dueOn));
  return { schedule, skipped };
}

/* ------------------------------------------------------------------ billing */

/**
 * THE RENTAL PERIOD, AS A LINE, when the hire is priced by the day.
 *
 * `daily_rate` is what each container day costs while it is inside the
 * included period, or for every day on a standing hire with none. Days past
 * the included period are the first meter in `bill` and are charged at the
 * overage rate there, never twice. A hire with no daily rate is priced by the
 * job's own line (a seven day flat rental from the price book), and has no
 * period line here: inventing one would bill the period twice.
 */
export function periodLine(input: {
  days: number;
  includedDays: number | null;
  dailyRate: string | null;
}): { days: number; rate: string; amount: string } | null {
  if (input.dailyRate === null) return null;
  const days = input.includedDays === null ? input.days : Math.min(input.days, input.includedDays);
  if (days <= 0) return null;
  return {
    days,
    rate: input.dailyRate,
    amount: m.toString(m.round(m.multiply(m.money(input.dailyRate), String(days)), 2)),
  };
}

/* ------------------------------------------------------------- scale tickets */

/**
 * A FACILITY'S FILE OF TICKETS
 *
 * Every landfill and transfer station that weighs a load can send the month
 * as a spreadsheet: ticket number, date, the can's number, and the weight.
 * Headers differ by facility, so each column is matched by every common
 * spelling, with case and punctuation ignored. The weight comes as net tons,
 * as net pounds, or as gross and tare in pounds, and all three are read.
 */
export interface TicketRow {
  line: number;
  ticketNumber: string;
  date: string;
  container: string;
  /** Net tons as a decimal string to four places. */
  netTons: string;
  material: string;
  facility: string;
  divertedTons: string | null;
}

export interface TicketProblem { line: number; message: string }

export const MAX_TICKET_ROWS = 5000;

const TICKET_COLUMNS = {
  ticket: ["ticket", "ticketnumber", "ticketno", "scaleticket", "ticketid", "ticketnum"],
  date: ["date", "ticketdate", "weighdate", "datein", "dateout", "transactiondate", "scaledate"],
  container: ["container", "containernumber", "containerno", "containerid", "can", "canno", "cannumber", "unit", "unitnumber", "unitno", "box", "boxnumber"],
  netTons: ["nettons", "nettonnage", "tons", "tonnage", "netton", "nettns"],
  netLb: ["netlb", "netlbs", "netpounds", "netweight", "netweightlb", "net"],
  grossLb: ["gross", "grosslb", "grosslbs", "grossweight", "grosspounds"],
  tareLb: ["tare", "tarelb", "tarelbs", "tareweight", "tarepounds"],
  material: ["material", "materialtype", "wastetype", "commodity", "product"],
  facility: ["facility", "site", "landfill", "transferstation", "location"],
  diverted: ["diverted", "divertedtons", "recycledtons", "recycled"],
} as const;

const header = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A date as a facility writes it: 2026-06-14, 6/14/2026 or 06/14/26. Day
 * first is refused rather than guessed, because 06/07 is June to one
 * facility and July to another and a ticket matched to the wrong week of a
 * hire is a charge on the wrong customer.
 */
export function ticketDate(raw: string): string | null {
  const text = raw.trim().split(/[ T]/)[0] ?? "";
  let y: number; let mo: number; let d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
  if (iso) { y = Number(iso[1]); mo = Number(iso[2]); d = Number(iso[3]); }
  else if (us) {
    mo = Number(us[1]); d = Number(us[2]);
    y = us[3]!.length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
  } else return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** A weight as written, thousands separators allowed. Null for anything else, never zero. */
function weight(raw: string): number | null {
  const text = raw.trim().replace(/,(?=\d{3}\b)/g, "");
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}

const tonsString = (tons: number) => tons.toFixed(4);

export function parseScaleTickets(text: string): { rows: TicketRow[]; problems: TicketProblem[] } {
  const records = splitRecords(text);
  const head = records[0];
  if (!head) return { rows: [], problems: [{ line: 1, message: "The file is empty." }] };
  const names = head.cells.map(header);
  const at = Object.fromEntries(
    Object.entries(TICKET_COLUMNS).map(([key, spellings]) => [key, names.findIndex((n) => (spellings as readonly string[]).includes(n))]),
  ) as Record<keyof typeof TICKET_COLUMNS, number>;

  const missing: string[] = [];
  if (at.ticket < 0) missing.push("ticket number");
  if (at.date < 0) missing.push("date");
  if (at.container < 0) missing.push("container number");
  const hasWeight = at.netTons >= 0 || at.netLb >= 0 || (at.grossLb >= 0 && at.tareLb >= 0);
  if (!hasWeight) missing.push("weight (net tons, net pounds, or gross and tare)");
  if (missing.length > 0) {
    return {
      rows: [],
      problems: [{ line: head.line, message: `The first line has to name the columns, and there is no ${missing.join(", ")} column.` }],
    };
  }
  const body = records.slice(1);
  if (body.length > MAX_TICKET_ROWS) {
    return { rows: [], problems: [{ line: head.line, message: `The file has ${body.length} tickets. Import at most ${MAX_TICKET_ROWS} at a time.` }] };
  }

  const cell = (cells: string[], index: number) => (index >= 0 ? (cells[index] ?? "").trim() : "");
  const rows: TicketRow[] = [];
  const problems: TicketProblem[] = [];
  for (const record of body) {
    const ticketNumber = cell(record.cells, at.ticket);
    const container = cell(record.cells, at.container);
    const rawDate = cell(record.cells, at.date);
    if (ticketNumber === "") { problems.push({ line: record.line, message: "No ticket number." }); continue; }
    if (container === "") { problems.push({ line: record.line, message: `Ticket ${ticketNumber} names no container.` }); continue; }
    const date = ticketDate(rawDate);
    if (date === null) {
      problems.push({ line: record.line, message: `Ticket ${ticketNumber} has a date of "${rawDate}", which is not a date in year, month, day or month/day/year order.` });
      continue;
    }

    let tons: number | null = null;
    let said = "";
    if (at.netTons >= 0 && cell(record.cells, at.netTons) !== "") {
      said = cell(record.cells, at.netTons);
      tons = weight(said);
    } else if (at.netLb >= 0 && cell(record.cells, at.netLb) !== "") {
      said = cell(record.cells, at.netLb);
      const lb = weight(said);
      tons = lb === null ? null : lb / 2000;
    } else if (at.grossLb >= 0 && at.tareLb >= 0) {
      const gross = weight(cell(record.cells, at.grossLb));
      const tare = weight(cell(record.cells, at.tareLb));
      said = `${cell(record.cells, at.grossLb)} gross, ${cell(record.cells, at.tareLb)} tare`;
      if (gross !== null && tare !== null) {
        if (tare > gross) {
          problems.push({ line: record.line, message: `Ticket ${ticketNumber} has a tare heavier than its gross (${said}).` });
          continue;
        }
        tons = (gross - tare) / 2000;
      }
    }
    if (tons === null) {
      problems.push({ line: record.line, message: `Ticket ${ticketNumber} has a weight of "${said}", which is not a number.` });
      continue;
    }
    const divertedRaw = cell(record.cells, at.diverted);
    const diverted = divertedRaw === "" ? null : weight(divertedRaw);
    if (divertedRaw !== "" && diverted === null) {
      problems.push({ line: record.line, message: `Ticket ${ticketNumber} has diverted tons of "${divertedRaw}", which is not a number.` });
      continue;
    }
    rows.push({
      line: record.line,
      ticketNumber,
      date,
      container,
      netTons: tonsString(tons),
      material: cell(record.cells, at.material),
      facility: cell(record.cells, at.facility),
      divertedTons: diverted === null ? null : tonsString(diverted),
    });
  }
  return { rows, problems };
}

/** One collected load, as the matcher sees it. */
export interface Haul {
  readonly rentalId: string;
  readonly container: string;
  /** The calendar day it was collected or swapped out, in the company's zone. */
  readonly collectedOn: string;
  readonly ticketNumber: string | null;
  readonly weightTons: string | null;
}

export type TicketPlan =
  | { line: number; action: "attach"; rentalId: string; row: TicketRow; why: string }
  | { line: number; action: "unchanged"; rentalId: string; row: TicketRow; why: string }
  | { line: number; action: "skip"; row: TicketRow; why: string };

const previousDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
const sameTons = (a: string, b: string) => Math.abs(Number(a) - Number(b)) < 0.005;

/**
 * WHICH HAUL EACH TICKET BELONGS TO.
 *
 * Matched on the can's number and the day: the haul that collected or swapped
 * out that can on the ticket's date, or the day before, because a load picked
 * up at four is often weighed the next morning. The same day is preferred.
 *
 * NOTHING IS OVERWRITTEN. A haul that already carries a different ticket, or
 * a typed weight that disagrees with the file, is skipped with both numbers
 * in the sentence: one of them is wrong, a person has to say which, and an
 * import that quietly replaced a weight somebody typed from the paper ticket
 * would make the file the truth by default.
 */
export function planTickets(rows: readonly TicketRow[], hauls: readonly Haul[]): TicketPlan[] {
  const plans: TicketPlan[] = [];
  const seenTickets = new Set<string>();
  const claimed = new Set<string>();
  const ticketOwner = new Map<string, Haul>();
  for (const haul of hauls) if (haul.ticketNumber) ticketOwner.set(haul.ticketNumber.toLowerCase(), haul);

  for (const row of rows) {
    const key = row.ticketNumber.toLowerCase();
    if (seenTickets.has(key)) {
      plans.push({ line: row.line, action: "skip", row, why: `Ticket ${row.ticketNumber} is in the file twice. Only the first is read.` });
      continue;
    }
    seenTickets.add(key);

    const container = row.container.toLowerCase();
    const sameDay = hauls.filter((h) => h.container.toLowerCase() === container && h.collectedOn === row.date);
    const dayBefore = hauls.filter((h) => h.container.toLowerCase() === container && h.collectedOn === previousDay(row.date));
    const candidates = [...sameDay, ...dayBefore];

    const owner = ticketOwner.get(key);
    if (owner) {
      if (candidates.some((h) => h.rentalId === owner.rentalId)) {
        if (owner.weightTons !== null && !sameTons(owner.weightTons, row.netTons)) {
          plans.push({
            line: row.line, action: "skip", row,
            why: `Ticket ${row.ticketNumber} is already on that haul at ${Number(owner.weightTons)} tons, and the file says ${Number(row.netTons)}. Check the paper ticket and correct the haul by hand.`,
          });
        } else {
          plans.push({ line: row.line, action: "unchanged", rentalId: owner.rentalId, row, why: `Ticket ${row.ticketNumber} is already recorded on this haul.` });
        }
      } else {
        plans.push({
          line: row.line, action: "skip", row,
          why: `Ticket ${row.ticketNumber} is already recorded on container ${owner.container}'s haul of ${owner.collectedOn}, not on ${row.container} on ${row.date}.`,
        });
      }
      claimed.add(owner.rentalId);
      continue;
    }

    const open = candidates.filter((h) => !claimed.has(h.rentalId));
    const haul = open[0];
    if (!haul) {
      plans.push({
        line: row.line, action: "skip", row,
        why: candidates.length > 0
          ? `Container ${row.container}'s haul on ${row.date} already has a ticket from earlier in this file.`
          : `No collection or swap of container ${row.container} on ${row.date} or the day before. Collect the hire first, or check the can number.`,
      });
      continue;
    }
    if (haul.ticketNumber !== null) {
      plans.push({
        line: row.line, action: "skip", row,
        why: `Container ${row.container}'s haul on ${haul.collectedOn} already carries ticket ${haul.ticketNumber}. Check which ticket is right.`,
      });
      claimed.add(haul.rentalId);
      continue;
    }
    if (haul.weightTons !== null && !sameTons(haul.weightTons, row.netTons)) {
      plans.push({
        line: row.line, action: "skip", row,
        why: `Container ${row.container}'s haul on ${haul.collectedOn} was typed in at ${Number(haul.weightTons)} tons and ticket ${row.ticketNumber} says ${Number(row.netTons)}. Check the paper ticket and correct the haul by hand.`,
      });
      claimed.add(haul.rentalId);
      continue;
    }
    claimed.add(haul.rentalId);
    plans.push({
      line: row.line, action: "attach", rentalId: haul.rentalId, row,
      why: `Container ${row.container}, collected ${haul.collectedOn}: ${Number(row.netTons)} tons on ticket ${row.ticketNumber}.`,
    });
  }
  return plans;
}
