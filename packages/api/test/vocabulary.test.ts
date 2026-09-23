import { describe, it, expect } from "vitest";
import { schema } from "@opentradesos/db";
import { parties, labor, marketing } from "@opentradesos/core";
import * as contracts from "../src/contracts/index";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

/**
 * LEAD SOURCES
 *
 * `marketing.LEAD_SOURCES` is a catalogue of twenty one real sources and
 * booking wrote `"online_booking"`, which is not one of them. It is a
 * CHANNEL, not a source, so every job and customer that path created carried
 * a value no report could group, no attribution model could credit, and
 * `leadSourceLabel` rendered by replacing an underscore with a space.
 *
 * The distinction costs money. Somebody who clicked a Google ad and then
 * booked on the website came from Google Ads and the ad account paid for
 * them. Recording the widget credits the website for every paid click a
 * company ever buys, and the ads look free.
 *
 * The catalogue was built and the writers never adopted it, which is how a
 * controlled vocabulary becomes a text column with extra steps.
 */
describe("lead sources", () => {
  /** Every string literal this codebase writes into a `leadSource` column. */
  function writtenLiterals(): { file: string; value: string }[] {
    const roots = [
      join(__dirname, "../src"),
      join(__dirname, "../../../apps/web/src"),
      join(__dirname, "../../db/src/seed"),
    ];
    const found: { file: string; value: string }[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { walk(path); continue; }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const source = readFileSync(path, "utf8");
        for (const match of source.matchAll(/leadSource:\s*"([^"]+)"/g)) {
          found.push({ file: entry.name, value: match[1]! });
        }
      }
    };

    for (const root of roots) walk(root);
    return found;
  }

  it("never writes a source that is not in the catalogue", () => {
    const known = new Set(marketing.LEAD_SOURCE_KEYS as readonly string[]);
    const written = writtenLiterals();

    const unknownOnes = written.filter((w) => !known.has(w.value));
    expect(
      unknownOnes.map((w) => `${w.file}: ${w.value}`),
      "a lead source no report can group",
    ).toEqual([]);
  });

  it("writes at least one, so the sweep above is not measuring an empty set", () => {
    // The assertion that keeps the test from passing because a regex broke.
    expect(writtenLiterals().length).toBeGreaterThan(0);
  });

  it("has a real key for a customer who simply typed the address in", () => {
    /**
     * `direct` and `unknown` are different facts. Unknown means we failed to
     * record it, direct means they came straight to us, and a report that
     * cannot tell them apart cannot tell a tracking gap from a strong brand.
     */
    const keys = marketing.LEAD_SOURCE_KEYS as readonly string[];
    expect(keys).toContain("direct");
    expect(keys).toContain("unknown");
  });
});

/**
 * A CONTRACT ENUM IS A THIRD COPY OF THE SAME LIST
 *
 * The party roles exist twice by necessity. A published enum makes a third,
 * and it is the worst of the three to get wrong: the OpenAPI document and
 * every generated client are built from it, so a missing value becomes a
 * type in somebody else's codebase that says a real response is impossible.
 *
 * This was not hypothetical. `MovementKind` shipped with seven of the eleven
 * kinds, chosen from memory, and the one most obviously missing was
 * `adjustment_out`: what a physical count writes when the shelf came up
 * short. A client generated from that document would have broken on the days
 * a count found less than the history expected, and on no other day.
 *
 * `PurchaseOrderStatus` was missing `acknowledged` in the same commit, which
 * would have made a legal transition fail input validation at the edge.
 */
describe("published enums match the columns behind them", () => {
  const pairs: [string, readonly string[], readonly string[]][] = [
    ["stock_movement_kind", contracts.MovementKind.options, schema.movementKind.enumValues],
    ["purchase_order_status", contracts.PurchaseOrderStatus.options, schema.purchaseOrderStatus.enumValues],
    ["call_status", contracts.CallStatus.options, schema.callStatus.enumValues],
  ];

  it("covers more than one column, so the loop is not proving itself", () => {
    expect(pairs.length).toBeGreaterThan(1);
  });

  for (const [column, published, stored] of pairs) {
    it(`publishes exactly the values ${column} can hold`, () => {
      expect([...published].sort()).toEqual([...stored].sort());
    });
  }
});

/**
 * FORM FIELD TYPES
 *
 * A third copy of a list that already exists in core and in whatever a
 * client generates from the document. This one shipped wrong on its first
 * commit: it invented `boolean` and `address` and omitted `service_address`,
 * `hidden` and `honeypot`.
 *
 * The omissions were the expensive half. `service_address` and the problem
 * description are the two fields every trades lead form has and most form
 * builders handle badly, and `honeypot` is the spam check: a generated
 * client could not have built any of them.
 */
describe("form field types", () => {
  it("publishes exactly the types core knows how to check", () => {
    /**
     * Core's union has no runtime value, so the list is read out of the
     * source. Reading it rather than restating it is the point: a restated
     * list is a fourth copy.
     */
    const source = readFileSync(
      join(__dirname, "../../core/src/marketing/index.ts"),
      "utf8",
    );
    const block = /export type FieldType =([\s\S]*?);/.exec(source);
    expect(block, "core's FieldType union moved").toBeTruthy();

    const inCore = [...block![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(inCore.length).toBeGreaterThan(5);

    expect([...contracts.FormFieldType.options].sort()).toEqual([...inCore].sort());
  });
});
