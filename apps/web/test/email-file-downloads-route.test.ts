import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET as readByKey } from "../src/app/files/[...key]/route";
import { GET as readFromThread } from "../src/app/(app)/inbox/[id]/media/[...key]/route";

/**
 * A WORD DOCUMENT, A SPREADSHEET, A TEXT FILE OR A ZIP IS ONLY EVER A DOWNLOAD (M18)
 *
 * A reply by email can bring these. Pictures and PDFs are drawn in a page; the four kinds are never,
 * on either route that serves a stored file, whatever the request says and whatever type they are
 * stored as: sent as `application/octet-stream`, as an attachment, with nothing to sniff.
 */
vi.mock("server-only", () => ({}));
const authenticateFileRead = vi.fn();
const open = vi.fn();
const picture = vi.fn();
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth", () => ({
  sessionFromCookie: async () => null,
  getCurrentUser: async () => ({ actor: { userId: "u", organizationId: "o", roles: ["owner"] } }),
}));
vi.mock("@opentradesos/api/http", () => ({ authenticateFileRead: (...args: unknown[]) => authenticateFileRead(...args) }));
vi.mock("@opentradesos/api/services", async () => {
  const actual = await vi.importActual<typeof import("@opentradesos/api/services")>("@opentradesos/api/services");
  return {
    ...actual,
    files: { ...actual.files, open: (...args: unknown[]) => open(...args) },
    comms: { ...actual.comms, picture: (...args: unknown[]) => picture(...args) },
  };
});

const KINDS = [
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["text/plain", "txt"],
  ["text/csv", "csv"],
  ["application/zip", "zip"],
] as const;

const session = { actor: { userId: "u", organizationId: "o", roles: ["owner"] } };

describe("a stored file read by its key", () => {
  beforeEach(() => {
    authenticateFileRead.mockReset().mockResolvedValue(session);
    open.mockReset();
  });

  it.each(KINDS)("sends %s only as a download that runs nothing", async (contentType, extension) => {
    open.mockResolvedValue({ bytes: Buffer.from("CONTENT"), contentType, sizeBytes: 7 });
    const response = await readByKey(
      new Request(`https://ops.example.test/files/o/ab/cd/x.${extension}`),
      { params: Promise.resolve({ key: ["o", "ab", "cd", `x.${extension}`] }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("still draws a picture and a PDF inline", async () => {
    for (const contentType of ["image/png", "application/pdf"]) {
      open.mockResolvedValue({ bytes: Buffer.from("X"), contentType, sizeBytes: 1 });
      const response = await readByKey(new Request("https://ops.example.test/files/o/a"), { params: Promise.resolve({ key: ["o", "a"] }) });
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(response.headers.get("content-disposition")).toBe("inline");
    }
  });
});

describe("a file from an email thread", () => {
  beforeEach(() => picture.mockReset());

  const ask = (query: string) => readFromThread(
    new Request(`https://ops.example.test/inbox/c1/media/o/ab/cd/x.docx${query}`),
    { params: Promise.resolve({ id: "c1", key: ["o", "ab", "cd", "x.docx"] }) },
  );

  it.each(KINDS)("sends %s as a download even when the request did not ask for one", async (contentType, extension) => {
    picture.mockResolvedValue({ bytes: Buffer.from("CONTENT"), contentType, sizeBytes: 7, name: "Quote.docx" });
    const response = await readFromThread(
      new Request(`https://ops.example.test/inbox/c1/media/o/ab/cd/x.${extension}`),
      { params: Promise.resolve({ id: "c1", key: ["o", "ab", "cd", `x.${extension}`] }) },
    );
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="Quote.${extension}"`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("shows a picture, saves a PDF only when asked, and answers a read it cannot make with a bare not found", async () => {
    picture.mockResolvedValue({ bytes: Buffer.from("PNG"), contentType: "image/png", sizeBytes: 3, name: "boiler.png" });
    const shown = await ask("");
    expect(shown.headers.get("content-type")).toBe("image/png");
    expect(shown.headers.get("content-disposition")).toBeNull();
    picture.mockResolvedValue({ bytes: Buffer.from("PDF"), contentType: "application/pdf", sizeBytes: 3, name: "Warranty.pdf" });
    expect((await ask("")).headers.get("content-disposition")).toBeNull();
    expect((await ask("?download=1")).headers.get("content-disposition")).toBe('attachment; filename="Warranty.docx"');
    /** Anything the read cannot answer is the same bare not found, with nothing about why. */
    picture.mockResolvedValue({ bytes: Buffer.from("X"), contentType: undefined, sizeBytes: 1, name: "x" });
    const refused = await ask("");
    expect(refused.status).toBe(404);
    expect(await refused.text()).toBe("Not found");
  });
});
