import type { PriceBookEntry, ReportField } from "./wire";

/**
 * A PRODUCT APPLIED, CHOSEN FROM THE BOOK
 *
 * A report's chemical question (product applied, the amount) used to be typed
 * by name, and a name cannot be costed: pest control's chemical cost per stop
 * values what was applied at the price book's cost on the day. So the phone
 * and "My day" offer the chemicals the company marks in its price book, each
 * with the unit its cost is per and its EPA number, and the technician types
 * only how much. The server carries the book's name, number and unit onto the
 * regulated record whatever the phone sent beside them.
 *
 * A product the book does not hold is still typed, as it always was, and the
 * record keeps it; it is shown on the scorecard beside the figure, never
 * valued from its name.
 */

export interface ChemicalChoice {
  id: string;
  code: string | null;
  name: string;
  /** What its cost is per, and so the unit the amount is typed in unless another is picked. */
  unit: string;
  epaRegistrationNumber: string | null;
  /** The units it is bought and used in, when they differ: an application can be recorded in either. */
  units: { buy: string; use: string } | null;
}

/** The chemicals in the book the phone holds, by name. */
export function chemicalsIn(book: readonly PriceBookEntry[]): ChemicalChoice[] {
  return book
    .filter((item) => item.chemical)
    .map((item) => ({
      id: item.id, code: item.code, name: item.name,
      unit: item.chemical!.unit, epaRegistrationNumber: item.chemical!.epaRegistrationNumber,
      units: item.chemical!.units ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The chemicals matching what was typed, by every word in the name or the
 * code, so "bif" finds "Bifen IT". With nothing typed, the first few, because
 * most companies carry a handful and the technician should see them.
 */
export function searchChemicals(chemicals: readonly ChemicalChoice[], query: string, limit = 8): ChemicalChoice[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return chemicals
    .filter((c) => words.every((w) => c.name.toLowerCase().includes(w) || (c.code ?? "").toLowerCase().includes(w)))
    .slice(0, limit);
}

/** No application is this big; the server refuses a non positive amount and this catches a slip of the thumb first. */
export const MOST_APPLIED = 1_000_000;

/** How much was applied, as typed, checked as the server checks it, or what is wrong in words. */
export function checkApplied(typed: string): { ok: true; quantity: string } | { ok: false; problem: string } {
  const text = typed.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,4})?$/.test(text) || !/[1-9]/.test(text)) {
    return { ok: false, problem: "Type how much was applied as a number, like 1.5." };
  }
  if (Number(text) > MOST_APPLIED) return { ok: false, problem: "That is more than one visit applies. Check the amount." };
  return { ok: true, quantity: text };
}

/** A unit as two spellings of it are compared, as the server compares them: "Gal " is "gal". */
const sameUnit = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The units an application of this chemical can be recorded in: its own (what
 * its cost is per) first, then the use and the buy unit of a chemical bought in
 * one and used in another, each once. One unit for anything else, so there is
 * nothing to pick.
 */
export function applicationUnits(chemical: ChemicalChoice): string[] {
  const all = [chemical.unit, ...(chemical.units ? [chemical.units.use, chemical.units.buy] : [])];
  return all.filter((unit, i) => all.findIndex((other) => sameUnit(other, unit)) === i);
}

/**
 * The unit an application is recorded in, exactly as the server and the
 * office's visit page decide it: the one picked when it is the chemical's buy
 * or use unit, spelt as the book spells it, and otherwise the chemical's own.
 * The amount is recorded as typed in that unit, never converted on the phone;
 * the server values it at the cost, or the cost over how many use units are in
 * a buy unit, as it does for the office.
 */
export function applicationUnitOf(chemical: ChemicalChoice, picked?: string | undefined): string {
  if (picked === undefined || !chemical.units) return chemical.unit;
  if (sameUnit(picked, chemical.units.buy)) return chemical.units.buy;
  if (sameUnit(picked, chemical.units.use)) return chemical.units.use;
  return chemical.unit;
}

/**
 * The payload of a `service_report.set_field` recording a product chosen from
 * the book, as the answer to one chemical question. The name, EPA number and
 * unit are sent so the screen shows them with no signal; the server replaces
 * them with the book's own, keeping the unit picked when it is the buy or the
 * use unit.
 */
export function applicationFromBook(
  question: Pick<ReportField, "key" | "label">, chemical: ChemicalChoice, quantity: string, unit?: string | undefined,
): Record<string, unknown> {
  return {
    field: question.key, label: question.label, kind: "chemical",
    value: chemical.name,
    priceBookItemId: chemical.id,
    productName: chemical.name,
    ...(chemical.epaRegistrationNumber ? { epaRegistrationNumber: chemical.epaRegistrationNumber } : {}),
    quantityApplied: quantity,
    applicationUnit: applicationUnitOf(chemical, unit),
  };
}
