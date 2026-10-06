import type { PdfImage } from "./image.js";
import { bundledFonts, type EmbeddedFont } from "./font.js";

/**
 * A PDF, WRITTEN BY HAND
 *
 * Every document this product hands a customer or an accountant as a file is
 * text, ruled lines and filled boxes: an invoice, a proposal, a statement, a
 * signed staff document, a report with its chart, the company's logo, and on a proposal the company's
 * photographs, which PDF takes as the JPEG or PNG data they already are
 * (`image.ts`). None of it needs a layout engine, and all of it has to be
 * produced in two places that are not a browser: a Next route handler and the
 * worker that emails a report at seven in the morning.
 *
 * WHY NOT A LIBRARY. The candidates were a headless browser (a hundred and
 * fifty megabytes of Chromium in a self hosted container, to draw a table),
 * pdfkit (reads its font metrics from files on disk at run time, which a
 * bundled Next server does not ship) and pdf-lib (the closest fit,
 * unmaintained since 2021, and a megabyte of code whose useful part here is
 * the same few hundred lines as this file). PDF 1.4 is a small, stable format
 * and the whole writer is the object table below. It is pure, it is tested
 * without a reader, and it cannot fail to bundle.
 *
 * THE FONT IS IN THE FILE. The standard fonts every reader carries know
 * Western European letters only, so a customer named in Vietnamese, Czech,
 * Greek or Russian had their name misprinted on their own invoice. Noto Sans
 * is bundled (`font.ts`) and the glyphs each document uses are embedded in
 * it; a script the bundle does not cover (Chinese, Arabic, Hebrew) still
 * prints a letter as its base letter where it has one and "?" where not.
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

/* ------------------------------------------------------------ the fonts */

const fontFor = (key: FontKey): EmbeddedFont => bundledFonts()[key];

/**
 * The glyphs a string prints as, each with the text it stands for. Line
 * breaks are the caller's to split on.
 *
 * A character the font has prints as itself. One it lacks prints as its base
 * letter when the accent comes off cleanly, and as "?" when even that is not
 * there (a Chinese or Arabic name, which the bundled scripts do not cover),
 * so a customer's name never prints as an empty box in the middle.
 */
export function glyphsOf(text: string, font: FontKey): Array<{ glyph: number; text: string }> {
  const face = fontFor(font);
  return [...text.replace(/[\r\n]+/g, " ").replace(/\t/g, " ")].map((char) => {
    const code = char.codePointAt(0) ?? 63;
    if (face.has(code)) return { glyph: face.glyphOf(code), text: char };
    const base = char.normalize("NFD")[0] ?? char;
    const baseCode = base.codePointAt(0) ?? 63;
    if (base !== char && face.has(baseCode)) return { glyph: face.glyphOf(baseCode), text: base };
    return { glyph: face.glyphOf(63), text: "?" };
  });
}

