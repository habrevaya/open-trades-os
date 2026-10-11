import { parseCsv } from "../custom-objects/index.js";
import { csvCell } from "../reporting/csv.js";
import { add, compare, money, subtract, toString, isZero, isNegative } from "../money/index.js";

/**
 * BRINGING IN A SPREADSHEET
 *
 * A company moving here has its history in files exported from wherever it
 * was before, and an owner with a spreadsheet and no programmer cannot drive
 * the migration toolkit. This is the half of the screen that needs no
 * database: which column is which, what each cell means, and which rows can
 * never load whatever the database says. The service takes what this hands
 * back and loads each row through the same creates the API uses.
 *
 * A COLUMN IS GUESSED FROM ITS HEADER, AND THE OWNER HAS THE LAST WORD. The
 * matcher knows the words people put at the top of a column (name, email,
 * phone, street, city, zip, amount, date) and nothing about any other
 * product's export: a header it does not know is left unmatched rather than
 * guessed at, because a wrong guess the owner does not notice puts every
 * phone number in the email column.
 *
 * A ROW IS REFUSED WITH A SENTENCE, NEVER REPAIRED. "about 200" in an amount
 * column is not loaded as nothing, a date that could be March or April is not
 * picked for the owner, and an invoice with no date is not dated today. Each
 * is a line saying why, and the rest of the file still goes in.
 *
 * A CELL IS TEXT. A cell that starts with `=` is stored as the characters it
 * holds and never evaluated, and when the refused rows go back out as a file a
 * spreadsheet shows it as text rather than running it.
 */

