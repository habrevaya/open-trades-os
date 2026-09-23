/**
 * FILES
 *
 * What a file is, decided from its bytes, and what may be kept.
 *
 * This module exists because three separate parts of the product needed the
 * same three decisions and only one of them had made any: `branding` sniffed
 * a logo, `attachment` held a storage key nothing ever wrote, and
 * `field_upload` held a queue of photographs from a technician's phone that
 * nothing ever drained. A second copy of a signature table would have been
 * the usual outcome, and a signature table that disagrees with another one is
 * a file that is a PNG on one screen and a document on the next.
 *
 * THE CONTENT TYPE ON AN UPLOAD IS A STRING THE CLIENT CHOSE.
 *
 * Trusting it means serving whatever somebody hands you, from your own
 * origin, under a name that makes a browser render it. That is the shape of
 * most file upload vulnerabilities and it is why nothing here reads the
 * claimed type except to disagree with it out loud.
 *
 * SVG IS NOT ACCEPTED ANYWHERE, and this is worth stating rather than
 * leaving as an omission. An SVG is a document that can carry script, so
 * serving one from the application's own origin is script execution on the
 * application's own domain by anybody who can reach an upload form. The
 * commonest reason somebody adds SVG support is a logo, and `branding` is
 * where that request arrives.
 */

export interface FileSignature {
  type: string;
  /** What the bytes look like. */
  bytes: number[];
  /** Where to look, when the magic is not at the start. */
  offset?: number;
  /** The extension a storage key gets. Never taken from the uploaded name. */
  extension: string;
}

/**
 * Every type this product will keep.
 *
 * Deliberately short. A list that accepts everything is a list nobody has
 * decided anything with, and every entry here is something a screen in this
 * product actually renders: photographs of work, a signature, and the PDF a
 * manufacturer sends as a warranty.
 */
export const SIGNATURES: readonly FileSignature[] = [
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], extension: "png" },
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff], extension: "jpg" },
  { type: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38], extension: "gif" },
  /** RIFF....WEBP. The four size bytes in between are why this needs an offset. */
  { type: "image/webp", bytes: [0x57, 0x45, 0x42, 0x50], offset: 8, extension: "webp" },
  { type: "image/x-icon", bytes: [0x00, 0x00, 0x01, 0x00], extension: "ico" },
  { type: "image/heic", bytes: [0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63], offset: 4, extension: "heic" },
  { type: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], extension: "pdf" },
];

/** What the bytes are, or nothing. Never what the upload claimed. */
export function sniff(bytes: Uint8Array): FileSignature | null {
  for (const signature of SIGNATURES) {
    const at = signature.offset ?? 0;
    if (bytes.length < at + signature.bytes.length) continue;
    if (signature.bytes.every((byte, i) => bytes[at + i] === byte)) return signature;
  }
  return null;
}

/**
 * How big a single file may be.
 *
 * Twenty megabytes, which is roughly a modern phone photograph at full
 * resolution with room to spare. Not a hundred: these are stored by a self
 * hoster who may be running a five dollar virtual machine, and a technician
 * who can attach a two hundred megabyte video is a technician whose van
 * fills somebody's disk on a Tuesday.
 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export type FileVerdict =
  | { ok: true; contentType: string; extension: string; sizeBytes: number }
  | { ok: false; reason: string };

/**
 * Whether this may be kept.
 *
 * `claimedType` is accepted and used ONLY to make the refusal better. A
 * technician told "that is not an image" when they attached a HEIC their
 * phone called a JPEG has learned nothing; told that the file claims to be a
 * JPEG and is not one, they have something to say to whoever wrote the app.
 */
export function checkFile(
  bytes: Uint8Array,
  options: { maxBytes?: number; claimedType?: string | undefined } = {},
): FileVerdict {
  if (bytes.length === 0) return { ok: false, reason: "That file is empty." };

  const limit = options.maxBytes ?? MAX_FILE_BYTES;
  if (bytes.length > limit) {
    return {
      ok: false,
      reason: `A file may be up to ${Math.round(limit / (1024 * 1024))} MB and that one is ${Math.round(bytes.length / (1024 * 1024))} MB.`,
    };
  }

  const signature = sniff(bytes);
  if (!signature) {
    const claimed = options.claimedType?.trim();
    const mismatch = claimed
      ? ` It claims to be ${claimed}, and it is not.`
      : "";
    return {
      ok: false,
      reason:
        "That is not a PNG, JPEG, GIF, WebP, ICO, HEIC or PDF."
        + mismatch
        + " SVG is deliberately not accepted: it can carry script, and files are served from the same origin as the application.",
    };
  }

  return {
    ok: true,
    contentType: signature.type,
    extension: signature.extension,
    sizeBytes: bytes.length,
  };
}

/**
 * Where a file lives, derived from what it IS rather than from what it is
 * attached to.
 *
 * Content addressed on purpose. The same photograph attached to a job, a
 * service report and an invoice is one set of bytes with three references,
 * and a technician whose phone retries an upload over a metered connection
 * sends it to the key it already occupies rather than to a second copy.
 *
 * The organization is in the key even though the hash alone would be unique,
 * because a self hoster looking at a directory or a bucket should be able to
 * see whose file is whose, and because two tenants sharing a key would mean
 * one could learn the other holds a file simply by trying to write it.
 *
 * The extension comes from the SNIFFED type. Taking it from the uploaded
 * name is the same mistake as trusting the content type, one layer down.
 */
export function storageKey(input: {
  organizationId: string;
  sha256: string;
  extension: string;
}): string {
  const hash = input.sha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`A storage key needs a SHA-256 hex digest, not ${input.sha256.slice(0, 16)}.`);
  }
  /**
   * Two levels of fan out from the hash, which is what every content
   * addressed store does and for the same reason: a single directory with
   * four hundred thousand files in it is a directory that takes a minute to
   * list on the day somebody needs to.
   */
  return `${input.organizationId}/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.${input.extension}`;
}

/**
 * Whether an upload should be tried again.
 *
 * Capped, because a queue that retries forever is how a phone spends a
 * technician's battery and a data allowance on a photograph the server has
 * already refused. Five is enough to survive a lift, a tunnel and a car
 * park; the sixth failure is telling you something.
 */
export const MAX_UPLOAD_ATTEMPTS = 5;

export const shouldRetry = (attempts: number): boolean => attempts < MAX_UPLOAD_ATTEMPTS;
