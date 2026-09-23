import { describe, it, expect } from "vitest";
import {
  parseColor, toRgb, luminance, contrast, readableOn, checkColor, textSafe,
  sniff, checkAsset, MAX_BYTES, WHITE, INK, CANVAS, AA,
} from "../src/branding/index.js";

describe("reading a colour somebody typed", () => {
  it("takes it in every shape a brand guide writes it", () => {
    for (const input of ["#1D4ED8", "1d4ed8", "  #1d4ed8  ", "#1D4ED8"]) {
      expect(parseColor(input), input).toBe("#1d4ed8");
    }
  });

  it("expands the three character form", () => {
    // `#f00` is what somebody pastes out of a CSS file.
    expect(parseColor("#f00")).toBe("#ff0000");
    expect(parseColor("abc")).toBe("#aabbcc");
  });

  it("refuses rather than guessing", () => {
    /**
     * A colour that silently became black is worse than a refusal: the owner
     * saved, saw a change, and has no reason to think the product ignored
     * them.
     */
    for (const input of ["", "blue", "#12345", "#1234567", "#gggggg", "rgb(1,2,3)"]) {
      expect(parseColor(input), input).toBeNull();
    }
  });
});

describe("how bright a colour is", () => {
  it("agrees with the published values at the ends", () => {
    expect(luminance(WHITE)).toBeCloseTo(1, 5);
    expect(luminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
  });

  it("applies the gamma step rather than averaging", () => {
    /**
     * The part people drop. Mid grey is 0x808080, and a plain average would
     * put it at 0.5; with the gamma curve it is about 0.216. Every contrast
     * number downstream is wrong by the same amount if this is missed, which
     * looks like a small error and produces a button nobody can read.
     */
    expect(luminance(toRgb("#808080")!)).toBeCloseTo(0.2159, 3);
  });

  it("knows green is brighter than blue at the same value", () => {
    // The coefficients, not the bytes. A plain average says these are equal.
    expect(luminance(toRgb("#00ff00")!)).toBeGreaterThan(luminance(toRgb("#0000ff")!));
  });
});

describe("contrast", () => {
  it("is 21 to 1 for black on white, which is the maximum", () => {
    expect(contrast(WHITE, { r: 0, g: 0, b: 0 })).toBeCloseTo(21, 4);
  });

  it("is 1 for a colour against itself", () => {
    expect(contrast(toRgb("#1d4ed8")!, toRgb("#1d4ed8")!)).toBeCloseTo(1, 6);
  });

  it("does not care which way round the two are given", () => {
    const a = toRgb("#1d4ed8")!;
    expect(contrast(a, WHITE)).toBeCloseTo(contrast(WHITE, a), 6);
  });
});

describe("what goes on top", () => {
  it("puts white on a dark brand colour and ink on a light one", () => {
    expect(readableOn("#1d4ed8")).toBe("#ffffff");
    expect(readableOn("#facc15")).toBe("#111827");
  });

  it("picks by contrast rather than by a brightness threshold", () => {
    /**
     * The case a threshold gets wrong, and it is exactly where brand colours
     * live. A mid teal is bright enough to pass "is it light" and still
     * reads better in ink than in white.
     */
    const teal = toRgb("#3aa6a6")!;
    const chosen = readableOn("#3aa6a6");
    const other = chosen === "#ffffff" ? INK : WHITE;
    expect(contrast(teal, chosen === "#ffffff" ? WHITE : INK))
      .toBeGreaterThanOrEqual(contrast(teal, other));
  });

  it("never claims a foreground for a colour it could not read", () => {
    expect(readableOn("not a colour")).toBeNull();
  });
});

describe("brand coloured text on a white page", () => {
  it("leaves a dark colour alone", () => {
    // It already reads. Darkening it would change their brand for nothing.
    expect(textSafe("#1d4ed8")).toBe("#1d4ed8");
  });

  it("darkens one that would be invisible", () => {
    /**
     * The case a contractor actually hits. Yellow at 1.5 to 1 on white is
     * not a low contrast link, it is no link at all.
     */
    const before = contrast(toRgb("#facc15")!, CANVAS);
    expect(before).toBeLessThan(AA);

    const after = textSafe("#facc15")!;
    expect(after).not.toBe("#facc15");
    expect(contrast(toRgb(after)!, CANVAS)).toBeGreaterThanOrEqual(AA);
  });

  it("darkens no further than it has to", () => {
    // Same hue, still recognisably their colour. A fixed step would land
    // somewhere much darker than necessary.
    const darkened = toRgb(textSafe("#facc15")!)!;
    expect(contrast(darkened, CANVAS)).toBeLessThan(AA + 0.5);
  });

  it("keeps the hue while it does it", () => {
    // Scaling toward black preserves the ratios between channels, which is
    // what makes the result look like the same colour rather than a new one.
    const original = toRgb("#facc15")!;
    const darkened = toRgb(textSafe("#facc15")!)!;
    expect(darkened.r / darkened.g).toBeCloseTo(original.r / original.g, 1);
    expect(darkened.b).toBeLessThan(darkened.r);
  });

  it("works for every colour, including white", () => {
    /**
     * White is the hard one: scaling it toward black is the only way down,
     * and a search that gave up would return something unreadable.
     */
    for (const color of ["#ffffff", "#000000", "#facc15", "#8b5cf6", "#22c55e", "#f97316"]) {
      const safe = textSafe(color);
      expect(safe, color).not.toBeNull();
      expect(contrast(toRgb(safe!)!, CANVAS), color).toBeGreaterThanOrEqual(AA);
    }
  });
});

describe("whether a brand colour can be used", () => {
  it("accepts every real colour, and says which form is which", () => {
    /**
     * Never refuses a colour that exists. A settings screen that rejects a
     * company's actual brand colour is one they work around by not using
     * the feature, and there is always an answer: a readable foreground for
     * the fill and a darkened variant for the text.
     */
    const verdict = checkColor("#1d4ed8");
    expect(verdict).toEqual({
      ok: true, color: "#1d4ed8", on: "#ffffff", text: "#1d4ed8", darkened: false,
    });
  });

  it("says when the text form had to be darkened", () => {
    const verdict = checkColor("#facc15");
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.darkened).toBe(true);
    // The fill is still exactly what they chose.
    expect(verdict.ok && verdict.color).toBe("#facc15");
    expect(verdict.ok && verdict.on).toBe("#111827");
  });

  it("refuses only something that is not a colour", () => {
    for (const input of ["chartreuse", "", "#12345"]) {
      const verdict = checkColor(input);
      expect(verdict.ok, input).toBe(false);
      // Names the format, because "invalid" tells somebody nothing they can do.
      expect(verdict.ok === false && verdict.reason, input).toMatch(/#/);
    }
  });
});

// ---------------------------------------------------------------------------

const png = (extra = 0) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(extra).fill(0)]);
const webp = () => new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

