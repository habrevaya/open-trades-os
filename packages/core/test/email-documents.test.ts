import { describe, it, expect } from "vitest";
import { files } from "../src/index";

/**
 * WHAT ELSE A REPLY MAY BRING: WORD, SPREADSHEET, TEXT AND ZIP
 *
 * Each is decided from its bytes. Nothing here is a program, a macro or a page, and none of it is
 * ever drawn in a page: `serving` says a download is all it may be.
 */

/** A zip with stored entries, built by hand: local headers, the table of contents and the end record. */
export function zipOf(entries: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const parts: number[][] = [];
  const central: number[][] = [];
  let offset = 0;
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  for (const [name, data] of Object.entries(entries)) {
    const n = [...enc.encode(name)];
    const d = [...enc.encode(data)];
    const local = [...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(d.length), ...u32(d.length), ...u16(n.length), ...u16(0), ...n, ...d];
    central.push([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(d.length), ...u32(d.length), ...u16(n.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...n]);
    parts.push(local);
    offset += local.length;
  }
  const cd = central.flat();
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(cd.length), ...u32(offset), ...u16(0)];
  return Uint8Array.from([...parts.flat(), ...cd, ...end]);
}

const text = (words: string) => new TextEncoder().encode(words);
const kind = (bytes: Uint8Array, name: string) => {
  const found = files.sniffEmailDocument(bytes, name);
  return found && found.ok ? found.kind : found;
};

describe("a Word document and a spreadsheet are zips with the right folders", () => {
  it("reads a docx and an xlsx from what is inside, whatever they were called", () => {
    const docx = zipOf({ "[Content_Types].xml": "<Types/>", "word/document.xml": "<w/>" });
    const xlsx = zipOf({ "[Content_Types].xml": "<Types/>", "xl/workbook.xml": "<w/>" });
    expect(kind(docx, "quote.docx")).toBe("docx");
    expect(kind(docx, "quote.txt")).toBe("docx");
    expect(kind(xlsx, "parts.xlsx")).toBe("xlsx");
    const verdict = files.checkFile(docx, { accept: "email", fileName: "quote.docx" });
    expect(verdict).toMatchObject({ ok: true, extension: "docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  });

  it("is a plain zip when it is neither, and a presentation is only a zip", () => {
    expect(kind(zipOf({ "photos/1.jpg": "x", "notes.txt": "y" }), "paperwork.zip")).toBe("zip");
    expect(kind(zipOf({ "[Content_Types].xml": "<Types/>", "ppt/presentation.xml": "<p/>" }), "deck.pptx")).toBe("zip");
  });

  it("refuses a macro project, which is what a .docm is whatever it was called", () => {
    const macro = zipOf({ "[Content_Types].xml": "<Types/>", "word/document.xml": "<w/>", "word/vbaProject.bin": "macros" });
    expect(kind(macro, "invoice.docx")).toMatchObject({ ok: false, reason: expect.stringContaining("macro") });
  });

  it("refuses a zip that holds a program or a script, or that cannot be read to the end", () => {
    expect(kind(zipOf({ "invoice.pdf.exe": "MZ" }), "invoice.zip")).toMatchObject({ ok: false, reason: expect.stringContaining("program") });
    expect(kind(zipOf({ "readme.txt": "hi", "run.js": "x" }), "files.zip")).toMatchObject({ ok: false });
    const cut = zipOf({ "a.txt": "hello" }).slice(0, 20);
    expect(kind(cut, "broken.zip")).toMatchObject({ ok: false, reason: expect.stringContaining("read") });
    const noEnd = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...new Array(60).fill(0)]);
    expect(kind(noEnd, "broken.zip")).toMatchObject({ ok: false });
  });
});

describe("text and CSV are told apart by name, and only if they are text", () => {
  it("keeps plain text and a CSV, and a file with accents in Windows text", () => {
    expect(kind(text("Part, Qty\nCapacitor, 2\n"), "parts.csv")).toBe("csv");
    expect(kind(text("Call me after five.\r\n"), "note.txt")).toBe("txt");
    expect(kind(Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x0a]), "cafe.csv")).toBe("csv");
  });

  it("is nothing when the name is not text, or the bytes are binary", () => {
    expect(kind(text("just words"), "words.dat")).toBeNull();
    expect(kind(Uint8Array.from([0x68, 0x69, 0x00, 0x01, 0x02]), "binary.txt")).toBeNull();
  });

  it("refuses text that looks like a web page or a script", () => {
    expect(kind(text("<!DOCTYPE html><html><script>alert(1)</script></html>"), "invoice.txt")).toMatchObject({ ok: false });
    expect(kind(text("hello\n<svg onload=alert(1)>"), "invoice.csv")).toMatchObject({ ok: false });
    expect(kind(text('<?xml version="1.0"?><x/>'), "data.txt")).toMatchObject({ ok: false });
  });
});

