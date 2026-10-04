import { NOTO_SANS_REGULAR } from "./fonts/noto-sans-regular.js";
import { NOTO_SANS_BOLD } from "./fonts/noto-sans-bold.js";

/**
 * A FONT THAT CAN SPELL A CUSTOMER'S NAME
 *
 * The standard PDF fonts every reader carries know Western European letters
 * and nothing else, so "Nguyễn" printed as "Nguyen" at best and "Dvořák" as
 * "Dvo?ák", on an invoice addressed to them. The fix is to put a font in the
 * file. Noto Sans (SIL Open Font License, `fonts/OFL.txt`) covers Latin with
 * every extension, Vietnamese, Greek and Cyrillic, and is bundled here as two
 * weights subset to those scripts.
 *
 * Embedded as PDF's Type 0 font over a TrueType outline: each character is
 * written as its glyph's number, the widths are given per glyph, and a
 * ToUnicode map says what each glyph means, so text copied out of the file or
 * searched for is the text that was drawn. Only the glyphs a document uses are
 * kept in its copy of the font (`subset`), so an invoice carries a few
 * kilobytes of font rather than the whole of it.
 *
 * Pure: the bytes are decoded from source, nothing is read from disk, and the
 * subset is rebuilt by hand from the font's own tables.
 */

export interface FontMetrics {
  /** Units per em, which every width and height below is in. */
  unitsPerEm: number;
  ascent: number;
  descent: number;
  capHeight: number;
  bbox: [number, number, number, number];
}

