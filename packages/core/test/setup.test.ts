import { describe, it, expect } from "vitest";
import {
  SETUP_STEPS, SETUP_STEP_KEYS, progress, stepAfter, stepNumber, isSetupStepKey,
  planUpgrade, differences, taggedVersion, planChangesSomething,
  planSetupUpgrade, canonical, changedParts, type SetupKind, type SetupPiece, type CompanySetupPiece,
  type CompanyItem, type PackSeedItem, type SeedFields, type UpgradeInput,
} from "../src/setup/index.js";

describe("the setup steps", () => {
  it("lists every key once, in the wizard's order, with the trade second", () => {
    expect(SETUP_STEPS.map((s) => s.key)).toEqual([...SETUP_STEP_KEYS]);
    expect(new Set(SETUP_STEP_KEYS).size).toBe(SETUP_STEP_KEYS.length);
    expect(stepNumber("trade")).toBe(2);
  });

  it("knows its own keys and nothing else", () => {
    expect(isSetupStepKey("payments")).toBe(true);
    expect(isSetupStepKey("payroll")).toBe(false);
  });

  it("goes on to the next step and stops after the last", () => {
    expect(stepAfter("company")).toBe("trade");
    expect(stepAfter("integrations")).toBeNull();
  });
});

describe("how far along a company is", () => {
  it("counts essentials apart from the rest", () => {
    const p = progress(new Set(["company", "trade", "team"]));
    expect(p.done).toBe(3);
    expect(p.essentialDone).toBe(2);
    expect(p.essentialTotal).toBe(SETUP_STEPS.filter((s) => s.essential).length);
    expect(p.complete).toBe(false);
  });

  it("resumes at the first outstanding step in the wizard's order, not the next essential", () => {
    expect(progress(new Set(["company", "trade", "service-area", "hours"])).next).toBe("team");
  });

  it("skips a step the person cannot do, so they are not sent to a page that refuses them", () => {
    const may = (p: string) => p !== "booking:configure";
    expect(progress(new Set(["company", "trade", "service-area"]), may).next).toBe("team");
  });

  it("has nowhere to send somebody when everything they can do is done", () => {
    const may = (p: string) => p === "settings:write";
    const p = progress(new Set(["company", "trade", "service-area"]), may);
    expect(p.next).toBeNull();
    expect(p.complete).toBe(false);
  });

  it("is complete when every step is", () => {
    const p = progress(new Set(SETUP_STEP_KEYS));
    expect(p.complete).toBe(true);
    expect(p.next).toBeNull();
  });
});

/* ------------------------------------------------------------- upgrades */

const fields = (over: Partial<SeedFields> = {}): SeedFields => ({
  name: "Tune up", description: null, price: "189", cost: "62", laborMinutes: 60,
  taxable: false, taxClass: "labor", warrantyMonths: null, ...over,
});

const seed = (code: string, over: Partial<SeedFields> = {}): PackSeedItem => ({
  code, kind: "service", category: "Maintenance", ...fields(over),
});

const item = (code: string, over: Omit<Partial<CompanyItem>, "current"> & { current?: Partial<SeedFields> } = {}): CompanyItem => ({
  itemId: `id-${code}`,
  code,
  tradePackId: "hvac@1",
  version: 1,
  ...over,
  current: fields(over.current),
});

const input = (over: Partial<UpgradeInput>): UpgradeInput => ({
  packId: "hvac",
  toVersion: 2,
  fromVersion: 1,
  baseline: null,
  company: [],
  pack: [],
  companyJobTypeCodes: [],
  packJobTypes: [],
  ...over,
});

