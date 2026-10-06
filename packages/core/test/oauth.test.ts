import { describe, it, expect } from "vitest";
import { oauth } from "../src/index";

/**
 * What a scope grants, which addresses may receive a code, and what a PKCE
 * verifier may be. The consent page and the token endpoint both lean on
 * these, so a mistake here is a mistake in both.
 */
describe("scopes", () => {
  it("reads a missing scope as reading only", () => {
    expect(oauth.parseScope(undefined)).toEqual(["read"]);
    expect(oauth.parseScope("  ")).toEqual(["read"]);
    expect(oauth.parseScope("jobs  jobs customer:read")).toEqual(["jobs", "customer:read"]);
  });

  it("expands bundles, cuts them to what the approver holds, and reports the cut", () => {
    const held = new Set(["job:read", "job:write"]);
    const result = oauth.resolveScopes(["jobs"], held);
    expect(result.granted).toEqual(["job:read", "job:write"]);
    expect(result.withheld).toEqual(["servicereport:read", "visit:read", "visit:write"]);
    expect(result.unknown).toEqual([]);
  });

  it("reports an unknown scope rather than dropping it", () => {
    expect(oauth.resolveScopes(["read", "teleport"], new Set()).unknown).toEqual(["teleport"]);
  });

  it("makes `read` every read permission and nothing that writes", () => {
    const read = oauth.SCOPE_BUNDLES["read"]!.permissions;
    expect(read).toContain("customer:read");
    expect(read.every((p) => p.endsWith(":read"))).toBe(true);
  });

  it("offers every bundle and every permission for discovery", () => {
    const supported = oauth.supportedScopes();
    expect(supported).toContain("jobs");
    expect(supported).toContain("invoice:void");
  });
});

describe("redirect addresses", () => {
  it("accepts https, loopback http and an application's own scheme", () => {
    expect(oauth.redirectUriProblem("https://claude.example.test/cb")).toBeNull();
    expect(oauth.redirectUriProblem("http://127.0.0.1:4000/cb")).toBeNull();
    expect(oauth.redirectUriProblem("http://localhost/cb")).toBeNull();
    expect(oauth.redirectUriProblem("com.example.app:/oauth")).toBeNull();
  });

  it("refuses plain http elsewhere, fragments and script schemes", () => {
    expect(oauth.redirectUriProblem("http://example.test/cb")).toMatch(/this machine/);
    expect(oauth.redirectUriProblem("https://example.test/cb#x")).toMatch(/fragment/);
    expect(oauth.redirectUriProblem("javascript:alert(1)")).toMatch(/cannot receive/);
    expect(oauth.redirectUriProblem("not a url")).toMatch(/not an address/);
  });

  it("matches byte for byte, except a loopback port", () => {
    const registered = ["http://127.0.0.1:3000/callback", "https://a.test/cb"];
    expect(oauth.redirectUriMatches("https://a.test/cb", registered)).toBe(true);
    expect(oauth.redirectUriMatches("https://a.test/cb/", registered)).toBe(false);
    expect(oauth.redirectUriMatches("http://127.0.0.1:59999/callback", registered)).toBe(true);
    expect(oauth.redirectUriMatches("http://127.0.0.1:59999/other", registered)).toBe(false);
    expect(oauth.redirectUriMatches("http://localhost:3000/callback", registered)).toBe(false);
  });
});

describe("PKCE", () => {
  it("knows a verifier and a challenge by their shape", () => {
    expect(oauth.isVerifier("a".repeat(43))).toBe(true);
    expect(oauth.isVerifier("a".repeat(42))).toBe(false);
    expect(oauth.isVerifier(`${"a".repeat(43)} `)).toBe(false);
    expect(oauth.isChallenge("A".repeat(43))).toBe(true);
    expect(oauth.isChallenge("A".repeat(44))).toBe(false);
  });

  it("compares strings without stopping at the first difference", () => {
    expect(oauth.sameString("abc", "abc")).toBe(true);
    expect(oauth.sameString("abc", "abd")).toBe(false);
    expect(oauth.sameString("abc", "ab")).toBe(false);
  });
});

describe("narrowing on the consent page", () => {
  const offered = ["customer:read", "customer:write", "property:read"] as const;

  it("gives what was ticked, in the order offered", () => {
    expect(oauth.narrowGrant([...offered], ["property:read", "customer:read"]))
      .toEqual({ ok: true, granted: ["customer:read", "property:read"] });
  });

  it("refuses a permission the page did not offer, by name, rather than granting it", () => {
    const result = oauth.narrowGrant([...offered], ["customer:read", "invoice:void"]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/invoice:void/);
  });

  it("refuses an empty grant, which is a refusal said the long way round", () => {
    expect(oauth.narrowGrant([...offered], []).ok).toBe(false);
  });
});
