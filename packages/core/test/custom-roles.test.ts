import { describe, it, expect } from "vitest";
import {
  effectiveScope, canDefineRole, resolveMembership, permissionsFor, type Actor,
} from "../src/access/index";
import { narrowest, widest } from "../src/access/scopes";

const actor = (over: Partial<Actor> = {}): Actor => ({
  userId: "u", organizationId: "o", roles: ["owner"], ...over,
});

/**
 * A scope override takes access away from one person. It was a column with a
 * comment claiming it "narrows WHICH records", written by nothing and read by
 * nothing, so an administrator who set one believed they had restricted
 * somebody and had not.
 */
describe("scope overrides narrow, and only narrow", () => {
  it("narrows a dispatcher to their own jobs", () => {
    const a = actor({ roles: ["dispatcher"], scopeOverrides: { job: "own" } });
    expect(effectiveScope(a, "job")).toBe("own");
  });

  it("cannot widen a technician past their role", () => {
    // Otherwise the override is a way to grant yourself scope the role never
    // had, which is the opposite of what it is for.
    const a = actor({ roles: ["technician"], scopeOverrides: { job: "all" } });
    expect(effectiveScope(a, "job")).toBe("own");
  });

  it("applies per resource, leaving the others alone", () => {
    const a = actor({ roles: ["dispatcher"], scopeOverrides: { customer: "own" } });
    expect(effectiveScope(a, "customer")).toBe("own");
    expect(effectiveScope(a, "job")).toBe("all");
  });

  it("is a ceiling over the combined roles, not one of the inputs", () => {
    // Applied inside the combination, a second role would widen back past it,
    // and an administrator who restricted somebody would find that adding a
    // dispatcher role quietly undid it.
    const a = actor({ roles: ["technician", "dispatcher"], scopeOverrides: { job: "own" } });
    expect(effectiveScope(a, "job")).toBe("own");
  });

  it("changes nothing when absent", () => {
    expect(effectiveScope(actor({ roles: ["technician"] }), "job")).toBe("own");
    expect(effectiveScope(actor({ roles: ["dispatcher"] }), "job")).toBe("all");
  });
});

describe("the scope ladder", () => {
  it("orders from own to all", () => {
    expect(widest("own", "all")).toBe("all");
    expect(narrowest("own", "all")).toBe("own");
    expect(narrowest("crew", "business_unit")).toBe("crew");
  });
});

/**
 * `role:write` is the most dangerous permission in the system once roles are
 * data, because a role is a container for permissions and anyone who can
 * write one can write `owner` into it.
 */
describe("you cannot grant what you do not hold", () => {
  it("lets an owner define anything they hold", () => {
    const result = canDefineRole(actor(), { permissions: ["job:read", "invoice:write"] });
    expect(result).toEqual({ ok: true });
  });

  it("refuses a permission the author does not hold", () => {
    // A dispatcher minting a role with ledger access and assigning it to
    // themselves is the whole attack.
    const a = actor({ roles: ["dispatcher"] });
    const held = permissionsFor(a);
    const forbidden = (["ledger:read", "settings:write", "role:write"] as const)
      .find((p) => !held.has(p))!;

    const result = canDefineRole(a, { permissions: ["job:read", forbidden] });
    expect(result).toMatchObject({ ok: false, reason: "missing_permission" });
    expect(result.ok === false && result.reason === "missing_permission" && result.permissions)
      .toContain(forbidden);
  });

  it("names every missing permission, not just the first", () => {
    const a = actor({ roles: ["technician"] });
    const held = permissionsFor(a);
    const missing = (["settings:write", "ledger:read"] as const).filter((p) => !held.has(p));
    const result = canDefineRole(a, { permissions: missing });
    expect(result.ok === false && result.reason === "missing_permission" && result.permissions.length)
      .toBe(missing.length);
  });

  it("refuses a scope wider than the author's own", () => {
    // A technician is scoped to their own jobs. Minting a role with `all`
    // and taking it would read the company.
    const result = canDefineRole(actor({ roles: ["technician"] }), {
      permissions: ["job:read"],
      scopes: { job: "all" },
    });
    expect(result).toMatchObject({ ok: false, reason: "widens_scope" });
    expect(result.ok === false && result.reason === "widens_scope" && result.resources)
      .toContain("job");
  });

  it("allows a scope narrower than the author's own", () => {
    // The normal case: an owner defining a restricted role.
    expect(canDefineRole(actor(), { permissions: ["job:read"], scopes: { job: "own" } }))
      .toEqual({ ok: true });
  });

  it("allows a scope equal to the author's own", () => {
    expect(canDefineRole(actor({ roles: ["technician"] }), {
      permissions: ["job:read"], scopes: { job: "own" },
    })).toEqual({ ok: true });
  });

  it("checks permissions before scopes, so the first answer is the useful one", () => {
    const a = actor({ roles: ["technician"] });
    const held = permissionsFor(a);
    const forbidden = (["settings:write"] as const).find((p) => !held.has(p))!;
    const result = canDefineRole(a, { permissions: [forbidden], scopes: { job: "all" } });
    expect(result.ok === false && result.reason).toBe("missing_permission");
  });

  it("accepts an empty role", () => {
    expect(canDefineRole(actor({ roles: ["readonly"] }), { permissions: [] })).toEqual({ ok: true });
  });
});

describe("what a membership resolves to", () => {
  it("uses the preset when there is no custom role", () => {
    const resolved = resolveMembership({ role: "technician" });
    expect(resolved.permissions).toContain("field:sync");
    expect(resolved.scopes.job).toBe("own");
  });

  it("lets a custom role replace the preset rather than add to it", () => {
    // A company that defined its own role means that role, not a preset with
    // unexplained extras.
    const resolved = resolveMembership({
      role: "technician",
      customRole: { permissions: ["job:read"], scopes: { job: "crew" } },
    });
    expect(resolved.permissions).toEqual(["job:read"]);
    expect(resolved.permissions).not.toContain("field:sync");
    expect(resolved.scopes.job).toBe("crew");
  });

  it("still applies per membership grants and revocations on top", () => {
    // An individual exception should not require a whole new role.
    const resolved = resolveMembership({
      role: "technician",
      customRole: { permissions: ["job:read"] },
      grants: ["invoice:read"],
      revocations: ["job:read"],
    });
    expect(resolved.permissions).toContain("invoice:read");
    expect(resolved.permissions).not.toContain("job:read");
  });

  it("lets revocation beat a grant, so taking access away is never ambiguous", () => {
    const resolved = resolveMembership({
      role: "owner", grants: ["job:read"], revocations: ["job:read"],
    });
    expect(resolved.permissions).not.toContain("job:read");
  });

  it("falls back to no scopes for a role with none", () => {
    expect(resolveMembership({ role: "owner" }).scopes).toEqual({});
  });
});
