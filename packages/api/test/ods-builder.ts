import { ZipWriter } from "../src/portability/zip";

/**
 * AN OPENDOCUMENT SPREADSHEET, WRITTEN BY HAND FOR A TEST
 *
 * The product only reads them, so a test that needs one writes it here, the way
 * LibreOffice saves it: a `mimetype` part first, a manifest, and one
 * `content.xml` holding every sheet, with the "row repeated a million times"
 * that ends every sheet it writes. A `raw` cell is XML written as it is, for the
 * odd cases (a comment on a cell, a cell that reads as an error, a repeat).
 */
export type OdsCell =
  | string | number | boolean | Date | null
  | { formula: string; value: string | number }
  | { error: string }
  | { raw: string }
  | { repeat: number; value: string | number };
export interface OdsSheet { name: string; rows: OdsCell[][] }

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function cellXml(cell: OdsCell): string {
  if (cell === null) return "<table:table-cell/>";
  if (typeof cell === "string") {
    return `<table:table-cell office:value-type="string" calcext:value-type="string"><text:p>${esc(cell).split("\n").join("</text:p><text:p>")}</text:p></table:table-cell>`;
  }
  if (typeof cell === "number") {
    return `<table:table-cell office:value-type="float" office:value="${cell}" calcext:value-type="float"><text:p>${cell}</text:p></table:table-cell>`;
  }
  if (typeof cell === "boolean") {
    return `<table:table-cell office:value-type="boolean" office:boolean-value="${cell}" calcext:value-type="boolean"><text:p>${cell ? "TRUE" : "FALSE"}</text:p></table:table-cell>`;
  }
  if (cell instanceof Date) {
    const iso = cell.toISOString();
    const wholeDay = cell.getTime() % 86_400_000 === 0;
    if (cell.getUTCFullYear() < 1900) {
      const h = cell.getUTCHours(); const m = cell.getUTCMinutes();
      return `<table:table-cell office:value-type="time" office:time-value="PT${String(h).padStart(2, "0")}H${String(m).padStart(2, "0")}M00S"><text:p>${h}:${m}</text:p></table:table-cell>`;
    }
    const said = wholeDay ? iso.slice(0, 10) : iso.slice(0, 19);
    return `<table:table-cell office:value-type="date" office:date-value="${said}" calcext:value-type="date"><text:p>${said}</text:p></table:table-cell>`;
  }
  if ("formula" in cell) {
    return typeof cell.value === "number"
      ? `<table:table-cell table:formula="of:=${esc(cell.formula)}" office:value-type="float" office:value="${cell.value}" calcext:value-type="float"><text:p>${cell.value}</text:p></table:table-cell>`
      : `<table:table-cell table:formula="of:=${esc(cell.formula)}" office:value-type="string" office:string-value="${esc(cell.value)}" calcext:value-type="string"><text:p>${esc(cell.value)}</text:p></table:table-cell>`;
  }
  if ("error" in cell) {
    return `<table:table-cell table:formula="of:=NA()" office:value-type="string" office:string-value="" calcext:value-type="error"><text:p>${esc(cell.error)}</text:p></table:table-cell>`;
  }
  if ("raw" in cell) return cell.raw;
  return `<table:table-cell table:number-columns-repeated="${cell.repeat}" office:value-type="${typeof cell.value === "number" ? "float" : "string"}"${typeof cell.value === "number" ? ` office:value="${cell.value}"` : ""}><text:p>${esc(String(cell.value))}</text:p></table:table-cell>`;
}

export interface OdsOptions {
  /** Further parts, stored as they are. */
  extra?: Record<string, Uint8Array>;
  /** Replaces the `mimetype`. */
  mimetype?: string;
  /** Written as the manifest (a protected file names its encryption in it). */
  manifest?: string;
  /** Rows written after every sheet's rows, as XML, in place of LibreOffice's own trailing repeat. */
  after?: string;
  /** Write the header row inside `table:table-header-rows`, as a sheet with a frozen header does. */
  headerGroup?: boolean;
}

export async function buildOds(sheets: OdsSheet[], options: OdsOptions = {}): Promise<Buffer> {
  const tables = sheets.map((sheet) => {
    const width = Math.max(1, ...sheet.rows.map((r) => r.length));
    const rows = sheet.rows.map((row) => `<table:table-row>${row.map(cellXml).join("")}</table:table-row>`);
    const body = options.headerGroup && rows.length > 0
      ? `<table:table-header-rows>${rows[0]}</table:table-header-rows>${rows.slice(1).join("")}`
      : rows.join("");
    const trailing = options.after ?? `<table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>`;
    return `<table:table table:name="${esc(sheet.name)}" table:style-name="ta1"><table:table-column table:number-columns-repeated="${width}"/>${body}${trailing}</table:table>`;
  });
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0" office:version="1.3"><office:body><office:spreadsheet>${tables.join("")}</office:spreadsheet></office:body></office:document-content>`;
  const manifest = options.manifest ?? `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`;

  const chunks: Buffer[] = [];
  const zip = new ZipWriter(async (chunk) => { chunks.push(Buffer.from(chunk)); }, new Date("2024-01-01T00:00:00Z"));
  await zip.addFile("mimetype", Buffer.from(options.mimetype ?? "application/vnd.oasis.opendocument.spreadsheet", "utf8"));
  await zip.addFile("content.xml", Buffer.from(content, "utf8"));
  await zip.addFile("META-INF/manifest.xml", Buffer.from(manifest, "utf8"));
  for (const [name, bytes] of Object.entries(options.extra ?? {})) await zip.addFile(name, bytes);
  await zip.finish();
  return Buffer.concat(chunks);
}
