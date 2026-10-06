import { automation, events } from "@opentradesos/core";
import { TradePack as TradePackSchema, type TradePack, type TradePackInput } from "./schema";
import { hvac } from "../packs/hvac";
import { plumbing } from "../packs/plumbing";
import { electrical } from "../packs/electrical";
import { lawnAndLandscape } from "../packs/lawn-and-landscape";
import { pestControl } from "../packs/pest-control";
import { cleaning } from "../packs/cleaning";
import { dumpsterRental } from "../packs/dumpster-rental";
import { trashBinCleaning } from "../packs/trash-bin-cleaning";

export * from "./schema";

/**
 * Every pack, validated at import.
 *
 * A malformed pack fails the build rather than seeding a broken company at
 * setup time, which is when a contractor would otherwise discover it, halfway
 * through their first hour with the product.
 */
const raw: TradePackInput[] = [hvac, plumbing, electrical, lawnAndLandscape, pestControl, cleaning, dumpsterRental, trashBinCleaning];

export const packs: TradePack[] = raw.map((p) => loadPack(p));

/**
 * One pack, checked. The schema says its shape; its recommended automations
 * are then held to what this build can run, so an automation naming a step,
 * an event or a question that does not exist fails here, at load, and never
 * on a company's "Turn on".
 */
export function loadPack(p: TradePackInput): TradePack {
  const parsed = TradePackSchema.safeParse(p);
  if (!parsed.success) {
    throw new Error(`Trade pack "${p.id}" is invalid:\n${JSON.stringify(parsed.error.format(), null, 2)}`);
  }
  const problems = parsed.data.automations.flatMap((seed) => {
    const checked = automation.checkPackAutomation(parsed.data.id, seed, events.SUBSCRIBABLE);
    return checked.ok ? [] : checked.problems;
  });
  const keys = parsed.data.automations.map((seed) => seed.key);
  for (const key of new Set(keys.filter((key, index) => keys.indexOf(key) !== index))) {
    problems.push(`${parsed.data.id} automation "${key}" is declared twice.`);
  }
  if (problems.length > 0) throw new Error(`Trade pack "${p.id}" is invalid:\n${problems.join("\n")}`);
  return parsed.data;
}

/**
 * Every recommended automation the packs declare, checked and keyed
 * `<pack id>.<key>`. What `/automations` offers beside the built in four,
 * to a company that applied the pack.
 */
export const packAutomations: automation.PackAutomation[] = packs.flatMap((pack) =>
  pack.automations.map((seed) => {
    const checked = automation.checkPackAutomation(pack.id, seed, events.SUBSCRIBABLE);
    if (!checked.ok) throw new Error(checked.problems.join("\n"));
    return checked.template;
  }));

export const packById = (id: string) => packs.find((p) => p.id === id);
export const packIds = packs.map((p) => p.id);

/** What the setup wizard lists. Small on purpose: name, what it is, and scale. */
export const packSummaries = packs.map((p) => ({
  id: p.id,
  name: p.name,
  summary: p.summary,
  priceBookItems: p.priceBook.length,
  jobTypes: p.jobTypes.length,
}));
