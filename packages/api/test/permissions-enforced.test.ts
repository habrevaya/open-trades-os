import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PERMISSIONS, ROLE_PRESETS } from "@opentradesos/core";

/**
 * A PERMISSION A ROLE CAN BE GRANTED IS A PERMISSION SOMETHING CHECKS
 *
 * The permission catalogue is the product's promise about what each role can
 * and cannot do. An owner reads a role's list to decide who to give it to.
 * A permission on that list that nothing ever asserts is not a restriction
 * at all, and the direction of the failure is the bad one: the person
 * reading the list believes they have withheld something.
 *
 * Forty two of a hundred and six were in that state when this file was
 * written, and they were two different problems wearing the same face.
 *
 * The harmless kind is a permission for a module nobody has built. Those are
 * honest placeholders, and they are listed below with the module that will
 * enforce them, so "not built yet" is a statement somebody made rather than
 * an absence.
 *
 * The other kind is a permission for a surface that EXISTS and is guarded by
 * a different permission. `vendor:read` and `vendor:write` were declared, and
 * every vendor read and write was guarded by `inventory:read` and
 * `inventory:adjust`. A role granted inventory and deliberately not vendors
 * saw every vendor and every price they charge. Nothing about that is visible
 * from either list.
 *
 * So: assert every permission, or say which module owes it.
 */
const SRC = [
  join(import.meta.dirname, "../src"),
  join(import.meta.dirname, "../../../apps/web/src"),
];

/**
 * Permissions for modules that do not exist yet, with the module that owes
 * each one. An entry here is a decision; the absence of one is a bug.
 *
 * This list is meant to shrink as modules land, and the test below fails
 * when an entry becomes enforced and is left here, so it cannot go stale in
 * the reassuring direction.
 */
const OWED_BY_UNBUILT_MODULES = new Map<string, string>([
  ["servicereport:read", "M11 reports exist as templates and fields; the report itself has no service."],
  ["servicereport:write", "M11."],
  ["servicereport:publish", "M11."],
  ["asset:read", "M22, fleet and company assets. Planned."],
  ["asset:write", "M22."],
  ["asset:checkout", "M22."],
  ["document:write", "M23, documents and compliance. Planned."],
  ["commission:read", "M17 pays hours; commissions are not built."],
  ["commission:configure", "M17."],
  ["campaign:read", "M19 measures; it does not yet send a campaign."],
  ["campaign:write", "M19."],
  ["accounting:sync", "M14, the accounting bridge. Planned."],
  ["accounting:close", "M14."],
  ["billing:manage", "The company's own subscription to this product. Not a module here."],
  ["agent:configure", "M27, AI agents. Planned."],
  ["customfield:write", "M29 stores custom fields; defining them has no service."],
  ["apikey:write", "M26 issues app tokens through connected apps, not bare API keys."],
  ["data:export", "M30. Export exists per report; a whole-tenant export does not."],
  ["job.cost:read", "M15. Job costing reads through reports, which carry their own permission."],
  ["pricebook:publish", "M06 has no draft state to publish from."],
  ["estimate:discount", "M07 applies discounts as line amounts, with no separate authority."],
  ["timeclock:own", "M17. The field app punches under field:sync; a self-service view is not built."],
  ["payroll:read", "M17 exports nothing yet; the timesheet reads under timesheet:read."],
  ["payroll:export", "M17."],
  ["user:read", "M01 lists members through role:read on the settings screen."],
  ["audit:read", "M01 writes the audit log; no screen reads it back."],
  ["job:delete", "M10 cancels rather than deletes, deliberately."],
  ["ledger:read", "M14. Postings are written; no trial balance or journal is read back."],
  ["ledger:post", "M14. Postings are a consequence of a guarded business action, never a bare entry. A manual journal has no surface."],
  ["invoice:send", "M13 writes invoice_delivery rows through no service; delivery is not built."],
  ["payment:read", "M13 records payments and lists none. The invoice carries its own."],
  ["payment:refund", "M13 refunds a deposit, not a payment."],
  ["deposit:read", "M13 requests, records, applies and refunds a deposit, and reads none back."],
  ["estimate.discount.unlimited", "M07 has no discount cap, so there is nothing to exceed."],
]);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

const body = SRC.flatMap(sources)
  .filter((path) => !path.includes("/access/"))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

const declared = Object.keys(PERMISSIONS);

describe("the permission catalogue", () => {
  it("is read at all", () => {
    /** The vacuous case: an empty catalogue or an empty corpus passes everything. */
    expect(declared.length).toBeGreaterThan(90);
    expect(body.length).toBeGreaterThan(100_000);
  });

  it("enforces every permission, or says which module owes it", () => {
    const unenforced = declared
      .filter((permission) => !body.includes(`"${permission}"`))
      .filter((permission) => !OWED_BY_UNBUILT_MODULES.has(permission));

    /**
     * Fix by guarding the surface with the permission its own name promises,
     * or by adding an entry above naming the module that will. A permission
     * on a role's list that nothing checks is a restriction the owner
     * believes they applied.
     */
    expect(unenforced, "granted to roles and checked by nothing").toEqual([]);
  });

  it("does not keep excusing a permission that is now enforced", () => {
    const healed = [...OWED_BY_UNBUILT_MODULES.keys()]
      .filter((permission) => body.includes(`"${permission}"`));
    expect(healed, "listed as owed by an unbuilt module and now enforced: delete the entry")
      .toEqual([]);
  });

  it("does not excuse a permission that is not in the catalogue", () => {
    const unknown = [...OWED_BY_UNBUILT_MODULES.keys()]
      .filter((permission) => !declared.includes(permission));
    expect(unknown, "excused and not a permission").toEqual([]);
  });

  it("grants only permissions that exist", () => {
    /**
     * The other direction, and the one a typo produces: a preset naming a
     * permission the catalogue does not have grants nothing, silently, and
     * the role is quietly narrower than its own description.
     */
    const bad: string[] = [];
    for (const [role, preset] of Object.entries(ROLE_PRESETS)) {
      for (const permission of preset.permissions) {
        if (!declared.includes(permission)) bad.push(`${role}: ${permission}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
