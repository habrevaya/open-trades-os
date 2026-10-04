import { ALL_PERMISSIONS, type Permission } from "../access/permissions.js";
import { DATA_TYPES, valueProblem, type FieldDefinition } from "../custom-fields/index.js";

/**
 * A COMPANY'S OWN KIND OF RECORD, CHECKED WITHOUT THE DATABASE
 *
 * A permit, a warranty registration, a truck inspection: a list with its own
 * columns that sometimes points at a customer, an address, a job or a unit.
 * The definition says what it is called, what it may point at and who may
 * see and change one; its columns are ordinary custom field definitions on
 * the entity type `object:<key>`, so they are checked by the same code as a
 * field on a customer.
 *
 * Everything here is a decision rather than a query, and every refusal is a
 * sentence somebody filling in the form can act on.
 */

/** Lowercase, starting with a letter, as a custom field's key is and for the same reasons. */
export const KEY = /^[a-z][a-z0-9_]{0,47}$/;

/**
 * What a record may point at. Closed, because each one is a real column with
 * a foreign key behind it; a link to something with no column would be a
 * box on a form whose answer goes nowhere.
 */
export const LINKS = ["customer", "property", "job", "equipment"] as const;
export type Link = (typeof LINKS)[number];

export const LINK_LABEL: Record<Link, string> = {
  customer: "Customer",
  property: "Address",
  job: "Job",
  equipment: "Unit",
};

/** The prefix that turns an object's key into the entity type its fields are defined on. */
export const ENTITY_PREFIX = "object:";

export const entityTypeFor = (key: string): string => `${ENTITY_PREFIX}${key}`;

/** The object key inside an entity type, or null when it is not an object's. */
export function keyOfEntityType(entityType: string): string | null {
  if (!entityType.startsWith(ENTITY_PREFIX)) return null;
  const key = entityType.slice(ENTITY_PREFIX.length);
  return KEY.test(key) ? key : null;
}

/** The permissions a company's records start with, when the definition names none. */
export const DEFAULT_READ: Permission = "record:read";
export const DEFAULT_WRITE: Permission = "record:write";

export interface TypeInput {
  key: string;
  label: string;
  pluralLabel?: string | undefined;
  description?: string | null | undefined;
  titleLabel?: string | undefined;
  links?: readonly string[] | undefined;
  readPermission?: string | undefined;
  writePermission?: string | undefined;
  sortOrder?: number | undefined;
}

export interface TypeDefinition {
  key: string;
  label: string;
  pluralLabel: string;
  description: string | null;
  titleLabel: string;
  links: Link[];
  readPermission: Permission;
  writePermission: Permission;
  sortOrder: number;
}

export type TypeDecision =
  | { ok: true; definition: TypeDefinition }
  | { ok: false; problems: string[] };

const isPermission = (value: string): value is Permission =>
  (ALL_PERMISSIONS as readonly string[]).includes(value);

/**
 * WHETHER A DEFINITION CAN BE SAVED, AND WHAT IT IS ONCE IT CAN.
 *
 * Every problem at once rather than the first, for the reason a custom field
 * form gives them all: a form corrected one box at a time is where somebody
 * gives up and types whatever gets past it.
 *
 *   The key is a stable identifier, written into every field definition and
 *   every event, so it is held to the pattern a field's key is.
 *
 *   The plural is asked for, not guessed. "Inspection" and "Inspections" is
 *   a suffix; "Battery" and "Batteries" is not, and a list headed "Batterys"
 *   is the first thing an owner sees after defining one.
 *
 *   The permissions are names from the catalogue. A permission nobody can
 *   hold would make the records unreadable by everybody, owner included,
 *   which is indistinguishable from them having been deleted.
 *
 *   Writing needs reading as well, in the service rather than here: somebody
 *   who may add a permit and may not see one would add it and then be told it
 *   does not exist.
 */
export function checkType(input: TypeInput): TypeDecision {
  const problems: string[] = [];
  const key = input.key.trim();
  const label = input.label.trim();
  const pluralLabel = (input.pluralLabel ?? "").trim() || `${label}s`;
  const titleLabel = (input.titleLabel ?? "").trim() || "Name";
  const description = (input.description ?? "").trim() || null;

  if (!KEY.test(key)) {
    problems.push(
      `"${input.key}" is not a usable key. It starts with a lowercase letter and holds only lowercase letters, `
      + "digits and underscores, because it is written into every field and every automation that uses it.",
    );
  }
  if (label === "") problems.push("Say what one of these is called, like Permit.");
  if (label.length > 60) problems.push("The name is longer than sixty characters.");
  if (pluralLabel.length > 60) problems.push("The plural is longer than sixty characters.");
  if (titleLabel.length > 60) problems.push("What each one is named is longer than sixty characters.");
  if (description && description.length > 500) problems.push("The description is longer than five hundred characters.");

  const links: Link[] = [];
  for (const raw of input.links ?? []) {
    const link = String(raw).trim();
    if (!(LINKS as readonly string[]).includes(link)) {
      problems.push(`"${link}" is not something a record can point at. One of: ${LINKS.join(", ")}.`);
    } else if (links.includes(link as Link)) {
      problems.push(`${LINK_LABEL[link as Link]} is listed twice.`);
    } else {
      links.push(link as Link);
    }
  }

  const readPermission = (input.readPermission ?? DEFAULT_READ).trim();
  const writePermission = (input.writePermission ?? DEFAULT_WRITE).trim();
  if (!isPermission(readPermission)) problems.push(`"${readPermission}" is not a permission anybody can hold.`);
  if (!isPermission(writePermission)) problems.push(`"${writePermission}" is not a permission anybody can hold.`);

  const sortOrder = input.sortOrder ?? 0;
  if (!Number.isInteger(sortOrder)) problems.push("Sort order is a whole number.");

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    definition: {
      key, label, pluralLabel, description, titleLabel,
      links: LINKS.filter((link) => links.includes(link)),
      readPermission: readPermission as Permission,
      writePermission: writePermission as Permission,
      sortOrder,
    },
  };
}