export const IMPORT_KINDS = ["customers", "equipment", "pricebook", "jobs", "invoices"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const isImportKind = (value: string): value is ImportKind =>
  (IMPORT_KINDS as readonly string[]).includes(value);

/** What each kind of file is called on the screen, and what one row of it is. */
export const KIND_LABEL: Record<ImportKind, { label: string; row: string; summary: string }> = {
  customers: {
    label: "Customers", row: "customer",
    summary: "One row per customer, with their address and, if you have one, the person to contact.",
  },
  equipment: {
    label: "Equipment", row: "unit",
    summary: "One row per unit, with the customer it belongs to and the address it is at.",
  },
  pricebook: {
    label: "Price book items", row: "item",
    summary: "One row per item, with its code, its name and its price.",
  },
  jobs: {
    label: "Past jobs", row: "job",
    summary: "One row per job, with the customer, what the job was and the day it was finished.",
  },
  invoices: {
    label: "Past invoices and their payments", row: "invoice",
    summary: "One row per invoice, with its date and total, and what was paid on it and when.",
  },
};

/** A file larger than this is several files. Five megabytes is tens of thousands of rows. */
export const MAX_BYTES = 5 * 1024 * 1024;
/** Rows in one file, for the same reason. */
export const MAX_ROWS = 10_000;
/** How many rows are tried, and then loaded, together. A batch goes in whole or not at all. */
export const BATCH_SIZE = 100;
/** The longest id a row can carry: room is left for `/payment` after an invoice's. */
export const MAX_KEY_LENGTH = 190;

export type FieldType =
  | "text" | "money" | "date" | "boolean"
  | "customerType" | "jobStatus" | "paymentMethod" | "itemKind";

export interface ImportField {
  key: string;
  label: string;
  type: FieldType;
  /** Header words that mean this field, compared without case or punctuation. */
  words: readonly string[];
  /** Needed on every row. Some kinds need one of two fields instead; see `mappingProblems`. */
  required?: boolean;
  /** Longest it may be, from the contract the row is loaded through. */
  max?: number;
}

/* Fields more than one kind of file has, so the words are said once. */
const REF: ImportField = {
  key: "ref", label: "Their id", type: "text", max: MAX_KEY_LENGTH,
  words: ["id", "record id", "ref", "reference", "external id", "old id"],
};
const CUSTOMER_REF: ImportField = {
  key: "customerRef", label: "Customer's id", type: "text", max: MAX_KEY_LENGTH,
  words: ["customer id", "client id", "account id", "account number", "customer number", "customer ref", "client number"],
};
const CUSTOMER_EMAIL: ImportField = {
  key: "customerEmail", label: "Customer's email", type: "text", max: 254,
  words: ["customer email", "client email", "email", "email address", "e mail", "customer email address"],
};
const STREET: ImportField = {
  key: "street", label: "Street", type: "text", max: 200,
  words: [
    "street", "address", "street address", "address 1", "address1", "address line 1", "line 1",
    "service address", "property address", "billing address", "mailing address", "job address",
  ],
};

export const FIELDS: Record<ImportKind, readonly ImportField[]> = {
  customers: [
    { ...REF, words: [...REF.words, "customer id", "client id", "account id", "account number", "customer number"] },
    { key: "name", label: "Name", type: "text", max: 200, words: ["name", "customer", "customer name", "client", "client name", "full name", "display name", "company", "company name", "business name"] },
    { key: "firstName", label: "First name", type: "text", max: 100, words: ["first name", "first", "given name", "firstname"] },
    { key: "lastName", label: "Last name", type: "text", max: 100, words: ["last name", "last", "surname", "family name", "lastname"] },
    { key: "type", label: "Home or business", type: "customerType", words: ["type", "customer type", "client type", "kind"] },
    { key: "email", label: "Email", type: "text", max: 254, words: ["email", "email address", "e mail", "mail", "customer email", "client email", "primary email"] },
    { key: "phone", label: "Phone", type: "text", max: 40, words: ["phone", "phone number", "mobile", "mobile phone", "cell", "cell phone", "telephone", "tel", "main phone", "customer phone", "client phone", "primary phone", "home phone", "work phone", "phone 1"] },
    STREET,
    { key: "street2", label: "Street, second line", type: "text", max: 200, words: ["address 2", "address2", "address line 2", "line 2", "street 2", "unit", "apt", "apartment", "suite"] },
    { key: "city", label: "City", type: "text", max: 100, words: ["city", "town"] },
    { key: "state", label: "State", type: "text", max: 50, words: ["state", "province", "region", "st"] },
    { key: "zip", label: "Zip", type: "text", max: 20, words: ["zip", "zip code", "zipcode", "postal", "postal code", "postcode"] },
    { key: "tags", label: "Tags", type: "text", words: ["tags", "tag", "labels"] },
    { key: "leadSource", label: "Lead source", type: "text", max: 100, words: ["lead source", "source", "referral source", "how did you hear", "how they found us"] },
    { key: "contactName", label: "Contact's name", type: "text", max: 200, words: ["contact", "contact name", "contact person"] },
    { key: "contactEmail", label: "Contact's email", type: "text", max: 254, words: ["contact email"] },
    { key: "contactPhone", label: "Contact's phone", type: "text", max: 40, words: ["contact phone", "contact mobile", "contact number"] },
    { key: "contactTitle", label: "Contact's role", type: "text", max: 100, words: ["contact title", "contact role", "title", "role"] },
  ],
  equipment: [
    { ...REF, words: [...REF.words, "equipment id", "unit id", "asset id"] },
    CUSTOMER_REF,
    CUSTOMER_EMAIL,
    STREET,
    { key: "category", label: "What it is", type: "text", required: true, max: 60, words: ["category", "type", "equipment type", "equipment", "unit type", "system", "system type", "kind"] },
    { key: "manufacturer", label: "Make", type: "text", max: 120, words: ["manufacturer", "make", "brand", "mfr"] },
    { key: "model", label: "Model", type: "text", max: 120, words: ["model", "model number", "model no"] },
    { key: "serial", label: "Serial number", type: "text", max: 120, words: ["serial", "serial number", "serial no", "sn", "s n"] },
    { key: "installedOn", label: "Installed on", type: "date", words: ["installed", "installed on", "install date", "date installed", "installation date"] },
    { key: "warrantyParts", label: "Parts warranty ends", type: "date", words: ["warranty", "warranty expires", "warranty end", "parts warranty", "warranty parts", "warranty expiration"] },
    { key: "warrantyLabor", label: "Labor warranty ends", type: "date", words: ["labor warranty", "labour warranty", "warranty labor", "warranty labour"] },
    { key: "tag", label: "Label", type: "text", max: 60, words: ["tag", "label", "unit name", "unit label"] },
    { key: "location", label: "Where it is", type: "text", max: 200, words: ["location", "where", "room", "located"] },
  ],
  pricebook: [
    { ...REF, words: [...REF.words, "item id", "product id"] },
    { key: "code", label: "Code", type: "text", required: true, max: 60, words: ["code", "sku", "item code", "part number", "part no", "item number", "item no", "product code"] },
    { key: "name", label: "Name", type: "text", required: true, max: 200, words: ["name", "item", "item name", "service", "service name", "product", "product name", "title"] },
    { key: "description", label: "Description", type: "text", max: 5000, words: ["description", "details", "long description"] },
    { key: "price", label: "Price", type: "money", required: true, words: ["price", "unit price", "sell price", "rate", "amount", "retail price"] },
    { key: "cost", label: "Cost", type: "money", words: ["cost", "unit cost", "our cost", "buy price"] },
    { key: "kind", label: "Kind of item", type: "itemKind", words: ["type", "kind", "item type"] },
    { key: "taxable", label: "Taxed", type: "boolean", words: ["taxable", "taxed", "tax"] },
  ],
  jobs: [
    { ...REF, words: [...REF.words, "job id", "work order id"] },
    { key: "number", label: "Job number", type: "text", max: MAX_KEY_LENGTH, words: ["job number", "job no", "job", "number", "work order", "work order number", "wo"] },
    CUSTOMER_REF,
    CUSTOMER_EMAIL,
    STREET,
    { key: "summary", label: "What the job was", type: "text", max: 300, words: ["summary", "title", "job title", "job name", "service", "work", "work done"] },
    { key: "description", label: "Notes", type: "text", max: 5000, words: ["description", "details", "notes", "job description", "job notes"] },
    { key: "status", label: "Status", type: "jobStatus", words: ["status", "job status", "state"] },
    { key: "finishedOn", label: "Finished on", type: "date", words: ["completed", "completed on", "completion date", "date completed", "finished", "finished on", "date", "job date", "closed", "closed on", "service date"] },
  ],
  invoices: [
    { ...REF, words: [...REF.words, "invoice id"] },
    { key: "number", label: "Invoice number", type: "text", max: MAX_KEY_LENGTH, words: ["invoice number", "invoice no", "invoice", "number", "inv", "inv number"] },
    CUSTOMER_REF,
    CUSTOMER_EMAIL,
    { key: "jobRef", label: "Job's id or number", type: "text", max: MAX_KEY_LENGTH, words: ["job id", "job number", "job", "work order", "job no"] },
    { key: "issuedOn", label: "Invoice date", type: "date", required: true, words: ["date", "invoice date", "issued", "issued on", "issue date", "date issued", "created", "billed on"] },
    { key: "dueOn", label: "Due date", type: "date", words: ["due", "due date", "due on", "date due"] },
    { key: "description", label: "What it was for", type: "text", max: 200, words: ["description", "item", "service", "memo", "details", "line", "for"] },
    { key: "subtotal", label: "Before tax", type: "money", words: ["subtotal", "sub total", "net", "amount before tax", "pre tax"] },
    { key: "tax", label: "Tax", type: "money", words: ["tax", "sales tax", "tax amount", "tax total"] },
    { key: "total", label: "Total", type: "money", words: ["total", "amount", "invoice total", "grand total", "total amount", "total due"] },
    { key: "paid", label: "Amount paid", type: "money", words: ["paid", "amount paid", "payment", "payments", "paid amount", "total paid"] },
    { key: "paidOn", label: "Paid on", type: "date", words: ["paid on", "payment date", "date paid", "paid date"] },
    { key: "method", label: "Paid by", type: "paymentMethod", words: ["method", "payment method", "paid by", "payment type", "paid with"] },
  ],
};

export function fieldsOf(kind: ImportKind): readonly ImportField[] {
  return FIELDS[kind];
}

/* ---------------------------------------------------------------- headers */

/**
 * A header as the matcher compares it: lower case, punctuation as spaces, and
 * `#` read as "number", because "Invoice #" and "Invoice Number" are the same
 * column.
 */
export function normalHeader(header: string): string {
  return header.toLowerCase()
    .replace(/#/g, " number ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** The file's headers as one key, order ignored, so a saved mapping finds a file shaped like the one it was saved from. */
export function headerKey(header: readonly string[]): string {
  return [...new Set(header.map(normalHeader).filter((h) => h !== ""))].sort().join("|");
}

/**
 * How well a header means a field. An exact phrase is certain; a header
 * containing every word of a phrase ("Customer Email Address" holding
 * "email address") is likely, and a longer phrase is a better reason than a
 * shorter one. Nothing else scores.
 */
function score(header: string, field: ImportField): number {
  if (header === "") return 0;
  const words = header.split(" ");
  let best = 0;
  for (const phrase of field.words) {
    if (header === phrase) return 1000;
    const parts = phrase.split(" ");
    const extra = words.length - parts.length;
    /**
     * A single word is only ever an exact match. Contained, "last" took
     * "Last service date" for a surname and "number" took "Phone number"
     * for a job's number; two words together are specific enough to find
     * inside a longer header.
     */
    if (parts.length >= 2 && extra <= 2 && parts.every((part) => words.includes(part))) {
      best = Math.max(best, 10 * parts.length - extra);
    }
  }
  return best;
}

/**
 * THE GUESS: each column's field, or null.
 *
 * Every pairing is scored, and the best pairs are taken first, each field
 * and each column once. So "Contact Email" goes to the contact's email (an
 * exact phrase) before "Email" can claim it, and two columns that both look
 * like a phone do not both become the phone.
 */
export function guessColumns(kind: ImportKind, header: readonly string[]): Array<string | null> {
  const normal = header.map(normalHeader);
  const pairs: Array<{ column: number; field: string; score: number }> = [];
  for (const [column, text] of normal.entries()) {
    for (const field of FIELDS[kind]) {
      const s = score(text, field);
      if (s > 0) pairs.push({ column, field: field.key, score: s });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.column - b.column);
  const out: Array<string | null> = header.map(() => null);
  const taken = new Set<string>();
  for (const pair of pairs) {
    if (out[pair.column] !== null || taken.has(pair.field)) continue;
    out[pair.column] = pair.field;
    taken.add(pair.field);
  }
  return out;
}

/** A saved mapping, as it is stored: normalised header to field. */
export function savedColumns(header: readonly string[], columns: readonly (string | null)[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [i, text] of header.entries()) {
    const field = columns[i];
    const key = normalHeader(text);
    if (field && key) out[key] = field;
  }
  return out;
}

/** A saved mapping applied to a file: its columns, in the file's order. */
export function columnsFromSaved(header: readonly string[], saved: Record<string, string>): Array<string | null> {
  return header.map((text) => saved[normalHeader(text)] ?? null);
}

/**
 * What is wrong with a mapping as a whole, before any row is read: a field
 * filled from two columns, or one every row needs filled from none.
 */
export function mappingProblems(kind: ImportKind, columns: readonly (string | null)[]): string[] {
  const fields = FIELDS[kind];
  const label = (key: string) => fields.find((f) => f.key === key)?.label ?? key;
  const used = columns.filter((c): c is string => c !== null);
  const problems: string[] = [];
  const unknown = used.filter((c) => !fields.some((f) => f.key === c));
  for (const key of new Set(unknown)) problems.push(`"${key}" is not something a ${KIND_LABEL[kind].row} has.`);
  for (const key of new Set(used)) {
    if (used.filter((c) => c === key).length > 1) problems.push(`Two columns are both set to ${label(key)}. Choose one.`);
  }
  const has = (key: string) => used.includes(key);
  for (const field of fields) {
    if (field.required && !has(field.key)) problems.push(`No column is set to ${field.label}. Every ${KIND_LABEL[kind].row} needs one.`);
  }
  if (kind === "customers" && !has("name") && !has("firstName") && !has("lastName")) {
    problems.push("No column is set to Name, or to First name and Last name. Every customer needs a name.");
  }
  if ((kind === "equipment" || kind === "jobs" || kind === "invoices") && !has("customerRef") && !has("customerEmail")) {
    problems.push(`No column is set to Customer's id or Customer's email, so there is no way to tell whose each ${KIND_LABEL[kind].row} is.`);
  }
  if (kind === "jobs" && !has("summary") && !has("description")) {
    problems.push("No column is set to What the job was, or to Notes. Every job needs to say what it was.");
  }
  if (kind === "invoices" && !has("total") && !has("subtotal")) {
    problems.push("No column is set to Total or to Before tax. Every invoice needs an amount.");
  }
  if (kind === "invoices" && has("paid") && !has("paidOn")) {
    problems.push("A column is set to Amount paid and none to Paid on. A payment without its date would land in today's books.");
  }
  return problems;
}

/* ------------------------------------------------------------------ cells */

export type Parsed = { ok: true; value: string } | { ok: false; why: string };
const ok = (value: string): Parsed => ({ ok: true, value });
const no = (why: string): Parsed => ({ ok: false, why });

/**
 * An amount: "$1,240.50", "1240.5", "(12.00)" or "-$12" for a negative.
 * Nothing that needs a guess: "about 200" and "=SUM(B2:B9)" are not amounts.
 */
export function parseAmount(raw: string): Parsed {
  let text = raw.trim();
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1).trim(); }
  if (text.startsWith("-")) { negative = !negative; text = text.slice(1).trim(); }
  text = text.replace(/^\$\s*/, "").replace(/\s*usd$/i, "");
  if (text.startsWith("-")) { negative = !negative; text = text.slice(1).trim(); }
  text = text.replace(/,(?=\d{3}(?:\D|$))/g, "");
  if (/^\.\d+$/.test(text)) text = `0${text}`;
  if (!/^\d+(\.\d+)?$/.test(text)) return no(`"${raw.trim()}" is not an amount.`);
  const decimals = text.split(".")[1]?.length ?? 0;
  if (decimals > 4) return no(`"${raw.trim()}" has more than four decimal places.`);
  const value = toString(money(text));
  return ok(negative && !isZero(money(value)) ? `-${value}` : value);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function calendar(year: number, month: number, day: number, raw: string): Parsed {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || month > 12 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return no(`"${raw}" is not a day on the calendar.`);
  }
  if (year < 1900) return no(`"${raw}" is before 1900.`);
  return ok(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
}

/**
 * A date, as `YYYY-MM-DD`.
 *
 * `2021-03-04`, with or without a time after it; `3/4/2021`, read month
 * first unless the owner says the file writes the day first; and `Mar 4,
 * 2021` or `4 March 2021`. A two digit year is refused rather than given a
 * century, and so is a bare number: a spreadsheet's count of days since 1900
 * looks exactly like a quantity, and picking wrongly puts an invoice in the
 * wrong decade.
 */
export function parseDate(raw: string, dayFirst = false): Parsed {
  const text = raw.trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(text);
  if (match) return calendar(Number(match[1]), Number(match[2]), Number(match[3]), text);
  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:\s.*)?$/.exec(text);
  if (match) {
    if (match[3]!.length !== 4) return no(`"${text}" has a two digit year. Write the year in full, like 2021.`);
    const [a, b] = [Number(match[1]), Number(match[2])];
    return dayFirst ? calendar(Number(match[3]), b, a, text) : calendar(Number(match[3]), a, b, text);
  }
  const words = text.toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
  match = /^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)? (\d{4})$/.exec(words);
  const named = (name: string) => MONTHS.indexOf(name.slice(0, 3)) + 1;
  if (match && named(match[1]!) > 0) return calendar(Number(match[3]), named(match[1]!), Number(match[2]), text);
  match = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)\.? (\d{4})$/.exec(words);
  if (match && named(match[2]!) > 0) return calendar(Number(match[3]), named(match[2]!), Number(match[1]), text);
  if (/^\d+(\.\d+)?$/.test(text)) {
    return no(`"${text}" is a number, not a date. Format the column as dates before saving the file.`);
  }
  return no(`"${text}" is not a date this can read. Write it like 2021-03-04 or 3/4/2021.`);
}

