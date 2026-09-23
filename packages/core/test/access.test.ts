import { describe, it, expect } from "vitest";
import {
  can, canAll, permissionsFor, redact, effectiveScope, assertCan,
  PermissionError, ROLE_PRESETS, ALL_PERMISSIONS, SENSITIVE_PERMISSIONS,
  type Actor,
} from "../src/access/index.js";

const actor = (roles: Actor["roles"], extra: Partial<Actor> = {}): Actor => ({
  userId: "u1", organizationId: "o1", roles, ...extra,
});

describe("role presets", () => {
  it("every preset references only real permissions", () => {
    for (const [id, preset] of Object.entries(ROLE_PRESETS)) {
      for (const p of preset.permissions) {
        expect(ALL_PERMISSIONS, `${id} references unknown permission ${p}`).toContain(p);
      }
    }
  });

  it("owner has everything", () => {
    expect(permissionsFor(actor(["owner"])).size).toBe(ALL_PERMISSIONS.length);
  });
});

describe("technicians never see money they should not", () => {
  const tech = actor(["technician"], { technicianId: "t1" });

  it("reads the price book but not cost or margin", () => {
    expect(can(tech, "pricebook:read")).toBe(true);
    expect(can(tech, "pricebook.cost:read")).toBe(false);
    expect(can(tech, "job.cost:read")).toBe(false);
  });

  it("holds no sensitive permission at all", () => {
    for (const p of SENSITIVE_PERMISSIONS) {
      expect(can(tech, p), `technician should not hold ${p}`).toBe(false);
    }
  });

  it("cannot void an invoice, refund, or touch the ledger", () => {
    expect(can(tech, "invoice:void")).toBe(false);
    expect(can(tech, "payment:refund")).toBe(false);
    expect(can(tech, "ledger:read")).toBe(false);
  });

  it("can still collect a payment in the field", () => {
    expect(can(tech, "payment:collect")).toBe(true);
  });

  it("is scoped to their own records", () => {
    expect(effectiveScope(tech, "job")).toBe("own");
    expect(effectiveScope(tech, "customer")).toBe("own");
  });
});

describe("field redaction", () => {
  /**
   * A real record shape, from a real table.
   *
   * This fixture used to be `{ id, summary, total, cost, grossMargin }`
   * redacted as a "job", and `job` has none of those cost fields and never
   * has. The test passed, the rules for `job.cost` and `job.grossMargin`
   * existed, and neither could ever fire against an actual row: an invented
   * fixture proved the mechanism and hid the fact that it was aimed at
   * nothing. `job_line` is where a job's cost actually lives.
   *
   * packages/api/test/redaction.test.ts now checks every rule against the
   * schema, so the pair cannot drift apart again.
   */
  const row = {
    id: "jl1", name: "Condenser fan motor",
    quantity: "1", unitPrice: "480.0000", unitCost: "210.0000",
  };

  it("strips what a line cost us, for a technician", () => {
    // They quote in the driveway and the customer can read their screen.
    const out = redact(actor(["technician"]), "jobLine", row);
    expect(out.unitPrice).toBe("480.0000");
    expect(out.unitCost).toBeUndefined();
  });

  it("keeps it for finance", () => {
    const out = redact(actor(["accountant"]), "jobLine", row);
    expect(out.unitCost).toBe("210.0000");
  });

  it("strips a wage for anybody without payroll", () => {
    const shift = { id: "t1", minutes: 480, appliedLoadedRate: "62.5000" };
    expect(redact(actor(["dispatcher"]), "timeclockEntry", shift).appliedLoadedRate).toBeUndefined();
    expect(redact(actor(["owner"]), "timeclockEntry", shift).appliedLoadedRate).toBe("62.5000");
  });

  it("does not mutate the input", () => {
    redact(actor(["technician"]), "jobLine", row);
    expect(row.unitCost).toBe("210.0000");
  });
});

describe("the three roles the business actually names", () => {
  it("back office runs jobs and invoicing but not the ledger or payroll", () => {
    const office = actor(["office_manager"]);
    expect(canAll(office, ["customer:write", "job:write", "invoice:write", "visit:dispatch", "po:write"])).toBe(true);
    expect(can(office, "ledger:post")).toBe(false);
    expect(can(office, "payroll:read")).toBe(false);
  });

  it("finance runs the ledger and payroll but cannot dispatch", () => {
    const finance = actor(["accountant"]);
    expect(canAll(finance, ["ledger:post", "payroll:export", "accounting:close", "invoice:writeoff"])).toBe(true);
    expect(can(finance, "visit:dispatch")).toBe(false);
    expect(can(finance, "customer:write")).toBe(false);
  });

  it("dispatch sees the board and no money at all", () => {
    const dispatch = actor(["dispatcher"]);
    expect(canAll(dispatch, ["visit:dispatch", "visit:reschedule", "job:write"])).toBe(true);
    expect(can(dispatch, "invoice:write")).toBe(false);
    expect(can(dispatch, "payment:collect")).toBe(false);
    expect(can(dispatch, "job.cost:read")).toBe(false);
  });
});

describe("grants and revocations", () => {
  it("a grant adds to the preset", () => {
    const t = actor(["technician"], { grants: ["job.cost:read"] });
    expect(can(t, "job.cost:read")).toBe(true);
  });

  it("revocation beats a grant, so removing access always works", () => {
    const t = actor(["owner"], { revocations: ["payroll:read"] });
    expect(can(t, "payroll:read")).toBe(false);
    expect(can(t, "ledger:read")).toBe(true);
  });

  it("multiple roles union their permissions and widen scope", () => {
    const both = actor(["technician", "dispatcher"]);
    expect(can(both, "visit:dispatch")).toBe(true);
    expect(can(both, "timeclock:own")).toBe(true);
    expect(effectiveScope(both, "job")).toBe("all");
    // Still no margin: neither role grants it.
    expect(can(both, "job.cost:read")).toBe(false);
  });
});

describe("agents get no special path", () => {
  it("an agent actor is bounded by the same role", () => {
    const agent = actor(["csr"], { agentId: "intake-agent" });
    expect(can(agent, "job:write")).toBe(true);
    expect(can(agent, "invoice:void")).toBe(false);
    expect(can(agent, "settings:write")).toBe(false);
  });
});

describe("assertCan", () => {
  it("throws a typed error naming the permission", () => {
    expect(() => assertCan(actor(["technician"]), "ledger:post")).toThrow(PermissionError);
    try {
      assertCan(actor(["technician"]), "ledger:post");
    } catch (e) {
      expect((e as PermissionError).permission).toBe("ledger:post");
    }
  });
});
