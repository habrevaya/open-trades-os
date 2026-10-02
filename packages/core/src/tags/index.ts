/**
 * A CUSTOMER'S TAGS
 *
 * Tags are the operator's own segmentation: "VIP", "landlord", "pays late",
 * "2024 storm list". They were stored and read back and nothing could act on
 * them, so the decisions here are the ones that stop a tag list rotting into
 * five spellings of the same word, which is what every tag list does when
 * nothing holds it together.
 *
 * ONE SPELLING PER TAG, COMPARED WITHOUT CASE. "VIP", "vip" and "Vip " are
 * one tag typed three ways, and a filter or a campaign rule that treats them
 * as three quietly leaves two thirds of the customers out. The first spelling
 * a list holds is the one kept, because it is the one somebody chose; the
 * service also hands a new tag the company's existing spelling, so the book
 * converges on one rather than drifting.
 *
 * Pure, so the rename and merge arithmetic is tested without a database and
 * the screen, the API and the bulk update all agree on it.
 */

/** Long enough for "2024 hail storm list", short enough to sit on a chip. */
export const MAX_TAG_LENGTH = 40;

/**
 * How many tags one customer may carry.
 *
 * A bound rather than a taste: a customer with two hundred tags is an import
 * that put a free text field in the wrong column, and the list screen would
 * be a wall of chips.
 */
export const MAX_TAGS_PER_CUSTOMER = 50;

/** What a tag is compared by. */
export const tagKey = (tag: string): string => tag.trim().replace(/\s+/g, " ").toLowerCase();

export type TagVerdict =
  | { ok: true; tag: string }
  | { ok: false; reason: "empty" | "too_long"; message: string };

/**
 * A tag as somebody typed it, cleaned, or why it cannot be one.
 *
 * Inner whitespace collapses to one space and the ends are trimmed, because
 * "storm  list" with two spaces is a tag nobody can find by typing it again.
 * Case is kept: it is how the company writes it.
 */
export function normalizeTag(raw: string): TagVerdict {
  const tag = raw.trim().replace(/\s+/g, " ");
  if (tag === "") {
    return { ok: false, reason: "empty", message: "A tag needs at least one letter or number." };
  }
  if (tag.length > MAX_TAG_LENGTH) {
    return {
      ok: false, reason: "too_long",
      message: `"${tag.slice(0, 20)}..." is longer than ${MAX_TAG_LENGTH} characters. A tag is a label, not a note.`,
    };
  }
  return { ok: true, tag };
}

/**
 * The list with duplicates taken out, first spelling kept.
 *
 * Applied to every list this module writes, so a list read back is always
 * one where each tag appears once, whatever an import put there.
 */
export function uniqueTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const verdict = normalizeTag(raw);
    if (!verdict.ok) continue;
    const key = tagKey(verdict.tag);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(verdict.tag);
  }
  return out;
}

/** The list with these added at the end, each once. */
export function addTags(existing: readonly string[], adding: readonly string[]): string[] {
  return uniqueTags([...existing, ...adding]);
}

/** The list without these, compared without case. */
export function removeTags(existing: readonly string[], removing: readonly string[]): string[] {
  const gone = new Set(removing.map(tagKey));
  return uniqueTags(existing).filter((tag) => !gone.has(tagKey(tag)));
}

/**
 * Every tag in `from` becomes `into`, at the place the first of them stood.
 *
 * This is both rename and merge. A customer tagged "vip" and "V.I.P." merged
 * into "VIP" ends with one "VIP" where "vip" was, not two and not at the end
 * of the list, because the order of a customer's tags is the order somebody
 * put them on and there is no reason a merge should shuffle it.
 */
export function replaceTags(
  existing: readonly string[], from: readonly string[], into: string,
): string[] {
  const replacing = new Set(from.map(tagKey));
  const result: string[] = [];
  let placed = false;
  for (const tag of uniqueTags(existing)) {
    if (replacing.has(tagKey(tag))) {
      if (!placed) result.push(into);
      placed = true;
      continue;
    }
    result.push(tag);
  }
  return uniqueTags(result);
}

/** Whether a customer's tags hold any of these. */
export function hasAnyTag(tags: readonly string[], wanted: readonly string[]): boolean {
  const keys = new Set(tags.map(tagKey));
  return wanted.some((tag) => keys.has(tagKey(tag)));
}

/** Whether a customer's tags hold every one of these. */
export function hasEveryTag(tags: readonly string[], wanted: readonly string[]): boolean {
  const keys = new Set(tags.map(tagKey));
  return wanted.every((tag) => keys.has(tagKey(tag)));
}

/**
 * Two customer ids as the pair a duplicate decision is stored under.
 *
 * Ordered, so the pair has one form whichever side it was looked at from:
 * "A is not B" and "B is not A" are the same decision and must be one row.
 */
export function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
