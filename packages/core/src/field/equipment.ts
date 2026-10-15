/**
 * A UNIT RECORDED FROM THE FIELD, MATCHED BY ITS SERIAL ACROSS THE COMPANY
 *
 * The serial number is the identity of a furnace: the only thing that
 * survives a customer moving out and the next owner calling. The office has
 * matched it across the whole company for a while, retired units included,
 * because the unit a landlord moved between two rentals or a maker swapped
 * under warranty is already on file somewhere else. The phone matched only
 * at the address it was standing in, so the same unit recorded on site was
 * a second record and its history split in two.
 *
 * THE SAME RULES AS THE OFFICE, decided here once for both:
 *
 *  - A serial is matched on its letters and digits, upper case. The same
 *    plate is typed "ab-1234 x" and "AB1234X" by two people on two days.
 *    A serial with no letters or digits in it matches nothing.
 *  - The same unit live at this address is that unit: it is updated, never
 *    added again.
 *  - The serial on file anywhere else, or taken off a register here, needs
 *    a person to say whether it is the same unit (a move on the existing
 *    record) or another unit with the same plate. The office answers in the
 *    form; the phone cannot ask, so its record is held for the office with
 *    the matches named, rather than added as a second record nobody chose.
 *  - Somebody who has seen the matches and says it is a different unit
 *    adds it.
 */

/** A serial as a match key: letters and digits, upper case. */
export function serialKey(serial: string): string {
  return serial.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export interface SerialOnFile {
  id: string;
  propertyId: string;
  /** Taken off the register: retired, replaced or removed. */
  retired: boolean;
}

export type SerialDecision =
  | { action: "update"; equipmentId: string }
  | { action: "add" }
  | { action: "ask"; matches: SerialOnFile[] };

export function decideSerial(input: {
  serial: string | null | undefined;
  propertyId: string;
  /** Every unit in the company whose serial has the same key. */
  matches: readonly SerialOnFile[];
  /** Somebody saw the matches and says this is a different unit. */
  confirmedDifferent?: boolean | undefined;
}): SerialDecision {
  if (!input.serial || serialKey(input.serial) === "") return { action: "add" };
  const here = input.matches.find((m) => m.propertyId === input.propertyId && !m.retired);
  if (here) return { action: "update", equipmentId: here.id };
  if (input.matches.length > 0 && !input.confirmedDifferent) return { action: "ask", matches: [...input.matches] };
  return { action: "add" };
}

/* ---------------------------------------------------- declared attributes */

/** What a trade pack declares a kind of unit carries: a key, a label, a kind and, for a choice, its options. */
export interface DeclaredAttribute {
  key: string;
  label: string;
  kind: "text" | "numeric" | "select" | "date" | "boolean";
  options?: readonly string[] | undefined;
}

export interface AttributeProblem {
  key: string;
  label: string;
  /** What is wrong, in words an office reads: "Open spaces is a number. "four" is not one." */
  message: string;
}

/**
 * A UNIT'S DETAILS, HELD TO WHAT ITS TRADE DECLARES.
 *
 * The electrical pack declares that a service panel carries its rating, its
 * open spaces and whether it is a known problem panel, each with a kind; the
 * register stored whatever it was sent under those keys, so "100A", "four" and
 * "yes" sat there as words and a figure reading them could not tell a rating
 * from a typo. Each detail that names a declared attribute, by its key or its
 * label in any case, is stored under the key as its kind: a number as a
 * number, yes or no as true or false, a choice as the option it matches, a
 * date as a date. A detail the trade does not declare is kept as it was.
 *
 * A value that cannot be read as its kind is a PROBLEM, named, and left as it
 * was sent: the office is refused with the problem in words, and the phone,
 * whose record of what is in the box must not be thrown away in a basement,
 * keeps the words, which nothing that reads the declared attribute will read.
 */
export function typedAttributes(
  declared: readonly DeclaredAttribute[],
  values: Readonly<Record<string, unknown>>,
): { attributes: Record<string, unknown>; problems: AttributeProblem[] } {
  const byName = new Map<string, DeclaredAttribute>();
  for (const attribute of declared) {
    byName.set(attribute.key.toLowerCase(), attribute);
    byName.set(attribute.label.toLowerCase(), attribute);
  }
  const attributes: Record<string, unknown> = {};
  const problems: AttributeProblem[] = [];
  for (const [name, value] of Object.entries(values)) {
    const attribute = byName.get(name.trim().toLowerCase());
    if (!attribute) {
      attributes[name] = value;
      continue;
    }
    if (value === null || value === undefined || value === "") continue;
    const typed = typedValue(attribute, value);
    if (typed.ok) {
      attributes[attribute.key] = typed.value;
    } else {
      attributes[attribute.key] = value;
      problems.push({ key: attribute.key, label: attribute.label, message: typed.message });
    }
  }
  return { attributes, problems };
}

const YES = ["yes", "y", "true"];
const NO = ["no", "n", "false"];

function typedValue(attribute: DeclaredAttribute, value: unknown):
  { ok: true; value: unknown } | { ok: false; message: string } {
  const said = typeof value === "string" ? value.trim() : value;
  const words = typeof said === "string" ? `"${said}"` : String(said);
  switch (attribute.kind) {
    case "numeric": {
      const n = typeof said === "number" ? said : typeof said === "string" && /^-?\d+(\.\d+)?$/.test(said) ? Number(said) : NaN;
      return Number.isFinite(n) ? { ok: true, value: n }
        : { ok: false, message: `${attribute.label} is a number. ${words} is not one.` };
    }
    case "boolean": {
      if (typeof said === "boolean") return { ok: true, value: said };
      const lower = typeof said === "string" ? said.toLowerCase() : "";
      if (YES.includes(lower)) return { ok: true, value: true };
      if (NO.includes(lower)) return { ok: true, value: false };
      return { ok: false, message: `${attribute.label} is yes or no. ${words} is neither.` };
    }
    case "select": {
      const options = attribute.options ?? [];
      const match = options.find((o) => o.toLowerCase() === String(said).toLowerCase());
      return match !== undefined ? { ok: true, value: match }
        : { ok: false, message: `${attribute.label} is one of ${options.join(", ")}. ${words} is not one of them.` };
    }
    case "date":
      return typeof said === "string" && /^\d{4}-\d{2}-\d{2}$/.test(said) && !Number.isNaN(Date.parse(`${said}T00:00:00Z`))
        ? { ok: true, value: said }
        : { ok: false, message: `${attribute.label} is a date, like 2026-06-15. ${words} is not one.` };
    case "text":
      return typeof said === "string" || typeof said === "number" || typeof said === "boolean"
        ? { ok: true, value: String(said) }
        : { ok: false, message: `${attribute.label} is words.` };
  }
}
