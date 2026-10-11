import { describe, it, expect } from "vitest";
import { plugins, money as m, reporting, type Permission } from "../src/index";

/**
 * PLUGINS, DECIDED WITHOUT THE DATABASE
 *
 * Three things an application can add, and each can hurt a company in its
 * own way: a workflow that holds a job forever or lets one skip a gate, a
 * pricing rule that charges a customer twice or takes a price below
 * nothing, and a report type that reads further than its base. All of it is
 * decided here, so all of it is tested here.
 */

const STATUSES = plugins.JOB_STATUSES;

const install = (gates: plugins.Gate[] = []) => ({
  stages: [
    { key: "booked", name: "Booked", statuses: ["lead", "estimating", "scheduled"], gates },
    { key: "work", name: "Install", statuses: ["in_progress", "on_hold"], gates: [{ kind: "field", key: "inspection_ref" }] },
    { key: "done", name: "Done", statuses: ["completed", "invoiced", "paid", "cancelled"] },
  ],
});

const known = { checklistItemIds: ["photos", "permit"], fieldKeys: ["permit_number", "inspection_ref"] };

describe("a job workflow is checked before it is kept", () => {
  it("accepts stages that place every status once, with gates the company can answer", () => {
    const checked = plugins.checkJobWorkflow(install([{ kind: "checklist", itemId: "permit" }]), known);
    expect(checked.ok).toBe(true);
  });

  it("refuses a status left out, and one placed twice, naming each", () => {
    const missing = install();
    missing.stages[2]!.statuses = ["completed", "invoiced", "paid"];
    const checked = plugins.checkJobWorkflow(missing, known);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.problems.join(" ")).toMatch(/Not placed: cancelled/);

    const twice = install();
    twice.stages[1]!.statuses = ["in_progress", "on_hold", "scheduled"];
    const again = plugins.checkJobWorkflow(twice, known);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.problems.join(" ")).toMatch(/"scheduled" is in both "Booked" and "Install"/);
  });

  it("refuses a gate on a checklist item or a field the company does not have", () => {
    const checked = plugins.checkJobWorkflow(install([
      { kind: "checklist", itemId: "nope" }, { kind: "field", key: "made_up" },
    ]), known);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.problems).toContain('"Booked" waits on checklist item "nope", which is not on this job type\'s checklist.');
      expect(checked.problems).toContain('"Booked" waits on the field "made_up", which the company has not defined on jobs.');
    }
  });

  it("refuses a status the product does not have and a gate kind it cannot answer", () => {
    const odd = { stages: [
      { key: "a", name: "A", statuses: [...STATUSES.slice(0, 5), "waiting_on_parts"], gates: [{ kind: "script", code: "x" }] },
      { key: "b", name: "B", statuses: STATUSES.slice(5) },
    ] };
    const checked = plugins.checkJobWorkflow(odd, known);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.problems.join(" ")).toMatch(/"waiting_on_parts", which is not a job status/);
      expect(checked.problems.join(" ")).toMatch(/A gate is "checklist" or "field"/);
    }
  });

  it("needs two stages, at most twelve, with distinct keys", () => {
    const one = plugins.checkJobWorkflow({ stages: [{ key: "all", name: "All", statuses: [...STATUSES] }] }, known);
    expect(one.ok).toBe(false);
    const dup = install();
    dup.stages[1]!.key = "booked";
    const checked = plugins.checkJobWorkflow(dup, known);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.problems).toContain('Two stages have the key "booked".');
  });

  it("says what it reads, so an application can only gate on what it may read itself", () => {
    const checked = plugins.checkJobWorkflow(install([{ kind: "checklist", itemId: "permit" }]), known);
    if (!checked.ok) throw new Error("expected ok");
    expect(plugins.workflowReads(checked.value)).toEqual(["job:read", "visit:read"]);
  });
});