/** How wide a string sets, in points, from the font's own advance widths. */
export function widthOf(text: string, font: FontKey, size: number): number {
  const face = fontFor(font);
  let units = 0;
  for (const { glyph } of glyphsOf(text, font)) units += face.width(glyph);
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
const hexGlyphs = (glyphs: number[]) => glyphs.map((g) => g.toString(16).padStart(4, "0")).join("");
/** A text string for the information dictionary: UTF-16 with its byte order mark, so any name survives. */
const utf16 = (text: string) => `FEFF${[...text].flatMap((char) => {
  const code = char.codePointAt(0)!;
  if (code < 0x10000) return [code];
  const v = code - 0x10000;
  return [0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff)];
}).map((unit) => unit.toString(16).padStart(4, "0")).join("")}`;

export class PdfPage {
  readonly width: number;
  readonly height: number;
  private readonly ops: string[] = [];
  /** The photographs this page draws, by the name its content stream calls each one. */
  readonly images: Array<{ name: string; image: PdfImage }> = [];
  /** Every glyph drawn, per font, with the text it stands for: what the file's fonts keep and map back. */
  readonly glyphs: Record<FontKey, Map<number, string>> = { regular: new Map(), bold: new Map() };

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
    const drawn = glyphsOf(value, font);
    for (const { glyph, text } of drawn) if (!this.glyphs[font].has(glyph)) this.glyphs[font].set(glyph, text);
    this.ops.push(
      `BT /${font === "bold" ? "F2" : "F1"} ${num(size)} Tf ${colour(options.color ?? { r: 0, g: 0, b: 0 })} rg `
      + `1 0 0 1 ${num(left)} ${num(this.height - y)} Tm <${hexGlyphs(drawn.map((d) => d.glyph))}> Tj ET`,
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

  /**
   * A photograph with its top left corner at (`x`, `y`), drawn at the size
   * given. The same image drawn twice on a page is one resource.
   */
  image(image: PdfImage, x: number, y: number, width: number, height: number): void {
    let found = this.images.find((entry) => entry.image === image);
    if (!found) {
      found = { name: `Im${this.images.length + 1}`, image };
      this.images.push(found);
    }
    this.ops.push(`q ${num(width)} 0 0 ${num(height)} ${num(x)} ${num(this.height - y - height)} cm /${found.name} Do Q`);
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
 * page, then the images, then what each font is made of) and the cross
 * reference table records where each one starts, which is the whole of what a
 * reader needs to open the file without repairing it.
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
  const stream = (id: number, dictionary: string, plain: Uint8Array, compress = true) => {
    const body = compress && options.deflate ? options.deflate(plain) : plain;
    const filter = compress && options.deflate ? " /Filter /FlateDecode" : "";
    object(id, [ascii(`<< ${dictionary}${dictionary ? " " : ""}/Length ${body.length}${filter} >>\nstream\n`), body, ascii("\nendstream")]);
  };

  // The second line is four bytes over 127, which tells a transfer tool the file is binary.
  push(ascii("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n"));

  const firstPage = 6;
  const kids = list.map((_, i) => `${firstPage + i * 2} 0 R`).join(" ");

  /**
   * Images come after the pages, one object each however many pages draw
   * them, and a transparent one's mask after it. Then four objects per font.
   */
  const imageIds = new Map<PdfImage, number>();
  let nextId = firstPage + list.length * 2;
  for (const page of list) {
    for (const { image } of page.images) {
      if (imageIds.has(image)) continue;
      imageIds.set(image, nextId);
      nextId += image.mask ? 2 : 1;
    }
  }
  const fontKeys: FontKey[] = ["regular", "bold"];
  const fontIds = new Map<FontKey, number>();
  for (const key of fontKeys) { fontIds.set(key, nextId); nextId += 4; }

  object(1, [ascii("<< /Type /Catalog /Pages 2 0 R >>")]);
  object(2, [ascii(`<< /Type /Pages /Kids [${kids}] /Count ${list.length} >>`)]);
  for (const [i, key] of fontKeys.entries()) {
    const face = fontFor(key);
    const base = fontIds.get(key)!;
    object(3 + i, [ascii(
      `<< /Type /Font /Subtype /Type0 /BaseFont /${subsetTag(list, key)}+${face.postscriptName} `
      + `/Encoding /Identity-H /DescendantFonts [${base} 0 R] /ToUnicode ${base + 3} 0 R >>`,
    )]);
  }
  const info = [
    `/Title <${utf16(meta.title)}>`,
    `/Producer (OpenTradesOS)`,
    ...(meta.author ? [`/Author <${utf16(meta.author)}>`] : []),
    `/CreationDate (${pdfDate(meta.createdAt ?? new Date())})`,
  ].join(" ");
  object(5, [ascii(`<< ${info} >>`)]);

  list.forEach((page, i) => {
    const pageId = firstPage + i * 2;
    const contentId = pageId + 1;
    const xobjects = page.images.length > 0
      ? ` /XObject << ${page.images.map(({ name, image }) => `/${name} ${imageIds.get(image)} 0 R`).join(" ")} >>`
      : "";
    object(pageId, [ascii(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] `
      + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjects} >> /Contents ${contentId} 0 R >>`,
    )]);
    stream(contentId, "", ascii(page.content()));
  });

  for (const [image, id] of imageIds) {
    const write = (target: PdfImage, at: number, extra: string) => object(at, [
      ascii(
        `<< /Type /XObject /Subtype /Image /Width ${target.width} /Height ${target.height} `
        + `/ColorSpace /${target.colorSpace} /BitsPerComponent 8 /Filter /${target.filter}`
        + `${target.extra ? ` ${target.extra}` : ""}${extra} /Length ${target.data.length} >>\nstream\n`,
      ),
      target.data,
      ascii("\nendstream"),
    ]);
    write(image, id, image.mask ? ` /SMask ${id + 1} 0 R` : "");
    if (image.mask) write(image.mask, id + 1, "");
  }

  for (const key of fontKeys) {
    const face = fontFor(key);
    const base = fontIds.get(key)!;
    const used = new Map<number, string>();
    for (const page of list) for (const [glyph, text] of page.glyphs[key]) if (!used.has(glyph)) used.set(glyph, text);
    const glyphs = [...used.keys()].sort((a, b) => a - b);
    const scale = (v: number) => Math.round((v * 1000) / face.metrics.unitsPerEm);
    const widths = glyphs.map((g) => `${g} [${face.width(g)}]`).join(" ");
    const name = `${subsetTag(list, key)}+${face.postscriptName}`;
    object(base, [ascii(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} `
      + `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> `
      + `/FontDescriptor ${base + 1} 0 R /CIDToGIDMap /Identity /DW ${face.width(0)} /W [${widths}] >>`,
    )]);
    const [x1, y1, x2, y2] = face.metrics.bbox;
    object(base + 1, [ascii(
      `<< /Type /FontDescriptor /FontName /${name} /Flags 32 `
      + `/FontBBox [${scale(x1)} ${scale(y1)} ${scale(x2)} ${scale(y2)}] /ItalicAngle 0 `
      + `/Ascent ${scale(face.metrics.ascent)} /Descent ${scale(face.metrics.descent)} `
      + `/CapHeight ${scale(face.metrics.capHeight)} /StemV ${key === "bold" ? 120 : 80} /FontFile2 ${base + 2} 0 R >>`,
    )]);
    const program = face.subset(glyphs);
    stream(base + 2, `/Length1 ${program.length}`, program);
    stream(base + 3, "", ascii(toUnicode(used)));
  }

  const count = nextId;
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

/**
 * Six capital letters naming this subset of the font, as PDF asks of an
 * embedded subset, from the glyphs it holds: the same pages give the same tag.
 */
function subsetTag(pages: PdfPage[], key: FontKey): string {
  let hash = 2166136261;
  for (const page of pages) {
    for (const glyph of page.glyphs[key].keys()) hash = Math.imul(hash ^ glyph, 16777619) >>> 0;
  }
  let tag = "";
  for (let i = 0; i < 6; i += 1) { tag += String.fromCharCode(65 + (hash % 26)); hash = Math.floor(hash / 26) + i * 7; }
  return tag;
}

/**
 * What each glyph means, as a CMap a reader uses to copy, search and read
 * aloud the text, and `inspect.ts` uses to read it back.
 */
function toUnicode(used: Map<number, string>): string {
  const entries = [...used.entries()].sort((a, b) => a[0] - b[0]);
  const hexText = (text: string) => utf16(text).slice(4);
  const blocks: string[] = [];
  for (let i = 0; i < entries.length; i += 100) {
    const block = entries.slice(i, i + 100);
    blocks.push(`${block.length} beginbfchar\n${block.map(([g, t]) => `<${g.toString(16).padStart(4, "0")}> <${hexText(t)}>`).join("\n")}\nendbfchar`);
  }
  return [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    ...blocks,
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
}
