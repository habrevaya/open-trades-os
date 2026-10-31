/**
 * A CLIENT'S CODES, READ AGAINST OURS
 *
 * A facilities client writes its own codes on every work order: "PLB-07 Leaking
 * tap", "ELE-12 Lights out". The office keeps a list per client of what each code
 * means here, a kind of work, a price book item and how many, and accepting an
 * order proposes the job from that list.
 *
 * PROPOSED, NEVER APPLIED. Everything here is a pure reading of the order's codes
 * against the client's list. The office sees it and confirms it; a code nobody
 * mapped is named in words, so a missing line is somebody's decision rather than
 * a gap nobody noticed.
 */

export interface OrderCode {
  code: string;
  /** How many the client asked for, when they said. One when they did not. */
  quantity: string | null;
  /** Their words for it, when they sent any. */
  description: string | null;
}

export interface CodeMapping {
  id: string;
  code: string;
  description: string | null;
  jobTypeId: string | null;
  jobTypeName: string | null;
  /** False when the job type has been switched off since it was mapped. */
  jobTypeActive: boolean;
  priceBookItemId: string | null;
  itemName: string | null;
  /** False when the item is no longer sold, or has no price in force. */
  itemSold: boolean;
  quantity: string;
}

export interface ProposedLine {
  code: string;
  mappingId: string;
  priceBookItemId: string;
  name: string;
  /** The mapping's quantity times the order's. */
  quantity: string;
}

export interface CodeReading {
  code: string;
  description: string | null;
  quantity: string | null;
  /** The mapping that matched, or null. */
  mappingId: string | null;
  jobTypeName: string | null;
  itemName: string | null;
  /** What became of this code, in a sentence. */
  words: string;
  /** True when nothing from this code reaches the job. */
  unmapped: boolean;
}

export interface Proposal {
  jobTypeId: string | null;
  jobTypeName: string | null;
  /** Said when the codes disagree about the kind of work, or name none. */
  jobTypeNote: string | null;
  lines: ProposedLine[];
  codes: CodeReading[];
  /** One sentence per code nothing came of. */
  unmapped: string[];
}

/** How a code is compared: without capitals or spaces at the ends. */
export const codeKey = (code: string) => code.trim().toLowerCase();

const DECIMAL = /^\d+(\.\d{1,4})?$/;

/** A quantity as written, or null when it is not one. */
export function quantityOf(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!DECIMAL.test(trimmed) || Number(trimmed) <= 0) return null;
  return trimmed;
}

/** Two quantities multiplied, to four places, without trailing noughts. */
export function timesQuantity(a: string, b: string | null): string {
  if (b === null) return trim(a);
  const product = Math.round(Number(a) * Number(b) * 10_000) / 10_000;
  return trim(product.toFixed(4));
}

