/**
 * A PDF, WRITTEN BY HAND
 *
 * Every document this product hands a customer or an accountant as a file is
 * text, ruled lines and filled boxes: an invoice, a proposal, a statement, a
 * report with its chart. None of it needs an embedded font, an image decoder
 * or a layout engine, and all of it has to be produced in two places that are
 * not a browser: a Next route handler and the worker that emails a report at
 * seven in the morning.
 *
 * WHY NOT A LIBRARY. The candidates were a headless browser (a hundred and
 * fifty megabytes of Chromium in a self hosted container, to draw a table),
 * pdfkit (reads its font metrics from files on disk at run time, which a
 * bundled Next server does not ship, and drags in a font engine for fonts
 * this never embeds) and pdf-lib (the closest fit, unmaintained since 2021,
 * and a megabyte of code whose useful part here is the same few hundred lines
 * as this file). PDF 1.4 with the standard Helvetica faces is a small,
 * stable format: the fonts are built into every reader, so nothing is
 * embedded, and the whole writer is the object table below. It is pure, it is
 * tested without a reader, and it cannot fail to bundle.
 *
 * WHAT IT CANNOT DO, said rather than discovered. The standard fonts carry
 * the Western European characters (WinAnsi), so a name in Vietnamese or
 * Chinese prints its accents or its letters as "?". Embedding a Unicode font
 * is the fix and it is not built.
 *
 * Coordinates here are from the TOP LEFT in points (a point is 1/72 inch), the
 * way a person lays out a page; the writer turns them over to PDF's bottom
 * left on the way out.
 */

export type FontKey = "regular" | "bold";

/** A colour as three channels from 0 to 1. */
export interface Rgb { r: number; g: number; b: number }

export const LETTER = { width: 612, height: 792 } as const;

