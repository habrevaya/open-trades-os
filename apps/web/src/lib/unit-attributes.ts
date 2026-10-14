/**
 * THE FREE FORM DETAILS OF A UNIT, AS LINES OF TEXT
 *
 * A unit carries attributes the register has no column for (a refrigerant, a
 * filter size, a breaker number). The unit's page shows them as "Name: value"
 * lines, one a line, and takes them back the same way, so a trades owner edits
 * them like a note and not like a form builder.
 *
 * Only plain details can be written as a line: text, numbers and yes or no. A
 * detail that is something more (a list or a group, which an import or the API
 * can put there) is not shown as a line and is kept exactly as it is: editing the
 * lines can neither lose it nor change it. A line left alone keeps the type it
 * had (a number stays a number); a line that was typed over is text. A line taken
 * out is taken off.
 */
export const MAX_ATTRIBUTES = 30;
export const MAX_ATTRIBUTE_NAME = 60;
export const MAX_ATTRIBUTE_VALUE = 200;

type Plain = string | number | boolean;
const isPlain = (value: unknown): value is Plain =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** The lines to show: every plain detail that has a value, in the order the unit holds them. */
export function attributeLines(attributes: Record<string, unknown> | null | undefined): string {
  return Object.entries(attributes ?? {})
    .filter(([, value]) => isPlain(value) && String(value) !== "")
    .map(([name, value]) => `${name}: ${String(value)}`)
    .join("\n");
}

/** How many details the form cannot show, which stay as they are. */
export function keptAsTheyAre(attributes: Record<string, unknown> | null | undefined): number {
  return Object.entries(attributes ?? {}).filter(([, value]) => value !== null && value !== "" && !isPlain(value)).length;
}

export type ParsedAttributes = { ok: true; attributes: Record<string, unknown> } | { ok: false; error: string };

/**
 * The details to save: the typed lines, plus every detail the form could not show, untouched.
 * Refuses in words rather than guessing: a line with no colon, a name used twice, a name that
 * belongs to a detail the form cannot show, or too much.
 */
export function parseAttributeLines(text: string, existing: Record<string, unknown> | null | undefined): ParsedAttributes {
  const before = existing ?? {};
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(before)) {
    if (value !== null && value !== "" && !isPlain(value)) out[name] = value;
  }
  const held = new Set(Object.keys(out));

  const typed = new Set<string>();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length + held.size > MAX_ATTRIBUTES) {
    return { ok: false, error: `A unit can carry at most ${MAX_ATTRIBUTES} other details. Take some out.` };
  }
  for (const line of lines) {
    const colon = line.indexOf(":");
    const name = colon < 0 ? "" : line.slice(0, colon).trim();
    const value = colon < 0 ? "" : line.slice(colon + 1).trim();
    if (colon < 0 || name === "") {
      return { ok: false, error: `"${line.slice(0, 40)}" needs a name, a colon and a value, like "Refrigerant: R-410A".` };
    }
    if (name.length > MAX_ATTRIBUTE_NAME) {
      return { ok: false, error: `"${name.slice(0, 20)}..." is too long a name. Keep it under ${MAX_ATTRIBUTE_NAME} letters.` };
    }
    if (value === "") {
      return { ok: false, error: `"${name}" has no value. Give it one, or take the line out.` };
    }
    if (value.length > MAX_ATTRIBUTE_VALUE) {
      return { ok: false, error: `The value for "${name}" is too long. Keep it under ${MAX_ATTRIBUTE_VALUE} letters.` };
    }
    if (typed.has(name)) return { ok: false, error: `"${name}" is on two lines. Put each detail on one line.` };
    if (held.has(name)) {
      return { ok: false, error: `"${name}" holds something this box cannot show, so it is kept as it is. Use another name.` };
    }
    typed.add(name);
    const was = before[name];
    out[name] = isPlain(was) && String(was) === value ? was : value;
  }
  return { ok: true, attributes: out };
}
