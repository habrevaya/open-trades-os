import { ConflictError } from "@opentradesos/api/services";

/**
 * A LIST ASKED FOR WITH FIELD FILTERS, AND WHAT TO SAY WHEN ONE CANNOT BE.
 *
 * The address carries each filter as a `field` and a `value`, repeated, paired
 * by position: `?field=plan&value=Annual&field=has_pets&value=yes` is the
 * customers on the Annual plan who have pets. Every pair has to hold. A pair
 * with half missing (a field chosen and no value typed) is left out rather
 * than refused, because it is a box somebody did not fill in rather than a
 * filter they asked for.
 *
 * A filter the service refuses (a field the company no longer declares, "soon"
 * for a number) is the list without the field filters and the sentence beside
 * it, never an error page.
 */
export interface FieldPair { key: string; value: string }

const asList = (value: string | string[] | undefined): string[] =>
  Array.isArray(value) ? value : value === undefined ? [] : [value];

export function fieldFrom(params: { field?: string | string[] | undefined; value?: string | string[] | undefined }) {
  const keys = asList(params.field);
  const values = asList(params.value);
  const pairs: FieldPair[] = [];
  for (const [index, raw] of keys.entries()) {
    const key = raw.trim();
    const value = (values[index] ?? "").trim();
    if (key !== "" && value !== "" && pairs.length < 10) pairs.push({ key, value });
  }
  return {
    pairs,
    /** The pairs as the address carries them, for every other filter's form to keep. */
    keep: { field: pairs.map((p) => p.key), value: pairs.map((p) => p.value) },
    byField: pairs.length > 0 ? { fields: pairs.map((p) => `${p.key}:${p.value}`) } : {},
  };
}

export async function withFieldFilter<T>(
  run: (byField: boolean) => Promise<T>,
): Promise<{ page: T; refusal: string | null }> {
  try {
    return { page: await run(true), refusal: null };
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    return { page: await run(false), refusal: error.message };
  }
}
