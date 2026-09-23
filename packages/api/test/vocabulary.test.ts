import { describe, it, expect } from "vitest";
import { schema } from "@opentradesos/db";
import { parties } from "@opentradesos/core";

/**
 * TWO COPIES OF A LIST DISAGREE EVENTUALLY
 *
 * The party roles exist twice by necessity: once as a Postgres enum, because
 * the column has to be constrained, and once in core, because a screen needs
 * a label and a meaning and the database cannot hold either.
 *
 * Nothing makes the two agree. A role added to core and not to the enum is a
 * screen that offers an option every save rejects; a role added to the enum
 * and not to core renders as a raw `bill_to` beside somebody's name. Neither
 * is a type error, and neither fails a build.
 */
describe("the party role vocabulary", () => {
  it("is the same seven roles in core and in the database", () => {
    expect([...parties.PARTY_ROLE_KEYS].sort())
      .toEqual([...schema.partyRole.enumValues].sort());
  });

  it("says what every role means, because the label alone is ambiguous", () => {
    // "Billed to" and "Pays" are different things and the difference is the
    // entire reason the role list is longer than two.
    for (const role of parties.PARTY_ROLES) {
      expect(role.meaning.length, role.key).toBeGreaterThan(20);
    }
  });

  it("shows a role it does not know rather than a blank", () => {
    expect(parties.roleLabel("bill_to")).toBe("Billed to");
    expect(parties.roleLabel("adjuster")).toBe("adjuster");
  });
});
