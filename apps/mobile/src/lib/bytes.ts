/** Bytes as lowercase hex, which is how the server writes a SHA-256. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * The base64 inside a `data:` URL, which is what a canvas hands back for a
 * signature. Refused rather than guessed at when it is not a PNG, because
 * the server decides the type from the bytes and a refusal there would reach
 * the technician a day later as "photo not sent".
 */
export function pngFromDataUrl(dataUrl: string): string | null {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl.trim());
  return match ? match[1]! : null;
}

/** The extension to keep a camera file under, from what the camera said it was. */
export function extensionFor(mimeType: string | null | undefined): { extension: string; contentType: string } {
  switch ((mimeType ?? "").toLowerCase()) {
    case "image/png": return { extension: "png", contentType: "image/png" };
    case "image/heic": return { extension: "heic", contentType: "image/heic" };
    case "image/webp": return { extension: "webp", contentType: "image/webp" };
    default: return { extension: "jpg", contentType: "image/jpeg" };
  }
}
