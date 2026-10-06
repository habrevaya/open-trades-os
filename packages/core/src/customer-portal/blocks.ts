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
 * Never hidden, whatever a layout says: the bills. A customer's account that
 * does not show what they owe is one they ring the office about, and the pay
 * button lives in it. The office can move it and rename it.
 */
export const NEVER_HIDDEN: readonly PortalBlockKind[] = ["invoices"];

/**
 * The blocks to draw, in order.
 *
 * Kinds this version does not know are dropped rather than guessed at; a
 * kind named twice is decided where it first appears, shown or hidden,
 * because two "Coming up" boxes is a page that looks broken and a block the
 * office hid must not come back because a second pack named it. A hidden
 * block is left out, and is not put back as one every account shows: the
 * office hid it on purpose. Only the bills are drawn even when hidden.
 */
export function composeBlocks(
  declared: readonly { kind: string; title?: string | null; config?: unknown; visible?: boolean }[],
): PortalBlock[] {
  const out: PortalBlock[] = [];
  const seen = new Set<PortalBlockKind>();
  for (const block of declared) {
    if (!isKind(block.kind) || seen.has(block.kind)) continue;
    seen.add(block.kind);
    if (block.visible === false && !NEVER_HIDDEN.includes(block.kind)) continue;
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
    if (!seen.has(kind)) {
      out.push({ kind, title: BLOCK_TITLES[kind], config: {}, declared: false });
    }
  }
  return out;
}

/* ------------------------------------------- the office arranging the page */

/** A heading short enough to sit on one line on a phone. */
export const MAX_TITLE = 60;

export interface ArrangedBlock {
  kind: PortalBlockKind;
  /** The office's own heading, or null for the usual one. */
  title: string | null;
  visible: boolean;
  config: Record<string, unknown>;
}

export interface LayoutRow {
  kind: PortalBlockKind;
  /** What the customer sees as the heading. */
  title: string;
  /** The office's own words, when it gave some. */
  customTitle: string | null;
  visible: boolean;
  /** Whether it can be hidden at all. */
  hideable: boolean;
  config: Record<string, unknown>;
}

/**
 * Every block a company could show, in the order the account page would draw
 * them now, shown ones first and then the ones it does not show. What the
 * office edits on the settings screen: the page as the customer sees it,
 * with every block it could add beside it.
 */
export function layoutRows(
  declared: readonly { kind: string; title?: string | null; config?: unknown; visible?: boolean }[],
): LayoutRow[] {
  const drawn = composeBlocks(declared);
  const byKind = new Map<string, { title?: string | null; config?: unknown; visible?: boolean }>();
  for (const block of declared) if (isKind(block.kind) && !byKind.has(block.kind)) byKind.set(block.kind, block);
  const custom = (kind: PortalBlockKind) => {
    const title = byKind.get(kind)?.title?.trim();
    return title && title !== BLOCK_TITLES[kind] ? title : null;
  };
  const configOf = (kind: PortalBlockKind) => {
    const config = byKind.get(kind)?.config;
    return config && typeof config === "object" && !Array.isArray(config) ? config as Record<string, unknown> : {};
  };
  const rows: LayoutRow[] = drawn.map((b) => ({
    kind: b.kind, title: b.title, customTitle: custom(b.kind), visible: true,
    hideable: !NEVER_HIDDEN.includes(b.kind), config: b.config,
  }));
  for (const kind of PORTAL_BLOCK_KINDS) {
    if (rows.some((r) => r.kind === kind)) continue;
    rows.push({
      kind, title: custom(kind) ?? BLOCK_TITLES[kind], customTitle: custom(kind), visible: false,
      hideable: true, config: configOf(kind),
    });
  }
  return rows;
}

export type ArrangeCheck = { ok: true; blocks: ArrangedBlock[] } | { ok: false; reason: string };

/**
 * The office's arrangement, checked: every block once, in the order given,
 * each shown or hidden, with a heading of the office's own or none.
 *
 * Every kind is named, hidden ones included, so what is saved says the whole
 * page and a block nobody mentioned cannot appear on it later. The bills
 * cannot be hidden. A heading the same as the usual one is stored as none,
 * so a later change to the usual words reaches it. A block's settings (which
 * readings a trend shows) are kept from the layout it came from; this screen
 * does not change them.
 */
export function arrangeLayout(
  requested: readonly { kind: string; title?: string | null; visible: boolean }[],
  current: readonly LayoutRow[],
): ArrangeCheck {
  const seen = new Set<string>();
  const blocks: ArrangedBlock[] = [];
  for (const row of requested) {
    if (!isKind(row.kind)) return { ok: false, reason: `There is no part of the page called ${row.kind}.` };
    if (seen.has(row.kind)) return { ok: false, reason: `${BLOCK_TITLES[row.kind]} is on the list twice.` };
    seen.add(row.kind);
    if (!row.visible && NEVER_HIDDEN.includes(row.kind)) {
      return { ok: false, reason: `${BLOCK_TITLES[row.kind]} cannot be hidden: customers need to see what they owe. You can move it or rename it.` };
    }
    const title = (row.title ?? "").replace(/\s+/g, " ").trim();
    if (title.length > MAX_TITLE) {
      return { ok: false, reason: `Keep a heading to ${MAX_TITLE} characters. "${title.slice(0, 20)}..." is ${title.length}.` };
    }
    blocks.push({
      kind: row.kind,
      title: title === "" || title === BLOCK_TITLES[row.kind] ? null : title,
      visible: row.visible,
      config: current.find((c) => c.kind === row.kind)?.config ?? {},
    });
  }
  const missing = PORTAL_BLOCK_KINDS.filter((kind) => !seen.has(kind));
  if (missing.length > 0) {
    return { ok: false, reason: `Say whether to show ${missing.map((k) => BLOCK_TITLES[k]).join(", ")}.` };
  }
  return { ok: true, blocks };
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