export function parseYesNo(raw: string): Parsed {
  const text = raw.trim().toLowerCase();
  if (["yes", "y", "true", "1", "x", "taxable", "taxed"].includes(text)) return ok("true");
  if (["no", "n", "false", "0", "not taxable", "exempt", "non taxable", "nontaxable"].includes(text)) return ok("false");
  return no(`"${raw.trim()}" is not yes or no.`);
}

function parseCustomerType(raw: string): Parsed {
  const text = raw.trim().toLowerCase();
  if (["residential", "home", "homeowner", "house", "res", "individual", "person", "consumer"].includes(text)) return ok("residential");
  if (["commercial", "business", "company", "com", "office", "b2b", "landlord", "property manager"].includes(text)) return ok("commercial");
  return no(`"${raw.trim()}" is not home or business.`);
}

export function parseJobStatus(raw: string): Parsed {
  const text = raw.trim().toLowerCase().replace(/[^a-z]+/g, " ").trim();
  if (["completed", "complete", "done", "finished", "closed", "invoiced", "paid", "billed"].includes(text)) return ok("completed");
  if (["cancelled", "canceled", "void", "voided", "called off"].includes(text)) return ok("cancelled");
  if (["open", "new", "lead", "pending", "scheduled", "in progress", "active", "unscheduled", "on hold"].includes(text)) return ok("open");
  return no(`"${raw.trim()}" is not a status this can read. Use completed, cancelled or open.`);
}

