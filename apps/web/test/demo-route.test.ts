import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// Imported statically, at collection, rather than inside a test: the first
// import compiles the services, and timing that against a five second test
// timeout is how a suite gets a test that fails only when the machine is busy.
import { GET } from "../src/app/demo/route";

/**
 * GET /demo, WITHOUT A SERVER
 *
 * The decisions (is this company the demo, is this address over its limit)
 * are SQL's and are tested against a database in
 * packages/api/test/demo.integration.test.ts. What this pins is the route
 * around them: off means a 404, a session is a two hour cookie and a
 * redirect into the app, and a refusal is never a session.
 */
vi.mock("server-only", () => ({}));
const createDemoSession = vi.fn();
const getCurrentUser = vi.fn();
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "198.51.100.7, 10.0.0.1" }),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: () => getCurrentUser() }));
vi.mock("@opentradesos/api/services/demo", async () => {
  const actual = await vi.importActual<typeof import("@opentradesos/api/services/demo")>("@opentradesos/api/services/demo");
  return { ...actual, createDemoSession: (...args: unknown[]) => createDemoSession(...args) };
});

const ORG = "6f0c6d0e-2a4b-4c1d-9e3f-1a2b3c4d5e6f";

describe("GET /demo", () => {
  beforeEach(() => {
    createDemoSession.mockReset();
    getCurrentUser.mockReset().mockResolvedValue(null);
  });
  afterEach(() => { delete process.env["DEMO_ORGANIZATION_ID"]; });

  it("is a 404 when DEMO_ORGANIZATION_ID is not set, and asks the database nothing", async () => {
    expect((await GET()).status).toBe(404);
    process.env["DEMO_ORGANIZATION_ID"] = "not-a-uuid";
    expect((await GET()).status).toBe(404);
    expect(createDemoSession).not.toHaveBeenCalled();
  });

  it("is a 404 when the company is not set up as the demo", async () => {
    process.env["DEMO_ORGANIZATION_ID"] = ORG;
    createDemoSession.mockResolvedValue("not_demo");
    const response = await GET();
    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("signs the visitor in for two hours and takes them to the dispatch board", async () => {
    process.env["DEMO_ORGANIZATION_ID"] = ORG;
    createDemoSession.mockResolvedValue("created");
    const response = await GET();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/schedule");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^ots_session=[A-Za-z0-9_-]{40,};/);
    expect(cookie).toMatch(/Max-Age=7200/);
    expect(cookie).toMatch(/HttpOnly/i);
    // The address the limit counts is the client's, not the proxy's.
    expect(createDemoSession.mock.calls[0]![1]).toMatchObject({ organizationId: ORG, ip: "198.51.100.7" });
  });

  it("is a 429 with no session once the address is over its limit", async () => {
    process.env["DEMO_ORGANIZATION_ID"] = ORG;
    createDemoSession.mockResolvedValue("limited");
    const response = await GET();
    expect(response.status).toBe(429);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("keeps a visitor's live demo session rather than spending another", async () => {
    process.env["DEMO_ORGANIZATION_ID"] = ORG;
    getCurrentUser.mockResolvedValue({ demo: true, organizationId: ORG });
    const response = await GET();
    expect(response.status).toBe(303);
    expect(createDemoSession).not.toHaveBeenCalled();
  });
});
