/**
 * READING BACK WHAT THE WRITER WROTE
 *
 * A test that says "the emailed report has a PDF attached" proves nothing
 * about the PDF. This checks the two things a reader needs (the cross
 * reference table points at every object it claims, and the trailer points at
 * the table) and pulls the text out of every page, through each font's own
 * ToUnicode map exactly as a reader copying text would, so a test can say
 * "the invoice PDF names invoice 1042 and a balance of $120.00" and mean it,
 * and a name comes back as it was written only if it was drawn that way. It
 * also lists the images the pages draw, with whether each carries a mask.
 *
 * It reads the files `writer.ts` produces and is not a general PDF parser:
 * a file from anywhere else may use features this does not look for.
 */

export interface PdfInspection {
  /** Empty when the structure holds together. */
  problems: string[];
  pageCount: number;
  /** Every string drawn, in drawing order, per page. */
  pages: string[][];
  /** Everything drawn, joined with spaces, for a quick `toContain`. */
  text: string;
  title: string | null;
  /** The images the pages draw (a mask is not listed on its own). */
  images: Array<{ width: number; height: number; colorSpace: string; masked: boolean }>;
  /** The fonts embedded, by the name each is given in the file. */
  fonts: string[];
}

const latin1 = (bytes: Uint8Array, from = 0, to = bytes.length) => {
  let out = "";
  for (let i = from; i < to; i += 1) out += String.fromCharCode(bytes[i]!);
  return out;
};

/** UTF-16BE hex to a string, with or without its byte order mark. */
function fromUtf16(hex: string): string {
  const units: number[] = [];
  for (let i = 0; i + 3 < hex.length; i += 4) units.push(Number.parseInt(hex.slice(i, i + 4), 16));
  if (units[0] === 0xfeff) units.shift();
  return String.fromCharCode(...units);
}

interface PdfObject { dictionary: string; stream: Uint8Array | null }

