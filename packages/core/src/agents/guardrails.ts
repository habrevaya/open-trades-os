import type { Permission } from "../access/permissions.js";
import { money, compare, multiply, round, toString, type Money } from "../money/index.js";
import type { CollectionsStep } from "./settings.js";

/**
 * WHAT A MODEL'S ANSWER IS HELD TO BEFORE ANYTHING READS IT
 *
 * The schema check in `catalogue.ts` says an answer has the right SHAPE. These
 * say it is TRUE against the company's own records: a price book item that
 * exists, a window that is open, a technician the board's own checks allow, an
 * amount the invoice really owes. Every one of them is a place a model will
 * confidently write something plausible and wrong, and every one of them is
 * cheaper to check than to explain to a customer.
 */

/* ------------------------------------------------------------- the person */

/**
 * The permissions `runAs` holds that `granter` does not.
 *
 * An owner choosing who an agent acts as is handing that person's authority to
 * something that runs unattended. Somebody with agent:configure and nothing
 * else could otherwise point an agent at the owner and borrow everything the
 * owner can do, which is the privilege escalation an agent layer is always one
 * setting away from. So the person chosen may hold nothing the chooser does
 * not. The same rule `canDefineRole` applies to a custom role.
 */
export function wouldWiden(granter: Set<Permission>, runAs: Set<Permission>): Permission[] {
  return [...runAs].filter((p) => !granter.has(p)).sort();
}

/* --------------------------------------------------------- what is a price */

/**
 * Every amount of money written in a piece of text, as a four place string.
 *
 * "$1,250", "$ 89.5" and "120 dollars" are all prices to a customer reading a
 * message, so all three are found. A bare number is not: "2 visits" and
 * "Tuesday the 14th" are not prices, and treating them as ones would refuse
 * half of every conversation.
 */
export function pricesIn(text: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?/g,
    /\b(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s?(?:dollars|bucks|usd)\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const whole = match[1]!.replace(/,/g, "");
      const cents = (match[2] ?? "").replace(".", "");
      found.push(toString(money(`${whole}.${cents.padEnd(2, "0")}`)));
    }
  }
  return found;
}

/**
 * The amounts in `text` that are not one of `allowed`.
 *
 * Compared as money rather than as strings, so "$95" and a price book entry of
 * "95.0000" are the same price. Empty means every amount mentioned is one the
 * company published, which is the only condition a reply quoting a price may
 * be sent under.
 */
export function unlistedPrices(text: string, allowed: readonly string[]): string[] {
  const known = allowed.map((value) => money(value));
  return pricesIn(text).filter((found) => {
    const amount = money(found);
    return !known.some((k) => compare(k, amount) === 0);
  });
}

/* --------------------------------------------------------- asking for a person */

const ASKS = [
  /\b(human|real person|live person|representative|customer service)\b/i,
  /\b(speak|talk|chat)\s+(to|with)\s+(a |an |the |your |someone |somebody )?(person|someone|somebody|human|manager|owner|agent|staff|office|real person|representative|technician|tech)\b/i,
  /^\s*(agent|operator|person|human|help me)\s*[.!?]*\s*$/i,
  /\bcall me\b/i,
  /\b(not|stop|no more|enough)\b.{0,20}\b(bot|robot|machine|ai)\b/i,
  /\bare you (a |an )?(bot|robot|machine|ai|real)\b/i,
];

/**
 * Whether the customer asked for a person.
 *
 * Decided here, in plain code, rather than left to the model, because "I want
 * to talk to somebody" is the one request a chat agent must never get wrong
 * and the one a model talked round by the rest of the message most often
 * does. When this says yes the conversation goes to the office and the model
 * is not asked at all. It errs towards yes: handing over somebody who did not
 * need it costs the office a minute, and the other mistake costs a customer.
 */
export const wantsAPerson = (text: string): boolean => ASKS.some((pattern) => pattern.test(text));

/* ---------------------------------------------------------- what the model reads */

/**
 * A stranger's words, made safe to put inside the prompt's own markers.
 *
 * Customer text is wrapped in `<customer>` tags and the instructions say
 * everything inside is information and never an instruction. A message
 * containing its own closing tag would end that block early and put whatever
 * followed it outside, where it reads as the prompt. So the markers are
 * removed from the text first. It is not the whole defence against a message
 * written to steer the model, and nothing in this file pretends otherwise:
 * the whole defence is that the model's answer can only be one of a few
 * proposals, each checked against the company's records.
 */