/**
 * How a payment was made. Anything this does not recognise ("Zelle", "store
 * credit") is recorded as other rather than refused: the money arrived, and
 * other is a true answer to how.
 */
export function parsePaymentMethod(raw: string): Parsed {
  const text = raw.trim().toLowerCase().replace(/[^a-z]+/g, " ").trim();
  if (text === "") return ok("other");
  if (["cash"].includes(text)) return ok("cash");
  if (["check", "cheque", "chk", "ck"].includes(text)) return ok("check");
  if (["card", "credit card", "credit", "debit", "debit card", "visa", "mastercard", "master card", "amex", "american express", "discover", "cc"].includes(text)) return ok("card");
  if (["ach", "bank", "bank transfer", "transfer", "eft", "wire", "direct deposit", "e check", "echeck"].includes(text)) return ok("ach");
  if (["financing", "finance", "loan"].includes(text)) return ok("financing");
  return ok("other");
}

function parseItemKind(raw: string): Parsed {
  const text = raw.trim().toLowerCase();
  if (["service", "services"].includes(text)) return ok("service");
  if (["material", "materials", "part", "parts", "product", "inventory"].includes(text)) return ok("material");
  if (["equipment"].includes(text)) return ok("equipment");
  if (["labor", "labour"].includes(text)) return ok("labor");
  if (["fee", "fees", "charge"].includes(text)) return ok("fee");
  if (["discount"].includes(text)) return ok("discount");
  return no(`"${raw.trim()}" is not a kind of item. Use service, material, equipment, labor, fee or discount.`);
}

