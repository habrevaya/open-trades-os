import { parseCsv } from "../custom-objects/index.js";
import { csvCell } from "../reporting/csv.js";
export * from "./workbook.js";
import { add, compare, money, multiply, round, subtract, sum, toString, isZero, isNegative, isPositive } from "../money/index.js";

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

export const IMPORT_KINDS = [
  "customers", "equipment", "pricebook", "jobs", "invoices", "payments", "estimates", "notes", "visits",
] as const;
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
    summary: "One row per invoice, with its date and total, and what was paid on it and when. "
      + "An invoice with several lines is several rows with the same invoice number, one per line.",
  },
  estimates: {
    label: "Past estimates", row: "estimate",
    summary: "One row per estimate, with the customer, its amount, the day it was written and sent, and how it ended: approved, declined or expired. "
      + "An estimate with several lines or several options is several rows with the same estimate number, one per line, and a column of option names says which option each line is in.",
  },
  notes: {
    label: "Customer notes", row: "note",
    summary: "One row per note, with the customer it is about, the day it was written and what it says.",
  },
  visits: {
    label: "Past visits", row: "visit",
    summary: "One row per visit on a finished job: the job, the email of the technician who went, the day, "
      + "the time they started and, if you have it, the time they finished.",
  },
  payments: {
    label: "Past payments", row: "payment",
    summary: "One row per invoice a payment paid, with the payment's id, the invoice, the amount and the day. "
      + "A payment split across invoices is several rows with the same payment id.",
  },
};

/**
 * THE KINDS WHERE SEVERAL ROWS ARE ONE RECORD.
 *
 * An invoice with three lines is three rows with one invoice number, a cheque
 * that paid two invoices is two rows with one payment id, and an estimate with
 * two options of two lines each is four rows with one estimate number: that is
 * how every accounting program exports them. The rows sharing an id are read
 * together and go in as one create, the first row carrying the rest; for any
 * other kind a second row with the same id is the same record twice, and is
 * refused naming the first.
 */
export const GROUPED_KINDS: readonly ImportKind[] = ["invoices", "payments", "estimates"];
export const isGrouped = (kind: ImportKind): boolean => GROUPED_KINDS.includes(kind);

/** A file larger than this is several files. Five megabytes is tens of thousands of rows. */
export const MAX_BYTES = 5 * 1024 * 1024;
/** Rows in one file, for the same reason. */
export const MAX_ROWS = 10_000;
/** How many rows are tried, and then loaded, together. A batch goes in whole or not at all. */
export const BATCH_SIZE = 100;
/** The longest id a row can carry: room is left for `/payment` after an invoice's. */
export const MAX_KEY_LENGTH = 190;