describe("moving a job past a gate", () => {
  const checked = plugins.checkJobWorkflow(install([
    { kind: "checklist", itemId: "permit" }, { kind: "field", key: "permit_number" },
  ]), known);
  if (!checked.ok) throw new Error("expected ok");
  const workflow = checked.value;
  const facts = (done: string[], filled: string[]): plugins.GateFacts => ({
    done: new Set(done), filled: new Set(filled),
    checklistLabel: (id) => ({ permit: "Permit pulled", photos: "Photos" })[id] ?? id,
    fieldLabel: (key) => ({ permit_number: "Permit number", inspection_ref: "Inspection reference" })[key] ?? key,
  });

  it("is refused in words that name every gate not met", () => {
    expect(plugins.moveRefusal(workflow, "scheduled", "in_progress", facts([], [])))
      .toBe('This job cannot leave "Booked" yet: tick "Permit pulled" on a visit and fill in "Permit number" on the job.');
  });

  it("passes once the gates hold", () => {
    expect(plugins.moveRefusal(workflow, "scheduled", "in_progress", facts(["permit"], ["permit_number"]))).toBeNull();
  });

  it("holds a job skipping a stage to the gates of the stage it skipped", () => {
    const refusal = plugins.moveRefusal(workflow, "scheduled", "completed", facts(["permit"], ["permit_number"]));
    expect(refusal).toBe('This job cannot leave "Install" yet: fill in "Inspection reference" on the job.');
  });

  it("never holds a move inside a stage, back to an earlier one, or to cancelled", () => {
    expect(plugins.gatesToPass(workflow, "lead", "scheduled")).toEqual([]);
    expect(plugins.gatesToPass(workflow, "in_progress", "scheduled")).toEqual([]);
    expect(plugins.gatesToPass(workflow, "scheduled", "cancelled")).toEqual([]);
  });

  it("finds the stage of every status", () => {
    for (const status of STATUSES) expect(plugins.stageOf(workflow, status)).not.toBeNull();
    expect(plugins.stageOf(workflow, "on_hold")!.stage.name).toBe("Install");
  });

  it("counts an empty answer as no answer", () => {
    expect(plugins.holdsValue("")).toBe(false);
    expect(plugins.holdsValue("  ")).toBe(false);
    expect(plugins.holdsValue([])).toBe(false);
    expect(plugins.holdsValue(null)).toBe(false);
    expect(plugins.holdsValue(0)).toBe(true);
    expect(plugins.holdsValue(false)).toBe(true);
    expect(plugins.holdsValue("B-12")).toBe(true);
  });
});

