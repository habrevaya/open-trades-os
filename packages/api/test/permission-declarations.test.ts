import { describe, it, expect } from "vitest";
import { routes } from "../src/contracts";
import { handlers } from "../src/routes/index";
import { PERMISSIONS, type Permission } from "@opentradesos/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { testDb } from "./helpers";

/**
 * THE DECLARED PERMISSION IS THE ENFORCED ONE
 *
 * `route.permissions` in a contract is NOT the enforcement. The service is: it
 * calls `guardedRead` or `guardedWrite` with a permission of its own, and that is
 * what refuses. The declaration is read by two things that matter and neither of
 * them checks it against the service:
 *
 *   OpenAPI, which publishes "Requires a session holding: ..." for every route.
 *   The MCP server, which FILTERS ITS TOOL LIST by it.
 *
 * So a drift is two failures at once. A role built from the published docs is
 * refused by the service, which looks like a bug in the product. And an agent
 * holding the permission the service really wants is never offered the tool,
 * while one holding the declared permission is offered a tool it cannot use.
 *
 * Five routes were in that state. `permissions-enforced.test.ts` had already
 * found the vendor half of it from the other direction, when `vendor:read` and
 * `vendor:write` turned out to be declared on role presets and guarded by
 * nothing, fixed the services, and nobody came back to the contracts.
 *
 * HOW THIS CHECKS IT, WHICH IS A PROBE RATHER THAN A PARSE.
 *
 * Call the handler with an actor holding NOTHING. `assertCan` throws a
 * `PermissionError` carrying the permission it wanted, before the callback runs
 * and therefore before anything touches a row. Whatever permission comes back is
 * what the service really demands, and it has to be one the route declares.
 *
 * A static parse was the alternative and it is worse: a handler is a thin arrow
 * calling an internal function, so it would mean following an identifier through
 * a module with a regex and guessing when the trail went cold. The probe asks the
 * code.
 *
 * WHAT THE PROBE CANNOT SEE, stated because a guard that hides its blind spots is
 * worse than none. It sees the FIRST permission demanded, so a handler guarded
 * twice is checked on the first one only. It sends an empty input, so a handler
 * that reads a field before the guard throws something else and is not resolved.
 * Both of those are counted and the count is asserted, so coverage collapsing is
 * a failure rather than a quiet pass.
 */

const SERVICES = join(__dirname, "../src/services");

/**
 * Routes whose permission depends on the input, with the one the probe cannot
 * reach and why the declaration is still the honest one.
 *
 * An entry here is a decision. It is not an excuse for a drift: the declared
 * permission still has to be what the route always needs, and this names the
 * extra one a particular transition asks for on top.
 */
const ESCALATES: Record<string, { also: Permission; when: string; service: string }> = {
  setPurchaseOrderStatus: {
    also: "po:approve",
    when:
      "Submitting an order for approval demands it; every other transition takes "
      + "`po:write`. Declaring both would tell a reader and an agent that moving an "
      + "order back to draft needs approval authority, which it does not.",
    service: "inventory.ts",
  },
  assignVisit: {
    also: "visit:assign_unqualified",
    when:
      "Only when the caller overrides a qualification refusal with a reason. An ordinary "
      + "assignment of somebody qualified takes `visit:dispatch` alone, and declaring both "
      + "would tell an agent it cannot put a qualified technician on a visit without the "
      + "authority to send an unqualified one.",
    service: "qualification.ts",
  },
};

interface Probe {
  name: string;
  declared: string[];
  demanded: string | null;
  unresolved: string | null;
}

