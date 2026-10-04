/**
 * WHAT A CUSTOMER'S ACCOUNT SHOWS, BY TRADE
 *
 * A trade pack declares the blocks its customers care about, in the order
 * they care about them (`portalBlocks` in the pack, seeded as the company's
 * portal layout when the pack is applied): a pest control customer wants
 * what was applied and when it is safe to let the dog out, a lawn customer
 * the season's visits, an HVAC customer their systems and filter sizes. The
 * account page draws whatever the layout says, in its order, and nothing in
 * the page knows which trade it is drawing for.
 *
 * A few things every account has whatever the trade: what is coming, what
 * was done, the bills, the plan and the equipment at the house. When a
 * layout does not name one of those, it is added after the layout's own
 * blocks, so a company with no pack (or a pack that forgot) still shows a
 * customer their history.
 *
 * Pure: the layout in, the blocks to draw out.
 */

export const PORTAL_BLOCK_KINDS = [
  "visit_timeline", "service_report", "readings_trend", "equipment_register",
  "checklist_results", "photo_gallery", "documents", "invoices", "payments",
  "plan_status", "next_visit", "recommended_work", "referral", "contact_card",
] as const;

export type PortalBlockKind = (typeof PORTAL_BLOCK_KINDS)[number];

export interface PortalBlock {
  kind: PortalBlockKind;
  /** The heading, the pack's own words when it gave some. */
  title: string;
  config: Record<string, unknown>;
  /** False for a block added because every account has one, rather than because the layout asked. */
  declared: boolean;
}

/** The heading a block gets when the layout gives none, in a customer's words. */
export const BLOCK_TITLES: Record<PortalBlockKind, string> = {
  visit_timeline: "Service history",
  service_report: "What we did",
  readings_trend: "Readings over time",
  equipment_register: "Your equipment",
  checklist_results: "What we checked last visit",
  photo_gallery: "Photos",
  documents: "Your documents",
  invoices: "Invoices",
  payments: "Payments",
  plan_status: "Your plan",
  next_visit: "Coming up",
  recommended_work: "What we recommend",
  referral: "Refer a friend",
  contact_card: "Your team",
};

/** Shown on every account, in this order after the layout's own, when the layout leaves them out. */
export const ALWAYS_SHOWN: readonly PortalBlockKind[] = [
  "next_visit", "visit_timeline", "invoices", "plan_status", "equipment_register",
];

const isKind = (value: unknown): value is PortalBlockKind =>
  typeof value === "string" && (PORTAL_BLOCK_KINDS as readonly string[]).includes(value);

/**
 * The blocks to draw, in order.
 *
 * Hidden blocks and kinds this version does not know are dropped rather
 * than guessed at; a kind named twice is drawn once, where it first
 * appears, because two "Coming up" boxes is a page that looks broken.
 */
export function composeBlocks(
  declared: readonly { kind: string; title?: string | null; config?: unknown; visible?: boolean }[],
): PortalBlock[] {
  const out: PortalBlock[] = [];
  for (const block of declared) {
    if (block.visible === false || !isKind(block.kind)) continue;
    if (out.some((b) => b.kind === block.kind)) continue;
    const title = block.title?.trim();
    out.push({
      kind: block.kind,
      title: title || BLOCK_TITLES[block.kind],
      config: block.config && typeof block.config === "object" && !Array.isArray(block.config)
        ? block.config as Record<string, unknown>
        : {},
      declared: true,
    });
  }
  for (const kind of ALWAYS_SHOWN) {
    if (!out.some((b) => b.kind === kind)) {
      out.push({ kind, title: BLOCK_TITLES[kind], config: {}, declared: false });
    }
  }
  return out;
}

/**
 * The reading keys a trend block asks for, from its config.
 *
 * At most six, because a customer reading more than six lines of numbers
 * is not reading them. Empty when the block names none, and then the page
 * shows every reading the company marked customer visible.
 */
export function readingKeys(config: Record<string, unknown>): string[] {
  const keys = config["keys"];
  if (!Array.isArray(keys)) return [];
  return [...new Set(keys.filter((k): k is string => typeof k === "string" && k.trim() !== "").map((k) => k.trim()))]
    .slice(0, 6);
}

/**
 * An equipment attribute's key as a heading, when the pack gives no label
 * for it: `filter_size` reads "Filter size".
 */
export function attributeLabel(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