/** `#1F6FEB` to channels. Anything unreadable is black, never an exception mid document. */
export function hex(color: string | null | undefined, fallback: Rgb = { r: 0, g: 0, b: 0 }): Rgb {
  const found = /^#?([0-9a-f]{6})$/i.exec((color ?? "").trim());
  if (!found) return fallback;
  const n = Number.parseInt(found[1]!, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/* ------------------------------------------------------------ the metrics */

/**
 * Helvetica and Helvetica Bold advance widths for the printable ASCII range,
 * in thousandths of the font size, from Adobe's published AFM files. Wrapping
 * a line and right aligning a column of money both need them, and guessing a
 * width per character is how a total ends up printed over its own label.
 */
const REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/**
 * Characters WinAnsi places outside Latin 1, by code point. Everything from
 * U+00A0 to U+00FF is the same byte in both, and printable ASCII is itself.
 */
const WIN_ANSI: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** The byte a character prints as, or `?` for one the standard fonts do not have. */
function byteOf(char: string): number {
  const code = char.codePointAt(0) ?? 63;
  if (code === 9) return 32;
  if (code >= 32 && code <= 126) return code;
  if (code >= 0xa0 && code <= 0xff) return code;
  return WIN_ANSI[code] ?? 63;
}

/** The bytes a string prints as. Line breaks are the caller's to split on. */
export function encode(text: string): number[] {
  return [...text.replace(/[\r\n]+/g, " ")].map((char) => {
    const byte = byteOf(char);
    if (byte !== 63 || char === "?") return byte;
    /**
     * A letter the fonts lack but whose accent comes off cleanly prints as
     * its base letter: "\u1ee9" in a Vietnamese surname prints as "u" rather
     * than as a question mark in the middle of a customer's name.
     */
    const base = char.normalize("NFD")[0] ?? char;
    return base !== char ? byteOf(base) : byte;
  });
}

/** How wide a string sets, in points. */
export function widthOf(text: string, font: FontKey, size: number): number {
  const table = font === "bold" ? BOLD : REGULAR;
  let units = 0;
  for (const byte of encode(text)) {
    units += byte >= 32 && byte <= 126 ? table[byte - 32]! : 556;
  }
  return (units * size) / 1000;
}

/**
 * A paragraph as lines that fit a width.
 *
 * Breaks at spaces; a single word wider than the line (a long serial, a URL)
 * is broken where it has to be rather than run off the edge of the page,
 * because a total printed beyond the margin is a total nobody can read.
 * Line breaks in the text are kept: a technician's note in three lines stays
 * in three lines.
 */
export function wrap(text: string, font: FontKey, size: number, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter((w) => w !== "");
    if (words.length === 0) { out.push(""); continue; }
    let line = "";
    for (const word of words) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (widthOf(candidate, font, size) <= width) { line = candidate; continue; }
      if (line !== "") out.push(line);
      let rest = word;
      while (widthOf(rest, font, size) > width && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && widthOf(rest.slice(0, cut), font, size) > width) cut -= 1;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    out.push(line);
  }
  return out;
}

/** A string cut to a width with an ellipsis, for a cell that must stay one line. */
export function fit(text: string, font: FontKey, size: number, width: number): string {
  if (widthOf(text, font, size) <= width) return text;
  let cut = text.length;
  while (cut > 0 && widthOf(`${text.slice(0, cut)}...`, font, size) > width) cut -= 1;
  return `${text.slice(0, cut).trimEnd()}...`;
}

/* --------------------------------------------------------------- a page */

const num = (value: number): string => {
  const fixed = (Math.round(value * 100) / 100).toFixed(2);
  return fixed.replace(/\.?0+$/, "") || "0";
};
const colour = (c: Rgb) => `${num(c.r)} ${num(c.g)} ${num(c.b)}`;
const hexBytes = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

export class PdfPage {
  readonly width: number;
  readonly height: number;
  private readonly ops: string[] = [];

  constructor(size: { width: number; height: number } = LETTER) {
    this.width = size.width;
    this.height = size.height;
  }

  /** Text with its baseline at `y`. */
  text(x: number, y: number, value: string, options: { font?: FontKey; size?: number; color?: Rgb; align?: "left" | "right" | "center" } = {}): void {
    if (value === "") return;
    const font = options.font ?? "regular";
    const size = options.size ?? 10;
    const width = widthOf(value, font, size);
    const left = options.align === "right" ? x - width : options.align === "center" ? x - width / 2 : x;
    this.ops.push(
      `BT /${font === "bold" ? "F2" : "F1"} ${num(size)} Tf ${colour(options.color ?? { r: 0, g: 0, b: 0 })} rg `
      + `1 0 0 1 ${num(left)} ${num(this.height - y)} Tm <${hexBytes(encode(value))}> Tj ET`,
    );
  }

  line(x1: number, y1: number, x2: number, y2: number, options: { width?: number; color?: Rgb } = {}): void {
    this.ops.push(
      `${num(options.width ?? 0.5)} w ${colour(options.color ?? { r: 0, g: 0, b: 0 })} RG `
      + `${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S`,
    );
  }

  /** A box from its top left corner. Filled, stroked, or both. */
  rect(x: number, y: number, width: number, height: number, options: { fill?: Rgb; stroke?: Rgb; lineWidth?: number }): void {
    const box = `${num(x)} ${num(this.height - y - height)} ${num(width)} ${num(height)} re`;
    if (options.fill && options.stroke) {
      this.ops.push(`${num(options.lineWidth ?? 0.5)} w ${colour(options.fill)} rg ${colour(options.stroke)} RG ${box} B`);
    } else if (options.fill) {
      this.ops.push(`${colour(options.fill)} rg ${box} f`);
    } else if (options.stroke) {
      this.ops.push(`${num(options.lineWidth ?? 0.5)} w ${colour(options.stroke)} RG ${box} S`);
    }
  }

  /** Connected segments, for a line chart. */
  polyline(points: { x: number; y: number }[], options: { width?: number; color?: Rgb } = {}): void {
    if (points.length < 2) return;
    const [first, ...rest] = points;
    this.ops.push(
      `${num(options.width ?? 1)} w 1 J 1 j ${colour(options.color ?? { r: 0, g: 0, b: 0 })} RG `
      + `${num(first!.x)} ${num(this.height - first!.y)} m `
      + rest.map((p) => `${num(p.x)} ${num(this.height - p.y)} l`).join(" ")
      + " S",
    );
  }

  /** The content stream, as PDF operators. */
  content(): string {
    return this.ops.join("\n");
  }
}

/* -------------------------------------------------------------- the file */

export interface PdfMeta {
  title: string;
  author?: string | undefined;
  /** Stamped as the creation date. Passed in, so a test can pin it. */
  createdAt?: Date | undefined;
}

export interface RenderOptions {
  /**
   * Compresses a content stream. Injected because core imports nothing from
   * Node: the api passes `zlib.deflateSync`, and without it the streams are
   * written plain, which every reader accepts and which is easier to debug.
   */
  deflate?: ((bytes: Uint8Array) => Uint8Array) | undefined;
}

const ascii = (text: string) => Uint8Array.from([...text].map((c) => c.charCodeAt(0) & 0xff));

function pdfDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `D:${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`
    + `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`;
}

