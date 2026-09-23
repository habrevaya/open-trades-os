import { describe, it, expect } from "vitest";
import { schema } from "@opentradesos/db";
import { parties, labor } from "@opentradesos/core";

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

/**
 * TIME ENTRY KINDS
 *
 * The same failure as the roles above, found the hard way: the enum said
 * `job` where core says `on_site`, and a single `break` where core
 * distinguishes paid from unpaid, which is a distinction with money on it.
 * Core had no `training`, `pto` or `holiday`, so a row holding one reached
 * `TIME_ENTRY_KIND[kind].paid`, got undefined, and threw out of a timesheet.
 *
 * Nobody had noticed, because nothing had ever run a timesheet. The two lists
 * can drift for as long as nothing reads both, and the day something does is
 * the day it breaks in front of somebody doing payroll.
 */
describe("time entry kinds", () => {
  it("says the same things core says", () => {
    expect([...schema.timeEntryKind.enumValues].sort())
      .toEqual([...labor.TIME_ENTRY_KINDS].sort());
  });

  it("gives every kind in the database a profile core can price", () => {
    for (const kind of schema.timeEntryKind.enumValues) {
      const profile = labor.TIME_ENTRY_KIND[kind as labor.TimeEntryKind];
      expect(profile, `no profile for ${kind}`).toBeDefined();
      expect(typeof profile.paid).toBe("boolean");
      // A kind nobody can explain on a timesheet is a kind nobody can query.
      expect(profile.contested.length).toBeGreaterThan(20);
    }
  });

  it("defaults the column to a kind that exists", () => {
    // The default was `job` after the enum stopped having a `job`.
    const column = schema.timeclockEntry.kind;
    const fallback = (column as unknown as { default?: string }).default;
    if (fallback) {
      expect([...schema.timeEntryKind.enumValues]).toContain(fallback);
    }
  });
});
