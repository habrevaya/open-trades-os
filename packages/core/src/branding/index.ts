/**
 * A COMPANY'S OWN COLOURS AND MARKS
 *
 * Every contractor who buys software puts their logo on it, and every one of
 * them is right to: the proposal, the invoice and the tracking page are seen
 * by their customers, not by ours. A product that cannot do this is one that
 * makes them look like somebody else's franchise.
 *
 * Two things in here, and both are the parts that are easy to get wrong in a
 * way nobody notices until a customer sees it.
 *
 *   A BRAND COLOUR GETS USED TWICE. As a fill with words on top, and as the
 *   words themselves. The first always works out; the second is where a real
 *   company's colour fails, and a contractor whose brand is yellow gets links
 *   at one and a half to one on a white page. Both forms are derived here,
 *   from the one colour they chose.
 *
 *   WHETHER A FILE IS THE PICTURE IT CLAIMS TO BE. A content type is a
 *   string the browser sent, and an upload that trusts it is an upload that
 *   serves whatever it is given from your own origin.
 */

export interface Rgb { r: number; g: number; b: number }

/**
 * A hex colour, in whatever shape somebody typed it.
 *
 * Accepts `#abc`, `abc`, `#aabbcc` and `AABBCC`, because all four are what a
 * person copies out of a brand guide, and returns one canonical form so
 * nothing downstream has to care. Anything else is null rather than a guess:
 * a colour that silently became black is worse than a refusal.
 */
export function parseColor(input: string): string | null {
  const text = input.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(text)) {
    return `#${text[0]!}${text[0]!}${text[1]!}${text[1]!}${text[2]!}${text[2]!}`;
  }
  if (/^[0-9a-f]{6}$/.test(text)) return `#${text}`;
  return null;
}

export function toRgb(hex: string): Rgb | null {
  const parsed = parseColor(hex);
  if (!parsed) return null;
  return {
    r: parseInt(parsed.slice(1, 3), 16),
    g: parseInt(parsed.slice(3, 5), 16),
    b: parseInt(parsed.slice(5, 7), 16),
  };
}

/**
 * Relative luminance, as WCAG defines it.
 *
 * The gamma step is the part people drop, and dropping it is not a rounding
 * difference: a plain average says mid grey and mid green are equally bright,
 * and they are not. Getting this wrong produces a contrast number that looks
 * fine and a button that cannot be read.
 */
