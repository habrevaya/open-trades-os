import { describe, it, expect } from "vitest";
import { routes, routeList } from "../src/contracts/index.js";
import { handlers, PENDING_ROUTES, routeNames } from "../src/routes/index";
import { ALL_PERMISSIONS } from "../../core/src/access/permissions.js";

/**
 * Cross package invariants. These are cheap to run and catch the class of
 * mistake that is otherwise found in production by a customer: a route
 * guarding on a permission that does not exist guards on nothing.
 */

describe("permissions", () => {
  it("every route guards on permissions that actually exist", () => {
    for (const route of routeList) {
      for (const p of route.permissions) {
        expect(
          ALL_PERMISSIONS as readonly string[],
          `${route.method.toUpperCase()} ${route.path} requires unknown permission "${p}"`,
        ).toContain(p);
      }
    }
  });

  /**
   * A write with no permissions is either a hole or a deliberate decision, and
   * the two look identical in the code. So the decision has to be written
   * down: a route reachable without a session says which of the two other
   * things it is, and anything that says nothing must be guarded.
   */
  it("every non-GET route is either permissioned or explicitly not session authorized", () => {
    for (const route of routeList) {
      if (route.method === "get" || route.internal) continue;
      const auth = route.authorization ?? "session";
      if (auth !== "session") continue;
      expect(route.permissions.length, `${route.path} is unguarded`).toBeGreaterThan(0);
    }
  });

  it("a route reachable without a session declares no permissions to hold", () => {
    for (const route of routeList) {
      const auth = route.authorization ?? "session";
      if (auth === "session") continue;
      expect(
        route.permissions,
        `${route.path} is authorized by ${auth} but expects permissions nobody without a session can hold`,
      ).toHaveLength(0);
    }
  });

  /**
   * The portal and booking surface is the only part of the product a stranger
   * can reach, so the count of routes in it is worth pinning. A route that
   * quietly joins this set should be a deliberate change, visible in a diff,
   * not something noticed later.
   */
  it("only the customer facing surface is reachable without a session", () => {
    const open = routeList
      .filter((r) => (r.authorization ?? "session") !== "session")
      .map((r) => `${r.method.toUpperCase()} ${r.path}`)
      .sort();

    expect(open).toEqual([
      "GET /v1/portal/estimate",
      "GET /v1/portal/job",
      "GET /v1/portal/session",
      "GET /v1/public/availability",
      "GET /v1/public/services",
      "POST /v1/portal/estimate/approve",
      "POST /v1/portal/estimate/decline",
      "POST /v1/public/bookings",
    ]);
  });
});

describe("money routes are idempotent", () => {
  /**
   * A retried payment that is not idempotent is a second charge. This test is
   * the reason the flag exists on the definition rather than in a convention.
   */
  const MONEY_PATHS = ["/v1/payments", "/v1/invoices"];

  it("every write route touching money requires an idempotency key", () => {
    for (const route of routeList) {
      if (route.method === "get") continue;
      if (!MONEY_PATHS.some((p) => route.path.startsWith(p))) continue;
      expect(route.idempotent, `${route.path} handles money without idempotency`).toBe(true);
    }
  });

  /**
   * Every POST, not just the money ones. A client on a truck with bad signal
   * retries, and the first version of this test was loose enough to miss a
   * route that could have created a duplicate link on a retry.
   */
  it("every POST is idempotent, because clients on bad connections retry", () => {
    for (const route of routeList) {
      if (route.method !== "post") continue;
      expect(
        route.idempotent,
        `POST ${route.path} is not idempotent, so a retry duplicates it`,
      ).toBe(true);
    }
  });
});

describe("route hygiene", () => {
  it("has no duplicate method and path pairs", () => {
    const seen = new Set<string>();
    for (const route of routeList) {
      const key = `${route.method} ${route.path}`;
      expect(seen.has(key), `duplicate route ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it("uses versioned paths", () => {
    for (const route of routeList) {
      expect(route.path.startsWith("/v1/"), `${route.path} is not versioned`).toBe(true);
    }
  });

  it("names a module so docs and permissions group the same way", () => {
    for (const route of routeList) {
      expect(route.module, `${route.path} has no module`).toMatch(/^M\d{2}$/);
    }
  });
});

describe("money is never a JSON number", () => {
  it("rejects a float and accepts a decimal string", () => {
    const line = routes.createInvoice.input.shape.lines.element.shape.unitPrice;
    expect(line.safeParse(12.34).success).toBe(false);
    expect(line.safeParse("12.34").success).toBe(true);
    expect(line.safeParse("12.34567").success).toBe(false);
    expect(line.safeParse("-5").success).toBe(true);
  });
});

describe("the contracts describe the domain correctly", () => {
  it("a job create can omit parties entirely, keeping residential simple", () => {
    const parsed = routes.createJob.input.safeParse({
      customerId: "11111111-1111-1111-1111-111111111111",
      propertyId: "22222222-2222-2222-2222-222222222222",
      summary: "No heat upstairs",
    });
    expect(parsed.success).toBe(true);
  });

  it("a job create accepts the three party commercial case", () => {
    const parsed = routes.createJob.input.safeParse({
      customerId: "11111111-1111-1111-1111-111111111111",
      propertyId: "22222222-2222-2222-2222-222222222222",
      summary: "Quarterly PM",
      parties: [
        { role: "requester", externalName: "Corrigo", externalReference: "WO-88213" },
        { role: "site_contact", contactId: "33333333-3333-3333-3333-333333333333" },
        { role: "payer", externalName: "Regional FM Co" },
      ],
      coverage: { source: "contract", coversLabour: true, coversParts: true },
    });
    expect(parsed.success).toBe(true);
  });

  it("completing a visit carries the offline timestamp", () => {
    const parsed = routes.completeVisit.input.safeParse({
      id: "44444444-4444-4444-4444-444444444444",
      completedOfflineAt: "2026-09-23T14:05:00.000Z",
      technicianNotes: "Replaced capacitor, unit running",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("every route has something behind it", () => {
  /**
   * A contract with no implementation is worse than no contract. The OpenAPI
   * document, the generated SDK and the MCP tool list are all built from
   * `routes`, so a declared route with nothing serving it is an endpoint three
   * separate consumers will offer and none of them can call.
   *
   * PENDING_ROUTES is the escape hatch and it is deliberately loud: a name in
   * it is a promise the code does not keep, so it should only ever shrink.
   */
  it("implements or explicitly defers every route", () => {
    const implemented = new Set(Object.keys(handlers));
    const deferred = new Set(PENDING_ROUTES);

    const orphans = routeNames.filter((n) => !implemented.has(n) && !deferred.has(n));

    expect(
      orphans,
      `These routes are declared and nothing serves them. Add a handler in ` +
      `src/routes/index.ts, or list them in PENDING_ROUTES with the phase ` +
      `they are waiting on: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("does not defer a route it actually implements", () => {
    const implemented = new Set<string>(Object.keys(handlers));
    const stale = PENDING_ROUTES.filter((n) => implemented.has(n));
    expect(stale, `PENDING_ROUTES still lists routes that are now built: ${stale.join(", ")}`)
      .toEqual([]);
  });

  it("does not name a route that no longer exists", () => {
    const real = new Set<string>(routeNames);
    const ghosts = PENDING_ROUTES.filter((n) => !real.has(n));
    expect(ghosts, `PENDING_ROUTES names routes that were removed: ${ghosts.join(", ")}`)
      .toEqual([]);
  });
});