async function probe(): Promise<Probe[]> {
  const db = testDb(process.env["DATABASE_URL"]!);
  const out: Probe[] = [];

  for (const [name, route] of Object.entries(routes)) {
    const declared = [...route.permissions] as string[];
    /**
     * Only session routes with something declared. A grant or public route has a
     * different handler shape and no permission to compare against, and a session
     * route declaring none is `define.ts`'s business rather than this file's.
     */
    if ((route.authorization ?? "session") !== "session") continue;
    if (declared.length === 0) continue;

    const handler = (handlers as Record<string, unknown>)[name];
    if (typeof handler !== "function") {
      out.push({ name, declared, demanded: null, unresolved: "no handler" });
      continue;
    }

    /**
     * An actor with no roles, no grants and ids that match nothing. The guard
     * refuses before the callback opens a transaction, so nothing is read and
     * nothing is written even for a handler that would otherwise do both.
     */
    const ctx = {
      actor: {
        userId: "00000000-0000-0000-0000-000000000001",
        organizationId: "00000000-0000-0000-0000-000000000002",
        roles: [],
        grants: [],
      },
      db,
    };

    try {
      await (handler as (c: unknown, i: unknown, m: unknown) => Promise<unknown>)(
        ctx, {}, { ip: null, userAgent: null },
      );
      out.push({ name, declared, demanded: null, unresolved: "ran without demanding anything" });
    } catch (error) {
      const e = error as { name?: string; permission?: string };
      if (e.name !== "PermissionError") {
        out.push({ name, declared, demanded: null, unresolved: e.name ?? "unknown error" });
        continue;
      }
      /**
       * `assertCan` with an undefined permission fails closed and reports
       * `undefined`, which is what an empty input produces for a handler that
       * looks a permission up by a field of its own input. Not a drift, not
       * resolved either.
       */
      if (typeof e.permission !== "string") {
        out.push({ name, declared, demanded: null, unresolved: "permission chosen from the input" });
        continue;
      }
      out.push({ name, declared, demanded: e.permission, unresolved: null });
    }
  }
  return out;
}

describe("every route demands a permission it declares", () => {
  it("demands nothing a route does not declare", async () => {
    const results = await probe();
    const drifted = results
      .filter((r) => r.demanded !== null && !r.declared.includes(r.demanded))
      .map((r) => `${r.name}: enforces ${r.demanded}, declares ${r.declared.join(", ")}`);
    expect(drifted, "routes whose published permission is not the one that refuses").toEqual([]);
  }, 120_000);

  it("has no route that declares a permission and demands nothing", async () => {
    /**
     * NOT A BLIND SPOT, A DEFECT, which is why it is its own assertion rather
     * than part of the unresolved count.
     *
     * A handler that runs to completion for an actor holding nothing, on a route
     * that declares a permission, is a restriction an owner believes they applied
     * and did not. `listLeadFieldTargets` was exactly that: it returned a
     * constant, took no context and checked nothing, while the route said
     * `integration:read`. Nothing tenant scoped leaked, and the published
     * promise was still false.
     *
     * An input-shaped refusal is a different thing and is counted as unresolved
     * above: this only catches a handler that answered.
     */
    const results = await probe();
    const open = results
      .filter((r) => r.unresolved === "ran without demanding anything")
      .map((r) => `${r.name}: declares ${r.declared.join(", ")} and asserts nothing`);
    expect(open, "routes declaring a permission that nothing enforces").toEqual([]);
  }, 120_000);

  it("resolved almost all of them, so a blind spot is not a pass", async () => {
    /**
     * The number that makes the test above mean something. It was 384 resolved
     * against 10 unresolved when this was written, and a change that drops
     * resolution to a handful would otherwise make the drift check vacuous while
     * still passing.
     */
    const results = await probe();
    const resolved = results.filter((r) => r.demanded !== null);
    expect(resolved.length).toBeGreaterThan(350);
    expect(results.length - resolved.length).toBeLessThan(25);
  }, 120_000);

  it("names the permissions a transition escalates to, and they are real", () => {
    for (const [name, entry] of Object.entries(ESCALATES)) {
      expect(routes, `${name} is a route`).toHaveProperty(name);
      expect(Object.keys(PERMISSIONS), `${entry.also} exists`).toContain(entry.also);
      /** And the service really asks for it, so the note cannot outlive the code. */
      const source = readFileSync(join(SERVICES, entry.service), "utf8");
      expect(source, `${entry.service} asks for ${entry.also}`).toContain(`"${entry.also}"`);
      expect(entry.when.length, `${name} says when`).toBeGreaterThan(40);
    }
  });

  it("is not excusing a route that the probe already resolves cleanly", async () => {
    /**
     * One directional, and the direction matters. A route in `ESCALATES` whose
     * declared list already contains the escalated permission does not need an
     * entry, and leaving one there is a note about nothing that the next reader
     * will believe.
     */
    for (const [name, entry] of Object.entries(ESCALATES)) {
      const route = routes[name as keyof typeof routes];
      expect([...route.permissions], `${name} declares ${entry.also} and needs no entry`)
        .not.toContain(entry.also);
    }
  });
});
