import { describe, it, expect } from "vitest";
import { customFields } from "../src/index";

/**
 * WHAT A SAVE IS HELD TO, AND WHAT A FORM BECOMES
 *
 * The two halves of the custom field rules that do not need a database: the
 * check a write runs against the definitions, and turning a form's strings
 * into the values that check sees. Each test is a way a company could be
 * refused a save for data it did not touch, or allowed one it should not be.
 */
const warranty = { key: "warranty_expires", label: "Warranty expires", dataType: "date", options: [], required: false };
const account = { key: "account_ref", label: "Account reference", dataType: "text", options: [], required: true };
const units = { key: "unit_count", label: "Units", dataType: "number", options: [], required: false };
const tier = { key: "tier", label: "Tier", dataType: "select", options: ["gold", "silver"], required: false };
const access = { key: "access", label: "Access", dataType: "multiselect", options: ["gate", "dog", "key"], required: false };
const gated = { key: "gated", label: "Gated", dataType: "boolean", options: [], required: false };
const all = [warranty, account, units, tier, access, gated];

describe("one value against its type", () => {
  it("takes what the type says and refuses what it does not", () => {
    expect(customFields.valueProblem(units, 4)).toBeNull();
    expect(customFields.valueProblem(units, "4")).toBe("has to be a number");
    expect(customFields.valueProblem(units, Number.NaN)).toBe("has to be a number");
    expect(customFields.valueProblem(gated, true)).toBeNull();
    expect(customFields.valueProblem(gated, "yes")).toBe("has to be true or false");
    expect(customFields.valueProblem(warranty, "2026-03-01")).toBeNull();
    expect(customFields.valueProblem(warranty, "soon")).toMatch(/date like/);
    expect(customFields.valueProblem(warranty, "2026-02-31")).toBe("is not a real date");
    expect(customFields.valueProblem(tier, "bronze")).toMatch(/not one of the options \(gold, silver\)/);
    expect(customFields.valueProblem(access, ["gate", "gate"])).toBe("lists the same option twice");
    expect(customFields.valueProblem(access, ["moat"])).toMatch(/not an option/);
  });

  it("does not call zero or false missing", () => {
    expect(customFields.isMissing(0)).toBe(false);
    expect(customFields.isMissing(false)).toBe(false);
    expect(customFields.isMissing("  ")).toBe(true);
    expect(customFields.isMissing([])).toBe(true);
  });
});

describe("what a write is refused for", () => {
  it("says every problem at once, one sentence per field, starting with its label", () => {
    expect(customFields.checkChanged(all, { warranty_expires: "soon", unit_count: "four" })).toEqual([
      { key: "account_ref", message: "Account reference is required." },
      { key: "unit_count", message: "Units has to be a number." },
      { key: "warranty_expires", message: "Warranty expires has to be a date like 2026-03-01." },
    ]);
  });

  it("refuses a required field this write cleared", () => {
    expect(customFields.checkChanged(all, {}, { account_ref: "A-1" }))
      .toEqual([{ key: "account_ref", message: "Account reference is required." }]);
  });

  it("does not refuse a record from before the field was required for leaving it empty", () => {
    expect(customFields.checkChanged(all, { unit_count: 3 }, { unit_count: 2 })).toEqual([]);
  });

  it("does not refuse a legacy value this write did not touch", () => {
    expect(customFields.checkChanged(all, { tier: "bronze", account_ref: "A" }, { tier: "bronze", account_ref: "A" }))
      .toEqual([]);
  });

  it("refuses a bad value typed into a field that already held one", () => {
    expect(customFields.checkChanged(all, { tier: "platinum", account_ref: "A" }, { tier: "bronze", account_ref: "A" }))
      .toEqual([{ key: "tier", message: "Tier is not one of the options (gold, silver)." }]);
  });

  it("allows a key nothing defines", () => {
    expect(customFields.checkChanged(all, { wty_exp_2: "whatever", account_ref: "A" })).toEqual([]);
  });

  it("does not treat an equal list as a change", () => {
    expect(customFields.checkChanged([{ ...access, options: ["gate"] }], { access: ["gate", "dog"] }, { access: ["gate", "dog"] }))
      .toEqual([]);
  });
});

describe("what a form becomes", () => {
  const posted = (values: Record<string, string[]>) => (key: string) => values[key] ?? [];

  it("stores each type the way the check expects it", () => {
    expect(customFields.fromForm(all, posted({
      warranty_expires: ["2026-03-01"], account_ref: [" A-1 "], unit_count: ["4"],
      tier: ["gold"], access: ["gate", "dog"], gated: ["false"],
    }))).toEqual({
      warranty_expires: "2026-03-01", account_ref: "A-1", unit_count: 4,
      tier: "gold", access: ["gate", "dog"], gated: false,
    });
  });

  it("leaves what was typed for the check to refuse, rather than dropping it", () => {
    expect(customFields.fromForm([units], posted({ unit_count: ["four"] }))).toEqual({ unit_count: "four" });
  });

  it("keeps keys the form does not draw, and leaves an empty box absent", () => {
    const previous = { wty_exp_2: "legacy", unit_count: 2 };
    expect(customFields.fromForm([units, account], posted({ unit_count: ["2"] }), previous))
      .toEqual({ wty_exp_2: "legacy", unit_count: 2 });
  });

  it("removes a value somebody emptied", () => {
    expect(customFields.fromForm([units], posted({ unit_count: [""] }), { unit_count: 2 })).toEqual({});
  });

  it("round trips an untouched record so the check sees no change", () => {
    const previous = { unit_count: 2, gated: true, access: ["key"] };
    const next = customFields.fromForm(all, posted({ unit_count: ["2"], gated: ["true"], access: ["key"] }), previous);
    expect(customFields.checkChanged(all, next, previous)).toEqual([]);
  });
});