describe("a pricing rule is one of four shapes", () => {
  const types = { jobTypeIds: ["11111111-1111-1111-1111-111111111111"] };

  it("accepts each kind with exactly one of a percentage and an amount", () => {
    expect(plugins.checkPricingRule({ kind: "customer_tag", tag: " VIP ", percent: "-10" }, types))
      .toEqual({ ok: true, value: { kind: "customer_tag", tag: "VIP", percent: "-10" } });
    expect(plugins.checkPricingRule({ kind: "job_type", jobTypeId: types.jobTypeIds[0], amount: "25" }, types))
      .toEqual({ ok: true, value: { kind: "job_type", jobTypeId: types.jobTypeIds[0], amount: "25.0000" } });
    expect(plugins.checkPricingRule({ kind: "time_window", window: { days: [6, 0], from: "18:00", to: "24:00" }, percent: "50" }, types))
      .toEqual({ ok: true, value: { kind: "time_window", window: { days: [0, 6], from: "18:00", to: "24:00" }, percent: "50" } });
    expect(plugins.checkPricingRule({ kind: "minimum_charge", minimum: "150" }, types))
      .toEqual({ ok: true, value: { kind: "minimum_charge", minimum: "150.0000" } });
  });

  it("refuses both, neither, a number instead of a string, and a percentage past a hundred", () => {
    const refused = (input: unknown) => {
      const checked = plugins.checkPricingRule(input, types);
      expect(checked.ok).toBe(false);
      return checked.ok ? [] : checked.problems;
    };
    expect(refused({ kind: "customer_tag", tag: "vip", percent: "-10", amount: "5" }).join(" ")).toMatch(/exactly one/);
    expect(refused({ kind: "customer_tag", tag: "vip" }).join(" ")).toMatch(/exactly one/);
    expect(refused({ kind: "customer_tag", tag: "vip", percent: -10 }).join(" ")).toMatch(/percentage/);
    expect(refused({ kind: "customer_tag", tag: "vip", percent: "-150" }).join(" ")).toMatch(/percentage/);
    expect(refused({ kind: "customer_tag", tag: "", percent: "5" }).join(" ")).toMatch(/tag/);
    expect(refused({ kind: "job_type", jobTypeId: "22222222-2222-2222-2222-222222222222", percent: "5" }).join(" "))
      .toMatch(/not one of the company's/);
    expect(refused({ kind: "time_window", window: { days: [1], from: "22:00", to: "06:00" }, percent: "5" }).join(" "))
      .toMatch(/two rules, or use "outside_hours"/);
    expect(refused({ kind: "minimum_charge", minimum: "150", percent: "5" }).join(" ")).toMatch(/not a percentage/);
    expect(refused({ kind: "markup_by_formula", expression: "price * 2" }).join(" ")).toMatch(/kind is one of/);
  });

  it("says what each reads", () => {
    expect(plugins.RULE_READS.customer_tag).toEqual(["customer:read"]);
    expect(plugins.RULE_READS.minimum_charge).toEqual([]);
  });
});

describe("the order pricing rules are applied in", () => {
  const usd = (v: string) => m.money(v, "USD");
  const line = (price: string, opts: Partial<plugins.RuleLine> = {}): plugins.RuleLine => ({
    quantity: "1", unitPrice: usd(price), discountAmount: usd("0"), touchable: true, counts: true, ...opts,
  });
  const rule = (id: string, r: plugins.PricingRule): plugins.ActiveRule => ({ id, name: id, appName: "Acme", version: 1, rule: r });
  const facts: plugins.RuleFacts = {
    customerTags: ["VIP"], jobTypeId: "jt", work: { dayOfWeek: 6, minute: 19 * 60, outsideHours: true },
  };
  const total = (lines: plugins.RuledLine[], quantities: string[] = lines.map(() => "1")) =>
    m.toString(m.sum(lines.map((l, i) => m.subtract(m.multiply(l.unitPrice, quantities[i]!), l.discountAmount)), "USD"));

  it("takes every percentage from the price after member pricing, so two give the same either way", () => {
    const rules = [
      rule("vip", { kind: "customer_tag", tag: "vip", percent: "-10" }),
      rule("evening", { kind: "time_window", window: "outside_hours", percent: "50" }),
    ];
    const a = plugins.applyPricingRules([line("200", { discountAmount: usd("20") })], rules, facts);
    const b = plugins.applyPricingRules([line("200", { discountAmount: usd("20") })], [...rules].reverse(), facts);
    // 180 after the member's 20: minus 18, plus 90.
    expect(a[0]!.applied.map((x) => x.amount)).toEqual(["-18.0000", "90.0000"]);
    expect(total(a)).toBe(total(b));
    expect(total(a)).toBe("252.0000");
    // Money off goes into the discount, money added into the price.
    expect(m.toString(a[0]!.discountAmount)).toBe("38.0000");
    expect(m.toString(a[0]!.unitPrice)).toBe("290.0000");
    expect(a[0]!.applied[0]!.unitPriceBefore).toBe("200.0000");
  });

  it("spreads an amount over the lines by what each comes to, to the cent", () => {
    const out = plugins.applyPricingRules(
      [line("100"), line("200")],
      [rule("trip", { kind: "job_type", jobTypeId: "jt", amount: "-30" })], facts,
    );
    expect(out.map((l) => m.toString(l.discountAmount))).toEqual(["10.0000", "20.0000"]);
  });

  it("applies percentages before amounts", () => {
    const out = plugins.applyPricingRules(
      [line("100")],
      [rule("flat", { kind: "job_type", jobTypeId: "jt", amount: "-10" }), rule("pct", { kind: "customer_tag", tag: "vip", percent: "-50" })],
      facts,
    );
    expect(out[0]!.applied.map((a) => a.ruleId)).toEqual(["pct", "flat"]);
    expect(total(out)).toBe("40.0000");
  });

  it("never takes a line below nothing", () => {
    const out = plugins.applyPricingRules(
      [line("40")],
      [rule("big", { kind: "job_type", jobTypeId: "jt", amount: "-100" })], facts,
    );
    expect(total(out)).toBe("0.0000");
    expect(out[0]!.applied[0]!.amount).toBe("-40.0000");
  });

  it("brings the document to the largest minimum last, after everything else", () => {
    const out = plugins.applyPricingRules(
      [line("60"), line("30")],
      [
        rule("min150", { kind: "minimum_charge", minimum: "150" }),
        rule("min200", { kind: "minimum_charge", minimum: "200" }),
        rule("vip", { kind: "customer_tag", tag: "vip", percent: "-10" }),
      ],
      facts,
    );
    expect(total(out)).toBe("200.0000");
    // The smaller minimum did nothing.
    expect(out.flatMap((l) => l.applied).some((a) => a.ruleId === "min150")).toBe(false);
  });

  it("leaves a typed price, a contract's price and history alone", () => {
    const out = plugins.applyPricingRules(
      [line("100", { touchable: false }), line("100")],
      [rule("vip", { kind: "customer_tag", tag: "vip", percent: "-10" })], facts,
    );
    expect(out[0]!.applied).toEqual([]);
    expect(m.toString(out[0]!.discountAmount)).toBe("0.0000");
    expect(out[1]!.applied).toHaveLength(1);
  });

  it("spreads amounts and minimums over lines that are bought, not optional lines left unticked", () => {
    const out = plugins.applyPricingRules(
      [line("100"), line("100", { counts: false })],
      [rule("off", { kind: "job_type", jobTypeId: "jt", amount: "-20" })], facts,
    );
    expect(m.toString(out[0]!.discountAmount)).toBe("20.0000");
    expect(out[1]!.applied).toEqual([]);
  });

  it("does nothing when no rule holds for the sale", () => {
    const out = plugins.applyPricingRules(
      [line("100")],
      [rule("vip", { kind: "customer_tag", tag: "gold", percent: "-10" }),
       rule("sat", { kind: "time_window", window: { days: [1, 2], from: "08:00", to: "17:00" }, percent: "20" })],
      facts,
    );
    expect(out[0]!.applied).toEqual([]);
    expect(plugins.applyPricingRules([line("100")], [rule("t", { kind: "time_window", window: "outside_hours", percent: "20" })],
      { ...facts, work: null })[0]!.applied).toEqual([]);
  });

  it("raises the price of a line of several so it never comes to less than the rule said, and records what changed", () => {
    const out = plugins.applyPricingRules(
      [line("10", { quantity: "3" })],
      [rule("add", { kind: "job_type", jobTypeId: "jt", amount: "10" })], facts,
    );
    // 10 / 3 rounded up at the fourth place.
    expect(m.toString(out[0]!.unitPrice)).toBe("13.3334");
    const added = m.subtract(m.multiply(out[0]!.unitPrice, "3"), usd("30"));
    expect(out[0]!.applied[0]!.amount).toBe(m.toString(added));
    expect(m.compare(added, usd("10"))).toBeGreaterThanOrEqual(0);
  });

  it("can say what part of a discount and of a price the rules made", () => {
    const applied = [{ amount: "-5.0000", unitPriceBefore: "90.0000" }, { amount: "12.0000", unitPriceBefore: "90.0000" }];
    expect(m.toString(plugins.ruleDiscount(applied))).toBe("5.0000");
    expect(plugins.priceBeforeRules("102.0000", applied)).toBe("90.0000");
    expect(plugins.priceBeforeRules("102.0000", [])).toBe("102.0000");
  });

  it("describes each in a sentence", () => {
    expect(plugins.describeRule({ kind: "customer_tag", tag: "VIP", percent: "-10" })).toBe('10% off for customers tagged "VIP"');
    expect(plugins.describeRule({ kind: "minimum_charge", minimum: "150.0000" })).toBe("at least $150.00 in all");
  });
});

describe("a report type is a cut of a dataset, and reads no further", () => {
  const jobs: reporting.Dataset = {
    key: "jobs", label: "Jobs", description: "", from: "public.job", permission: "job:read", scope: "job",
    dateColumn: "job.created_at",
    records: { noun: "job", plural: "jobs", id: "job.id", label: "job.summary", href: "/jobs/{id}", orderBy: "job.created_at", columns: [] },
    dimensions: [
      { key: "status", label: "Status", type: "status", sql: "job.status" },
      { key: "job_type", label: "Job type", type: "text", sql: "jt.name" },
      { key: "technician_check", label: "Technician: Check", type: "text", sql: "x", permission: "user:read" },
    ],
    measures: [
      { key: "count", label: "Jobs", kind: "count", type: "number" },
      { key: "cost", label: "Cost", kind: "sum", type: "money", sql: "job.cost", permission: "job.cost:read" },
    ],
  };
  const held = (...p: Permission[]) => new Set<Permission>(p);

  it("refuses a base that is not a dataset, and columns the base does not have", () => {
    const checked = plugins.checkReportType({ label: "X", base: "jobs", dimensions: ["nope"], measures: ["count", "margin"] }, [jobs]);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.problems).toEqual(['Jobs has no column "nope".', 'Jobs has no measure "margin".']);
    const base = plugins.checkReportType({ label: "X", base: "ledger", measures: ["count"] }, [jobs]);
    expect(base.ok).toBe(false);
  });

  it("is held, at registration, to what its base, columns and filters need", () => {
    const checked = plugins.checkReportType({
      label: "Installs by status", base: "jobs", dimensions: ["status"], measures: ["count", "cost"],
      filters: [{ dimension: "job_type", op: "eq", value: "Install" }],
    }, [jobs]);
    if (!checked.ok) throw new Error(checked.problems.join(" "));
    expect(plugins.readRefusal(checked.value, [jobs], held("job:read"))).toBe("This report needs: job.cost:read.");
    expect(plugins.readRefusal(checked.value, [jobs], held("job:read", "job.cost:read"))).toBeNull();
  });

  it("becomes a dataset of its own over the same records, carrying its filters and its base", () => {
    const checked = plugins.checkReportType({
      label: "Checked installs", base: "jobs", measures: ["count"],
      filters: [{ dimension: "technician_check", op: "eq", value: "Failed" }],
    }, [jobs]);
    if (!checked.ok) throw new Error(checked.problems.join(" "));
    const dataset = plugins.reportTypeDataset("checked", checked.value, [jobs])!;
    expect(dataset.key).toBe("app_checked");
    expect(dataset.base).toBe("jobs");
    expect(dataset.from).toBe("public.job");
    expect(dataset.dimensions).toEqual([]);
    expect(dataset.fixedFilters).toEqual([{
      dimension: "technician_check", label: "Technician: Check", sql: "x", permission: "user:read", op: "eq", value: "Failed",
    }]);

    // Running it needs the filter's permission as well, though the column is not offered.
    const refused = reporting.resolveReport({ dataset: "app_checked", dimensions: [], measures: ["count"] }, [dataset], held("job:read"));
    expect(refused.ok).toBe(false);
    const allowed = reporting.resolveReport({ dataset: "app_checked", dimensions: [], measures: ["count"] }, [dataset], held("job:read", "user:read"));
    expect(allowed.ok).toBe(true);
  });

  it("is left out of the catalogue when a column it is built from has gone", () => {
    const type: plugins.ReportType = { label: "X", description: null, base: "jobs", dimensions: ["cf_gone"], measures: ["count"], filters: [] };
    expect(plugins.reportTypeDataset("x", type, [jobs])).toBeNull();
  });

  it("cannot be cut from another application's type", () => {
    const type: plugins.ReportType = { label: "A", description: null, base: "jobs", dimensions: [], measures: ["count"], filters: [] };
    const derived = plugins.reportTypeDataset("a", type, [jobs])!;
    const checked = plugins.checkReportType({ label: "B", base: "app_a", measures: ["count"] }, [jobs, derived]);
    expect(checked.ok).toBe(false);
  });
});
