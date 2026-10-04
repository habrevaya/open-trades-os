import { sha256Hex, toBase64 } from "@opentradesos/field-client";

/**
 * A PHOTOGRAPH FROM THE PHONE'S CAMERA, READY TO QUEUE
 *
 * What `/my-day` does with the picture a technician just took, before it goes
 * into the same upload queue the phone app uses: made smaller, hashed, and
 * turned into the base64 the server takes.
 *
 * SMALLER, because a phone camera takes twelve megapixels and a technician
 * sends it over one bar from a van. The longest side is brought down to 2000
 * pixels, which is more than enough to read a model plate or see a cracked
 * heat exchanger, and a JPEG at that size is a few hundred kilobytes instead
 * of five megabytes. A picture the browser cannot decode (an iPhone's HEIC
 * in a browser that does not read it) goes as it came rather than not at all.
 *
 * HASHED with the browser's own SHA-256 where the page is secure, and with
 * the field client's where it is not, because a company running the server
 * on its own network over plain http gets no `crypto.subtle` at all. See
 * `packages/field-client/src/sha256.ts`.
 */

const LONGEST_SIDE = 2000;
const QUALITY = 0.8;

export interface PreparedPhoto {
  base64: string;
  contentType: string;
  byteSize: number;
  contentHash: string;
}

export async function preparePhoto(file: Blob): Promise<PreparedPhoto> {
  const { bytes, contentType } = await shrink(file);
  return {
    base64: toBase64(bytes),
    contentType,
    byteSize: bytes.length,
    contentHash: await hashOf(bytes),
  };
}

async function shrink(file: Blob): Promise<{ bytes: Uint8Array; contentType: string }> {
  const original = { bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type || "image/jpeg" };
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, LONGEST_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return original;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
    if (!blob) return original;
    const smaller = new Uint8Array(await blob.arrayBuffer());
    // Never bigger than what the camera gave: a small PNG re-encoded can grow.
    return smaller.length < original.bytes.length ? { bytes: smaller, contentType: "image/jpeg" } : original;
  } catch {
    return original;
  }
}

async function hashOf(bytes: Uint8Array): Promise<string> {
  const subtle = typeof crypto !== "undefined" ? crypto.subtle : undefined;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return sha256Hex(bytes);
}

/**
 * A signature drawn on the page, from the canvas's PNG data URL, hashed the
 * same way as a photograph so it travels the same hash checked path. Not
 * made smaller: a signature is a few kilobytes, and re-encoding it as a JPEG
 * would put grey fringes round the ink.
 */
export async function prepareSignature(dataUrl: string): Promise<PreparedPhoto> {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error("Not a PNG signature.");
  const binary = atob(match[1]!);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return { base64: match[1]!, contentType: "image/png", byteSize: bytes.length, contentHash: await hashOf(bytes) };
}
