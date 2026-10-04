/**
 * TAKING A COMPANY OUT AND PUTTING IT BACK
 *
 * The pure half of M30's copy, archive and restore: the CSV format the archive
 * writes and reads, the order a restore loads tables in, how ids are carried
 * across when they cannot be kept, when a scheduled copy is next due and which
 * copies a bucket no longer needs. Nothing here touches a database, a socket or
 * a file, so each rule is tested on its own and the services only plumb.
 */

/* ------------------------------------------------------------------- CSV */

/**
 * One value in a CSV cell, or null for NULL.
 *
 * THE CONVENTION IS POSTGRES'S OWN COPY FORMAT, so every file in the archive
 * loads with `\copy table from 'table.csv' with (format csv, header)` and
 * nothing written here: an empty cell with no quotes is NULL, and every value
 * that is not NULL is quoted, so `""` is an empty string and the two can never
 * be confused. A CSV that writes NULL and the empty string the same way loses
 * the difference between "no email" and "an email of nothing", which a restore
 * then has to guess at.
 */
export function csvCell(value: string | null): string {
  return value === null ? "" : `"${value.replace(/"/g, "\"\"")}"`;
}

/** One line, ended the way a spreadsheet expects. */
export function csvLine(values: readonly (string | null)[]): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}

/** The header line. Column names are plain identifiers and are left unquoted so they read cleanly. */
export function csvHeader(columns: readonly string[]): string {
  return `${columns.join(",")}\r\n`;
}

/**
 * Reads CSV a chunk at a time, so a table of a million rows is never one string.
 *
 * A row is complete only when its line ends outside quotes, so a value with a
 * line break inside it (a job note, an address) is one cell however the
 * chunks happen to fall. A quoted cell is a string even when empty; an
 * unquoted empty cell is null, which is the convention `csvCell` writes. A
 * byte order mark at the very start is dropped, because the archive writes one
 * for the spreadsheet's sake and it is not part of the first column's name.
 */
export class CsvReader {
  private field = "";
  private quoted = false;
  private inQuotes = false;
  /** Just saw a quote inside a quoted cell: either the cell ended or a doubled quote follows. */
  private afterQuote = false;
  /** Just ended a line on a carriage return, so a line feed next belongs to it. */
  private afterReturn = false;
  private row: (string | null)[] = [];
  private started = false;
  private sawAnything = false;

  push(text: string): (string | null)[][] {
    const rows: (string | null)[][] = [];
    let start = 0;
    if (!this.started) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) start = 1;
    }
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (this.afterReturn) {
        this.afterReturn = false;
        if (ch === "\n") continue;
      }
      if (this.inQuotes) {
        if (this.afterQuote) {
          this.afterQuote = false;
          if (ch === "\"") {
            this.field += "\"";
            continue;
          }
          this.inQuotes = false;
          // Falls through to be read as a character after the closing quote.
        } else if (ch === "\"") {
          this.afterQuote = true;
          continue;
        } else {
          this.field += ch;
          continue;
        }
      }
      if (ch === ",") {
        this.endField();
      } else if (ch === "\n" || ch === "\r") {
        this.endField();
        rows.push(this.row);
        this.row = [];
        this.sawAnything = false;
        if (ch === "\r") this.afterReturn = true;
      } else if (ch === "\"" && this.field === "" && !this.quoted) {
        this.inQuotes = true;
        this.quoted = true;
        this.sawAnything = true;
      } else {
        this.field += ch;
        this.sawAnything = true;
      }
    }
    return rows;
  }

  /** The last row, when the file did not end with a line break. */
  end(): (string | null)[][] {
    if (this.inQuotes && !this.afterQuote) {
      throw new Error("The file ends inside a quoted value, so its last row is cut short.");
    }
    if (this.inQuotes) this.inQuotes = false;
    if (this.row.length === 0 && !this.sawAnything && this.field === "") return [];
    this.endField();
    const last = this.row;
    this.row = [];
    return [last];
  }

  private endField(): void {
    this.row.push(this.quoted || this.field !== "" ? this.field : null);
    this.field = "";
    this.quoted = false;
    this.sawAnything = true;
  }
}

/* ------------------------------------------------------- the load order */

/** A foreign key from one table in the copy to another. */
export interface ForeignKey {
  table: string;
  column: string;
  references: string;
  nullable: boolean;
}

export interface LoadOrder {
  /** Every table, each after every table it points at. */
  order: string[];
  /**
   * Keys that cannot be satisfied by order alone: a table pointing at itself (a
   * customer referred by another customer) or a ring of tables. Their column is
   * loaded empty and filled in once every row is in, which is why only a
   * nullable key may be one.
   */
  deferred: ForeignKey[];
}

/**
 * The order to load tables in, so every row's foreign keys point at rows that
 * are already there.
 *
 * Foreign keys here cannot be deferred to the end of the transaction (none is
 * declared DEFERRABLE, on purpose), so the order is the only way to load a
 * company without switching the checks off, and switching them off needs a
 * superuser. Alphabetical among equals, so the same schema always loads the
 * same way and a failure is reproducible.
 */