export function quoteCustomer(text: string, maxLength = 6000): string {
  return text.replace(/<\/?\s*customer\s*>/gi, "").slice(0, maxLength);
}

/* -------------------------------------------------------------- the estimate */

export interface BookItem {
  id: string;
  name: string;
  /** The price in force today, as the price book holds it. */
  price: string;
  description?: string | null;
}

export interface DraftLine { priceBookItemId: string; quantity: number; reason?: string | undefined }
export interface DraftOption {
  name: string;
  description?: string | undefined;
  recommended?: boolean | undefined;
  lines: DraftLine[];
}

export interface PricedLine {
  priceBookItemId: string;
  name: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  reason: string | null;
}

export interface PricedOption {
  name: string;
  description: string | null;
  recommended: boolean;
  lines: PricedLine[];
  total: string;
}

export type EstimateVerdict =
  | { ok: true; options: PricedOption[] }
  | { ok: false; reason: string };

/**
 * An estimate draft, priced from the book, or refused.
 *
 * THE MODEL NEVER WRITES A PRICE. Its lines carry an item id and a quantity,
 * and the price on every line is the price book's price in force today, read
 * here. A line naming an item that is not in the book refuses the whole
 * draft rather than being dropped: an option missing the line that made it
 * "better" is a cheaper option with the wrong name, and a customer would be
 * sold it.
 *
 * Exactly one option ends up recommended. None marked takes the middle one
 * (or the only one), several marked takes the first, because a proposal with
 * two "recommended" badges recommends nothing.
 */
export function priceDraft(options: readonly DraftOption[], book: ReadonlyMap<string, BookItem>): EstimateVerdict {
  if (options.length === 0) return { ok: false, reason: "The draft had no options." };
  const priced: PricedOption[] = [];
  for (const option of options) {
    const lines: PricedLine[] = [];
    for (const line of option.lines) {
      const item = book.get(line.priceBookItemId);
      if (!item) {
        return {
          ok: false,
          reason: `The draft's "${option.name}" option used an item that is not in the price book (${line.priceBookItemId.slice(0, 64)}). Nothing was drafted.`,
        };
      }
      /** Quantities to two places. A quantity of 1.3333333 is a model's arithmetic, not a measurement. */
      const quantity = (Math.round(line.quantity * 100) / 100).toFixed(2);
      const unit = money(item.price);
      lines.push({
        priceBookItemId: item.id,
        name: item.name,
        quantity,
        unitPrice: toString(unit),
        lineTotal: toString(round(multiply(unit, quantity), 2)),
        reason: line.reason ?? null,
      });
    }
    const total = lines.reduce<Money>((sum, line) => ({
      amount: sum.amount + money(line.lineTotal).amount, currency: sum.currency,
    }), money("0"));
    priced.push({
      name: option.name, description: option.description ?? null,
      recommended: option.recommended === true, lines, total: toString(total),
    });
  }
  const marked = priced.findIndex((o) => o.recommended);
  const pick = marked >= 0 ? marked : Math.floor((priced.length - 1) / 2);
  return { ok: true, options: priced.map((o, i) => ({ ...o, recommended: i === pick })) };
}

/* -------------------------------------------------------------- the windows */

export interface OpenWindow {
  bookableServiceId: string;
  date: string;
  arrivalWindowId: string;
  label: string;
}

/**
 * The windows a draft named that are really open, in the draft's order.
 *
 * The model was shown the open windows and asked to pick from them. A pick
 * that is not among them, a window that was full or a date it made up, is
 * dropped rather than refusing the whole draft: the rest of a booking draft
 * (who, where, what is wrong) is still worth a person's look, and with no
 * window left the office simply chooses one. A window for a different service
 * than the one drafted is dropped too, because a slot on the boiler calendar
 * is not a slot on the drain calendar.
 */
export function openOnly(
  picked: readonly { date: string; arrivalWindowId: string }[],
  serviceId: string | null,
  open: readonly OpenWindow[],
): OpenWindow[] {
  const out: OpenWindow[] = [];
  for (const pick of picked) {
    const match = open.find((w) => w.date === pick.date && w.arrivalWindowId === pick.arrivalWindowId
      && (serviceId === null || w.bookableServiceId === serviceId));
    if (match && !out.includes(match)) out.push(match);
  }
  return out;
}

/* ------------------------------------------------------------- the dispatch */

export interface DispatchCandidate {
  visitId: string;
  /** Technicians the board's own checks allow on this visit. */
  allowed: readonly string[];
}