describe("a newer trade pack over an older one", () => {
  it("reads which pack and version made a row", () => {
    expect(taggedVersion("hvac@3", "hvac")).toBe(3);
    expect(taggedVersion("plumbing@3", "hvac")).toBeNull();
    expect(taggedVersion(null, "hvac")).toBeNull();
    expect(taggedVersion("hvac", "hvac")).toBeNull();
  });

  it("compares money as money, so a stored 189.0000 is the 189 the pack wrote", () => {
    expect(differences(fields({ price: "189.0000", cost: "62.0000" }), fields())).toEqual([]);
    expect(differences(fields({ price: "190" }), fields())).toEqual([
      { field: "price", from: "190", to: "189" },
    ]);
  });

  it("adds what the company does not have", () => {
    const plan = planUpgrade(input({ pack: [seed("NEW")] }));
    expect(plan.add.map((a) => a.code)).toEqual(["NEW"]);
    expect(planChangesSomething(plan)).toBe(true);
  });

  it("updates an item still exactly as the old version seeded it", () => {
    const plan = planUpgrade(input({
      baseline: { TUNE: fields() },
      company: [item("TUNE")],
      pack: [seed("TUNE", { price: "199", laborMinutes: 75 })],
    }));
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0]!.changes.map((c) => c.field)).toEqual(["price", "laborMinutes"]);
    expect(plan.kept).toEqual([]);
  });

  it("never touches an item somebody here re-priced, and says what it would have changed", () => {
    const plan = planUpgrade(input({
      baseline: { TUNE: fields() },
      company: [item("TUNE", { version: 2, current: { price: "225" } })],
      pack: [seed("TUNE", { price: "199" })],
    }));
    expect(plan.update).toEqual([]);
    expect(plan.kept).toEqual([{
      itemId: "id-TUNE", code: "TUNE", name: "Tune up", reason: "edited",
      changes: [{ field: "price", from: "225", to: "199" }],
    }]);
  });

  it("catches an edit by comparing fields, whatever version number it left behind", () => {
    // A bulk re-price and its undo leave the price where the pack put it on
    // version three: that is not an edit, and the item is still the pack's.
    const plan = planUpgrade(input({
      baseline: { TUNE: fields() },
      company: [item("TUNE", { version: 3 })],
      pack: [seed("TUNE", { price: "199" })],
    }));
    expect(plan.update.map((u) => u.code)).toEqual(["TUNE"]);
  });

  it("without a snapshot, treats anything past version one as edited, which keeps it", () => {
    const plan = planUpgrade(input({
      baseline: null,
      company: [item("A"), item("B", { version: 2 })],
      pack: [seed("A", { price: "1" }), seed("B", { price: "1" })],
    }));
    expect(plan.update.map((u) => u.code)).toEqual(["A"]);
    expect(plan.kept.map((k) => [k.code, k.reason])).toEqual([["B", "edited"]]);
  });

  it("keeps an item the company made itself under the same code", () => {
    const plan = planUpgrade(input({
      company: [item("TUNE", { tradePackId: null }), item("FLUSH", { tradePackId: "plumbing@1" })],
      pack: [seed("TUNE", { price: "1" }), seed("FLUSH", { price: "1" })],
    }));
    expect(plan.kept.map((k) => [k.code, k.reason])).toEqual([["TUNE", "yours"], ["FLUSH", "yours"]]);
    expect(plan.update).toEqual([]);
  });

  it("counts an item that already says what the new version says as unchanged", () => {
    const plan = planUpgrade(input({ company: [item("TUNE")], pack: [seed("TUNE")] }));
    expect(plan.unchanged).toBe(1);
    expect(planChangesSomething(plan)).toBe(false);
  });

  it("reports an item the new version dropped and leaves it alone", () => {
    const plan = planUpgrade(input({
      company: [item("OLD"), item("MINE", { tradePackId: null })],
      pack: [],
    }));
    expect(plan.dropped.map((d) => d.code)).toEqual(["OLD"]);
  });

  it("adds job types the company is missing and leaves the rest", () => {
    const plan = planUpgrade(input({
      companyJobTypeCodes: ["repair"],
      packJobTypes: [{ code: "repair", name: "Repair" }, { code: "maint", name: "Maintenance" }],
    }));
    expect(plan.jobTypes).toEqual({ add: [{ code: "maint", name: "Maintenance" }], present: 1 });
  });

  it("knows when the company is already on the newest version", () => {
    expect(planUpgrade(input({ fromVersion: 2, toVersion: 2 })).upToDate).toBe(true);
    expect(planUpgrade(input({ fromVersion: 1, toVersion: 2 })).upToDate).toBe(false);
    expect(planUpgrade(input({ fromVersion: null, toVersion: 1 })).upToDate).toBe(false);
  });
});

