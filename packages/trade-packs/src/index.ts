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

export const packs: TradePack[] = raw.map((p) => {
  const parsed = TradePackSchema.safeParse(p);
  if (!parsed.success) {
    throw new Error(`Trade pack "${p.id}" is invalid:\n${JSON.stringify(parsed.error.format(), null, 2)}`);
  }
  return parsed.data;
});

export const packById = (id: string) => packs.find((p) => p.id === id);
export const packIds = packs.map((p) => p.id);

/** What the setup wizard lists. Small on purpose: name, what it is, and scale. */
export const packSummaries = packs.map((p) => ({
  id: p.id,
  name: p.name,
  summary: p.summary,
  capacityModel: p.capacityModel,
  priceBookItems: p.priceBook.length,
  jobTypes: p.jobTypes.length,
}));
