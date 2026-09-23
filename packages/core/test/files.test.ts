import { describe, it, expect } from "vitest";
import { files } from "../src/index";

/**
 * WHAT A FILE IS, DECIDED FROM ITS BYTES
 *
 * The content type on an upload is a string the client chose, so nothing
 * here reads it except to disagree with it out loud. Every test below is
 * about a way that going wrong turns into a file served from the
 * application's own origin under a name that makes a browser run it.
 */
const bytesOf = (...values: number[]) => Uint8Array.from(values);
const PNG = bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPEG = bytesOf(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a);
const PDF = bytesOf(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37);

describe("sniffing", () => {
  it("recognises the types this product renders", () => {
    expect(files.sniff(PNG)?.type).toBe("image/png");
    expect(files.sniff(JPEG)?.type).toBe("image/jpeg");
    expect(files.sniff(PDF)?.type).toBe("application/pdf");
  });

  it("reads WebP past the four size bytes rather than at the start", () => {
    const webp = new Uint8Array(16);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x1a, 0x00, 0x00, 0x00], 4);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(files.sniff(webp)?.type).toBe("image/webp");
  });

  it("does not run off the end of a file shorter than a signature", () => {
    // A one byte file matching the first byte of JPEG. An index that walked
    // past the end would compare undefined and might still agree.
    expect(files.sniff(bytesOf(0xff))).toBeNull();
  });

  it("refuses an SVG, which is a document that can carry script", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect(files.sniff(svg)).toBeNull();

    const verdict = files.checkFile(svg);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    /** Named, because the commonest request for SVG support is a logo. */
    expect(verdict.reason).toContain("SVG");
  });

  it("refuses an executable wearing a photograph's name", () => {
    const elf = bytesOf(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01);
    const verdict = files.checkFile(elf, { claimedType: "image/jpeg" });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    /**
     * The claim is quoted back. "That is not an image" sends a technician to
     * look at their camera; "it claims to be image/jpeg and it is not" sends
     * them to whoever wrote the app.
     */
    expect(verdict.reason).toContain("image/jpeg");
  });

  it("reports the type it found, never the one it was told", () => {
    const verdict = files.checkFile(PNG, { claimedType: "application/pdf" });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.contentType).toBe("image/png");
    expect(verdict.extension).toBe("png");
  });

  it("refuses an empty file and one over the cap", () => {
    expect(files.checkFile(new Uint8Array(0)).ok).toBe(false);

    const huge = new Uint8Array(files.MAX_FILE_BYTES + 1);
    huge.set(PNG, 0);
    const verdict = files.checkFile(huge);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("MB");
  });

  it("takes the caller's cap when it is stricter", () => {
    expect(files.checkFile(PNG, { maxBytes: 4 }).ok).toBe(false);
  });
});

describe("where a file lives", () => {
  const hash = "a".repeat(64);

  it("is derived from the hash, not from what it is attached to", () => {
    const key = files.storageKey({ organizationId: "org-1", sha256: hash, extension: "png" });
    expect(key).toBe(`org-1/aa/aa/${hash}.png`);
  });

  it("fans out, so one directory does not hold four hundred thousand files", () => {
    const key = files.storageKey({ organizationId: "org-1", sha256: "0123" + "b".repeat(60), extension: "jpg" });
    expect(key).toContain("/01/23/");
  });

  it("gives the same bytes the same key, which is what makes a retry free", () => {
    const a = files.storageKey({ organizationId: "org-1", sha256: hash, extension: "png" });
    const b = files.storageKey({ organizationId: "org-1", sha256: hash.toUpperCase(), extension: "png" });
    expect(a).toBe(b);
  });

  it("keeps two tenants apart even when they hold the same file", () => {
    /**
     * The hash alone would be unique. The organization is in the key so a
     * self hoster can see whose file is whose, and so one tenant cannot
     * learn another holds a file by trying to write it.
     */
    const a = files.storageKey({ organizationId: "org-1", sha256: hash, extension: "png" });
    const b = files.storageKey({ organizationId: "org-2", sha256: hash, extension: "png" });
    expect(a).not.toBe(b);
  });

  it("refuses anything that is not a SHA-256 digest", () => {
    expect(() => files.storageKey({ organizationId: "org-1", sha256: "../../etc/passwd", extension: "png" }))
      .toThrow(/SHA-256/);
    expect(() => files.storageKey({ organizationId: "org-1", sha256: "abc", extension: "png" }))
      .toThrow(/SHA-256/);
  });
});

describe("how often a phone should try", () => {
  it("stops at the cap", () => {
    expect(files.shouldRetry(0)).toBe(true);
    expect(files.shouldRetry(files.MAX_UPLOAD_ATTEMPTS - 1)).toBe(true);
    expect(files.shouldRetry(files.MAX_UPLOAD_ATTEMPTS)).toBe(false);
  });

  it("is enough for a lift, a tunnel and a car park, and not forever", () => {
    expect(files.MAX_UPLOAD_ATTEMPTS).toBeGreaterThan(2);
    expect(files.MAX_UPLOAD_ATTEMPTS).toBeLessThan(20);
  });
});