export function luminance({ r, g, b }: Rgb): number {
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast, from 1 (identical) to 21 (black on white). */
export function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

export const WHITE: Rgb = { r: 255, g: 255, b: 255 };
/** Not pure black. The rest of the product's dark ink, so a branded button
 * sits beside an unbranded one without one of them looking heavier. */
export const INK: Rgb = { r: 17, g: 24, b: 39 };

/**
 * Which text colour to put on a background.
 *
 * Whichever of the two has more contrast, rather than a brightness threshold.
 * A threshold picks white on a mid blue that would have been more readable in
 * ink, and the difference is exactly where a brand colour usually lands.
 */
export function readableOn(background: string): "#ffffff" | "#111827" | null {
  const rgb = toRgb(background);
  if (!rgb) return null;
  return contrast(rgb, WHITE) >= contrast(rgb, INK) ? "#ffffff" : "#111827";
}

/** WCAG AA for normal text. Below this, somebody outside the office cannot read it. */
export const AA = 4.5;
/** AA for large text, which is what a button label and a heading are. */
export const AA_LARGE = 3;

/** The app's own page background, which brand coloured text has to sit on. */
export const CANVAS: Rgb = { r: 255, g: 255, b: 255 };

/**
 * The same colour, darkened until it can be read as TEXT on the canvas.
 *
 * THIS IS THE CHECK THAT MATTERS, and it is not the one you reach for first.
 *
 * A brand colour gets used two ways: as a fill with words on top, and as the
 * words themselves, for links and headings. The first is always solvable,
 * because white and near black are both available and one of them always
 * clears the bar. I wrote a refusal for the case where neither does, and a
 * test proved that case cannot exist: it would need a colour both lighter
 * than 0.3 and darker than 0.13 luminance at once.
 *
 * The second is where a real company's colour actually fails. A contractor
 * whose brand is yellow gets links at 1.5 to 1 on a white page, which is to
 * say invisible, and refusing their colour outright would be telling them
 * their logo is wrong.
 *
 * So the fill keeps the colour they chose and the text gets a darkened
 * version of it. Same hue, enough contrast, and the screen still looks like
 * their company. Binary search on a scale toward black: deterministic, and
 * closer to the original than stepping in fixed increments.
 */
export function textSafe(color: string, on: Rgb = CANVAS, target = AA): string | null {
  const rgb = toRgb(color);
  if (!rgb) return null;
  if (contrast(rgb, on) >= target) return parseColor(color);

  const at = (scale: number): Rgb => ({
    r: Math.round(rgb.r * scale),
    g: Math.round(rgb.g * scale),
    b: Math.round(rgb.b * scale),
  });

  // Black always clears it against a light canvas, so the search has an
  // answer. Twenty steps puts the result within a rounding error of the
  // lightest shade that works.
  let low = 0;
  let high = 1;
  for (let i = 0; i < 20; i += 1) {
    const mid = (low + high) / 2;
    if (contrast(at(mid), on) >= target) low = mid; else high = mid;
  }

  const found = at(low);
  const hex = `#${[found.r, found.g, found.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  return contrast(found, on) >= target ? hex : "#000000";
}

export type ColorVerdict =
  | { ok: false; reason: string }
  | {
      ok: true;
      /** What they chose. Used as a fill. */
      color: string;
      /** What goes on top of that fill. */
      on: string;
      /** The same colour, dark enough to read as text on the page. */
      text: string;
      /** True when the text colour had to be darkened to be legible. */
      darkened: boolean;
    };

/**
 * Whether a colour can be used, and the two forms it will be used in.
 *
 * Never refuses a real colour. The only refusal is for something that is not
 * a colour at all, because every hex value has a readable foreground and a
 * darkened text variant, and a settings screen that rejects a company's
 * actual brand colour is one they work around by not using the feature.
 */
export function checkColor(input: string): ColorVerdict {
  const color = parseColor(input);
  if (!color) {
    return { ok: false, reason: "That is not a colour. Use a hex code like #1D4ED8." };
  }

  const on = readableOn(color)!;
  const text = textSafe(color)!;
  return { ok: true, color, on, text, darkened: text !== color };
}

// ---------------------------------------------------------------------------
// The marks
// ---------------------------------------------------------------------------

export type BrandAssetKind = "logo" | "favicon";

/**
 * WHAT A FILE ACTUALLY IS, FROM ITS BYTES.
 *
 * The content type on an upload is a string the client chose. Trusting it
 * means serving whatever somebody hands you from your own origin under a name
 * that makes a browser render it, which is the shape of most file upload
 * vulnerabilities. So the first few bytes decide, and the claimed type is
 * ignored entirely.
 */
const SIGNATURES: { type: string; bytes: number[]; offset?: number }[] = [
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { type: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  // RIFF....WEBP. The four size bytes in between are why this needs an offset.
  { type: "image/webp", bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  { type: "image/x-icon", bytes: [0x00, 0x00, 0x01, 0x00] },
];

export function sniff(bytes: Uint8Array): string | null {
  for (const signature of SIGNATURES) {
    const at = signature.offset ?? 0;
    if (bytes.length < at + signature.bytes.length) continue;
    if (signature.bytes.every((byte, i) => bytes[at + i] === byte)) return signature.type;
  }
  return null;
}

/**
 * How big a mark may be.
 *
 * Small, deliberately. These are stored in the database and served on every
 * page, and a logo is a logo rather than a photograph: the one somebody
 * exports from their sign writer's artwork is usually four megabytes of
 * transparent margin.
 */
export const MAX_BYTES: Record<BrandAssetKind, number> = {
  logo: 512 * 1024,
  favicon: 64 * 1024,
};

export type AssetVerdict =
  | { ok: true; contentType: string }
  | { ok: false; reason: string };

export function checkAsset(kind: BrandAssetKind, bytes: Uint8Array): AssetVerdict {
  if (bytes.length === 0) return { ok: false, reason: "That file is empty." };

  const limit = MAX_BYTES[kind];
  if (bytes.length > limit) {
    return {
      ok: false,
      reason: `A ${kind} may be up to ${Math.round(limit / 1024)} KB and that one is ${Math.round(bytes.length / 1024)} KB. Export it smaller: this is served on every page.`,
    };
  }

  const type = sniff(bytes);
  if (!type) {
    /**
     * Named as the thing it actually is, because the commonest case by far is
     * an SVG, and an SVG is a document that can carry script. Serving one from
     * your own origin is script execution on your own domain, by whoever can
     * reach the upload form.
     */
    return {
      ok: false,
      reason: "That is not a PNG, JPEG, GIF, WebP or ICO. SVG is deliberately not accepted: it can carry script, and this is served from the same origin as the application.",
    };
  }

  if (kind === "favicon" && type === "image/webp") {
    // Safari still will not render one as a tab icon, and a favicon that
    // works in one browser is a favicon somebody thinks is broken.
    return { ok: false, reason: "Use a PNG or an ICO for a favicon. WebP is not shown as a tab icon everywhere." };
  }

  return { ok: true, contentType: type };
}
