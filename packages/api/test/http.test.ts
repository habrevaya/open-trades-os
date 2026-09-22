import { describe, it, expect } from "vitest";
import { matchRoute, queryToInput } from "../src/http/match";
import { routes } from "../src/contracts/index";

/**
 * The matcher decides which code runs for a URL.
 *
 * A matcher that is a little bit wrong serves a request from the wrong
 * endpoint, which is not a class of bug anybody wants to find by reading
 * logs. These are cheap and they are the only thing standing between a path
 * and the handler it reaches.
 */
describe("matching a path to a route", () => {
  it("matches a literal path", () => {
    const { match } = matchRoute("GET", "/v1/customers");
    expect(match?.name).toBe("listCustomers");
  });

  it("matches a parameter and decodes it", () => {
    const { match } = matchRoute("GET", "/v1/customers/abc-123");
    expect(match?.name).toBe("getCustomer");
    expect(match?.params["id"]).toBe("abc-123");
  });

  it("does not let a parameter swallow extra segments", () => {
    // /v1/jobs/{id} must not serve /v1/jobs/abc/visits. Asserting the match is
    // ABSENT rather than merely "not getJob": a negative assertion is
    // satisfied by any other wrong answer, and the first version of this test
    // passed against a greedy matcher for exactly that reason.
    const result = matchRoute("GET", "/v1/jobs/abc/visits");
    expect(result.match).toBeUndefined();
  });

  it("prefers a literal segment over a parameter", () => {
    // /v1/public/services is literal; nothing parameterised may take it.
    const { match } = matchRoute("GET", "/v1/public/services");
    expect(match?.name).toBe("listBookableServices");
  });

  /**
   * No two routes can claim the same request.
   *
   * The matcher prefers literal segments over parameters, which resolves a
   * collision. This makes sure there is nothing to resolve, which is the
   * stronger property: an ambiguous pair is a design mistake in the contracts
   * and it should be caught when the second one is written rather than relied
   * on to be sorted correctly afterwards.
   */
  it("has no two routes that could serve the same path", () => {
    const split = (p: string) => p.split("/").filter(Boolean);
    const isParam = (s: string) => s.startsWith("{") && s.endsWith("}");
    const all = Object.entries(routes).map(([name, route]) => {
      const r = route as { method: string; path: string };
      return { name, method: r.method, path: r.path, segments: split(r.path) };
    });

    const collisions: string[] = [];
    for (const a of all) {
      for (const b of all) {
        if (a.name === b.name) continue;
        if (a.method !== b.method) continue;
        if (a.segments.length !== b.segments.length) continue;
        // Could a concrete path matching `a` also match `b`?
        const overlaps = a.segments.every(
          (seg, i) => isParam(b.segments[i]!) || isParam(seg) || seg === b.segments[i],
        );
        if (overlaps) collisions.push(`${a.method.toUpperCase()} ${a.path} vs ${b.path}`);
      }
    }
    expect(collisions, `Ambiguous routes: ${collisions.join("; ")}`).toEqual([]);
  });

  it("separates method and path so the caller gets 405 rather than 404", () => {
    // Answering 404 sends an integrator hunting for a typo in a correct URL.
    const result = matchRoute("DELETE", "/v1/customers");
    expect(result.match).toBeUndefined();
    expect(result.pathMatched).toBe(true);
    expect(result.allowed.sort()).toEqual(["get", "post"]);
  });

  it("reports an unknown path as unmatched", () => {
    const result = matchRoute("GET", "/v1/nothing-here");
    expect(result.match).toBeUndefined();
    expect(result.pathMatched).toBe(false);
  });

  it("ignores a trailing slash", () => {
    expect(matchRoute("GET", "/v1/customers/").match?.name).toBe("listCustomers");
  });

  it("is case sensitive on the path and not on the method", () => {
    expect(matchRoute("get", "/v1/customers").match?.name).toBe("listCustomers");
    expect(matchRoute("GET", "/v1/CUSTOMERS").match).toBeUndefined();
  });

  it("matches a nested parameterised route", () => {
    const { match } = matchRoute("POST", "/v1/jobs/j-1/visits");
    expect(match?.name).toBe("scheduleVisit");
    expect(match?.params["id"]).toBe("j-1");
  });

  it("decodes a percent encoded parameter", () => {
    const { match } = matchRoute("GET", "/v1/customers/a%2Fb");
    expect(match?.params["id"]).toBe("a/b");
  });
});

describe("reading a query string", () => {
  const shape = {
    limit: "number" as const,
    includeInactive: "boolean" as const,
    tags: "array" as const,
    q: "other" as const,
  };
  const q = (s: string) => queryToInput(new URLSearchParams(s), shape);

  it("coerces the types a URL cannot carry", () => {
    expect(q("limit=25&includeInactive=true")).toEqual({ limit: 25, includeInactive: true });
  });

  it("leaves a postal code a string", () => {
    // Coercing everything numeric-looking turns 78701 into a number and an
    // 07620 into 7620.
    expect(q("q=78701")).toEqual({ q: "78701" });
  });

  it("leaves an unparseable number alone so the schema can name the problem", () => {
    // "expected number, received string" is fixable; "received nan" is not.
    expect(q("limit=lots")).toEqual({ limit: "lots" });
  });

  it("collects repeated keys into an array when the schema wants one", () => {
    expect(q("tags=a&tags=b")).toEqual({ tags: ["a", "b"] });
  });

  it("takes the last value for a repeated scalar", () => {
    expect(q("limit=1&limit=2")).toEqual({ limit: 2 });
  });

  it("omits an empty parameter so a schema default applies", () => {
    // `?cursor=` means "no cursor", not "the cursor is an empty string".
    expect(q("q=")).toEqual({});
  });

  it("only treats true and false as booleans", () => {
    expect(q("includeInactive=yes")).toEqual({ includeInactive: "yes" });
  });
});
