import { ZipWriter } from "../src/portability/zip";

/**
 * A WORKBOOK, WRITTEN BY HAND FOR A TEST
 *
 * The product only reads workbooks, so a test that needs one writes it here:
 * the five parts an .xlsx cannot do without, with shared strings and a date
 * style the way a spreadsheet program saves them. A `formula` cell carries the
 * answer the program worked out beside the formula itself, which is what a real
 * file holds and all the reader looks at.
 */

export type Cell = string | number | boolean | Date | null | { formula: string; value: string | number };
export interface Sheet { name: string; rows: Cell[][] }

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Excel's count of days since 1899-12-30, with the time of day as the fraction. */
const serial = (at: Date) => at.getTime() / 86_400_000 + 25569;

function column(index: number): string {
  let out = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

export interface BuildOptions {
  /** Further parts, stored as they are. */
  extra?: Record<string, Uint8Array>;
  /** A part of this name that opens into this many megabytes of spaces, however small it is stored. */
  inflate?: { name: string; megabytes: number };
}

export async function buildWorkbook(sheets: Sheet[], options: BuildOptions = {}): Promise<Buffer> {
  const strings: string[] = [];
  const stringId = (text: string) => {
    const at = strings.indexOf(text);
    if (at >= 0) return at;
    strings.push(text);
    return strings.length - 1;
  };

  const sheetXml = sheets.map((sheet) => {
    const rows = sheet.rows.map((row, r) => {
      const cells = row.map((cell, c) => {
        const ref = `${column(c)}${r + 1}`;
        if (cell === null) return "";
        if (typeof cell === "string") return `<c r="${ref}" t="s"><v>${stringId(cell)}</v></c>`;
        if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
        if (typeof cell === "boolean") return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
        if (cell instanceof Date) {
          const wholeDay = cell.getTime() % 86_400_000 === 0;
          /** Style 1 is a date, 2 a date with a time. A time alone is a date on day zero, style 3. */
          const style = cell.getUTCFullYear() < 1900 ? 3 : wholeDay ? 1 : 2;
          const value = cell.getUTCFullYear() < 1900 ? serial(cell) - Math.floor(serial(cell)) : serial(cell);
          return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
        }
        return typeof cell.value === "number"
          ? `<c r="${ref}"><f>${esc(cell.formula)}</f><v>${cell.value}</v></c>`
          : `<c r="${ref}" t="str"><f>${esc(cell.formula)}</f><v>${esc(cell.value)}</v></c>`;
      }).join("");
      return `<row r="${r + 1}">${cells}</row>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });

  const parts: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="21" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
  };
  parts["xl/sharedStrings.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("")}</sst>`;
  sheetXml.forEach((xml, i) => { parts[`xl/worksheets/sheet${i + 1}.xml`] = xml; });

  const chunks: Buffer[] = [];
  const zip = new ZipWriter(async (chunk) => { chunks.push(Buffer.from(chunk)); }, new Date("2024-01-01T00:00:00Z"));
  for (const [name, text] of Object.entries(parts)) await zip.addFile(name, Buffer.from(text, "utf8"));
  for (const [name, bytes] of Object.entries(options.extra ?? {})) await zip.addFile(name, bytes);
  if (options.inflate) {
    const entry = await zip.begin(options.inflate.name);
    const block = Buffer.alloc(1024 * 1024, 0x20);
    for (let i = 0; i < options.inflate.megabytes; i++) await entry.write(block);
    await entry.end();
  }
  await zip.finish();
  return Buffer.concat(chunks);
}

/**
 * A workbook tampered with after it was written, to test what a stranger's file
 * can do: say its parts are smaller than they are, or mark them encrypted.
 */
export function tamper(workbook: Buffer, change: { declaredSize?: number; flags?: number }): Buffer {
  const out = Buffer.from(workbook);
  for (let i = 0; i + 46 <= out.length; i++) {
    if (out.readUInt32LE(i) !== 0x02014b50) continue;
    if (change.flags !== undefined) out.writeUInt16LE(out.readUInt16LE(i + 8) | change.flags, i + 8);
    if (change.declaredSize !== undefined) out.writeUInt32LE(change.declaredSize, i + 24);
  }
  return out;
}
