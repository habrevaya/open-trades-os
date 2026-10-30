import { describe, it, expect } from "vitest";
import { files } from "../src/index";

/**
 * WHAT A REPLY BY EMAIL MAY BRING (M18)
 *
 * Anybody can email the reply address, so the files are held to the types
 * kept everywhere here, decided from the bytes, and to limits of their own.
 * A program is refused by its name before it is downloaded and by its bytes
 * whatever it was called.
 */
const pdf = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]);

describe("a program is never kept", () => {
  it("knows one by its name or its claimed type", () => {
    for (const name of ["setup.exe", "invoice.pdf.exe", "pay.JS", "run.bat ", "x.ps1", "page.html", "logo.svg", "a.scr."]) {
      expect(files.isProgramName(name), name).toBe(true);
    }
    expect(files.isProgramName("photo.jpg", "application/x-msdownload")).toBe(true);
    expect(files.isProgramName("plans.final.pdf", "application/pdf")).toBe(false);
    expect(files.isProgramName("README", null)).toBe(false);
  });

  it("knows one by its bytes, whatever it was called", () => {
    expect(files.isProgramBytes(exe)).toBe(true);
    expect(files.isProgramBytes(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2]))).toBe(true);
    expect(files.isProgramBytes(new TextEncoder().encode("#!/bin/sh\nrm -rf /"))).toBe(true);
    expect(files.isProgramBytes(pdf)).toBe(false);
    const verdict = files.checkEmailAttachment({ fileName: "invoice.pdf", contentType: "application/pdf", bytes: exe }, { bytesAlreadyKept: 0 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("program");
  });
});

describe("the limits", () => {
  it("downloads the first ten that are not programs and not said to be too big", () => {
    const named = [
      { fileName: "virus.exe", contentType: "application/octet-stream" },
      { fileName: "huge.pdf", contentType: "application/pdf", size: files.EMAIL_ATTACHMENTS.maxFileBytes + 1 },
      ...Array.from({ length: 11 }, (_, i) => ({ fileName: `p${i}.jpg`, contentType: "image/jpeg", size: 1000 })),
    ];
    const plan = files.planEmailAttachments(named);
    expect(plan.filter((p) => p.fetch)).toHaveLength(files.EMAIL_ATTACHMENTS.maxFiles);
    expect(plan[0]).toMatchObject({ fetch: false, refused: expect.stringContaining("virus.exe") });
    expect(plan[1]).toMatchObject({ fetch: false, refused: expect.stringContaining("MB") });
    expect(plan[12]).toMatchObject({ fetch: false, refused: expect.stringContaining("first 10") });
  });

  it("refuses a file that is too big, or one that takes the email past its total, or one that is not a kept type", () => {
    const big = new Uint8Array(files.EMAIL_ATTACHMENTS.maxFileBytes + 1);
    big.set(pdf);
    expect(files.checkEmailAttachment({ fileName: "a.pdf", contentType: "application/pdf", bytes: big }, { bytesAlreadyKept: 0 }).ok).toBe(false);
    expect(files.checkEmailAttachment({ fileName: "a.pdf", contentType: "application/pdf", bytes: pdf },
      { bytesAlreadyKept: files.EMAIL_ATTACHMENTS.maxTotalBytes }).ok).toBe(false);
    /** A text file is a kept type since Word, spreadsheet, text and zip files were allowed on a reply; bytes that are none of them are not. */
    expect(files.checkEmailAttachment({ fileName: "notes.bin", contentType: "application/octet-stream", bytes: Uint8Array.from([1, 2, 3, 4]) },
      { bytesAlreadyKept: 0 }).ok).toBe(false);
    expect(files.checkEmailAttachment({ fileName: "notes.txt", contentType: "text/plain", bytes: new TextEncoder().encode("hello") },
      { bytesAlreadyKept: 0 })).toMatchObject({ ok: true, contentType: "text/plain", extension: "txt" });
    expect(files.checkEmailAttachment({ fileName: "a.pdf", contentType: "application/pdf", bytes: pdf }, { bytesAlreadyKept: 0 }))
      .toMatchObject({ ok: true, contentType: "application/pdf", extension: "pdf" });
  });
});

describe("a name somebody else chose", () => {
  it("is shown without folders, quotes or control characters", () => {
    expect(files.displayName("..\\..\\windows/\"evil\"\u0007.pdf")).toBe("evil.pdf");
    expect(files.displayName("")).toBe("attachment");
  });

  it("is downloaded with the extension of what the bytes are", () => {
    expect(files.downloadName("Warranty card.pdf", "pdf")).toBe("Warranty card.pdf");
    expect(files.downloadName("photo.exe", "jpg")).toBe("photo.jpg");
    expect(files.downloadName("ünïcødé;\r\nx.png", "png")).toBe("ncdx.png");
  });
});
