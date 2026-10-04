import { portability } from "@opentradesos/core";
import type { ExportSource, Manifest, ManifestTable } from "../services/export";
import { ZipWriter, type Sink } from "./zip";

/**
 * THE WHOLE COMPANY AS A ZIP OF SPREADSHEETS
 *
 * One CSV per table, the manifest, a README explaining the columns, and every
 * stored file under its own name. For the owner who wants to open their
 * customer list in a spreadsheet, and for whoever loads it into another
 * database, because each CSV is in Postgres's own COPY format and loads with
 * one `\copy` line.
 *
 * WHY BOTH THIS AND THE NEWLINE DELIMITED FILE. That one keeps every type and
 * every nested value exactly, and is the better input to a program. This one is
 * the shape most people can open, and the README says what each column holds
 * so the CSV's loss of types is made good in words. A restore reads either.
 *
 * Streamed like the other: a table is compressed as its rows arrive and the
 * first byte leaves as soon as there is one. The directory at the end is what
 * makes it whole, and `complete.json`, the last entry, carries the counts of
 * what was actually written, as the other format's last line does.
 */
export async function writeArchive(
  source: ExportSource, sink: Sink,
): Promise<{ rows: number; files: number; size: number }> {
  const manifest = source.manifest;
  const zip = new ZipWriter(sink, new Date(manifest.generatedAt));
  const folder = archiveFolder(manifest.generatedAt);

  await zip.addFile(`${folder}/README.md`, Buffer.from(readme(manifest), "utf8"));
  await zip.addFile(`${folder}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));

  let written = 0;
  for (const table of manifest.tables) {
    /**
     * Every table gets a file, even an empty one, with its header. A folder
     * missing `vehicle.csv` reads as a copy that lost the vans; one holding a
     * header and no rows says there were none.
     */
    const entry = await zip.begin(`${folder}/tables/${table.table}.csv`);
    // A byte order mark, so a spreadsheet opens accented names as the letters they are.
    await entry.write("﻿");
    await entry.write(portability.csvHeader(table.columns.map((column) => column.name)));
    if (table.rows > 0) {
      let after: string[] | undefined;
      for (;;) {
        const page = await source.page(table.table, after, true);
        let block = "";
        for (const row of page.rows) {
          block += portability.csvLine(table.columns.map((column) => {
            const value = row[column.name];
            return value === null || value === undefined ? null : String(value);
          }));
          written += 1;
        }
        await entry.write(block);
        if (!page.more || page.cursor === null) break;
        after = page.cursor;
      }
    }
    await entry.end();
  }

  let files = 0;
  let cursor: string | undefined;
  for (;;) {
    const batch = await source.files(cursor);
    for (const file of batch.files) {
      await zip.addFile(`${folder}/files/${file.storageKey}`, await source.bytes(file));
      files += 1;
    }
    if (!batch.more || batch.cursor === null) break;
    cursor = batch.cursor;
  }

  await zip.addFile(`${folder}/complete.json`, Buffer.from(JSON.stringify({
    complete: true, rows: written, expected: manifest.totalRows, files, expectedFiles: manifest.files.count,
  }, null, 2), "utf8"));
  await zip.finish();
  return { rows: written, files, size: zip.size };
}

/** The folder everything sits in, so unzipping makes one dated folder rather than a mess. */
export const archiveFolder = (generatedAt: string) => `opentradesos-export-${generatedAt.slice(0, 10)}`;

export const archiveFilename = (generatedAt: string) => `${archiveFolder(generatedAt)}.zip`;

/* ----------------------------------------------------------------- README */

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** What a column holds, in a sentence, from its name and type. */
function describe(table: ManifestTable, name: string, type: string, references: string | null): string {
  if (name === "id") return "This row's own id.";
  if (name === "organization_id") return "The company. The same on every row in this copy.";
  if (references) return `Points at a row in ${references}.csv, by its id.`;
  if (name === "created_at") return "When the row was made.";
  if (name === "updated_at") return "When the row last changed.";
  if (name === "deleted_at") return "When it was removed. Empty for a row still in use; a removed row is kept, not erased.";
  if (name === "source_system") return "The system this record came from in a migration, such as jobber. Empty for one made here.";
  if (name === "source_id") return "That system's own id for it.";
  if (name === "source_payload") return "What that system sent, as it sent it.";
  if (name === "custom_fields") return "The company's own fields on this record, as JSON keyed by each field's key.";
  if (type === "numeric(14,4)") return "A decimal with four places. Amounts of money are kept this way, in the company's currency.";
  if (type === "numeric(9,6)") return "A rate as a fraction: 0.0825 is 8.25 percent.";
  if (type === "jsonb") return "JSON.";
  if (type.startsWith("timestamp")) return "A moment, in UTC.";
  if (type === "date") return "A calendar day.";
  if (type === "boolean") return "true or false.";
  if (type === "bytea") return "Bytes, as \\x followed by hex.";
  if (type.endsWith("[]")) return "A list, in Postgres's {a,b} form.";
  if (name.endsWith("_id") && type === "uuid") return "The id of a related record.";
  void table;
  return "";
}

/**
 * The README, written from the manifest so it can never describe a table the
 * copy does not hold or miss one it does.
 */
export function readme(manifest: Manifest): string {
  const company = typeof manifest.company["name"] === "string" ? manifest.company["name"] : "this company";
  const lines: string[] = [];
  lines.push(`# ${company}: a whole company copy`);
  lines.push("");
  lines.push(`Taken ${manifest.generatedAt} from OpenTradesOS. ${plural(manifest.totalRows, "row")} in ${plural(manifest.tables.length, "table")}, and ${plural(manifest.files.count, "file")}.`);
  lines.push("");
  lines.push("## What is here");
  lines.push("");
  lines.push("- `tables/` has one CSV per table, every table, with a header row even when it is empty.");
  lines.push("- `files/` has every photograph, signature, document and recording, under the name the `storage_key` column gives it.");
  lines.push("- `manifest.json` lists every table with its row count, its columns and their types, what was held back and why, the company's own details and the people who work here.");
  lines.push("- `complete.json` is written last. It counts the rows and files actually written. If it is missing, the copy stopped part way: take it again.");
  lines.push("");
  lines.push("## Reading the CSV files");
  lines.push("");
  lines.push("They are UTF-8 with a byte order mark, so a spreadsheet shows accented names correctly. Every value is in double quotes. A cell with nothing in it, not even quotes, is empty in the database (NULL); a cell with two quotes and nothing between them is text that is blank. The two are different and both are kept.");
  lines.push("");
  lines.push("A spreadsheet that guesses types may turn long numbers into scientific notation or drop leading zeros from postal codes. Opening a file through the spreadsheet's import, with every column as text, keeps them as they are. A value that begins with `=` is a value somebody typed, not a formula.");
  lines.push("");
  lines.push("Values are written the way Postgres writes them: a moment is ISO 8601 in UTC (`2026-10-04T14:05:00.123456+00:00`), a day is `2026-10-04`, true and false are `true` and `false`, JSON is JSON, a list is `{a,b}`, and bytes are `\\x` and hex.");
  lines.push("");
  lines.push("## Loading them into a database");
  lines.push("");
  lines.push("Each file is in Postgres's COPY format. Into a database with the same tables:");
  lines.push("");
  lines.push("```");
  lines.push("\\copy customer from 'tables/customer.csv' with (format csv, header)");
  lines.push("```");
  lines.push("");
  lines.push("Load a table after the tables it points at; the column notes below say which those are. Into another OpenTradesOS, use Restore a copy instead, which does the order, the people and the files for you.");
  lines.push("");
  lines.push("## What is not here, and why");
  lines.push("");
  const redacted = manifest.tables.filter((table) => table.redacted.length > 0);
  if (redacted.length === 0) lines.push("Nothing was held back.");
  for (const table of redacted) {
    for (const column of table.redacted) lines.push(`- \`${table.table}.${column.column}\`: ${column.reason}`);
  }
  lines.push("");
  for (const table of manifest.tables.filter((t) => t.apart.length > 0)) {
    for (const column of table.apart) lines.push(`- \`${table.table}.${column.column}\` is not in the CSV. ${column.reason}`);
  }
  lines.push("");
  for (const outside of manifest.outsideTheTenant) lines.push(`- \`${outside.table}\` is not a table here. ${outside.reason}`);
  lines.push("");
  lines.push("## The tables and their columns");
  lines.push("");
  for (const table of manifest.tables) {
    lines.push(`### ${table.table}`);
    lines.push("");
    lines.push(`${plural(table.rows, "row")}. Identified by ${table.key.map((k) => `\`${k}\``).join(" and ")}.`);
    lines.push("");
    lines.push("| Column | Type | Empty allowed | Notes |");
    lines.push("|---|---|---|---|");
    for (const column of table.columns) {
      const note = describe(table, column.name, column.type, column.references);
      lines.push(`| \`${column.name}\` | ${column.type} | ${column.nullable ? "yes" : "no"} | ${note} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
