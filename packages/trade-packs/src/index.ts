import { TradePack as TradePackSchema, type TradePack, type TradePackInput } from "./schema";
import { hvac } from "../packs/hvac";

export * from "./schema";

/**
 * Every pack, validated at import. A malformed pack fails the build rather
 * than seeding a broken company at setup time, which is when a contractor
 * would otherwise discover it.
 */
const raw: TradePackInput[] = [hvac];

export const packs: TradePack[] = raw.map((p) => {
  const parsed = TradePackSchema.safeParse(p);
  if (!parsed.success) {
    throw new Error(`Trade pack "${p.id}" is invalid:\n${JSON.stringify(parsed.error.format(), null, 2)}`);
  }
  return parsed.data;
});

export const packById = (id: string) => packs.find((p) => p.id === id);
export const packIds = packs.map((p) => p.id);
