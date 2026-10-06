import { PdfPage, renderPdf, wrap, fit, widthOf, LETTER, type FontKey, type Rgb, type RenderOptions } from "./writer.js";
import { fitWithin, type PdfImage } from "./image.js";
import { money as parseMoney, format as formatMoney } from "../money/index.js";

/**
 * A PAGE THAT FILLS ITSELF
 *
 * The documents are written top to bottom, the way they are read: a header,
 * some facts, a table, the totals. This keeps the place on the page, starts a
 * new page when the next thing would not fit, repeats a table's heading on
 * the page it continues onto, and numbers the pages once it knows how many
 * there are. Each document in `documents.ts` is then a list of what to say,
 * not a set of coordinates.
 */

export const INK: Rgb = { r: 0.07, g: 0.09, b: 0.15 };
export const MUTED: Rgb = { r: 0.35, g: 0.38, b: 0.43 };
export const RULE: Rgb = { r: 0.82, g: 0.84, b: 0.87 };
export const SHADE: Rgb = { r: 0.95, g: 0.96, b: 0.97 };
export const LOSS: Rgb = { r: 0.75, g: 0.11, b: 0.11 };

export interface Column {
  label: string;
  /** In points. The last column takes what is left when this is omitted. */
  width?: number;
  align?: "left" | "right";
}

export interface Header {
  company: string;
  /** Lines under the company's name: its address, its phone and email. */
  contact?: string[] | undefined;
  /** The company's colour, for the band at the top. Ink when it has none. */
  accent: Rgb | null;
  /** The company's logo, at the top left of every page, with the name beside it. */
  logo?: PdfImage | null | undefined;
  title: string;
  /** Under the title: a date, a number, a period. */
  subtitle?: string | undefined;
}

const MARGIN = 48;
const FOOTER = 36;

export class Flow {
  readonly pages: PdfPage[] = [];
  page: PdfPage;
  y = 0;
  readonly left = MARGIN;
  readonly right = LETTER.width - MARGIN;
  readonly width = LETTER.width - MARGIN * 2;
  private readonly header: Header;

  constructor(header: Header) {
    this.header = header;
    this.page = this.newPage();
  }

  private get bottom(): number {
    return LETTER.height - MARGIN - FOOTER;
  }

  newPage(): PdfPage {
    const page = new PdfPage(LETTER);
    this.pages.push(page);
    this.page = page;
    const accent = this.header.accent ?? INK;
    page.rect(0, 0, LETTER.width, 6, { fill: accent });
    /**
     * The logo, kept to its shape inside a box at most 44 points high and 120
     * wide, and the name and contact lines beside it rather than under it, so
     * a page with a logo is no longer before its first line than one without.
     */
    let nameLeft = this.left;
    let logoBottom = 0;
    if (this.header.logo) {
      const size = fitWithin(this.header.logo, 120, 44);
      page.image(this.header.logo, this.left, MARGIN - 14, size.width, size.height);
      nameLeft = this.left + size.width + 12;
      logoBottom = MARGIN - 14 + size.height;
    }
    const nameWidth = this.width * 0.55 - (nameLeft - this.left);
    page.text(nameLeft, MARGIN, fit(this.header.company, "bold", 14, nameWidth), { font: "bold", size: 14, color: INK });
    page.text(this.right, MARGIN, this.header.title, { font: "bold", size: 14, color: INK, align: "right" });
    /**
     * The contact lines sit under the name on the left and the subtitle under
     * the title on the right, so the rule goes under whichever runs longer.
     * Fitted rather than wrapped: an address is one line on paper, and one
     * that wrapped would push the title column out of line with it.
     */
    let left = MARGIN;
    for (const line of this.header.contact ?? []) {
      left += 12;
      page.text(nameLeft, left, fit(line, "regular", 9, nameWidth), { size: 9, color: MUTED });
    }
    left = Math.max(left, logoBottom);
    let y = MARGIN;
    if (this.header.subtitle) {
      y += 15;
      page.text(this.right, y, this.header.subtitle, { size: 9, color: MUTED, align: "right" });
    }
    y = Math.max(y, left);
    y += 10;
    page.line(this.left, y, this.right, y, { color: RULE });
    this.y = y + 20;
    return page;
  }

  /** Room for `height` more points, or a new page. */
  ensure(height: number): void {
    if (this.y + height > this.bottom) this.newPage();
  }

  gap(points = 10): void {
    this.y += points;
  }

  heading(text: string, size = 12): void {
    this.ensure(size + 24);
    this.y += size;
    this.page.text(this.left, this.y, text, { font: "bold", size, color: INK });
    this.y += 8;
  }

  /** A paragraph, wrapped to the page. */
  paragraph(text: string, options: { size?: number; font?: FontKey; color?: Rgb; indent?: number } = {}): void {
    const size = options.size ?? 10;
    const font = options.font ?? "regular";
    const indent = options.indent ?? 0;
    const leading = size * 1.35;
    for (const line of wrap(text, font, size, this.width - indent)) {
      this.ensure(leading);
      this.y += leading;
      this.page.text(this.left + indent, this.y, line, { size, font, color: options.color ?? INK });
    }
  }

  /** Label and value pairs in two columns, skipping a pair with nothing to say. */
  facts(pairs: Array<[string, string | null | undefined]>): void {
    const shown = pairs.filter((pair): pair is [string, string] => Boolean(pair[1]));
    const labelWidth = 120;
    for (const [label, value] of shown) {
      const lines = wrap(value, "regular", 10, this.width - labelWidth);
      this.ensure(lines.length * 13.5 + 2);
      this.y += 13.5;
      this.page.text(this.left, this.y, label, { size: 9, color: MUTED });
      lines.forEach((line, i) => {
        this.page.text(this.left + labelWidth, this.y + i * 13.5, line, { size: 10, color: INK });
      });
      this.y += (lines.length - 1) * 13.5;
    }
  }

