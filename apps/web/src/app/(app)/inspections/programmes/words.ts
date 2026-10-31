import { packById } from "@opentradesos/trade-packs";

/** A trade pack by the name an owner knows it by: `plumbing@2` reads as "Plumbing". */
export function packName(tag: string | null): string {
  if (!tag) return "a trade pack";
  const id = tag.split("@")[0]!;
  return packById(id)?.name ?? id;
}

type CopiedFrom =
  | { kind: "trade_pack"; packId: string; packVersion: number; code: string; name: string }
  | { kind: "program"; programId: string; version: number; name: string };

/** Where a programme came from, in one sentence. */
export function sourceLine(p: { tradePackId: string | null; copiedFrom: CopiedFrom | null }): string {
  if (p.tradePackId) return `Set up by the ${packName(p.tradePackId)} trade pack.`;
  if (p.copiedFrom?.kind === "trade_pack") {
    return `Your own, copied from the ${packName(p.copiedFrom.packId)} trade pack's ${p.copiedFrom.name}.`;
  }
  if (p.copiedFrom?.kind === "program") return `Your own, copied from ${p.copiedFrom.name}, version ${p.copiedFrom.version}.`;
  return "Your own.";
}

/** The parts of a programme a version can change, as an owner would say them. */
export const PART: Record<string, string> = {
  name: "the name",
  standard: "the standard",
  reportAudience: "who gets the report",
  authorityName: "the authority",
  frequencyMonths: "how often",
  checkpoints: "the checkpoints",
};

/** How serious a fail is, as the backlog says it, with the deadline it sets. */
export const SEVERITY: Record<string, string> = {
  critical: "Safety: fix today",
  major: "Failed: fix within 30 days",
  minor: "Wearing out: fix within 180 days",
  advisory: "Worth knowing: no deadline",
};

export const AUDIENCE: Record<string, string> = {
  customer: "The customer",
  authority: "An authority",
  both: "The customer and an authority",
};