function trim(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

const quoted = (reading: { code: string; description: string | null }) =>
  reading.description ? `${reading.code} (${reading.description})` : reading.code;

/**
 * Read an order's codes against the client's list.
 *
 * Each code is matched on its key. A matched code adds its item as a line (its
 * quantity times the order's) and votes for its job type. The job type is
 * proposed only when every code that names one names the same one: when they
 * disagree the office chooses, because picking one would put the wrong trade on
 * the board for half the order.
 */
export function propose(
  codes: readonly OrderCode[], mappings: readonly CodeMapping[], clientName: string,
): Proposal {
  const byKey = new Map(mappings.map((m) => [codeKey(m.code), m]));
  const readings: CodeReading[] = [];
  const lines: ProposedLine[] = [];
  const unmapped: string[] = [];
  const types = new Map<string, { name: string; codes: string[] }>();

  for (const code of codes) {
    const mapping = byKey.get(codeKey(code.code));
    const description = code.description ?? mapping?.description ?? null;
    const label = quoted({ code: code.code, description });
    if (!mapping) {
      const words = `${label} is not on ${clientName}'s list of codes. Nothing is added for it; `
        + "add its work by hand, or map the code first.";
      readings.push({
        code: code.code, description, quantity: code.quantity, mappingId: null,
        jobTypeName: null, itemName: null, words, unmapped: true,
      });
      unmapped.push(words);
      continue;
    }

    const parts: string[] = [];
    let added = false;
    if (mapping.jobTypeId && mapping.jobTypeActive) {
      const entry = types.get(mapping.jobTypeId) ?? { name: mapping.jobTypeName ?? "a job type", codes: [] };
      entry.codes.push(code.code);
      types.set(mapping.jobTypeId, entry);
      parts.push(`a ${mapping.jobTypeName} job`);
      added = true;
    }
    if (mapping.priceBookItemId && mapping.itemSold) {
      const quantity = timesQuantity(mapping.quantity, code.quantity);
      lines.push({
        code: code.code, mappingId: mapping.id, priceBookItemId: mapping.priceBookItemId,
        name: mapping.itemName ?? "Price book item", quantity,
      });
      parts.push(`${quantity} of ${mapping.itemName}`);
      added = true;
    }

    const gone: string[] = [];
    if (mapping.jobTypeId && !mapping.jobTypeActive) gone.push(`its job type, ${mapping.jobTypeName}, is switched off`);
    if (mapping.priceBookItemId && !mapping.itemSold) gone.push(`its item, ${mapping.itemName ?? "the item"}, is no longer sold`);
    if (mapping.jobTypeId === null && mapping.priceBookItemId === null) gone.push("what it was mapped to has been removed");

    const words = added
      ? `${label} becomes ${parts.join(" and ")}.${gone.length ? ` Not used: ${gone.join(", and ")}.` : ""}`
      : `${label} is mapped, but ${gone.join(", and ")}. Nothing is added for it; add its work by hand, `
        + "or change the mapping.";
    if (!added) unmapped.push(words);
    readings.push({
      code: code.code, description, quantity: code.quantity, mappingId: mapping.id,
      jobTypeName: mapping.jobTypeActive ? mapping.jobTypeName : null,
      itemName: mapping.itemSold ? mapping.itemName : null,
      words, unmapped: !added,
    });
  }

  let jobTypeId: string | null = null;
  let jobTypeName: string | null = null;
  let jobTypeNote: string | null = null;
  if (types.size === 1) {
    const [[id, entry]] = [...types.entries()] as [[string, { name: string; codes: string[] }]];
    jobTypeId = id;
    jobTypeName = entry.name;
  } else if (types.size > 1) {
    jobTypeNote = `The codes point to more than one kind of work: ${[...types.values()]
      .map((t) => `${t.name} (${t.codes.join(", ")})`).join(", ")}. Choose which this job is.`;
  } else if (codes.length > 0) {
    jobTypeNote = "None of the codes says what kind of work this is. Choose it, or leave it blank.";
  } else {
    jobTypeNote = "The order carries no codes. Choose the kind of work, or leave it blank.";
  }

  return { jobTypeId, jobTypeName, jobTypeNote, lines, codes: readings, unmapped };
}

export interface MappingInput {
  code: string;
  jobTypeId: string | null;
  priceBookItemId: string | null;
  quantity: string;
}

/**
 * What is wrong with a client's list, in a sentence, or null.
 *
 * A code twice is refused rather than the second winning, because which of two
 * rows somebody meant is not something to guess. A code that maps to nothing is
 * refused because a row that adds nothing reads, on the list, as if it did.
 */
export function checkMappings(rows: readonly MappingInput[]): string | null {
  const seen = new Map<string, string>();
  for (const row of rows) {
    const code = row.code.trim();
    if (code === "") return "Every row needs the client's code.";
    const key = codeKey(code);
    const first = seen.get(key);
    if (first !== undefined) return `The code ${code} is in the list twice. Keep one row for it.`;
    seen.set(key, code);
    if (row.jobTypeId === null && row.priceBookItemId === null) {
      return `The code ${code} is mapped to nothing. Choose a kind of work, an item, or both.`;
    }
    if (quantityOf(row.quantity) === null) {
      return `The quantity for ${code} has to be a number more than nothing, to four places at most.`;
    }
  }
  return null;
}