/**
 * A record's name. Required, short enough for a list, and never only spaces,
 * because a row nobody can tell apart from the next is not a row anybody
 * opens.
 */
export function titleProblem(titleLabel: string, title: string): string | null {
  const trimmed = title.trim();
  if (trimmed === "") return `${titleLabel} is required.`;
  if (trimmed.length > 200) return `${titleLabel} is longer than two hundred characters.`;
  return null;
}

/* ------------------------------------------------------------------ CSV in */

/**
 * RFC 4180, read back. Quoted cells may hold commas, quotes doubled and line
 * breaks; a line ending is CRLF or LF. A trailing empty line is not a row.
 *
 * The apostrophe this product's own export puts in front of a cell that would
 * otherwise be a formula is taken off again, so a file exported and imported
 * unchanged says what it said.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const source = text.replace(/^﻿/, "");
  while (i < source.length) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      cell += char; i += 1; continue;
    }
    if (char === '"' && cell === "") { quoted = true; i += 1; continue; }
    if (char === ",") { row.push(cell); cell = ""; i += 1; continue; }
    if (char === "\r" || char === "\n") {
      row.push(cell); cell = "";
      rows.push(row); row = [];
      i += char === "\r" && source[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += char; i += 1;
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  return rows
    .filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => r.map((c) => (/^'[=+\-@\t\r]/.test(c) ? c.slice(1) : c)));
}

/** A heading, compared without case, spaces or punctuation. */
const normal = (heading: string) => heading.toLowerCase().replace(/[^a-z0-9]+/g, "");

export interface ImportColumns {
  title: number;
  links: Partial<Record<Link | "job_number", number>>;
  fields: Map<string, number>;
  /** Headings nothing reads, said rather than dropped. */
  ignored: string[];
}

/**
 * WHICH COLUMN IS WHICH, FROM THE HEADER ROW.
 *
 * A field matches its key or its label, so this product's own export reads
 * back and so does a spreadsheet somebody typed headings into by hand. The
 * name column matches what each one is named ("Permit number") or "Title".
 * Links are by id (`Customer id`, `Job id`, ...) or a job by its number,
 * because a name is not unique and an import that attached a permit to the
 * wrong Smith is worse than one that said it could not tell.
 *
 * Null when there is no name column, which is the one column every row
 * needs.
 */
export function importColumns(
  header: readonly string[],
  titleLabel: string,
  definitions: readonly Pick<FieldDefinition, "key" | "label">[],
): ImportColumns | null {
  const seen = header.map(normal);
  const at = (...names: string[]) => {
    for (const name of names) {
      const index = seen.indexOf(normal(name));
      if (index >= 0) return index;
    }
    return -1;
  };
  const title = at(titleLabel, "title", "name");
  if (title < 0) return null;

  const used = new Set<number>([title]);
  const links: ImportColumns["links"] = {};
  for (const link of LINKS) {
    const index = at(`${link} id`, `${LINK_LABEL[link]} id`);
    if (index >= 0) { links[link] = index; used.add(index); }
  }
  const jobNumber = at("job number", "job no");
  if (jobNumber >= 0) { links.job_number = jobNumber; used.add(jobNumber); }

  const fields = new Map<string, number>();
  for (const definition of definitions) {
    const index = at(definition.key, definition.label);
    if (index >= 0 && !used.has(index)) { fields.set(definition.key, index); used.add(index); }
  }
  const ignored = header.filter((h, index) => !used.has(index) && h.trim() !== "");
  return { title, links, fields, ignored };
}

/**
 * ONE CELL, AS THE VALUE ITS FIELD STORES.
 *
 * Like `fromForm`, this converts and does not judge: "soon" in a date column
 * stays "soon", so the import refuses that row with the sentence the screen
 * and the API would give, rather than this dropping it and the row appearing
 * to load. An empty cell is no value.
 *
 * A list of choices is separated by semicolons, which is how this product's
 * export writes one, because a comma is the column separator.
 */
export function cellValue(definition: Pick<FieldDefinition, "dataType">, raw: string): unknown {
  const text = raw.trim();
  if (text === "") return undefined;
  switch (definition.dataType) {
    case "number": {
      const plain = text.replace(/,/g, "");
      return /^-?\d+(\.\d+)?$/.test(plain) ? Number(plain) : text;
    }
    case "boolean":
      if (/^(yes|y|true)$/i.test(text)) return true;
      if (/^(no|n|false)$/i.test(text)) return false;
      return text;
    case "multiselect":
      return text.split(";").map((part) => part.trim()).filter((part) => part !== "");
    default:
      return text;
  }
}

/** A stored value as one CSV cell: the inverse of `cellValue`. */
export function cellText(definition: Pick<FieldDefinition, "dataType">, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (definition.dataType === "boolean") return value === true ? "Yes" : value === false ? "No" : String(value);
  if (Array.isArray(value)) return value.map(String).join("; ");
  return String(value);
}

/** Whether a type could be checked at all, for a column a report or an import offers. */
export const isKnownType = (dataType: string): boolean => (DATA_TYPES as readonly string[]).includes(dataType);

export { valueProblem };
