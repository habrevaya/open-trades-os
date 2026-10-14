import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "../src/app/files/[...key]/route";

/**
 * GET /files/{key}, WITHOUT A SERVER
 *
 * Who may read is decided by `authenticateFileRead` and `files.open`, which are
 * tested against a database in packages/api/test/phone-customer-files.integration.test.ts.
 * What this pins is the route around them: the phone's bearer header reaches the
 * check, a refusal is a plain "not found" with nothing in it, a suspended company
 * is the same, and the bytes go out under the type that was sniffed when they were
 * stored, inline, and never guessed at.
 */
vi.mock("server-only", () => ({}));
const authenticateFileRead = vi.fn();
const open = vi.fn();
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth", () => ({ sessionFromCookie: async () => null }));
vi.mock("@opentradesos/api/http", () => ({ authenticateFileRead: (...args: unknown[]) => authenticateFileRead(...args) }));
vi.mock("@opentradesos/api/services", async () => {
  const actual = await vi.importActual<typeof import("@opentradesos/api/services")>("@opentradesos/api/services");
  return { ...actual, files: { ...actual.files, open: (...args: unknown[]) => open(...args) } };
});
const { NotFoundError, OrganizationSuspendedError } = await import("@opentradesos/api/services");

const params = (...key: string[]) => ({ params: Promise.resolve({ key }) });
const asked = (headers: Record<string, string> = {}) => new Request("https://ops.example.test/files/org/ab/cd/x.jpg", { headers });
const session = { actor: { userId: "u", organizationId: "o", roles: ["technician"] } };

describe("GET /files/{key}", () => {
  beforeEach(() => {
    authenticateFileRead.mockReset().mockResolvedValue(session);
    open.mockReset().mockResolvedValue({ bytes: Buffer.from("JPEGBYTES"), contentType: "image/jpeg", sizeBytes: 9 });
  });

  it("hands the request, header and all, to the check on who is reading", async () => {
    await GET(asked({ authorization: "Bearer otd_abc" }), params("org", "ab", "cd", "x.jpg"));
    const request = authenticateFileRead.mock.calls[0]![0] as Request;
    expect(request.headers.get("authorization")).toBe("Bearer otd_abc");
  });

  it("serves the bytes inline under the stored type, to the reader's own company", async () => {
    const response = await GET(asked(), params("org", "ab", "cd", "x.jpg"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("JPEGBYTES");
    // The key is rejoined from the catch-all, and asked for as the reader's actor.
    expect(open).toHaveBeenCalledWith({ actor: session.actor, db: {} }, "org/ab/cd/x.jpg");
  });

  it("is a bare not found for nobody, asking the database for nothing", async () => {
    authenticateFileRead.mockResolvedValue(null);
    const response = await GET(asked({ authorization: "Bearer otd_gone" }), params("org", "ab", "cd", "x.jpg"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(open).not.toHaveBeenCalled();
  });

  it("is the same not found for a suspended company, and for a file that is not theirs", async () => {
    authenticateFileRead.mockRejectedValue(new OrganizationSuspendedError());
    expect((await GET(asked(), params("k"))).status).toBe(404);
    authenticateFileRead.mockResolvedValue(session);
    open.mockRejectedValue(new NotFoundError("File"));
    expect((await GET(asked(), params("k"))).status).toBe(404);
  });
});
