/**
 * READING BACK WHAT THE WRITER WROTE
 *
 * A test that says "the emailed report has a PDF attached" proves nothing
 * about the PDF. This checks the two things a reader needs (the cross
 * reference table points at every object it claims, and the trailer points at
 * the table) and pulls the text out of every page, so a test can say "the
 * invoice PDF names invoice 1042 and a balance of $120.00" and mean it.
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
}

const FROM_WIN_ANSI: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†",
  0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ",
  0x8e: "Ž", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•",
  0x96: "–", 0x97: "—", 0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›",
  0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
};

function decodeHex(hexText: string): string {
  let out = "";
  for (let i = 0; i + 1 < hexText.length; i += 2) {
    const byte = Number.parseInt(hexText.slice(i, i + 2), 16);
    out += FROM_WIN_ANSI[byte] ?? String.fromCharCode(byte);
  }
  return out;
}

const latin1 = (bytes: Uint8Array, from = 0, to = bytes.length) => {
  let out = "";
  for (let i = from; i < to; i += 1) out += String.fromCharCode(bytes[i]!);
  return out;
};

export function inspectPdf(
  bytes: Uint8Array,
  inflate?: (bytes: Uint8Array) => Uint8Array,
): PdfInspection {
  const problems: string[] = [];
  const whole = latin1(bytes);
  if (!whole.startsWith("%PDF-1.")) problems.push("It does not start with a PDF header.");
  if (!/%%EOF\s*$/.test(whole)) problems.push("It does not end with %%EOF.");

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
          }
        }
      }
    }
  }

  const pages: string[][] = [];
  const streamPattern = /<< \/Length (\d+)( \/Filter \/FlateDecode)? >>\nstream\n/g;
  for (let found = streamPattern.exec(whole); found; found = streamPattern.exec(whole)) {
    const from = found.index + found[0].length;
    const to = from + Number(found[1]);
    let content = bytes.subarray(from, to);
    if (whole.slice(to, to + 10) !== "\nendstream") {
      problems.push(`A stream's /Length (${found[1]}) does not match where it ends.`);
    }
    if (found[2]) {
      if (!inflate) { problems.push("A stream is compressed and nothing was given to inflate it."); continue; }
      content = inflate(content);
    }
    const text = latin1(content);
    pages.push([...text.matchAll(/<([0-9a-f]*)> Tj/g)].map((m) => decodeHex(m[1]!)));
  }

  const pageCount = (whole.match(/\/Type \/Page\b(?!s)/g) ?? []).length;
  if (pageCount !== pages.length) problems.push(`${pageCount} pages and ${pages.length} content streams.`);
  const titleHex = /\/Title <([0-9a-f]*)>/.exec(whole);

  return {
    problems,
    pageCount,
    pages,
    text: pages.flat().join(" "),
    title: titleHex ? decodeHex(titleHex[1]!) : null,
  };
}
