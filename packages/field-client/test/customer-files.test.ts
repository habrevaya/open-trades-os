import { describe, it, expect } from "vitest";
import {
  FieldApi, customerFileKind, customerFileLabel, customerFilesToShow, fileReadProblem, pdfFileName, projectDay,
  type FieldCustomerFile,
} from "../src/index";
import { FakeServer } from "./fake-server";

/**
 * THE FILES THE CUSTOMER SENT, ON THE PHONE'S VISIT
 *
 * What is drawn for each is decided by the type the server sniffed from the
 * bytes, never by the name the customer gave it; the day carries them with the
 * visit; and they are read with the phone's own sign in as a header, never with
 * the token in the address.
 */
const file = (over: Partial<FieldCustomerFile> = {}): FieldCustomerFile => ({
  id: "0b9a7d1e-5c2f-4d83-8a6b-3e4f5a6b7c8d", fileName: "boiler.jpg", contentType: "image/jpeg",
  storageKey: "org/ab/cd/abcdef.jpg", addedAt: "2026-10-05T14:00:00.000Z", ...over,
});

describe("what kind of file it is", () => {
  it("goes by the sniffed type, not the name", () => {
    expect(customerFileKind(file())).toBe("photo");
    expect(customerFileKind(file({ contentType: "image/heic" }))).toBe("photo");
    expect(customerFileKind(file({ contentType: "application/pdf", fileName: "plate.jpg" }))).toBe("pdf");
    expect(customerFileKind(file({ contentType: "text/html", fileName: "plate.jpg" }))).toBe("other");
    expect(customerFileKind(file({ contentType: null }))).toBe("other");
  });

  it("is called by the customer's own name, or by what it is", () => {
    expect(customerFileLabel(file())).toBe("boiler.jpg");
    expect(customerFileLabel(file({ fileName: null }))).toBe("A photo");
    expect(customerFileLabel(file({ fileName: "  ", contentType: "application/pdf" }))).toBe("A PDF");
    expect(customerFileLabel(file({ fileName: null, contentType: null }))).toBe("A file");
  });
});

describe("what the visit shows", () => {
  it("puts photographs first, then PDFs, newest first within each, and says how many are left out", () => {
    const sent = [
      file({ id: "a", contentType: "application/pdf", fileName: "plate.pdf" }),
      file({ id: "b", fileName: "one.jpg" }),
      file({ id: "c", contentType: "text/plain", fileName: "x" }),
      file({ id: "d", fileName: "two.jpg" }),
    ];
    expect(customerFilesToShow(sent).shown.map((f) => f.id)).toEqual(["b", "d", "a", "c"]);
    const some = customerFilesToShow(sent, 2);
    expect(some.shown.map((f) => f.id)).toEqual(["b", "d"]);
    expect(some.more).toBe(2);
  });

  it("is empty from a server too old to send any", () => {
    expect(customerFilesToShow(undefined)).toEqual({ shown: [], more: 0 });
  });

  it("comes through the day with the visit", () => {
    const server = new FakeServer();
    server.addVisit("v1", { customerFiles: [file()] });
    const day = projectDay({ snapshot: { revision: 1, unchanged: false, visits: [...server.visits.values()], priceBook: [], openTimeEntry: null }, operations: [] });
    expect(day.visits[0]!.customerFiles).toEqual([file()]);
  });
});

describe("reading one", () => {
  const api = (serverUrl: string, token?: string) => new FieldApi({ serverUrl, ...(token ? { token } : {}) });

  it("is the server's file address with the sign in as a header, never in the address", () => {
    const request = api("https://ops.example.com/", "otd_secret").fileRequest("org-1/ab/cd/abcdef 1.jpg");
    expect(request.url).toBe("https://ops.example.com/files/org-1/ab/cd/abcdef%201.jpg");
    expect(request.headers).toEqual({ authorization: "Bearer otd_secret" });
    expect(request.url).not.toContain("otd_secret");
  });

  it("sits under a path the server is served from", () => {
    expect(api("https://example.com/ops", "t").fileRequest("k/a.pdf").url).toBe("https://example.com/ops/files/k/a.pdf");
  });

  it("sends no header when nobody is signed in, so the server answers not found", () => {
    expect(api("https://ops.example.com").fileRequest("k/a.pdf").headers).toEqual({});
  });
});

describe("the words", () => {
  it("names a PDF safely, keeping it apart from another with the same name", () => {
    expect(pdfFileName(file({ fileName: "Model plate.pdf" }))).toBe("Model plate-0b9a7d1e.pdf");
    expect(pdfFileName(file({ fileName: "../../etc/passwd" }))).toBe("etcpasswd-0b9a7d1e.pdf");
    expect(pdfFileName(file({ fileName: null }))).toBe("file-0b9a7d1e.pdf");
  });

  it("tells the technician why a file did not open", () => {
    expect(fileReadProblem(true)).toMatch(/no signal/);
    expect(fileReadProblem(false)).toMatch(/could not be opened/);
  });
});
