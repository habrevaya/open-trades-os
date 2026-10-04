/**
 * A SANDBOX COMPANY, DECIDED WITHOUT THE DATABASE
 *
 * An owner who wants to try an automation, a new kind of record or a
 * proposal layout should not have to try it on real customers. A sandbox is
 * a second company holding a copy of the first one's configuration and none
 * of its customers, with optional sample work whose people and addresses are
 * invented, and a way to carry chosen settings back once they work.
 *
 * What is decided here: what a sandbox is called (so nobody mistakes it for
 * the real thing), what its sample people look like (so nothing in it can
 * reach a real person), and what copying a setting back would do to the real
 * company, item by item, before it does it.
 */

/** The kinds of setting that can be copied back, in the order they are applied. */
export const SETTING_KINDS = ["custom_object", "custom_field", "proposal_template", "workflow"] as const;
export type SettingKind = (typeof SETTING_KINDS)[number];

export const SETTING_LABEL: Record<SettingKind, string> = {
  custom_object: "Kind of record",
  custom_field: "Custom field",
  proposal_template: "Proposal layout",
  workflow: "Automation",
};

/** The name a sandbox goes by, everywhere its company name is printed. */
export const sandboxName = (name: string): string => `${name} (sandbox)`;

export const sandboxSlug = (slug: string): string => `${slug.slice(0, 40)}-sandbox`;

/** How many sample jobs a sandbox is given at most. Enough to try an automation on; not a copy of the book. */
export const MAX_SAMPLE = 25;

/**
 * A SAMPLE CUSTOMER, ANONYMISED BY CONSTRUCTION.
 *
 * Nothing about the real customer is carried but the town their address is
 * in, which is what lets a dispatch or tax rule be tried against the right
 * area. The name is a number, the street is invented, the email is at
 * `example.com` (reserved, so nothing sent there reaches anybody) and the
 * phone number is in the 555-01xx block set aside for fiction, so an
 * automation that texts a sample customer cannot text a person.
 */
export function sampleCustomer(index: number, from: { city?: string | null; state?: string | null; postalCode?: string | null }) {
  const n = index + 1;
  return {
    name: `Sample customer ${n}`,
    email: `sample${n}@example.com`,
    phone: `+1512555${String(100 + (index % 100)).padStart(4, "0")}`,
    addressLine1: `${100 + n} Sample Street`,
    city: from.city ?? null,
    state: from.state ?? null,
    postalCode: from.postalCode ?? null,
  };
}

export interface SettingItem {
  kind: SettingKind;
  /** What makes it the same setting in both companies: a field's entity and key, a name. */
  naturalKey: string;
  label: string;
  /** Everything that would be written, so equal means copying it changes nothing. */
  content: unknown;
}

export type CopyAction = "create" | "update" | "same";

export interface CopyPlanItem {
  kind: SettingKind;
  naturalKey: string;
  label: string;
  action: CopyAction;
}

/** A stable rendering for comparison: object keys sorted, so key order is not a difference. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export const itemId = (item: Pick<SettingItem, "kind" | "naturalKey">): string => `${item.kind}:${item.naturalKey}`;

/**
 * WHAT COPYING THE CHOSEN SETTINGS BACK WOULD DO, before it does it.
 *
 * Matched by what makes a setting the same one in both companies (a field by
 * where it lives and its key, everything else by its name), because ids
 * differ between two companies by definition. Each chosen item is a create, an
 * update, or the same already, and "the same" is said rather than skipped, so
 * the person who ticked it knows it was looked at.
 *
 * Ordered by kind so a kind of record is created before the fields on it and
 * before an automation that might mention it. A chosen id that is not in the
 * sandbox is not silently dropped: it is reported back as unknown.
 */
export function planCopyBack(
  sandbox: readonly SettingItem[],
  production: readonly SettingItem[],
  chosen: readonly string[],
): { items: CopyPlanItem[]; unknown: string[] } {
  const wanted = new Set(chosen);
  const there = new Map(production.map((item) => [itemId(item), item]));
  const found = new Set<string>();
  const items: CopyPlanItem[] = [];
  for (const kind of SETTING_KINDS) {
    for (const item of sandbox.filter((i) => i.kind === kind)) {
      const id = itemId(item);
      if (!wanted.has(id)) continue;
      found.add(id);
      const existing = there.get(id);
      const action: CopyAction = !existing ? "create" : stable(existing.content) === stable(item.content) ? "same" : "update";
      items.push({ kind: item.kind, naturalKey: item.naturalKey, label: item.label, action });
    }
  }
  return { items, unknown: [...wanted].filter((id) => !found.has(id)) };
}
