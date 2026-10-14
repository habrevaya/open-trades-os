/**
 * A LOGO THE PDFS CAN PRINT, MADE IN THE BROWSER
 *
 * The estimate and invoice PDFs print a PNG or a JPEG and nothing else: the
 * PDF writer in core reads those two without an image library, and there is
 * no image library on the server to read a WebP with. A WebP logo was kept
 * and shown on screens and left off every PDF.
 *
 * So a WebP chosen on the settings screen is turned into a PNG here, before it
 * is sent, by the browser that already knows how to draw it. The server never
 * has to decode it, and it keeps what it is sent exactly as before.
 *
 * AN SVG IS DRAWN THE ONE WAY THAT IS SAFE, AND NEVER SENT. The server still
 * refuses SVG outright (core `branding.checkAsset`): one served from the
 * application's own address could run script. Here it is loaded as a picture
 * (an `img`), which is the mode browsers draw an SVG in with scripts switched
 * off and nothing fetched from anywhere else, painted onto a canvas, and sent
 * as the PNG of that painting. What reaches the server is pixels.
 *
 * Big pictures are drawn at most 1200 pixels on their longest side, and drawn
 * smaller again until the PNG fits the logo's limit.
 */

const LONGEST_SIDE = 1200;
const SMALLEST_SIDE = 160;

export type LogoConversion =
  | { kind: "unchanged" }
  | { kind: "converted"; file: File; from: "WebP" | "SVG" }
  | { kind: "refused"; problem: string };

const isSvg = (file: File) => file.type === "image/svg+xml" || /\.svgz?$/i.test(file.name);
const isWebp = (file: File) => file.type === "image/webp" || /\.webp$/i.test(file.name);

/** The size an SVG says it is drawn at, from its viewBox, when it gives no width and height of its own. */
async function svgShape(file: File): Promise<{ width: number; height: number } | null> {
  /**
   * Parsed, not rendered: a document from DOMParser is inert, so nothing in
   * it runs and nothing it names is fetched. Only the numbers are read.
   */
  const doc = new DOMParser().parseFromString(await file.text(), "image/svg+xml");
  const box = doc.documentElement.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number) ?? [];
  const [, , width = 0, height = 0] = box;
  return width > 0 && height > 0 ? { width, height } : null;
}

async function picture(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } finally {
    // Kept until drawn would be tidier; a decoded picture no longer needs its address.
    URL.revokeObjectURL(url);
  }
  return img;
}

async function png(img: HTMLImageElement, width: number, height: number): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
}

/** A WebP or an SVG as a PNG of at most `maxBytes`; anything else as it came. */
export async function printableLogo(file: File, maxBytes: number): Promise<LogoConversion> {
  const from = isSvg(file) ? "SVG" : isWebp(file) ? "WebP" : null;
  if (!from) return { kind: "unchanged" };
  const cannot = from === "SVG"
    ? "This browser could not turn that SVG into a picture. Export it from your design program as a PNG and upload that."
    : "This browser could not read that WebP. Export it as a PNG and upload that.";
  try {
    const img = await picture(from === "SVG" ? new Blob([await file.arrayBuffer()], { type: "image/svg+xml" }) : file);
    let { naturalWidth: width, naturalHeight: height } = img;
    if (from === "SVG") {
      const shape = await svgShape(file);
      if (shape && (!width || !height)) ({ width, height } = shape);
      if (!width || !height) {
        return { kind: "refused", problem: "That SVG does not say how big it is. Export it as a PNG and upload that." };
      }
      // A drawing has no pixels of its own, so it is drawn at the largest size a logo needs.
      const grow = LONGEST_SIDE / Math.max(width, height);
      width *= grow;
      height *= grow;
    }
    let scale = Math.min(1, LONGEST_SIDE / Math.max(width, height));
    for (;;) {
      const blob = await png(img, width * scale, height * scale);
      if (!blob) return { kind: "refused", problem: cannot };
      if (blob.size <= maxBytes) {
        const stem = file.name.replace(/\.[^.]*$/, "") || "logo";
        return { kind: "converted", file: new File([blob], `${stem}.png`, { type: "image/png" }), from };
      }
      if (Math.max(width, height) * scale <= SMALLEST_SIDE) {
        return { kind: "refused", problem: "That picture is too detailed to fit as a logo. Export a smaller PNG and upload that." };
      }
      scale *= 0.7;
    }
  } catch {
    /** A canvas the browser will not read back (it treats some SVGs as from elsewhere) lands here too. */
    return { kind: "refused", problem: cannot };
  }
}