describe("a reply's file is checked as a whole", () => {
  it("keeps the new kinds only when asked for an email's, never from an ordinary upload", () => {
    const docx = zipOf({ "[Content_Types].xml": "<Types/>", "word/document.xml": "<w/>" });
    expect(files.checkFile(docx).ok).toBe(false);
    expect(files.checkFile(docx, { accept: "email", fileName: "q.docx" }).ok).toBe(true);
    expect(files.checkFile(text("hello"), { fileName: "n.txt" }).ok).toBe(false);
  });

  it("still keeps pictures and PDFs, and says what is kept in words when it is none of them", () => {
    const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    expect(files.checkFile(pdf, { accept: "email", fileName: "a.pdf" })).toMatchObject({ ok: true, extension: "pdf" });
    const refused = files.checkFile(Uint8Array.from([1, 2, 3, 4, 5]), { accept: "email", fileName: "a.bin" });
    expect(refused).toMatchObject({ ok: false, reason: expect.stringContaining(".docx") });
  });

  it("holds the four kinds to a smaller limit than a picture", () => {
    const big = new Uint8Array(files.EMAIL_ATTACHMENTS.maxDocumentBytes + 1).fill(0x61);
    expect(files.checkFile(big, { accept: "email", fileName: "list.txt", maxBytes: files.EMAIL_ATTACHMENTS.maxFileBytes }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("5 MB") });
    const named = files.planEmailAttachments([
      { fileName: "list.xlsx", contentType: "application/octet-stream", size: files.EMAIL_ATTACHMENTS.maxDocumentBytes + 1 },
      { fileName: "photo.png", contentType: "image/png", size: files.EMAIL_ATTACHMENTS.maxDocumentBytes + 1 },
    ]);
    expect(named[0]).toMatchObject({ fetch: false });
    expect(named[1]).toEqual({ fetch: true });
  });

  it("names an older Word or Excel file and does not download it", () => {
    for (const fileName of ["quote.doc", "parts.XLS", "deck.ppt", "letter.rtf"]) {
      const [step] = files.planEmailAttachments([{ fileName, contentType: "application/msword", size: 1000 }]);
      expect(step).toMatchObject({ fetch: false, refused: expect.stringContaining("macros") });
    }
    expect(files.planEmailAttachments([{ fileName: "quote.docm", contentType: "application/vnd.ms-word", size: 10 }])[0])
      .toMatchObject({ fetch: false, refused: expect.stringContaining("program") });
  });
});

describe("how a stored file is sent back", () => {
  it("draws a picture and a PDF, and sends everything else only as a download that runs nothing", () => {
    expect(files.serving("image/png")).toEqual({ contentType: "image/png", inline: true });
    expect(files.serving("application/pdf")).toEqual({ contentType: "application/pdf", inline: true });
    for (const type of [
      "application/zip", "text/plain", "text/csv", "image/svg+xml", "text/html",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]) {
      expect(files.serving(type)).toEqual({ contentType: "application/octet-stream", inline: false });
    }
  });
});