/**
 * The pages, as the bytes of a PDF file.
 *
 * Objects are numbered in a fixed order (catalogue, page tree, the two fonts,
 * the information dictionary, then a page and its content stream for each
 * page) and the cross reference table records where each one starts, which is
 * the whole of what a reader needs to open the file without repairing it.
 */
export function renderPdf(pages: PdfPage[], meta: PdfMeta, options: RenderOptions = {}): Uint8Array {
  const list = pages.length > 0 ? pages : [new PdfPage()];
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (bytes: Uint8Array) => { chunks.push(bytes); length += bytes.length; };
  const object = (id: number, body: Uint8Array[]) => {
    offsets[id] = length;
    push(ascii(`${id} 0 obj\n`));
    for (const part of body) push(part);
    push(ascii("\nendobj\n"));
  };

  // The second line is four bytes over 127, which tells a transfer tool the file is binary.
  push(ascii("%PDF-1.4\n%âãÏÓ\n"));

  const firstPage = 6;
  const kids = list.map((_, i) => `${firstPage + i * 2} 0 R`).join(" ");
  object(1, [ascii("<< /Type /Catalog /Pages 2 0 R >>")]);
  object(2, [ascii(`<< /Type /Pages /Kids [${kids}] /Count ${list.length} >>`)]);
  object(3, [ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")]);
  object(4, [ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")]);
  const info = [
    `/Title <${hexBytes(encode(meta.title))}>`,
    `/Producer (OpenTradesOS)`,
    ...(meta.author ? [`/Author <${hexBytes(encode(meta.author))}>`] : []),
    `/CreationDate (${pdfDate(meta.createdAt ?? new Date())})`,
  ].join(" ");
  object(5, [ascii(`<< ${info} >>`)]);

  list.forEach((page, i) => {
    const pageId = firstPage + i * 2;
    const contentId = pageId + 1;
    object(pageId, [ascii(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] `
      + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`,
    )]);
    const plain = ascii(page.content());
    const body = options.deflate ? options.deflate(plain) : plain;
    object(contentId, [
      ascii(`<< /Length ${body.length}${options.deflate ? " /Filter /FlateDecode" : ""} >>\nstream\n`),
      body,
      ascii("\nendstream"),
    ]);
  });

  const count = firstPage + list.length * 2;
  const xref = length;
  push(ascii(`xref\n0 ${count}\n0000000000 65535 f\r\n`));
  for (let id = 1; id < count; id += 1) {
    push(ascii(`${String(offsets[id]).padStart(10, "0")} 00000 n\r\n`));
  }
  push(ascii(`trailer\n<< /Size ${count} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`));

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}