function parseCell(field: ImportField, raw: string, dayFirst: boolean): Parsed {
  switch (field.type) {
    case "money": return parseAmount(raw);
    case "date": return parseDate(raw, dayFirst);
    case "boolean": return parseYesNo(raw);
    case "customerType": return parseCustomerType(raw);
    case "jobStatus": return parseJobStatus(raw);
    case "paymentMethod": return parsePaymentMethod(raw);
    case "itemKind": return parseItemKind(raw);
    default: {
      const text = raw.trim();
      if (field.max !== undefined && text.length > field.max) {
        return no(`${field.label} is longer than ${field.max} characters.`);
      }
      return ok(text);
    }
  }
}

/* ------------------------------------------------------------------- rows */

export interface ReadOptions {
  dayFirst: boolean;
  /** The company's today, so a date after it is refused here rather than by the first service that sees it. */
  today: string;
}

export interface ReadRow {
  /** Each filled field, as the value it means: amounts as decimals, dates as `YYYY-MM-DD`. */
  values: Record<string, string>;
  /** Why it cannot load, each a sentence. Empty when nothing here stops it. */
  problems: string[];
}

/**
 * ONE ROW, READ.
 *
 * Every cell of a mapped column is read by its field's type, and the row is
 * held to the rules that need no database: the fields it needs, an address
 * that is either whole or absent, and above all a date on anything that
 * posts to the books. An invoice or a payment without one would be dated
 * today, which is exactly the history landing in this month's books that the
 * rest of this product refuses.
 */