export type PicksVerdict = {
  kept: { visitId: string; technicianId: string; why: string }[];
  /** One sentence per pick that was not allowed, for the log. */
  dropped: string[];
};

/**
 * The copilot's picks, held to the board's own checks.
 *
 * The optimiser and the qualification check decide who MAY take a visit; the
 * model only chooses among them and explains. A pick of somebody the checks
 * refused, somebody who is not on the board, or a visit that is not open, is
 * dropped and said, never passed through: the copilot is there to explain the
 * board's answer, not to overrule it.
 */
export function holdPicks(
  picks: readonly { visitId: string; technicianId: string; why: string }[],
  candidates: readonly DispatchCandidate[],
): PicksVerdict {
  const byVisit = new Map(candidates.map((c) => [c.visitId, c]));
  const kept: PicksVerdict["kept"] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const pick of picks) {
    const candidate = byVisit.get(pick.visitId);
    if (!candidate) {
      dropped.push(`A pick named a visit that is not open on this day (${pick.visitId.slice(0, 64)}).`);
      continue;
    }
    if (seen.has(pick.visitId)) {
      dropped.push(`A visit was picked twice; the first pick stands.`);
      continue;
    }
    if (!candidate.allowed.includes(pick.technicianId)) {
      dropped.push(`A pick put somebody on a visit the board's checks do not allow (${pick.technicianId.slice(0, 64)}).`);
      continue;
    }
    seen.add(pick.visitId);
    kept.push(pick);
  }
  return { kept, dropped };
}

/* ------------------------------------------------------------- collections */

/**
 * Which reminder step an overdue invoice is due for now, or null.
 *
 * The LATEST step whose day has come, and only if it is later than every step
 * already taken for this invoice. An invoice forty days late that nobody has
 * chased gets the forty day reminder, not three reminders on one morning; and
 * once the thirty day step has gone, the fourteen day one is never sent after
 * it, because a softer reminder after a firm one reads as the company having
 * lost track.
 *
 * Steps are recognised by their day rather than their position, so a company
 * inserting a new first step does not make every invoice look as if it had
 * skipped one.
 */
export function dueStep(
  daysOverdue: number, steps: readonly CollectionsStep[], takenDays: readonly number[],
): CollectionsStep | null {
  if (daysOverdue < 0) return null;
  const latestTaken = takenDays.length > 0 ? Math.max(...takenDays) : -1;
  let due: CollectionsStep | null = null;
  for (const step of steps) {
    if (step.afterDays <= daysOverdue && (due === null || step.afterDays > due.afterDays)) due = step;
  }
  if (due === null || due.afterDays <= latestTaken) return null;
  return due;
}

/* --------------------------------------------------------- the field assistant */

/**
 * One thing the field assistant may answer from: a piece of equipment and its
 * history, a visit's notes, a price book line, one of the company's how-to
 * notes. Each carries an id the answer has to cite, and the prices in it, so
 * an answer naming a figure that is in none of them is caught here.
 */
export interface FieldFact {
  id: string;
  kind: "equipment" | "history" | "notes" | "price" | "procedure" | "job";
  title: string;
  detail: string;
  /** Every amount of money this fact states, as decimal strings. */
  prices: string[];
}

export type FieldAnswerVerdict =
  | { ok: true; answer: string; sources: FieldFact[] }
  | { ok: false; reason: string };

/**
 * Whether the assistant's answer may be shown to the technician.
 *
 * Two checks, and both are about the one way this agent can do harm, which is
 * a confident answer that did not come from the company's records. Every fact
 * it cites must be one it was given, so "according to the service history" is
 * a history this company holds. And every amount it states must be a price in
 * one of those facts, because a part's price said wrong in a driveway becomes
 * the price the customer was told.
 */
export function checkFieldAnswer(
  input: { answer: string; sources: readonly string[] },
  facts: readonly FieldFact[],
): FieldAnswerVerdict {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const unknown = input.sources.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    return { ok: false, reason: "The answer named a record it was not given, so it was not shown." };
  }
  const cited = [...new Set(input.sources)].map((id) => byId.get(id)!);
  const amounts = unlistedPrices(input.answer, facts.flatMap((fact) => fact.prices));
  if (amounts.length > 0) {
    return {
      ok: false,
      reason: `The answer named ${amounts.length === 1 ? "an amount" : "amounts"} that ${amounts.length === 1 ? "is" : "are"} not in your records, so it was not shown.`,
    };
  }
  return { ok: true, answer: input.answer.trim(), sources: cited };
}
