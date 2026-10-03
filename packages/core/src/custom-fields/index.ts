/**
 * CUSTOM FIELD VALUES, CHECKED WITHOUT THE DATABASE
 *
 * The rules a value is held to, and the rule for which values a write is
 * held to at all. The service reads the definitions and calls these; the
 * screens call `fromForm` to turn what a person typed into the values the
 * service will check, so a form and the API are refused by the same code.
 */

/**
 * The closed vocabulary of what a custom field can be. See the service for
 * why it is closed: an open one is a text box for everything.
 */
export const DATA_TYPES = [
  "text", "number", "boolean", "date", "select", "multiselect",
] as const;
export type DataType = (typeof DATA_TYPES)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What a check needs to know about a definition, and no more. */
export interface FieldDefinition {
  key: string;
  label: string;
  dataType: DataType | string;
  options: readonly string[];
  required: boolean;
}

/** One field's problem: which field, and a sentence that starts with its label. */
export interface FieldRefusal {
  key: string;
  message: string;
}

/**
 * Whether a value counts as not filled in.
 *
 * Absent, JSON null, blank text and an empty list are all "nobody filled
 * this in". Zero and false are answers, and are not missing.
 */
export function isMissing(value: unknown): boolean {
  return value === null || value === undefined
    || (typeof value === "string" && value.trim() === "")
    || (Array.isArray(value) && value.length === 0);
}

/**
 * What is wrong with one value, or null when nothing is, as the end of a
 * sentence whose start is the field's label: "has to be a number".
 *
 * A missing value is not a type failure. Whether it is allowed is the
 * `required` question, which is a different thing to say to somebody.
 */
export function valueProblem(
  definition: Pick<FieldDefinition, "dataType" | "options">, value: unknown,
): string | null {
  if (value === null || value === undefined) return null;

  switch (definition.dataType) {
    case "text":
      return typeof value === "string" ? null : "has to be text";

    case "number":
      /**
       * Finite, because `NaN` and `Infinity` are not representable in JSON:
       * they serialise to `null` on the way into jsonb, so a value that
       * passed a `typeof value === "number"` check reads back as empty and
       * the field looks like nobody filled it in.
       */
      return typeof value === "number" && Number.isFinite(value) ? null : "has to be a number";

    case "boolean":
      return typeof value === "boolean" ? null : "has to be true or false";

    case "date": {
      if (typeof value !== "string" || !ISO_DATE.test(value)) {
        return "has to be a date like 2026-03-01";
      }
      /**
       * Parsed as well as matched. `2026-02-31` satisfies the pattern, and a
       * date nobody can reach is worse than a rejected one: it sorts, it
       * exports, and it is never the day anybody meant.
       */
      const [y, m, d] = value.split("-").map(Number) as [number, number, number];
      const date = new Date(Date.UTC(y, m - 1, d));
      const real = date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
      return real ? null : "is not a real date";
    }

    case "select":
      if (typeof value !== "string") return "has to be one of the options";
      return definition.options.includes(value)
        ? null
        : `is not one of the options (${definition.options.join(", ")})`;

    case "multiselect": {
      if (!Array.isArray(value)) return "has to be a list of options";
      const bad = value.filter((entry) => typeof entry !== "string" || !definition.options.includes(entry));
      if (bad.length > 0) {
        return `holds something that is not an option (${definition.options.join(", ")})`;
      }
      if (new Set(value as string[]).size !== value.length) return "lists the same option twice";
      return null;
    }

    default:
      return `is a ${definition.dataType} field, which this product cannot check`;
  }
}

/** Deep equality for values that came out of jsonb. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * THE CHECK A SAVE IS HELD TO: every defined field THIS WRITE changed.
 *
 *   REFUSED   a value that contradicts its definition.
 *   REFUSED   a required field this write left empty or cleared.
 *   ALLOWED   a key nothing defines (reported elsewhere, never refused here).
 *   ALLOWED   anything this write did not change.
 *
 * `previous` is the bag as stored, absent on a create. The last rule is how
 * a record created before a field existed, or before it became required,
 * still saves: a value identical to what was already there is not checked,
 * so nobody is refused for data they did not touch. On a create everything
 * is new, so a required field left empty IS refused; that is what required
 * means.
 *
 * Every refusal at once, one sentence per field, in key order, because a
 * form corrected one field at a time is where somebody gives up.
 */
export function checkChanged(
  definitions: readonly FieldDefinition[],
  next: Record<string, unknown>,
  previous?: Record<string, unknown> | undefined,
): FieldRefusal[] {
  const refusals: FieldRefusal[] = [];
  for (const definition of definitions) {
    const value = next[definition.key];
    if (previous !== undefined && same(value, previous[definition.key])) continue;

    if (isMissing(value)) {
      if (definition.required) {
        refusals.push({ key: definition.key, message: `${definition.label} is required.` });
      }
      continue;
    }
    const problem = valueProblem(definition, value);
    if (problem) refusals.push({ key: definition.key, message: `${definition.label} ${problem}.` });
  }
  return refusals.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * WHAT A FORM POSTED, AS THE VALUES THE SERVICE CHECKS.
 *
 * A form posts strings. This turns them into the shape each type is stored
 * in, and it does NOT judge them: "soon" in a date box stays "soon", so the
 * service refuses it with the sentence the API would give, rather than this
 * dropping it quietly and the save appearing to work.
 *
 * Built on top of what is stored, so a key nothing on the form draws (one no
 * definition describes, written before definitions existed) is carried
 * through untouched. A box left empty for a field that was never filled in
 * stays absent rather than becoming an empty string, which is what keeps a
 * record from before a field was required saving: absent before, absent
 * after, unchanged. A box emptied of a value that was there removes it, and
 * a required one is then refused, because clearing it is a change.
 *
 * `posted` is each field's posted values by key: one string for most types,
 * every ticked option for a multiselect.
 */
export function fromForm(
  definitions: readonly FieldDefinition[],
  posted: (key: string) => string[],
  previous: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...previous };
  for (const definition of definitions) {
    const values = posted(definition.key).map((v) => v.trim()).filter((v) => v !== "");
    if (definition.dataType === "multiselect") {
      if (values.length === 0) delete out[definition.key];
      else out[definition.key] = values;
      continue;
    }
    const raw = values[0];
    if (raw === undefined) { delete out[definition.key]; continue; }
    switch (definition.dataType) {
      case "number": {
        const n = Number(raw);
        out[definition.key] = Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(raw) ? n : raw;
        break;
      }
      case "boolean":
        out[definition.key] = raw === "true" ? true : raw === "false" ? false : raw;
        break;
      default:
        out[definition.key] = raw;
    }
  }
  return out;
}