describe("what a file actually is", () => {
  it("reads the bytes rather than the claim", () => {
    expect(sniff(png())).toBe("image/png");
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniff(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif");
    expect(sniff(new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01]))).toBe("image/x-icon");
  });

  it("finds WEBP past the four size bytes", () => {
    // The offset is the whole reason this one needs its own case: the magic
    // is at byte eight, not byte zero.
    expect(sniff(webp())).toBe("image/webp");
  });

  it("does not mistake a short file for a match", () => {
    expect(sniff(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(sniff(new Uint8Array())).toBeNull();
  });

  it("does not recognise an SVG, which is the point", () => {
    /**
     * An SVG is a document that can carry script, and serving one from the
     * application's own origin is script execution on that origin by whoever
     * can reach the upload form. It is refused rather than sanitised,
     * because sanitising SVG is a losing game somebody has to keep playing.
     */
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(sniff(svg)).toBeNull();
    expect(checkAsset("logo", svg).ok).toBe(false);
  });

  it("is not fooled by a PNG name on other bytes", () => {
    // The name never reaches this function, which is the design: there is
    // nothing here to lie to.
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    expect(checkAsset("logo", zip).ok).toBe(false);
  });
});

describe("whether a mark may be saved", () => {
  it("accepts a small PNG", () => {
    const verdict = checkAsset("logo", png(100));
    expect(verdict).toEqual({ ok: true, contentType: "image/png" });
  });

  it("refuses an empty file", () => {
    expect(checkAsset("logo", new Uint8Array()).ok).toBe(false);
  });

  it("refuses one over the limit, and says both numbers", () => {
    /**
     * These are served on every page from the database. The logo somebody
     * exports from their sign writer's artwork is usually four megabytes of
     * transparent margin, and "too big" without the numbers is a refusal
     * nobody can act on.
     */
    const verdict = checkAsset("logo", png(MAX_BYTES.logo));
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/512 KB/);
  });

  it("holds a favicon to a tighter limit than a logo", () => {
    const between = png(MAX_BYTES.favicon + 1024);
    expect(checkAsset("logo", between).ok).toBe(true);
    expect(checkAsset("favicon", between).ok).toBe(false);
  });

  it("refuses a WebP favicon, which not every browser shows", () => {
    // A favicon that works in one browser is a favicon somebody thinks is
    // broken, and they are right.
    expect(checkAsset("logo", webp()).ok).toBe(true);
    expect(checkAsset("favicon", webp()).ok).toBe(false);
  });
});