  /**
   * A table. Cells wrap rather than overflow, the heading repeats on every
   * page the table runs onto, and a right aligned column stays right aligned
   * so a column of money can be added up by eye.
   */
  table(columns: Column[], rows: string[][], options: { size?: number; boldRows?: Set<number> } = {}): void {
    const size = options.size ?? 9;
    const leading = size * 1.35;
    const fixed = columns.reduce((t, c) => t + (c.width ?? 0), 0);
    const flexible = columns.filter((c) => c.width === undefined).length;
    const widths = columns.map((c) => c.width ?? Math.max(40, (this.width - fixed) / Math.max(1, flexible)));
    const xs = widths.map((_, i) => this.left + widths.slice(0, i).reduce((t, w) => t + w, 0));
    const pad = 4;

    const drawHead = () => {
      this.ensure(leading * 2 + 4);
      this.page.rect(this.left, this.y, this.width, leading + 6, { fill: SHADE });
      columns.forEach((column, i) => {
        const label = fit(column.label, "bold", size, widths[i]! - pad * 2);
        const x = column.align === "right" ? xs[i]! + widths[i]! - pad : xs[i]! + pad;
        this.page.text(x, this.y + leading, label, { font: "bold", size, color: INK, align: column.align === "right" ? "right" : "left" });
      });
      this.y += leading + 6;
    };

    drawHead();
    rows.forEach((row, r) => {
      const font: FontKey = options.boldRows?.has(r) ? "bold" : "regular";
      const cells = columns.map((column, i) => {
        const value = row[i] ?? "";
        return column.align === "right"
          ? [fit(value, font, size, widths[i]! - pad * 2)]
          : wrap(value, font, size, widths[i]! - pad * 2);
      });
      const lines = Math.max(1, ...cells.map((c) => c.length));
      const height = lines * leading + 6;
      if (this.y + height > this.bottom) { this.newPage(); drawHead(); }
      cells.forEach((cell, i) => {
        const column = columns[i]!;
        cell.forEach((line, l) => {
          const x = column.align === "right" ? xs[i]! + widths[i]! - pad : xs[i]! + pad;
          this.page.text(x, this.y + leading * (l + 1), line, {
            size, font, color: INK, align: column.align === "right" ? "right" : "left",
          });
        });
      });
      this.y += height;
      this.page.line(this.left, this.y, this.right, this.y, { color: RULE, width: 0.4 });
    });
  }

  /**
   * A photograph, as large as fits the width and `maxHeight`, on a new page
   * when it does not fit on this one. Centred, with a caption under it when
   * there is one.
   */
  image(image: PdfImage, options: { maxHeight?: number; caption?: string | null | undefined } = {}): void {
    const size = fitWithin(image, this.width, Math.min(options.maxHeight ?? 320, this.bottom - MARGIN - 40));
    this.ensure(size.height + (options.caption ? 20 : 8));
    this.page.image(image, this.left + (this.width - size.width) / 2, this.y, size.width, size.height);
    this.y += size.height;
    if (options.caption) {
      this.y += 12;
      this.page.text(this.left + this.width / 2, this.y, fit(options.caption, "regular", 8, this.width), { size: 8, color: MUTED, align: "center" });
    }
    this.y += 8;
  }

  /** Totals, right aligned under a table: label then figure. */
  totals(pairs: Array<[string, string, boolean?]>): void {
    for (const [label, value, strong] of pairs) {
      const font: FontKey = strong ? "bold" : "regular";
      this.ensure(16);
      this.y += 15;
      this.page.text(this.right - 110, this.y, label, { size: 10, font, color: strong ? INK : MUTED, align: "right" });
      this.page.text(this.right, this.y, value, { size: 10, font, color: INK, align: "right" });
    }
  }

  /**
   * The bytes. Footers are drawn last, because "page 2 of 3" needs the 3.
   */
  finish(meta: { title: string; createdAt?: Date | undefined; footer?: string | undefined }, options: RenderOptions = {}): Uint8Array {
    const count = this.pages.length;
    this.pages.forEach((page, i) => {
      const y = LETTER.height - MARGIN + 8;
      page.line(this.left, y - 14, this.right, y - 14, { color: RULE, width: 0.4 });
      if (meta.footer) page.text(this.left, y, fit(meta.footer, "regular", 8, this.width - 80), { size: 8, color: MUTED });
      page.text(this.right, y, `Page ${i + 1} of ${count}`, { size: 8, color: MUTED, align: "right" });
    });
    return renderPdf(this.pages, { title: meta.title, author: this.header.company, createdAt: meta.createdAt }, options);
  }
}

/* -------------------------------------------------------------- words */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "4 March 2026" style dates read badly in Texas; this is "March 4, 2026". */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const found = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!found) return iso;
  return `${MONTHS[Number(found[2]) - 1] ?? ""} ${Number(found[3])}, ${found[1]}`;
}

/**
 * Money for a person to read. Exact through the money module when the value
 * is one it accepts, which is every stored amount; a computed figure with
 * more places than money keeps (labour at a frozen rate) is rounded for
 * display only, which is all this is for.
 */
export function usd(value: string | number | null | undefined, currency = "USD"): string {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value).trim();
  try {
    return formatMoney(parseMoney(text, currency));
  } catch {
    const n = Number(text);
    if (!Number.isFinite(n)) return text;
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
  }
}

/** A plain quantity: "2", "1.5", never "1.5000". */
export function quantity(value: string | number): string {
  const text = String(value);
  return /\./.test(text) ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/** How wide a run of text is, for callers measuring a label. */
export { widthOf };
