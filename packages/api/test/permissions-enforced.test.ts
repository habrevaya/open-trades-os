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
/**
 * FOUR ENTRIES LEFT THIS LIST IN ONE COMMIT, which is what it is for.
 *
 * `audit:read`, `ledger:read`, `payment:read` and `deposit:read` all said the
 * same thing in different words: the data is written and nothing reads it
 * back. They are enforced now, by the audit log reader, the trial balance and
 * journal, the payment list and the deposit list, and the test below is what
 * made removing them compulsory rather than optional: it fails when a
 * permission on this list becomes enforced and the entry is left behind.
 *
 * That direction matters more than it looks. A stale excuse is a sentence
 * saying a module owes something it has already delivered, sitting in the one
 * file somebody reads to find out what is missing.
 */
const OWED_BY_UNBUILT_MODULES = new Map<string, string>([
  /**
   * `ledger:post` stays, and not because nobody got to it. A posting in this
   * product is a consequence of a guarded business action: invoicing, taking
   * a payment, writing one off. There is no bare journal entry surface and
   * there should not be one, because an operator who can post freely can make
   * the books say anything with no document behind it. The permission exists
   * for the day a manual journal is genuinely needed.
   */
  ["campaign:read", "M19 measures; it does not yet send a campaign."],
  ["campaign:write", "M19."],
  ["billing:manage", "The company's own subscription to this product. Not a module here."],
  ["apikey:write", "M26 issues app tokens through connected apps, not bare API keys."],
  ["data:export", "M30. Export exists per report; a whole-tenant export does not."],
  ["job:delete", "M10 cancels rather than deletes, deliberately."],
  ["ledger:post", "M14. Postings are a consequence of a guarded business action, never a bare entry. A manual journal has no surface."],
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
