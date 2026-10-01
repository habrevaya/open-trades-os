import { describe, it, expect, vi } from "vitest";
import type { Database } from "@opentradesos/db";
import { dispatch, type DispatchDeps } from "../src/http/dispatch";
import { configuredToken, presentsToken, MIN_TOKEN_LENGTH } from "../src/http/bearer";

/**
 * WHO MAY REACH THE OPERATOR API
 *
 * No database here, on purpose: every refusal below has to happen before one
 * is touched. The database is a proxy that fails the test if anything reads
 * it, so a refusal that quietly ran a query first would be caught rather than
 * passing on whatever the query happened to return.
 */
const untouchable = new Proxy({}, {
  get: () => { throw new Error("the database was touched before the caller was authenticated"); },
}) as unknown as Database;

const TOKEN = "t".repeat(MIN_TOKEN_LENGTH + 8);

const deps = (operator: DispatchDeps["operator"]): DispatchDeps => ({
  db: untouchable,
  basePath: "/api",
  resolveSession: async () => {
    throw new Error("the operator API read a session");
  },
  ...(operator === undefined ? {} : { operator }),
});

const request = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(`https://ots.example.test/api${path}`, { method, headers });

describe("the operator API is off unless a long enough token is set", () => {
  it("answers 404 to everything when nothing is configured", async () => {
    for (const path of [
      "/v1/operator/organizations",
      "/v1/operator/organizations/00000000-0000-4000-8000-000000000001",
      "/v1/operator",
    ]) {
      const res = await dispatch(request(path, { authorization: `Bearer ${TOKEN}` }), deps(undefined));
      expect(res.status).toBe(404);
    }
  });

  it("answers the same 404 an unknown route gets, so it does not reveal itself", async () => {
    const off = await dispatch(request("/v1/operator/organizations"), deps({ token: null }));
    const unknown = await dispatch(request("/v1/nothing-here"), deps({ token: null }));
    expect(off.status).toBe(unknown.status);
    expect(Object.keys(await off.json() as object).sort()).toEqual(Object.keys(await unknown.json() as object).sort());
  });

  it("treats a short token as no token, and says so in the log", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(configuredToken("SHORT_TOKEN_FOR_TEST", { SHORT_TOKEN_FOR_TEST: "changeme" })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    // Once per process, not once per request.
    configuredToken("SHORT_TOKEN_FOR_TEST", { SHORT_TOKEN_FOR_TEST: "changeme" });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();

    expect(configuredToken("X", { X: "" })).toBeNull();
    expect(configuredToken("X", {})).toBeNull();
    expect(configuredToken("X", { X: `${TOKEN}\n` })).toBe(TOKEN);
  });
});

describe("the operator token", () => {
  const on = deps({ token: TOKEN, publicUrl: "https://ots.example.test" });

  it("is required", async () => {
    const res = await dispatch(request("/v1/operator/organizations/x"), on);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("must be exactly right", async () => {
    for (const wrong of [TOKEN.slice(1), `${TOKEN}x`, TOKEN.toUpperCase(), "ots_" + TOKEN]) {
      const res = await dispatch(request("/v1/operator/organizations/x", {
        authorization: `Bearer ${wrong}`,
      }), on);
      expect(res.status).toBe(401);
    }
  });

  it("is never taken from a cookie", async () => {
    const res = await dispatch(request("/v1/operator/organizations/x", {
      cookie: `ots_session=${TOKEN}; operator=${TOKEN}`,
    }), on);
    expect(res.status).toBe(401);
  });

  it("is checked before anything says which paths exist", async () => {
    const real = await dispatch(request("/v1/operator/organizations", {}, "POST"), on);
    const fake = await dispatch(request("/v1/operator/does-not-exist", {}, "DELETE"), on);
    expect(real.status).toBe(401);
    expect(fake.status).toBe(401);
  });

  it("admits the right one far enough to be routed", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    // Wrong method and an id that is not one are both answered without the
    // database, which the proxy above would otherwise report.
    expect((await dispatch(request("/v1/operator/organizations", auth, "GET"), on)).status).toBe(405);
    expect((await dispatch(request("/v1/operator/organizations/not-a-uuid", auth), on)).status).toBe(404);
    expect((await dispatch(request("/v1/operator/elsewhere", auth), on)).status).toBe(404);
  });

  it("compares without throwing on a different length", () => {
    const req = (value: string) => new Request("https://x.test", { headers: { authorization: value } });
    expect(presentsToken(req(`Bearer ${TOKEN}`), TOKEN)).toBe(true);
    expect(presentsToken(req("Bearer a"), TOKEN)).toBe(false);
    expect(presentsToken(req(`Basic ${TOKEN}`), TOKEN)).toBe(false);
    expect(presentsToken(new Request("https://x.test"), TOKEN)).toBe(false);
  });
});