describe("the rest of a newer pack: templates, programmes, rules and the portal", () => {
  const seed = (key: string, content: Record<string, unknown>, kind: SetupKind = "retention_rule"): SetupPiece =>
    ({ kind, key, name: key, content });
  const row = (key: string, content: Record<string, unknown>, extra: Partial<CompanySetupPiece> = {}): CompanySetupPiece => ({
    kind: "retention_rule", key, name: key, content, id: `id-${key}`, tradePackId: "hvac@1", untouched: false, ...extra,
  });
  const plan = (input: Partial<Parameters<typeof planSetupUpgrade>[0]>) =>
    planSetupUpgrade({ packId: "hvac", baseline: null, company: [], pack: [], ...input });

  it("compares content, not the order its keys were written in", () => {
    expect(canonical({ b: 1, a: [{ y: 2, x: undefined, z: null }] })).toBe(canonical({ a: [{ z: null, y: 2 }], b: 1 }));
    expect(changedParts({ months: 36, basis: "EPA" }, { basis: "EPA", months: 24 })).toEqual(["months"]);
  });

  it("updates a piece still as the old version set it up, and keeps one somebody changed", () => {
    const result = plan({
      baseline: { "retention_rule:a": { months: 36 }, "retention_rule:b": { months: 36 } },
      company: [row("a", { months: 36 }), row("b", { months: 48 })],
      pack: [seed("a", { months: 24 }), seed("b", { months: 24 })],
    });
    expect(result.update.map((u) => [u.key, u.changed])).toEqual([["a", ["months"]]]);
    expect(result.kept.map((k) => [k.key, k.reason])).toEqual([["b", "edited"]]);
  });

  it("does not put back a piece the company removed, and adds one that is new", () => {
    const result = plan({
      baseline: { "retention_rule:gone": { months: 36 } },
      pack: [seed("gone", { months: 24 }), seed("new", { months: 12 })],
    });
    expect(result.kept).toEqual([{ kind: "retention_rule", key: "gone", id: null, name: "gone", reason: "removed", changed: [] }]);
    expect(result.add.map((a) => a.key)).toEqual(["new"]);
  });

  it("never shortens a rule allowed to purge, and lengthens one happily", () => {
    const shorter = plan({
      baseline: { "retention_rule:a": { retainMonths: 36 } },
      company: [row("a", { retainMonths: 36 }, { purgeAllowed: true })],
      pack: [seed("a", { retainMonths: 24 })],
    });
    expect(shorter.kept.map((k) => k.reason)).toEqual(["purging"]);
    const longer = plan({
      baseline: { "retention_rule:a": { retainMonths: 36 } },
      company: [row("a", { retainMonths: 36 }, { purgeAllowed: true })],
      pack: [seed("a", { retainMonths: 48 })],
    });
    expect(longer.update.map((u) => u.key)).toEqual(["a"]);
  });

  it("leaves what the company made under the same key, and what the new version dropped", () => {
    const result = plan({
      company: [row("mine", { months: 120 }, { tradePackId: null }), row("old", { months: 12 })],
      pack: [seed("mine", { months: 84 })],
    });
    expect(result.kept.map((k) => [k.key, k.reason])).toEqual([["mine", "yours"]]);
    expect(result.dropped.map((d) => d.key)).toEqual(["old"]);
  });

  it("without a record of what was set up, trusts only a row nobody has saved since it was made", () => {
    const result = plan({
      company: [row("fresh", { months: 36 }, { untouched: true }), row("saved", { months: 36 })],
      pack: [seed("fresh", { months: 24 }), seed("saved", { months: 24 })],
    });
    expect(result.update.map((u) => u.key)).toEqual(["fresh"]);
    expect(result.kept.map((k) => [k.key, k.reason])).toEqual([["saved", "edited"]]);
  });
});