export function readRow(
  kind: ImportKind, columns: readonly (string | null)[], cells: readonly string[], options: ReadOptions,
): ReadRow {
  const fields = FIELDS[kind];
  const values: Record<string, string> = {};
  const problems: string[] = [];
  for (const [i, key] of columns.entries()) {
    if (!key) continue;
    const field = fields.find((f) => f.key === key);
    const raw = (cells[i] ?? "").trim();
    if (!field || raw === "") continue;
    const parsed = parseCell(field, raw, options.dayFirst);
    if (parsed.ok) {
      if (parsed.value !== "") values[key] = parsed.value;
    } else {
      problems.push(`${field.label}: ${parsed.why}`);
    }
  }
  const label = (key: string) => fields.find((f) => f.key === key)?.label ?? key;
  for (const field of fields) {
    if (field.type === "date" && values[field.key] && values[field.key]! > options.today) {
      problems.push(`${field.label} is ${values[field.key]}, which has not happened yet.`);
    }
  }
  for (const field of fields) {
    if (field.required && values[field.key] === undefined && !problems.some((p) => p.startsWith(`${field.label}:`))) {
      problems.push(kind === "invoices" && field.key === "issuedOn"
        ? "It has no invoice date. Without one it would be put in today's books instead of the day it was sent."
        : `${field.label} is empty.`);
    }
  }
  const missing = (keys: string[]) => keys.filter((k) => values[k] === undefined && !problems.some((p) => p.startsWith(`${label(k)}:`)));

  switch (kind) {
    case "customers": {
      if (values["name"] === undefined) {
        const joined = [values["firstName"], values["lastName"]].filter(Boolean).join(" ");
        if (joined) values["name"] = joined;
        else if (!problems.some((p) => p.startsWith("Name:"))) problems.push("Name is empty.");
      }
      const address = ["street", "city", "state", "zip"];
      if (address.some((k) => values[k] !== undefined) || values["street2"] !== undefined) {
        const gap = missing(address);
        if (gap.length > 0) {
          problems.push(`The address is missing its ${gap.map((k) => label(k).toLowerCase()).join(", ")}. Fill it in or leave the whole address empty.`);
        }
      }
      if (values["state"] !== undefined && values["state"].length < 2) problems.push("State needs at least two letters.");
      if (values["contactName"] === undefined
        && (values["contactEmail"] !== undefined || values["contactPhone"] !== undefined || values["contactTitle"] !== undefined)) {
        problems.push("There are contact details and no contact's name.");
      }
      break;
    }
    case "equipment":
    case "jobs":
    case "invoices": {
      if (values["customerRef"] === undefined && values["customerEmail"] === undefined
        && !problems.some((p) => p.startsWith("Customer"))) {
        problems.push("Neither the customer's id nor their email is filled in, so there is no telling whose it is.");
      }
      break;
    }
    default:
      break;
  }

  if (kind === "equipment" && values["warrantyParts"] && values["installedOn"] && values["warrantyParts"] < values["installedOn"]) {
    problems.push("The parts warranty ends before the unit was installed.");
  }

  if (kind === "jobs") {
    if (values["summary"] === undefined && values["description"] !== undefined) {
      values["summary"] = values["description"].split(/\r?\n/)[0]!.slice(0, 300);
    }
    if (values["summary"] === undefined && !problems.some((p) => p.startsWith("What the job was:"))) {
      problems.push("It does not say what the job was.");
    }
    const status = values["status"] ?? (values["finishedOn"] ? "completed" : undefined);
    if (status === undefined && !problems.some((p) => p.startsWith("Status:"))) {
      problems.push("It has no status and no day it was finished. Fill in the day it was finished, or put open or cancelled in its status.");
    } else if (status === "completed" && values["finishedOn"] === undefined && !problems.some((p) => p.startsWith("Finished on:"))) {
      problems.push("It says it was finished and not when. Without the day it would be counted as finished today.");
    } else if (status === "open" && values["finishedOn"] !== undefined) {
      problems.push("It has a day it was finished and says it is still open. Change one of them.");
    }
    if (status !== undefined) values["status"] = status;
  }

  if (kind === "invoices") {
    const amounts = invoiceAmounts(values);
    if (!amounts.ok) problems.push(amounts.why);
    else {
      values["subtotal"] = amounts.subtotal;
      values["tax"] = amounts.tax;
      values["total"] = amounts.total;
      const paid = values["paid"];
      if (paid !== undefined && !isZero(money(paid))) {
        if (isNegative(money(paid))) problems.push("Amount paid is below zero. Record a refund on the payment instead.");
        else if (compare(money(paid), money(amounts.total)) > 0) {
          problems.push(`It says ${trimMoney(paid)} was paid on an invoice of ${trimMoney(amounts.total)}.`);
        }
        if (values["paidOn"] === undefined && !problems.some((p) => p.startsWith("Paid on:"))) {
          problems.push("It says money was paid and not when. Without the day the payment would be put in today's books.");
        }
      }
    }
  }

  return { values, problems };
}

