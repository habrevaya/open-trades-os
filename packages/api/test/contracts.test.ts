import { describe, it, expect } from "vitest";
import { routes, routeList } from "../src/contracts/index.js";
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

  it("every non-GET route declares at least one permission", () => {
    for (const route of routeList) {
      if (route.method === "get" || route.internal) continue;
      expect(route.permissions.length, `${route.path} is unguarded`).toBeGreaterThan(0);
    }
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