export class EmbeddedFont {
  readonly bytes: Uint8Array;
  readonly metrics: FontMetrics;
  /** The PostScript name, which the PDF names the font by. */
  readonly postscriptName: string;
  private readonly cmap = new Map<number, number>();
  private readonly advances: number[] = [];
  private readonly tables = new Map<string, { offset: number; length: number }>();
  private readonly numGlyphs: number;
  private readonly longLoca: boolean;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint16(4);
    for (let i = 0; i < count; i += 1) {
      const at = 12 + i * 16;
      const tag = String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
      this.tables.set(tag, { offset: view.getUint32(at + 8), length: view.getUint32(at + 12) });
    }
    const head = this.table("head");
    const unitsPerEm = view.getUint16(head + 18);
    const bbox: [number, number, number, number] = [
      view.getInt16(head + 36), view.getInt16(head + 38), view.getInt16(head + 40), view.getInt16(head + 42),
    ];
    this.longLoca = view.getInt16(head + 50) === 1;
    const hhea = this.table("hhea");
    const ascent = view.getInt16(hhea + 4);
    const descent = view.getInt16(hhea + 6);
    const longMetrics = view.getUint16(hhea + 34);
    this.numGlyphs = view.getUint16(this.table("maxp") + 4);
    const hmtx = this.table("hmtx");
    let last = 0;
    for (let g = 0; g < this.numGlyphs; g += 1) {
      if (g < longMetrics) last = view.getUint16(hmtx + g * 4);
      this.advances.push(last);
    }
    const os2 = this.tables.get("OS/2");
    const capHeight = os2 && view.getUint16(os2.offset) >= 2 && os2.length >= 90
      ? view.getInt16(os2.offset + 88) : ascent;
    this.metrics = { unitsPerEm, ascent, descent, capHeight, bbox };
    this.readCmap(view);
    this.postscriptName = this.readName(view, 6) ?? "NotoSans";
  }

  private table(tag: string): number {
    const found = this.tables.get(tag);
    if (!found) throw new Error(`The font has no ${tag} table.`);
    return found.offset;
  }

  /** The Unicode to glyph map, from a format 4 or format 12 subtable. */
  private readCmap(view: DataView): void {
    const cmap = this.table("cmap");
    const subtables = view.getUint16(cmap + 2);
    let best: number | null = null;
    let bestFormat = 0;
    for (let i = 0; i < subtables; i += 1) {
      const platform = view.getUint16(cmap + 4 + i * 8);
      const encoding = view.getUint16(cmap + 6 + i * 8);
      const offset = cmap + view.getUint32(cmap + 8 + i * 8);
      const format = view.getUint16(offset);
      const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
      if (!unicode) continue;
      if (format === 12 || (format === 4 && bestFormat !== 12)) { best = offset; bestFormat = format; }
    }
    if (best === null) throw new Error("The font has no Unicode character map.");
    if (bestFormat === 12) {
      const groups = view.getUint32(best + 12);
      for (let i = 0; i < groups; i += 1) {
        const at = best + 16 + i * 12;
        const start = view.getUint32(at);
        const end = view.getUint32(at + 4);
        const glyph = view.getUint32(at + 8);
        for (let c = start; c <= end; c += 1) this.cmap.set(c, glyph + (c - start));
      }
      return;
    }
    const segments = view.getUint16(best + 6) / 2;
    const ends = best + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const ranges = deltas + segments * 2;
    for (let s = 0; s < segments; s += 1) {
      const end = view.getUint16(ends + s * 2);
      const start = view.getUint16(starts + s * 2);
      const delta = view.getInt16(deltas + s * 2);
      const range = view.getUint16(ranges + s * 2);
      for (let c = start; c <= end && c !== 0xffff; c += 1) {
        let glyph: number;
        if (range === 0) glyph = (c + delta) & 0xffff;
        else {
          const at = ranges + s * 2 + range + (c - start) * 2;
          glyph = view.getUint16(at);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph !== 0) this.cmap.set(c, glyph);
      }
    }
  }

  private readName(view: DataView, nameId: number): string | null {
    const found = this.tables.get("name");
    if (!found) return null;
    const base = found.offset;
    const count = view.getUint16(base + 2);
    const strings = base + view.getUint16(base + 4);
    for (let i = 0; i < count; i += 1) {
      const at = base + 6 + i * 12;
      if (view.getUint16(at + 6) !== nameId) continue;
      const platform = view.getUint16(at);
      const length = view.getUint16(at + 8);
      const offset = strings + view.getUint16(at + 10);
      let out = "";
      if (platform === 3 || platform === 0) {
        for (let k = 0; k < length; k += 2) out += String.fromCharCode(view.getUint16(offset + k));
      } else {
        for (let k = 0; k < length; k += 1) out += String.fromCharCode(this.bytes[offset + k]!);
      }
      if (out) return out.replace(/[^A-Za-z0-9-]/g, "");
    }
    return null;
  }

  /** The glyph for a code point, or 0 (the font's "missing" box) when it has none. */
  glyphOf(codePoint: number): number {
    return this.cmap.get(codePoint) ?? 0;
  }

  has(codePoint: number): boolean {
    return this.cmap.has(codePoint);
  }

  /** A glyph's advance in thousandths of the font size, which is the unit PDF widths are in. */
  width(glyph: number): number {
    return Math.round(((this.advances[glyph] ?? 0) * 1000) / this.metrics.unitsPerEm);
  }

  private glyphRange(view: DataView, glyph: number): { start: number; end: number } {
    const loca = this.table("loca");
    const glyf = this.table("glyf");
    const at = (g: number) => (this.longLoca ? view.getUint32(loca + g * 4) : view.getUint16(loca + g * 2) * 2);
    return { start: glyf + at(glyph), end: glyf + at(glyph + 1) };
  }

  /**
   * A copy of the font holding only the glyphs given (and glyph 0, and every
   * glyph a composite one is built from), with every glyph number unchanged,
   * so the numbers the page wrote still name the right shapes. The tables a
   * PDF reader needs for a TrueType outline are kept; the character map and
   * names are not, because the PDF says what each glyph means itself.
   */
  subset(used: Iterable<number>): Uint8Array {
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const keep = new Set<number>([0]);
    const pending = [...used].filter((g) => g >= 0 && g < this.numGlyphs);
    while (pending.length > 0) {
      const glyph = pending.pop()!;
      if (keep.has(glyph) && glyph !== 0) continue;
      keep.add(glyph);
      const { start, end } = this.glyphRange(view, glyph);
      if (end - start < 10 || view.getInt16(start) >= 0) continue;
      /** A composite glyph: follow each component it is built from. */
      let at = start + 10;
      for (;;) {
        const flags = view.getUint16(at);
        const component = view.getUint16(at + 2);
        if (!keep.has(component)) pending.push(component);
        at += 4 + (flags & 0x0001 ? 4 : 2);
        if (flags & 0x0008) at += 2;
        else if (flags & 0x0040) at += 4;
        else if (flags & 0x0080) at += 8;
        if (!(flags & 0x0020)) break;
      }
    }

    const pieces: Uint8Array[] = [];
    const offsets: number[] = [];
    let length = 0;
    for (let g = 0; g < this.numGlyphs; g += 1) {
      offsets.push(length);
      if (!keep.has(g)) continue;
      const { start, end } = this.glyphRange(view, g);
      const piece = this.bytes.subarray(start, end);
      const padded = (piece.length + 3) & ~3;
      const copy = new Uint8Array(padded);
      copy.set(piece);
      pieces.push(copy);
      length += padded;
    }
    offsets.push(length);
    const glyf = concat(pieces);
    const loca = new Uint8Array(offsets.length * 4);
    const locaView = new DataView(loca.buffer);
    offsets.forEach((o, i) => locaView.setUint32(i * 4, o));

    const original = (tag: string) => {
      const t = this.tables.get(tag)!;
      return this.bytes.slice(t.offset, t.offset + t.length);
    };
    const head = original("head");
    const headView = new DataView(head.buffer);
    headView.setUint32(8, 0);       // checkSumAdjustment, set below
    headView.setInt16(50, 1);       // indexToLocFormat: long offsets

    const tables: Array<[string, Uint8Array]> = [
      ["glyf", glyf], ["head", head], ["hhea", original("hhea")], ["hmtx", original("hmtx")],
      ["loca", loca], ["maxp", original("maxp")],
      ...(this.tables.has("post") ? [["post", original("post")] as [string, Uint8Array]] : []),
    ];
    const file = writeSfnt(tables);
    const adjustment = (0xb1b0afba - checksum(file)) >>> 0;
    const headAt = tableOffset(file, "head");
    new DataView(file.buffer).setUint32(headAt + 8, adjustment);
    return file;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function checksum(bytes: Uint8Array): number {
  let sum = 0;
  const padded = (bytes.length + 3) & ~3;
  for (let i = 0; i < padded; i += 4) {
    const word = ((bytes[i] ?? 0) << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

/** A TrueType file from its tables, with a directory and each table's checksum. */
function writeSfnt(tables: Array<[string, Uint8Array]>): Uint8Array {
  const sorted = [...tables].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const count = sorted.length;
  let power = 1;
  let log = 0;
  while (power * 2 <= count) { power *= 2; log += 1; }
  const header = new Uint8Array(12 + count * 16);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, count);
  view.setUint16(6, power * 16);
  view.setUint16(8, log);
  view.setUint16(10, count * 16 - power * 16);
  let offset = header.length;
  const bodies: Uint8Array[] = [];
  sorted.forEach(([tag, data], i) => {
    const at = 12 + i * 16;
    for (let k = 0; k < 4; k += 1) header[at + k] = tag.charCodeAt(k);
    view.setUint32(at + 4, checksum(data));
    view.setUint32(at + 8, offset);
    view.setUint32(at + 12, data.length);
    const padded = new Uint8Array((data.length + 3) & ~3);
    padded.set(data);
    bodies.push(padded);
    offset += padded.length;
  });
  return concat([header, ...bodies]);
}

function tableOffset(file: Uint8Array, tag: string): number {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const count = view.getUint16(4);
  for (let i = 0; i < count; i += 1) {
    const at = 12 + i * 16;
    if (String.fromCharCode(file[at]!, file[at + 1]!, file[at + 2]!, file[at + 3]!) === tag) return view.getUint32(at + 8);
  }
  throw new Error(`No ${tag} table`);
}

/** Base64 to bytes, without a Node or browser global, so core stays pure. */
function fromBase64(text: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Uint8Array(128);
  for (let i = 0; i < alphabet.length; i += 1) lookup[alphabet.charCodeAt(i)] = i;
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = lookup[clean.charCodeAt(i)]!;
    const b = lookup[clean.charCodeAt(i + 1)]!;
    const c = i + 2 < clean.length ? lookup[clean.charCodeAt(i + 2)]! : 0;
    const d = i + 3 < clean.length ? lookup[clean.charCodeAt(i + 3)]! : 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length && i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (o < out.length && i + 3 < clean.length) out[o++] = n & 255;
  }
  return out;
}

let fonts: { regular: EmbeddedFont; bold: EmbeddedFont } | null = null;

/** The two bundled weights, decoded once per process on first use. */
export function bundledFonts(): { regular: EmbeddedFont; bold: EmbeddedFont } {
  fonts ??= {
    regular: new EmbeddedFont(fromBase64(NOTO_SANS_REGULAR)),
    bold: new EmbeddedFont(fromBase64(NOTO_SANS_BOLD)),
  };
  return fonts;
}