/**
 * An invoice's three amounts from whichever the file has. Before tax and tax
 * give the total; a total and tax give what came before it; a total alone
 * was not taxed. When all three are there they have to agree to the cent,
 * because a file that disagrees with itself does not say which one is wrong.
 */
export function invoiceAmounts(values: Record<string, string>):
  { ok: true; subtotal: string; tax: string; total: string } | { ok: false; why: string } {
  const sub = values["subtotal"];
  const tax = values["tax"];
  const total = values["total"];
  if (sub === undefined && total === undefined) return { ok: false, why: "It has no amount: fill in Total or Before tax." };
  const t = tax ?? "0";
  const subtotal = sub ?? toString(subtract(money(total!), money(t)));
  const sum = toString(add(money(subtotal), money(t)));
  if (total !== undefined && compare(money(sum), money(total)) !== 0) {
    return { ok: false, why: `Before tax ${trimMoney(subtotal)} and tax ${trimMoney(t)} come to ${trimMoney(sum)}, not the ${trimMoney(total)} in Total.` };
  }
  if (isNegative(money(subtotal))) return { ok: false, why: "The amount before tax is below zero. Bring in a credit as a credit note instead." };
  if (!isZero(money(t)) && isZero(money(subtotal))) return { ok: false, why: "It has tax on nothing: the amount before tax is zero." };
  return { ok: true, subtotal, tax: toString(money(t)), total: sum };
}