export function inspectPdf(
  bytes: Uint8Array,
  inflate?: (bytes: Uint8Array) => Uint8Array,
): PdfInspection {
  const problems: string[] = [];
  const whole = latin1(bytes);
  if (!whole.startsWith("%PDF-1.")) problems.push("It does not start with a PDF header.");
  if (!/%%EOF\s*$/.test(whole)) problems.push("It does not end with %%EOF.");

  const offsets = new Map<number, number>();
  const start = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(whole);
  if (!start) {
    problems.push("There is no startxref.");
  } else {
    const xref = Number(start[1]);
    if (whole.slice(xref, xref + 4) !== "xref") {
      problems.push(`startxref points at byte ${xref}, which is not the cross reference table.`);
    } else {
      const header = /^xref\s+0\s+(\d+)\s+/.exec(whole.slice(xref));
      if (!header) problems.push("The cross reference table has no subsection header.");
      else {
        const count = Number(header[1]);
        const body = xref + header[0].length;
        for (let id = 1; id < count; id += 1) {
          const entry = whole.slice(body + id * 20, body + id * 20 + 20);
          const offset = Number(entry.slice(0, 10));
          if (!whole.startsWith(`${id} 0 obj`, offset)) {
            problems.push(`Object ${id} is not where the cross reference table says it is.`);
          } else offsets.set(id, offset);
        }
      }
    }
  }

  const objects = new Map<number, PdfObject>();
  let warnedInflate = false;
  const read = (id: number): PdfObject | null => {
    if (objects.has(id)) return objects.get(id)!;
    const offset = offsets.get(id);
    if (offset === undefined) return null;
    const from = offset + `${id} 0 obj\n`.length;
    const streamAt = whole.indexOf(">>\nstream\n", from);
    const endAt = whole.indexOf("\nendobj", from);
    let found: PdfObject;
    if (streamAt !== -1 && streamAt < endAt) {
      const dictionary = whole.slice(from, streamAt + 2);
      const length = Number(/\/Length (\d+)/.exec(dictionary)?.[1] ?? "0");
      const dataFrom = streamAt + ">>\nstream\n".length;
      if (whole.slice(dataFrom + length, dataFrom + length + 10) !== "\nendstream") {
        problems.push(`Object ${id}'s /Length (${length}) does not match where its stream ends.`);
      }
      let data: Uint8Array | null = bytes.subarray(dataFrom, dataFrom + length);
      if (/\/Filter \/FlateDecode/.test(dictionary) && !/\/Subtype \/Image/.test(dictionary)) {
        if (!inflate) {
          if (!warnedInflate) problems.push("A stream is compressed and nothing was given to inflate it.");
          warnedInflate = true;
          data = null;
        } else data = inflate(data);
      }
      found = { dictionary, stream: data };
    } else {
      found = { dictionary: whole.slice(from, endAt), stream: null };
    }
    objects.set(id, found);
    return found;
  };

  /** Each font's glyph to text map, from its ToUnicode CMap. */
  const maps = new Map<number, Map<number, string>>();
  const mapOf = (fontId: number): Map<number, string> => {
    if (maps.has(fontId)) return maps.get(fontId)!;
    const map = new Map<number, string>();
    const ref = /\/ToUnicode (\d+) 0 R/.exec(read(fontId)?.dictionary ?? "");
    const cmap = ref ? read(Number(ref[1]))?.stream : null;
    if (cmap) {
      for (const m of latin1(cmap).matchAll(/<([0-9a-fA-F]{4})> <([0-9a-fA-F]+)>/g)) {
        map.set(Number.parseInt(m[1]!, 16), fromUtf16(m[2]!));
      }
    }
    maps.set(fontId, map);
    return map;
  };

  const ids = [...offsets.keys()].sort((a, b) => a - b);
  const pages: string[][] = [];
  for (const id of ids.filter((i) => /\/Type \/Page\b(?!s)/.test(read(i)?.dictionary ?? ""))) {
    const dictionary = read(id)!.dictionary;
    const fonts = new Map<string, number>();
    const fontBlock = /\/Font << ([^>]*) >>/.exec(dictionary)?.[1] ?? "";
    for (const m of fontBlock.matchAll(/\/(F\d+) (\d+) 0 R/g)) fonts.set(m[1]!, Number(m[2]));
    const contents = /\/Contents (\d+) 0 R/.exec(dictionary);
    const content = contents ? read(Number(contents[1]))?.stream : null;
    if (!content) continue;
    const drawn: string[] = [];
    let font = new Map<number, string>();
    for (const m of latin1(content).matchAll(/\/(F\d+) [\d.]+ Tf|<([0-9a-f]*)> Tj/g)) {
      if (m[1]) { font = mapOf(fonts.get(m[1]) ?? -1); continue; }
      const hex = m[2]!;
      let text = "";
      for (let i = 0; i + 3 < hex.length; i += 4) text += font.get(Number.parseInt(hex.slice(i, i + 4), 16)) ?? "�";
      drawn.push(text);
    }
    pages.push(drawn);
  }

  const masks = new Set<number>();
  for (const id of ids) {
    const ref = /\/SMask (\d+) 0 R/.exec(read(id)?.dictionary ?? "");
    if (ref) masks.add(Number(ref[1]));
  }
  const images = ids
    .filter((id) => !masks.has(id) && /\/Subtype \/Image/.test(read(id)?.dictionary ?? ""))
    .map((id) => {
      const dictionary = read(id)!.dictionary;
      return {
        width: Number(/\/Width (\d+)/.exec(dictionary)?.[1] ?? 0),
        height: Number(/\/Height (\d+)/.exec(dictionary)?.[1] ?? 0),
        colorSpace: /\/ColorSpace \/(\w+)/.exec(dictionary)?.[1] ?? "",
        masked: /\/SMask \d+ 0 R/.test(dictionary),
      };
    });
  const fonts = [...whole.matchAll(/\/FontName \/([A-Z]{6}\+[\w-]+)/g)].map((m) => m[1]!);

  const pageCount = (whole.match(/\/Type \/Page\b(?!s)/g) ?? []).length;
  if (pageCount !== pages.length) problems.push(`${pageCount} pages and ${pages.length} content streams.`);
  const titleHex = /\/Title <([0-9a-fA-F]*)>/.exec(whole);

  return {
    problems,
    pageCount,
    pages,
    text: pages.flat().join(" "),
    title: titleHex ? fromUtf16(titleHex[1]!) : null,
    images,
    fonts,
  };
}