export function loadOrder(tables: readonly string[], keys: readonly ForeignKey[]): LoadOrder {
  const present = new Set(tables);
  const relevant = keys.filter((key) => present.has(key.table) && present.has(key.references));
  const deferred: ForeignKey[] = [];
  let edges = relevant.filter((key) => {
    if (key.table !== key.references) return true;
    if (!key.nullable) {
      throw new Error(`${key.table}.${key.column} points at its own table and cannot be empty, so no order loads it.`);
    }
    deferred.push(key);
    return false;
  });

  const order: string[] = [];
  const placed = new Set<string>();
  for (;;) {
    const waiting = new Map<string, number>();
    for (const table of tables) if (!placed.has(table)) waiting.set(table, 0);
    for (const edge of edges) {
      if (!placed.has(edge.table) && !placed.has(edge.references)) {
        waiting.set(edge.table, (waiting.get(edge.table) ?? 0) + 1);
      }
    }
    if (waiting.size === 0) break;
    const ready = [...waiting.entries()].filter(([, n]) => n === 0).map(([table]) => table).sort();
    if (ready.length > 0) {
      // One at a time, alphabetically, so the order does not depend on how the batch fell.
      const next = ready[0]!;
      order.push(next);
      placed.add(next);
      continue;
    }
    /**
     * A ring. Break it at a nullable key, the first one alphabetically, and
     * carry on. There is no ring in the schema today; this is here so the day
     * somebody adds one the restore still works, or says exactly why not.
     */
    const ring = edges
      .filter((edge) => !placed.has(edge.table) && !placed.has(edge.references) && edge.nullable)
      .sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`));
    const broken = ring[0];
    if (!broken) {
      const stuck = [...waiting.keys()].sort().join(", ");
      throw new Error(`These tables point at each other through keys that cannot be empty, so no order loads them: ${stuck}.`);
    }
    deferred.push(broken);
    edges = edges.filter((edge) => edge !== broken);
  }
  return { order, deferred };
}

/* ------------------------------------------------------------ the ids */

/** A uuid anywhere in a string. Ids are lower case as Postgres writes them; upper case is matched too. */
export const UUID_IN_TEXT = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

export const isUuid = (value: string): boolean =>
  value.length === 36 && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);

/**
 * Every uuid in a value, in its strings and in its object keys, at any depth.
 *
 * Keys too, because a jsonb map keyed by id is an ordinary shape here (custom
 * field values by field, settings by record) and a reference in a key is still
 * a reference.
 */
export function uuidsIn(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    if (value.length < 36) return;
    for (const match of value.matchAll(UUID_IN_TEXT)) into.add(match[0].toLowerCase());
  } else if (Array.isArray(value)) {
    for (const item of value) uuidsIn(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      uuidsIn(key, into);
      uuidsIn(item, into);
    }
  }
}

/**
 * The same value with every id the lookup knows replaced by what it maps to.
 *
 * BY VALUE, NOT BY COLUMN, and that is the design. A restore that renumbers a
 * company has to rewrite every reference to every row, and the references are
 * not all foreign keys: an attachment names its record by type and id, an audit
 * line keeps the record's id and a before and after in jsonb, a storage key
 * starts with the company's id, a workflow's settings name a job type. A list
 * of the columns that hold ids would be the hand maintained list the export
 * refuses to have, and the first one it missed would point the restored company
 * at the original. A uuid is 122 random bits, so one that equals a row's id IS a
 * reference to that row, wherever it sits; anything the lookup does not know
 * (another system's id, a provider's reference) is left exactly as it was.
 */
export function remap(value: unknown, lookup: (id: string) => string | undefined): unknown {
  if (typeof value === "string") {
    if (value.length < 36) return value;
    return value.replace(UUID_IN_TEXT, (found) => lookup(found.toLowerCase()) ?? found);
  }
  if (Array.isArray(value)) return value.map((item) => remap(item, lookup));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[remap(key, lookup) as string] = remap(item, lookup);
    return out;
  }
  return value;
}

/* ------------------------------------------------------- the schedule */

export type BackupFrequency = "daily" | "weekly" | "off";
export const BACKUP_FREQUENCIES: readonly BackupFrequency[] = ["daily", "weekly", "off"];

/** The weekday a calendar date falls on, 0 for Sunday. A date has no zone, so noon UTC is safe. */
const weekdayOf = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay();

const nextDate = (date: string): string => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/**
 * When the next copy is due, strictly after `after`.
 *
 * In the company's own time, because "two in the morning" is a time on the
 * owner's clock, and a copy that starts at two in the morning UTC starts at
 * nine at night in Texas, while the office is still closing invoices. The
 * zone conversion is passed in rather than imported, so this stays free of
 * any one implementation of it.
 */
export function nextBackupAt(input: {
  frequency: BackupFrequency;
  hour: number;
  weekday: number | null;
  after: Date;
  /** The calendar date an instant falls on in the company's zone. */
  dateIn: (instant: Date) => string;
  /** The instant a wall clock time on a date is, in the company's zone. */
  instantOf: (date: string, minutesPastMidnight: number) => Date;
}): Date | null {
  if (input.frequency === "off") return null;
  const hour = Math.min(Math.max(Math.trunc(input.hour), 0), 23);
  let date = input.dateIn(input.after);
  // Eight days covers a weekly copy whose day is today and whose hour has passed.
  for (let i = 0; i < 9; i++) {
    const fits = input.frequency === "daily" || weekdayOf(date) === (input.weekday ?? 0);
    if (fits) {
      const at = input.instantOf(date, hour * 60);
      if (at.getTime() > input.after.getTime()) return at;
    }
    date = nextDate(date);
  }
  return null;
}

/* --------------------------------------------------------- what to keep */

export interface CopyOnRecord {
  id: string;
  status: string;
  startedAt: Date;
  prunedAt: Date | null;
}

/**
 * The copies to delete from the bucket so that `keep` finished ones remain.
 *
 * Only finished copies count and only finished copies go: a failed copy left
 * nothing in the bucket to delete (its upload is abandoned, not kept), and a
 * copy still running is the newest one and is never the one to remove. At
 * least one is always kept, whatever `keep` says, because a setting of nought
 * would delete the copy that was just made.
 */
export function copiesToPrune(copies: readonly CopyOnRecord[], keep: number): string[] {
  const kept = Math.max(1, Math.trunc(keep));
  return copies
    .filter((copy) => copy.status === "succeeded" && copy.prunedAt === null)
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .slice(kept)
    .map((copy) => copy.id);
}

/* ------------------------------------------------------ the destination */

export interface DestinationInput {
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  accessKeyId: string;
  secretKeyRef: string;
  frequency: BackupFrequency;
  hour: number;
  weekday: number | null;
  keep: number;
}

/**
 * What is wrong with a destination, in words an owner can act on. Empty when
 * nothing is.
 *
 * The secret key is refused when it looks like a key rather than the name of
 * one. That is the mistake every owner makes once, and storing the key in a
 * column that is in every backup and every export is exactly what naming
 * secrets exists to prevent.
 */
export function checkDestination(input: DestinationInput): string[] {
  const problems: string[] = [];
  let url: URL | null = null;
  try {
    url = new URL(input.endpoint);
  } catch {
    problems.push("The endpoint has to be a web address, such as https://s3.us-east-1.amazonaws.com.");
  }
  if (url && url.protocol !== "https:" && url.protocol !== "http:") {
    problems.push("The endpoint has to start with https:// (or http:// for a store on your own network).");
  }
  if (url && (url.pathname !== "/" && url.pathname !== "")) {
    problems.push("The endpoint is the service's address alone. Put the bucket in its own box and any folder in the prefix.");
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) {
    problems.push("A bucket name is 3 to 63 lower case letters, numbers, dots and dashes.");
  }
  if (!/^[a-z0-9-]{2,40}$/.test(input.region)) {
    problems.push("The region is a short name such as us-east-1. Services that do not use regions take us-east-1 or auto.");
  }
  if (input.prefix.startsWith("/") || input.prefix.includes("..") || input.prefix.length > 200) {
    problems.push("The prefix is a folder inside the bucket, such as backups/, with no leading slash.");
  }
  if (!/^[A-Za-z0-9]{8,128}$/.test(input.accessKeyId)) {
    problems.push("The access key id is the shorter of the two values the service gave you, letters and numbers only.");
  }
  if (!/^[A-Za-z0-9_.:/-]{1,200}$/.test(input.secretKeyRef)) {
    problems.push("The secret key name is the name your deployment keeps the secret under, such as BACKUP_SECRET_KEY.");
  } else if (looksLikeAKey(input.secretKeyRef)) {
    problems.push("That looks like the secret key itself. Put the key in your deployment's secret store and type the NAME it is kept under here, so the key is never written into the database or a copy of it.");
  }
  if (!BACKUP_FREQUENCIES.includes(input.frequency)) problems.push("Choose daily, weekly or off.");
  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23) problems.push("The hour is 0 to 23.");
  if (input.frequency === "weekly" && (input.weekday === null || !Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6)) {
    problems.push("Choose the day of the week a weekly copy is taken.");
  }
  if (!Number.isInteger(input.keep) || input.keep < 1 || input.keep > 365) problems.push("Keep between 1 and 365 copies.");
  return problems;
}

/**
 * Whether a string looks like a secret key rather than a name for one.
 *
 * A key is long and mixes cases and digits with no word separators; a name is
 * words joined by underscores. Not a proof, a guard against the one paste
 * everybody makes.
 */
export function looksLikeAKey(value: string): boolean {
  if (value.length < 30) return false;
  if (/[_]/.test(value)) return false;
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);
}

/** The object name for one copy: dated, so a bucket listing sorts oldest first and reads at a glance. */
export function backupObjectKey(prefix: string, slug: string, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const folder = prefix === "" || prefix.endsWith("/") ? prefix : `${prefix}/`;
  return `${folder}${slug}/opentradesos-${slug}-${stamp}.zip`;
}