export type FieldType =
  | "text" | "money" | "date" | "time" | "boolean" | "quantity"
  | "customerType" | "jobStatus" | "paymentMethod" | "itemKind" | "estimateOutcome";

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
    { key: "quantity", label: "Quantity", type: "quantity", words: ["quantity", "qty", "hours", "line quantity"] },
    { key: "unitPrice", label: "Price each", type: "money", words: ["price each", "unit price", "price", "rate", "line rate"] },
    { key: "subtotal", label: "Before tax", type: "money", words: ["subtotal", "sub total", "net", "before tax", "amount before tax", "pre tax", "line amount", "line total"] },
    { key: "tax", label: "Tax", type: "money", words: ["tax", "sales tax", "tax amount", "tax total"] },
    { key: "total", label: "Total", type: "money", words: ["total", "amount", "invoice total", "grand total", "total amount", "total due"] },
    { key: "paid", label: "Amount paid", type: "money", words: ["paid", "amount paid", "payment", "payments", "paid amount", "total paid"] },
    { key: "paidOn", label: "Paid on", type: "date", words: ["paid on", "payment date", "date paid", "paid date"] },
    { key: "method", label: "Paid by", type: "paymentMethod", words: ["method", "payment method", "paid by", "payment type", "paid with"] },
  ],
  estimates: [
    { ...REF, words: [...REF.words, "estimate id", "quote id", "proposal id"] },
    { key: "number", label: "Estimate number", type: "text", max: MAX_KEY_LENGTH, words: ["estimate number", "estimate no", "estimate", "quote number", "quote no", "quote", "proposal number", "number"] },
    CUSTOMER_REF,
    CUSTOMER_EMAIL,
    STREET,
    { key: "jobRef", label: "Job's id or number", type: "text", max: MAX_KEY_LENGTH, words: ["job id", "job number", "job", "work order", "job no"] },
    { key: "title", label: "What it was for", type: "text", max: 200, words: ["title", "description", "summary", "estimate title", "quote title", "name", "for"] },
    { key: "issuedOn", label: "Written on", type: "date", required: true, words: ["date", "estimate date", "quote date", "written", "written on", "created", "created on", "issued", "issued on", "issue date"] },
    { key: "sentOn", label: "Sent on", type: "date", words: ["sent", "sent on", "date sent", "sent date"] },
    { key: "subtotal", label: "Before tax", type: "money", words: ["subtotal", "sub total", "before tax", "amount before tax", "pre tax", "net"] },
    { key: "tax", label: "Tax", type: "money", words: ["tax", "sales tax", "tax amount", "tax total"] },
    { key: "total", label: "Total", type: "money", words: ["total", "amount", "estimate total", "quote total", "grand total", "value", "price"] },
    { key: "outcome", label: "How it ended", type: "estimateOutcome", words: ["status", "outcome", "result", "estimate status", "quote status", "stage"] },
    { key: "decidedOn", label: "Decided on", type: "date", words: ["decided", "decided on", "approved on", "declined on", "accepted on", "closed on", "won on", "lost on", "outcome date", "date decided", "date approved", "approved date"] },
    { key: "reason", label: "Why it was declined", type: "text", max: 1000, words: ["reason", "decline reason", "declined reason", "lost reason", "why"] },
    /* An estimate that arrives whole: the columns that say which line is in which option. */
    { key: "option", label: "Option", type: "text", max: 100, words: ["option", "option name", "package", "package name", "tier", "choice", "proposal option"] },
    { key: "lineName", label: "Line item", type: "text", max: 200, words: ["line", "line item", "line description", "line name", "item", "item name", "item description", "product", "product name"] },
    { key: "quantity", label: "Quantity", type: "quantity", words: ["quantity", "qty", "line quantity", "hours"] },
    { key: "unitPrice", label: "Price each", type: "money", words: ["price each", "unit price", "rate", "line rate", "each"] },
    { key: "recommended", label: "Recommended", type: "boolean", words: ["recommended", "is recommended", "recommended option", "best value", "preferred"] },
    { key: "chosen", label: "Chosen by the customer", type: "boolean", words: ["chosen", "selected", "chosen option", "selected option", "approved option", "accepted option", "option chosen", "option selected", "picked"] },
  ],
  /**
   * NOTES AND VISITS, the last of a customer's history a file can carry.
   *
   * A note is dated by its file and lands as one of the customer's notes,
   * marked as brought in (M03). A visit goes on a job a jobs file already
   * brought in, finished: it names the technician by their email, and only
   * somebody on the board matches, because a visit put on the wrong person, or
   * on nobody, is worse than a row refused.
   */
  notes: [
    { ...REF, words: [...REF.words, "note id", "comment id"] },
    CUSTOMER_REF,
    CUSTOMER_EMAIL,
    { key: "body", label: "The note", type: "text", required: true, max: 4000, words: ["note", "notes", "comment", "comments", "text", "body", "note text", "details"] },
    { key: "notedOn", label: "Written on", type: "date", required: true, words: ["date", "note date", "created", "created on", "created at", "written", "written on", "date added", "added on"] },
    { key: "forField", label: "For the technician", type: "boolean", words: ["for technician", "show technician", "technician note", "field note", "show in field", "for field"] },
  ],
  visits: [
    { ...REF, words: [...REF.words, "visit id", "appointment id"] },
    { key: "jobRef", label: "Job's id or number", type: "text", required: true, max: MAX_KEY_LENGTH, words: ["job id", "job number", "job", "work order", "work order number", "job no"] },
    { key: "technicianEmail", label: "Technician's email", type: "text", required: true, max: 254, words: ["technician email", "tech email", "employee email", "assigned to email", "assignee email", "technician", "tech", "assigned to"] },
    { key: "visitedOn", label: "Day", type: "date", required: true, words: ["date", "visit date", "day", "service date", "appointment date", "scheduled date", "start date"] },
    { key: "startTime", label: "Started at", type: "time", required: true, words: ["start", "start time", "time", "started", "started at", "arrival", "arrival time", "arrived", "time in"] },
    { key: "endTime", label: "Finished at", type: "time", words: ["end", "end time", "finish", "finish time", "finished", "finished at", "departed", "time out", "completed at"] },
    { key: "notes", label: "What the technician wrote", type: "text", max: 5000, words: ["notes", "technician notes", "tech notes", "visit notes", "work done", "description", "comments"] },
  ],
  payments: [
    { ...REF, words: [...REF.words, "payment id", "payment number", "receipt number", "transaction id"] },
    CUSTOMER_REF,
    CUSTOMER_EMAIL,
    { key: "invoiceRef", label: "Invoice's id or number", type: "text", max: MAX_KEY_LENGTH, words: ["invoice id", "invoice number", "invoice", "invoice no", "inv", "applied to", "invoice ref"] },
    { key: "amount", label: "Amount", type: "money", required: true, words: ["amount", "amount applied", "applied", "amount paid", "paid", "payment amount", "payment"] },
    { key: "paidOn", label: "Paid on", type: "date", required: true, words: ["date", "paid on", "payment date", "date paid", "received", "received on", "date received"] },
    { key: "method", label: "Paid by", type: "paymentMethod", words: ["method", "payment method", "paid by", "payment type", "paid with", "type"] },
    { key: "checkNumber", label: "Check number", type: "text", max: 50, words: ["check number", "check no", "cheque number", "check"] },
    { key: "memo", label: "Note", type: "text", max: 1000, words: ["memo", "note", "notes", "description"] },
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
  if (kind === "payments" && !has("customerRef") && !has("customerEmail") && !has("invoiceRef")) {
    problems.push("No column is set to Customer's id, Customer's email or Invoice's id or number, so there is no way to tell whose each payment is.");
  }
  if ((kind === "invoices" || kind === "estimates") && has("quantity") && !has("unitPrice")) {
    problems.push("A column is set to Quantity and none to Price each. A quantity needs the price of one to make a line.");
  }
  if ((kind === "equipment" || kind === "jobs" || kind === "invoices") && !has("customerRef") && !has("customerEmail")) {
    problems.push(`No column is set to Customer's id or Customer's email, so there is no way to tell whose each ${KIND_LABEL[kind].row} is.`);
  }
  if (kind === "jobs" && !has("summary") && !has("description")) {
    problems.push("No column is set to What the job was, or to Notes. Every job needs to say what it was.");
  }
  if (kind === "estimates" && !has("total") && !has("subtotal") && !has("unitPrice")) {
    problems.push("No column is set to Total, Before tax or Price each. Every estimate needs an amount.");
  }
  if (kind === "notes" && !has("customerRef") && !has("customerEmail")) {
    problems.push("No column is set to Customer's id or Customer's email, so there is no way to tell whose each note is.");
  }
  if (kind === "estimates" && !has("customerRef") && !has("customerEmail")) {
    problems.push("No column is set to Customer's id or Customer's email, so there is no way to tell whose each estimate is.");
  }
  if (kind === "invoices" && !has("total") && !has("subtotal") && !has("unitPrice")) {
    problems.push("No column is set to Total, Before tax or Price each. Every invoice needs an amount.");
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

/**
 * A time of day, as `HH:MM` on a 24 hour clock: "14:30", "2:30 PM", "2pm",
 * "09:05:00", or a time with its day in front, "2021-03-04 14:30". Read on the company's clock by whoever places it. A time with
 * no AM or PM is read as a 24 hour clock, so "2:30" is the middle of the
 * night: a file that writes afternoons without PM says so in every other row.
 */
export function parseTime(raw: string): Parsed {
  /** A date and time in one cell, as a workbook's date column gives it: the day is read from the Day column instead. */
  const text = raw.trim().toLowerCase().replace(/\s+/g, " ").replace(/^\d{4}-\d{2}-\d{2}[t ]/, "");
  const match = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s?(am|pm|a\.m\.|p\.m\.)?$/.exec(text);
  if (!match || (match[2] === undefined && match[4] === undefined)) {
    return no(`"${raw.trim()}" is not a time this can read. Write it like 14:30 or 2:30 PM.`);
  }
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const half = match[4]?.startsWith("p") ? "pm" : match[4] ? "am" : null;
  if (minute > 59) return no(`"${raw.trim()}" is not a time on the clock.`);
  if (half) {
    if (hour < 1 || hour > 12) return no(`"${raw.trim()}" is not a time on the clock.`);
    hour = (hour % 12) + (half === "pm" ? 12 : 0);
  } else if (hour > 23) {
    return no(`"${raw.trim()}" is not a time on the clock.`);
  }
  return ok(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
}

/** Minutes after midnight of an `HH:MM`. */
export const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** How many: "2", "1.5", "0.25". Above zero, at most four places, and never a guess. */
export function parseQuantity(raw: string): Parsed {
  const text = raw.trim().replace(/,(?=\d{3}(?:\D|$))/g, "");
  if (!/^\d*\.?\d+$/.test(text)) return no(`"${raw.trim()}" is not a quantity.`);
  if ((text.split(".")[1]?.length ?? 0) > 4) return no(`"${raw.trim()}" has more than four decimal places.`);
  const value = toString(money(text.startsWith(".") ? `0${text}` : text));
  if (!isPositive(money(value))) return no("A quantity has to be more than nothing.");
  return ok(value);
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

/**
 * How an estimate ended. Open is an answer too: it was never decided, and
 * comes in as a draft to send from here.
 */
export function parseEstimateOutcome(raw: string): Parsed {
  const text = raw.trim().toLowerCase().replace(/[^a-z]+/g, " ").trim();
  if (["approved", "accepted", "won", "sold", "signed", "yes", "converted", "closed won", "booked"].includes(text)) return ok("approved");
  if (["declined", "rejected", "lost", "no", "closed lost", "turned down"].includes(text)) return ok("declined");
  if (["expired", "lapsed", "timed out"].includes(text)) return ok("expired");
  if (["open", "pending", "sent", "draft", "waiting", "new", "viewed", "awaiting response", "follow up"].includes(text)) return ok("open");
  return no(`"${raw.trim()}" is not how an estimate ended this can read. Use approved, declined, expired or open.`);
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
    case "time": return parseTime(raw);
    case "boolean": return parseYesNo(raw);
    case "quantity": return parseQuantity(raw);
    case "customerType": return parseCustomerType(raw);
    case "jobStatus": return parseJobStatus(raw);
    case "paymentMethod": return parsePaymentMethod(raw);
    case "itemKind": return parseItemKind(raw);
    case "estimateOutcome": return parseEstimateOutcome(raw);
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
  /**
   * The row is one of several that are one record (`readGroup`): a line of
   * an invoice, or one invoice a payment paid. Its Before tax and Tax are
   * the line's; what the rows share (the invoice date, whose it is, its
   * Total, the day a payment was paid) only has to be on one of them, and
   * is checked once across the rows rather than against this one.
   */
  line?: boolean | undefined;
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
  const sharedKeys = options.line ? sharedOf(kind) : [];
  for (const field of fields) {
    if (sharedKeys.includes(field.key)) continue;
    if (field.required && values[field.key] === undefined && !problems.some((p) => p.startsWith(`${field.label}:`))) {
      problems.push(kind === "invoices" && field.key === "issuedOn"
        ? "It has no invoice date. Without one it would be put in today's books instead of the day it was sent."
        : kind === "payments" && field.key === "paidOn"
          ? "It has no day it was paid. Without one the payment would be put in today's books."
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
    case "estimates":
    case "notes":
    case "invoices": {
      if (options.line) break;
      if (values["customerRef"] === undefined && values["customerEmail"] === undefined
        && !problems.some((p) => p.startsWith("Customer"))) {
        problems.push("Neither the customer's id nor their email is filled in, so there is no telling whose it is.");
      }
      break;
    }
    case "payments": {
      if (!options.line && values["customerRef"] === undefined && values["customerEmail"] === undefined && values["invoiceRef"] === undefined
        && !problems.some((p) => p.startsWith("Customer") || p.startsWith("Invoice"))) {
        problems.push("Neither the invoice nor the customer is filled in, so there is no telling whose money it is.");
      }
      if (values["amount"] !== undefined && !isPositive(money(values["amount"]))) {
        problems.push("Amount has to be more than nothing. Record money given back as a refund on the payment instead.");
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

  if (kind === "visits") {
    const email = values["technicianEmail"];
    if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      problems.push(`Technician's email: "${email}" is not an email address. A visit finds the technician by the email they sign in with.`);
    }
    const start = values["startTime"];
    const end = values["endTime"];
    if (start !== undefined && end !== undefined && minutesOf(end) <= minutesOf(start)) {
      problems.push(`It finished at ${end}, which is not after it started at ${start}. A visit that ran past midnight is not taken: split it at midnight.`);
    }
  }

  if ((kind === "invoices" || kind === "estimates") && values["unitPrice"] !== undefined) {
    /**
     * A quantity at a price each makes the line's amount before tax, rounded
     * to the cent the way the invoice rounds it. A Before tax beside them
     * has to agree, because a row that disagrees with itself does not say
     * which number is wrong.
     */
    const before = lineAmount(values["quantity"] ?? "1", values["unitPrice"]);
    if (values["subtotal"] !== undefined && compare(money(values["subtotal"]), money(before)) !== 0) {
      problems.push(`${trimQuantity(values["quantity"] ?? "1")} at ${trimMoney(values["unitPrice"])} is ${trimMoney(before)}, not the ${trimMoney(values["subtotal"])} in Before tax.`);
    }
    values["subtotal"] = before;
  }

  if (kind === "estimates" && !options.line) readEstimate(values, problems, label);

  if ((kind === "invoices" || kind === "estimates") && options.line) {
    /** One line of several: its own amount, with the record's total checked across the rows by `readGroup`. */
    const sub = values["subtotal"];
    if (sub === undefined && !problems.some((p) => p.startsWith("Before tax:") || p.startsWith("Price each:"))) {
      problems.push(`A line of ${kind === "invoices" ? "an invoice" : "an estimate"} with several needs its own amount: fill in Before tax, or Price each.`);
    } else if (sub !== undefined) {
      const tax = values["tax"] ?? "0";
      if (isNegative(money(sub))) {
        problems.push(kind === "invoices"
          ? "The amount before tax is below zero. Bring in a credit as a credit note instead."
          : "The amount before tax is below zero. An estimate is for an amount.");
      } else if (!isZero(money(tax)) && isZero(money(sub))) problems.push("It has tax on nothing: the amount before tax is zero.");
      values["tax"] = toString(money(tax));
    }
  } else if (kind === "invoices") {
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
 * AN ESTIMATE AS IT ENDED. Its amounts the way an invoice's are read; then
 * how it ended, which needs the day when it was decided and never a day
 * when it was not; and the day it was sent, which only an estimate that
 * ended may carry. One sent and still waiting is not brought in as sent,
 * because a follow up that chases waiting estimates would chase one the
 * customer answered in the old system years ago; it is refused, to bring in
 * as open and send from here, or with how it ended.
 */
function readEstimate(values: Record<string, string>, problems: string[], label: (key: string) => string): void {
  const amounts = invoiceAmounts(values);
  if (!amounts.ok) problems.push(amounts.why.replace("Bring in a credit as a credit note instead.", "An estimate is for an amount."));
  else {
    values["subtotal"] = amounts.subtotal;
    values["tax"] = amounts.tax;
    values["total"] = amounts.total;
  }
  estimateOutcome(values, problems, label);
}

/**
 * How an estimate ended, from what it says once: read on a row of its own, or
 * on the values its rows share when it has several.
 */
function estimateOutcome(values: Record<string, string>, problems: string[], label: (key: string) => string): void {
  const outcome = values["outcome"] ?? (values["decidedOn"] !== undefined ? undefined : "open");
  const decided = values["decidedOn"];
  if (outcome === undefined) {
    if (!problems.some((p) => p.startsWith(`${label("outcome")}:`))) {
      problems.push("It has a day it was decided and does not say how it ended. Fill in approved, declined or expired.");
    }
    return;
  }
  values["outcome"] = outcome;
  if (outcome === "open") {
    if (decided !== undefined) problems.push("It has a day it was decided and says it is still open. Change one of them.");
    if (values["sentOn"] !== undefined) {
      problems.push("It was sent and is still waiting for an answer. Bring it in as open with no day sent, to send from here, or say how it ended.");
    }
  } else if (decided === undefined) {
    if (!problems.some((p) => p.startsWith(`${label("decidedOn")}:`))) {
      problems.push(`It says it was ${outcome} and not when. Fill in the day in Decided on.`);
    }
  }
  const written = values["issuedOn"];
  if (written !== undefined && decided !== undefined && decided < written) {
    problems.push(`It was decided on ${decided}, before it was written on ${written}.`);
  }
  if (values["sentOn"] !== undefined && written !== undefined && values["sentOn"] < written) {
    problems.push(`It was sent on ${values["sentOn"]}, before it was written on ${written}.`);
  }
  if (values["sentOn"] !== undefined && decided !== undefined && values["sentOn"] > decided) {
    problems.push(`It was sent on ${values["sentOn"]}, after it was decided on ${decided}.`);
  }
  if (values["reason"] !== undefined && outcome !== "declined") {
    problems.push(`It has a reason it was declined and says it was ${outcome}.`);
  }
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

/** A line's amount before tax: the quantity at the price each, rounded to the cent as the invoice rounds it. */
export function lineAmount(quantity: string, unitPrice: string): string {
  return toString(round(multiply(money(unitPrice), quantity), 2));
}

/** A quantity as a person reads it: "2", "1.5". */
export function trimQuantity(value: string): string {
  const [whole = "0", frac = ""] = value.split(".");
  const kept = frac.replace(/0+$/, "");
  return kept ? `${whole}.${kept}` : whole;
}

/* -------------------------------------------------- several rows, one record */

export interface InvoiceLine { name: string; quantity: string; unitPrice: string; subtotal: string; tax: string }
export interface Allocation { invoiceRef: string | null; amount: string }

/** One option of an estimate that arrives whole: its lines, what they come to and whether the file calls it recommended or chosen. */
export interface EstimateOptionRead {
  name: string;
  recommended: boolean;
  chosen: boolean;
  lines: InvoiceLine[];
  /** What its lines come to, tax included. */
  total: string;
  /** The Total the file gives it, or null when the file gives none. */
  fileTotal: string | null;
}

export interface GroupRead {
  /** What the record is, from its rows: the fields they share, and the amounts across them. */
  values: Record<string, string>;
  /** An invoice's lines, one per row. Empty for anything else. */
  lines: InvoiceLine[];
  /** A payment's share of each invoice, one per row. Empty for anything else. */
  allocations: Allocation[];
  /** An estimate's options, each with its lines, in the order the file first names them. Empty for anything else. */
  options: EstimateOptionRead[];
  /** Why the rows cannot load together, each a sentence. */
  problems: string[];
}

/** What the rows of one invoice say once: the invoice, not the line. */
const INVOICE_SHARED = ["ref", "number", "customerRef", "customerEmail", "jobRef", "issuedOn", "dueOn", "total", "paid", "paidOn", "method"];
/** What the rows of one payment say once: the payment, not the invoice it paid. */
const PAYMENT_SHARED = ["ref", "customerRef", "customerEmail", "paidOn", "method", "checkNumber", "memo"];
/** What the rows of one estimate say once: the estimate and how it ended, not the option or the line. */
const ESTIMATE_SHARED = ["ref", "number", "customerRef", "customerEmail", "street", "jobRef", "title", "issuedOn", "sentOn", "outcome", "decidedOn", "reason"];
const sharedOf = (kind: ImportKind): string[] =>
  kind === "invoices" ? INVOICE_SHARED : kind === "payments" ? PAYMENT_SHARED : kind === "estimates" ? ESTIMATE_SHARED : [];

/**
 * THE ROWS OF ONE INVOICE OR ONE PAYMENT, READ TOGETHER.
 *
 * Each row has already been read on its own (`readRow`, with `line` for an
 * invoice of several rows). What is read here is what only the rows together
 * can say: the fields they share have to agree wherever they are filled, a
 * Total is the invoice's and has to equal its lines added up, and what was
 * paid on it is checked against that. A row that disagrees with another is
 * refused naming both, because loading either version would be a guess.
 */
export function readGroup(
  kind: ImportKind, rows: ReadonlyArray<{ row: number; values: Record<string, string> }>,
): GroupRead {
  const fields = FIELDS[kind];
  const label = (key: string) => fields.find((f) => f.key === key)?.label ?? key;
  const problems: string[] = [];
  const shared = sharedOf(kind);
  const values: Record<string, string> = {};
  const from: Record<string, number> = {};
  for (const { row, values: v } of rows) {
    for (const key of shared) {
      const value = v[key];
      if (value === undefined) continue;
      if (values[key] === undefined) {
        values[key] = value;
        from[key] = row;
      } else if (values[key] !== value && !problems.some((p) => p.includes(`says ${label(key)} is`))) {
        problems.push(`Row ${from[key]} says ${label(key)} is ${values[key]} and row ${row} says ${value}. They are one ${KIND_LABEL[kind].row}, so they have to agree.`);
      }
    }
  }

  if (rows.length > 1 && (kind === "invoices" || kind === "payments" || kind === "estimates")) {
    /** What one row would have been refused for, asked of the rows together. */
    if (kind === "invoices" && values["issuedOn"] === undefined) {
      problems.push("It has no invoice date. Without one it would be put in today's books instead of the day it was sent.");
    }
    if (kind === "estimates" && values["issuedOn"] === undefined) problems.push("Written on is empty.");
    if (kind === "payments" && values["paidOn"] === undefined) {
      problems.push("It has no day it was paid. Without one the payment would be put in today's books.");
    }
    const whose = values["customerRef"] !== undefined || values["customerEmail"] !== undefined
      || (kind === "payments" && rows.every(({ values: v }) => v["invoiceRef"] !== undefined));
    if (!whose) {
      problems.push(kind === "payments"
        ? "Neither the invoice nor the customer is filled in, so there is no telling whose money it is."
        : "Neither the customer's id nor their email is filled in, so there is no telling whose it is.");
    }
  }

  if (kind === "payments") {
    const allocations: Allocation[] = [];
    const seen = new Map<string, number>();
    for (const { row, values: v } of rows) {
      const invoiceRef = v["invoiceRef"] ?? null;
      if (invoiceRef !== null) {
        const before = seen.get(invoiceRef);
        if (before !== undefined) problems.push(`Rows ${before} and ${row} both put this payment on invoice ${invoiceRef}. Put it on one row.`);
        else seen.set(invoiceRef, row);
      }
      if (v["amount"] !== undefined) allocations.push({ invoiceRef, amount: v["amount"] });
    }
    values["amount"] = toString(sum(allocations.map((a) => money(a.amount))));
    return { values, lines: [], allocations, options: [], problems };
  }

  if (kind === "estimates") return readEstimateGroup(rows, values, problems, label);

  if (kind !== "invoices") return { values: { ...rows[0]?.values }, lines: [], allocations: [], options: [], problems };

  const lines: InvoiceLine[] = rows
    .filter(({ values: v }) => v["subtotal"] !== undefined)
    .map(({ values: v }) => {
      const priced = v["unitPrice"] !== undefined;
      return {
        name: v["description"] ?? "As billed",
        quantity: priced ? v["quantity"] ?? "1" : "1",
        unitPrice: priced ? v["unitPrice"]! : v["subtotal"]!,
        subtotal: v["subtotal"]!,
        tax: v["tax"] ?? "0",
      };
    });
  if (rows.length === 1) {
    /** One row is the whole invoice, read and checked by `readRow` already. */
    return { values: { ...rows[0]!.values }, lines, allocations: [], options: [], problems };
  }
  const subtotal = round(sum(lines.map((l) => money(l.subtotal))), 2);
  const tax = round(sum(lines.map((l) => money(l.tax))), 2);
  const total = add(subtotal, tax);
  if (values["total"] !== undefined && compare(money(values["total"]), total) !== 0 && lines.length === rows.length) {
    problems.push(`Its ${rows.length} lines come to ${trimMoney(toString(total))}, not the ${trimMoney(values["total"])} in Total.`);
  }
  values["subtotal"] = toString(subtotal);
  values["tax"] = toString(tax);
  values["total"] = toString(total);
  const paid = values["paid"];
  if (paid !== undefined && !isZero(money(paid))) {
    if (isNegative(money(paid))) problems.push("Amount paid is below zero. Record a refund on the payment instead.");
    else if (compare(money(paid), total) > 0) problems.push(`It says ${trimMoney(paid)} was paid on an invoice of ${trimMoney(toString(total))}.`);
    if (values["paidOn"] === undefined) problems.push("It says money was paid and not when. Without the day the payment would be put in today's books.");
  }
  return { values, lines, allocations: [], options: [], problems };
}

/**
 * AN ESTIMATE'S ROWS: ITS OPTIONS, EACH WITH ITS LINES.
 *
 * Lines are grouped into options by the Option column (the same name, however
 * it is spelt in capitals), and a file with no such column, or one that leaves
 * it empty on every row, is one option. What the file says about the estimate
 * (whose it is, the day it was written, how it ended) is said once and has to
 * agree wherever it is said; what it says about an option (its Total, whether it
 * is recommended, whether the customer chose it) has to agree across that
 * option's rows. Each option's lines are added up and checked against the Total
 * the file gives it, and a disagreement is a refusal naming the option and both
 * figures, because loading either would be a guess about a quote a customer
 * holds a copy of.
 *
 * WHICH OPTION THE CUSTOMER CHOSE IS NEVER GUESSED. An approved estimate with
 * several options and no column saying which is refused: choosing the cheapest,
 * or the recommended, or the first would put a sale in the books for work the
 * customer may not have bought. An estimate with one option that was approved
 * chose it.
 */
function readEstimateGroup(
  rows: ReadonlyArray<{ row: number; values: Record<string, string> }>,
  values: Record<string, string>,
  problems: string[],
  label: (key: string) => string,
): GroupRead {
  const single = rows.length === 1;
  if (!single) estimateOutcome(values, problems, label);

  const named = rows.filter((r) => r.values["option"] !== undefined);
  const unnamed = rows.filter((r) => r.values["option"] === undefined);
  if (named.length > 0 && unnamed.length > 0) {
    problems.push(`Row ${unnamed[0]!.row} is in no option, and row ${named[0]!.row} is in the option "${named[0]!.values["option"]}". Name the option on every line, or on none.`);
  }

  /** Options in the order the file first names them, found by their name without case or extra spaces. */
  const groups = new Map<string, { name: string; rows: typeof rows[number][] }>();
  for (const r of rows) {
    const name = r.values["option"] ?? "As quoted";
    const key = name.toLowerCase().replace(/\s+/g, " ");
    const group = groups.get(key) ?? { name, rows: [] };
    group.rows.push(r);
    groups.set(key, group);
  }

  const asked = (key: string) => rows.some((r) => r.values[key] !== undefined);
  const options: EstimateOptionRead[] = [];
  for (const group of groups.values()) {
    const one = groups.size === 1 && named.length === 0;
    const lines: InvoiceLine[] = group.rows
      .filter((r) => r.values["subtotal"] !== undefined)
      .map((r) => {
        const v = r.values;
        const priced = v["unitPrice"] !== undefined;
        return {
          name: v["lineName"] ?? values["title"] ?? "As quoted",
          quantity: priced ? v["quantity"] ?? "1" : "1",
          unitPrice: priced ? v["unitPrice"]! : v["subtotal"]!,
          subtotal: v["subtotal"]!,
          tax: v["tax"] ?? "0",
        };
      });
    const subtotal = round(sum(lines.map((l) => money(l.subtotal))), 2);
    const tax = round(sum(lines.map((l) => money(l.tax))), 2);
    const total = add(subtotal, tax);

    /** The Total the file gives the option: on any of its rows, the same on all of those that give one. */
    const totals = group.rows.filter((r) => r.values["total"] !== undefined);
    const first = totals[0];
    const other = totals.find((r) => first && compare(money(r.values["total"]!), money(first.values["total"]!)) !== 0);
    let fileTotal: string | null = first ? first.values["total"]! : null;
    if (first && other) {
      problems.push(`Rows ${first.row} and ${other.row} ${one ? "say" : `are in the option "${group.name}" and say its`} ${one ? "the Total is" : "Total is"} ${trimMoney(first.values["total"]!)} and ${trimMoney(other.values["total"]!)}.`);
      fileTotal = null;
    } else if (first && !single && lines.length === group.rows.length && compare(money(first.values["total"]!), total) !== 0) {
      problems.push(one
        ? `Its ${lines.length} lines come to ${trimMoney(toString(total))}, not the ${trimMoney(first.values["total"]!)} in Total.`
        : `The option "${group.name}" comes to ${trimMoney(toString(total))}, not the ${trimMoney(first.values["total"]!)} in Total.`);
    }

    /** Yes or no about the option, from whichever of its rows say; rows that say opposite things are refused. */
    const flag = (key: string): boolean | null => {
      const said = group.rows.filter((r) => r.values[key] !== undefined);
      if (said.length === 0) return null;
      const yes = said.filter((r) => r.values[key] === "true");
      if (yes.length > 0 && yes.length < said.length) {
        problems.push(`Rows ${said[0]!.row} and ${said.find((r) => r.values[key] !== said[0]!.values[key])!.row} disagree about whether ${one ? "the estimate" : `the option "${group.name}"`} is ${key === "chosen" ? "chosen" : "recommended"}.`);
      }
      return yes.length > 0;
    };
    options.push({
      name: group.name,
      recommended: flag("recommended") ?? false,
      chosen: flag("chosen") ?? false,
      lines,
      total: toString(total),
      fileTotal: fileTotal === null ? null : toString(money(fileTotal)),
    });
  }

  if (options.length > 5) problems.push(`It has ${options.length} options. An estimate can have at most 5.`);

  const quoted = (list: EstimateOptionRead[]) => list.map((o) => `"${o.name}"`);
  /** A single option of the estimate is the one it is recommended on, unless the file says otherwise. */
  if (options.length === 1 && !asked("recommended")) options[0]!.recommended = true;
  const recommended = options.filter((o) => o.recommended);
  if (recommended.length > 1) {
    problems.push(`${recommended.length === 2 ? "Two" : recommended.length} options are marked recommended: ${quoted(recommended).join(" and ")}. Only one can be.`);
  }

  const outcome = values["outcome"];
  const chosen = options.filter((o) => o.chosen);
  if (outcome === "approved") {
    if (options.length === 1) {
      if (asked("chosen") && !options[0]!.chosen) problems.push("It was approved, and the file says its only option was not chosen.");
      options[0]!.chosen = true;
    } else if (chosen.length === 0) {
      problems.push(`It was approved and the file does not say which of its ${options.length} options the customer chose. Fill in the ${label("chosen").split(" ")[0]} column for that option.`);
    } else if (chosen.length > 1) {
      problems.push(`${chosen.length === 2 ? "Two" : chosen.length} options are marked chosen: ${quoted(chosen).join(" and ")}. The customer chose one.`);
    }
  } else if (outcome !== undefined && chosen.length > 0) {
    problems.push(`The option "${chosen[0]!.name}" is marked chosen, and the estimate was not approved.`);
  }

  return { values, lines: [], allocations: [], options, problems };
}

/**
 * THE TAX AN ESTIMATE'S LINES WERE CHARGED, AS A RATE THE ESTIMATE CAN CARRY.
 *
 * An estimate works its tax out from a rate and cannot be told an amount, so
 * the file's tax has to become a rate. The company's own rate of today is never
 * used: a quote written in 2022 was taxed at 2022's. When one rate, to four
 * places, reproduces every option's tax to the cent it is the estimate's (a
 * clean 0.0825, not the 0.082520 that a half cent of rounding implies on one
 * line); otherwise each taxed line carries the rate its own tax implies, to six
 * places. The caller then checks what the estimate comes to against the file.
 */
export interface EstimateTax {
  /** The estimate's one rate, or null when no line was taxed or the lines carry their own. */
  rate: string | null;
  /** Per option, per line: the rate that line carries itself, or null. Set only when `rate` is null. */
  lineRates: Array<Array<string | null>>;
}

export function estimateTax(options: ReadonlyArray<{ lines: ReadonlyArray<{ subtotal: string; tax: string }> }>): EstimateTax {
  const taxed = (l: { subtotal: string; tax: string }) => !isZero(money(l.tax));
  const own = options.map((o) => o.lines.map((l) => (taxed(l) ? taxRateOf(l.tax, l.subtotal) : null)));
  const found = own.flat().filter((r): r is string => r !== null);
  if (found.length === 0) return { rate: null, lineRates: [] };
  /** A rate to six places rounded to four. */
  const four = (rate: string): string => {
    const scaled = BigInt(rate.replace(".", ""));
    const cut = (scaled + 50n) / 100n;
    return `${cut / 10_000n}.${(cut % 10_000n).toString().padStart(4, "0")}00`;
  };
  const candidates = [...new Set(found.map(four))];
  for (const rate of candidates) {
    const holds = options.every((o) => {
      const lines = o.lines.filter(taxed);
      const made = round(sum(lines.map((l) => multiply(money(l.subtotal), rate))), 2);
      return compare(made, round(sum(lines.map((l) => money(l.tax))), 2)) === 0;
    });
    if (holds) return { rate, lineRates: [] };
  }
  return { rate: null, lineRates: own };
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
  if ((kind === "jobs" || kind === "invoices" || kind === "estimates") && values["number"]) return values["number"];
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
   * refused with what to do instead. A workbook has its own reader
   * (`workbook.ts`), and a CSV that turns out to be one was sent the wrong way.
   */
  if (text.startsWith("PK\u0003\u0004") || text.includes("\u0000")) {
    return { ok: false, why: "That is a spreadsheet workbook, not a CSV file. Choose it as a workbook, or in your spreadsheet program choose Save As or Download, pick CSV, and bring in that file." };
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