/**
 * The rate a tax was charged at, to six places, from the amount before tax
 * and the tax. The invoice keeps the tax as the file had it; the rate is what
 * the line records it was charged at, and the invoice service checks the two
 * agree to within a cent.
 */
export function taxRateOf(tax: string, subtotal: string): string {
  const t = money(tax).amount;
  const s = money(subtotal).amount;
  if (s === 0n) return "0.000000";
  const scaled = (t * 1_000_000n * 2n + s) / (2n * s);
  const whole = scaled / 1_000_000n;
  const frac = (scaled % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

/** An amount as a person reads it: two places, more only when it has them. */
export function trimMoney(value: string): string {
  const [whole = "0", frac = ""] = value.split(".");
  const kept = frac.replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${kept}`;
}

/**
 * The id a row's record is given, before the service falls back to a hash of
 * the row: the file's own id, or the field that already names one record
 * (a price book item's code, a job's or an invoice's number).
 */
export function naturalKey(kind: ImportKind, values: Record<string, string>): string | null {
  if (values["ref"]) return values["ref"];
  if (kind === "pricebook" && values["code"]) return values["code"];
  if ((kind === "jobs" || kind === "invoices") && values["number"]) return values["number"];
  return null;
}

/** The fields a row's preview shows, in the order the kind lists them. */
export function previewFields(kind: ImportKind, columns: readonly (string | null)[]): ImportField[] {
  const used = new Set(columns.filter((c): c is string => c !== null));
  return FIELDS[kind].filter((f) => used.has(f.key));
}

/* ------------------------------------------------------------- the file */

/**
 * The file as rows, refused in words when it is too big to be one file. Five
 * megabytes and ten thousand rows is a company's whole customer list; a file
 * past that is several files, and a spreadsheet splits by rows easily.
 */
export function readFile(text: string, bytes: number):
  { ok: true; header: string[]; rows: string[][] } | { ok: false; why: string } {
  if (bytes > MAX_BYTES) {
    const mb = (bytes / 1024 / 1024).toFixed(1);
    return { ok: false, why: `That file is ${mb} MB. Bring in at most 5 MB at a time: split it into smaller files and bring each one in.` };
  }
  /**
   * A workbook is a zip, and a zip starts "PK". Reading one as text gives a
   * screen of symbols and a mapping nobody can make sense of, so it is
   * refused with what to do instead. This reads CSV only: no workbook reader
   * is part of this product.
   */
  if (text.startsWith("PK\u0003\u0004") || text.includes("\u0000")) {
    return { ok: false, why: "That is a spreadsheet workbook, not a CSV file. In your spreadsheet program choose Save As or Download, pick CSV, and bring in that file." };
  }
  const all = parseCsv(text);
  const [header, ...rows] = all;
  if (!header || header.every((h) => h.trim() === "")) return { ok: false, why: "That file is empty." };
  if (rows.length === 0) return { ok: false, why: "That file has a header row and nothing under it." };
  if (rows.length > MAX_ROWS) {
    return { ok: false, why: `That file has ${rows.length.toLocaleString("en-US")} rows. Bring in at most ${MAX_ROWS.toLocaleString("en-US")} at a time: split it into smaller files.` };
  }
  return { ok: true, header: header.map((h) => h.trim()), rows };
}

/**
 * The refused rows as a file to fix and bring in again: the original header
 * and cells, with the row's place in the first file and the reason last. A
 * cell that would be a formula in a spreadsheet is written as text, and this
 * product's own reader takes the mark off again on the way back in.
 */
export function refusedCsv(
  header: readonly string[], rows: ReadonlyArray<{ row: number; cells: readonly string[]; reason: string }>,
): string {
  const line = (cells: readonly string[]) => cells.map((c) => csvCell(c)).join(",");
  const lines = [line([...header, "Original row", "Refused because"])];
  for (const row of rows) {
    const cells = header.map((_, i) => row.cells[i] ?? "");
    lines.push(line([...cells, String(row.row), row.reason]));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
