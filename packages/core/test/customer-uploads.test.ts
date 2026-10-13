import { describe, it, expect } from "vitest";
import { files } from "../src/index";

/**
 * WHAT A SIGNED IN CUSTOMER MAY ADD TO A JOB (M05)
 *
 * The rules a reply by email is held to, narrowed to a photograph or a PDF:
 * never a program, by name, claimed type or bytes, and limits on one file, on
 * the count and on the total for one job.
 */
const pdf = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const exe = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03]);
const gif = new TextEncoder().encode("GIF89a....");
const fresh = { filesAlreadyAdded: 0, bytesAlreadyAdded: 0 };

describe("what a customer may add", () => {
  it("takes a photograph or a PDF, typed from the bytes", () => {
    expect(files.checkCustomerUpload({ fileName: "boiler.jpg", contentType: "image/jpeg", bytes: jpeg }, fresh))
      .toMatchObject({ ok: true, contentType: "image/jpeg" });
    expect(files.checkCustomerUpload({ fileName: "warranty.pdf", contentType: "application/pdf", bytes: pdf }, fresh))
      .toMatchObject({ ok: true, contentType: "application/pdf" });
  });

  it("refuses a program renamed as a photograph, by its bytes", () => {
    const verdict = files.checkCustomerUpload({ fileName: "boiler.jpg", contentType: "image/jpeg", bytes: exe }, fresh);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("program");
  });

  it("refuses a program by its name or claimed type, even when the bytes would pass", () => {
    for (const fileName of ["photo.jpg.exe", "unit.svg", "page.html"]) {
      expect(files.checkCustomerUpload({ fileName, contentType: "image/jpeg", bytes: jpeg }, fresh).ok, fileName).toBe(false);
    }
    expect(files.checkCustomerUpload({ fileName: "photo.jpg", contentType: "image/svg+xml", bytes: jpeg }, fresh).ok).toBe(false);
  });

  it("refuses a type kept elsewhere that is not a photograph or a PDF", () => {
    const verdict = files.checkCustomerUpload({ fileName: "funny.gif", contentType: "image/gif", bytes: gif }, fresh);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("PDF");
    expect(files.checkCustomerUpload({ fileName: "notes.txt", contentType: "text/plain", bytes: new TextEncoder().encode("hi") }, fresh).ok)
      .toBe(false);
  });

  it("holds one file, the count on one job and the total on one job to their limits", () => {
    const big = new Uint8Array(files.CUSTOMER_UPLOADS.maxFileBytes + 1);
    big.set(pdf);
    const tooBig = files.checkCustomerUpload({ fileName: "scan.pdf", contentType: "application/pdf", bytes: big }, fresh);
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.reason).toContain("MB");

    const full = files.checkCustomerUpload({ fileName: "one-more.pdf", bytes: pdf },
      { filesAlreadyAdded: files.CUSTOMER_UPLOADS.maxFilesPerJob, bytesAlreadyAdded: 0 });
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.reason).toContain(`${files.CUSTOMER_UPLOADS.maxFilesPerJob} files`);

    expect(files.checkCustomerUpload({ fileName: "last.pdf", bytes: pdf },
      { filesAlreadyAdded: 1, bytesAlreadyAdded: files.CUSTOMER_UPLOADS.maxTotalBytesPerJob }).ok).toBe(false);
  });
});
