import { describe, it, expect } from "vitest";
import * as project from "../src/project/index.js";

/**
 * M12. THE ARITHMETIC OF A PROJECT.
 *
 * Three things a certifier, a customer or a crew reads off this module's
 * output and acts on: which phases decide the finish date, what agreeing a
 * change order does to the contract, and what an application for payment
 * asks for once retainage is held and released. Each figure below is worked
 * out by hand in the comment beside it, because a test that recomputes the
 * answer the way the code does proves only that the code agrees with itself.
 */

const phase = (
  id: string, startsOn: string | null, endsOn: string | null,
  dependsOnPhaseId: string | null = null,
  status: project.PhaseStatus = "not_started",
): project.PlannedPhase => ({
  id, name: id, sequence: id.charCodeAt(0), dependsOnPhaseId, startsOn, endsOn, status,
});

describe("the critical path", () => {
  /**
   * Demolition (3 days) then rough in (5) then close up (4), with paint (2)
   * hanging off rough in in parallel and finishing well before close up.
   *
   *   demo     1 to 3
   *   rough    4 to 8      waits for demo
   *   close    9 to 12     waits for rough
   *   paint    9 to 10     waits for rough, two days of slack before the 12th
   */
  const plan = [
    phase("demo", "2026-11-01", "2026-11-03"),
    phase("rough", "2026-11-04", "2026-11-08", "demo"),
    phase("close", "2026-11-09", "2026-11-12", "rough"),
    phase("paint", "2026-11-09", "2026-11-10", "rough"),
  ];

  it("is the chain that decides the finish, and leaves out the phase with room to slip", () => {
    const result = project.analyseSchedule(plan);
    expect(result.finish).toBe("2026-11-12");
    expect(result.start).toBe("2026-11-01");
    expect(result.criticalPath).toEqual(["demo", "rough", "close"]);
    const paint = result.phases.find((p) => p.id === "paint")!;
    expect(paint.critical).toBe(false);
    /** The 10th to the 12th is two days of float. */
    expect(paint.floatDays).toBe(2);
  });

  it("counts a phase that starts and ends on one day as one day, not none", () => {
    expect(project.durationDays("2026-11-04", "2026-11-04")).toBe(1);
    const result = project.analyseSchedule([phase("a", "2026-11-04", "2026-11-04")]);
    expect(result.phases[0]!.durationDays).toBe(1);
    expect(result.criticalPath).toEqual(["a"]);
  });

  it("gives a gap between phases as float on the earlier one", () => {
    /** b waits for a and starts three days after a ends: a can slip two days without moving b. */
    const result = project.analyseSchedule([
      phase("a", "2026-11-01", "2026-11-02"),
      phase("b", "2026-11-05", "2026-11-06", "a"),
    ]);
    expect(result.phases.find((p) => p.id === "a")!.floatDays).toBe(2);
    expect(result.criticalPath).toEqual(["b"]);
  });

  it("never lights up a finished phase, which can no longer slip", () => {
    const result = project.analyseSchedule([
      phase("demo", "2026-11-01", "2026-11-03", null, "complete"),
      phase("rough", "2026-11-04", "2026-11-08", "demo"),
    ]);
    expect(result.criticalPath).toEqual(["rough"]);
  });

  it("leaves out a phase with no dates and says so, rather than calling it critical", () => {
    const result = project.analyseSchedule([...plan, phase("snag", null, null, "close")]);
    const snag = result.phases.find((p) => p.id === "snag")!;
    expect(snag.scheduled).toBe(false);
    expect(snag.floatDays).toBeNull();
    expect(result.unscheduled).toEqual(["snag"]);
    expect(result.statement).toContain("1 phase has no dates");
  });

  it("says when a phase is drawn starting before the one it waits for has finished", () => {
    const result = project.analyseSchedule([
      phase("a", "2026-11-01", "2026-11-05"),
      phase("b", "2026-11-05", "2026-11-06", "a"),
    ]);
    expect(result.phases.find((p) => p.id === "b")!.overlapsPredecessor).toBe(true);
    /** a must end the day before b starts, the 4th, so it is already a day late: negative float. */
    expect(result.phases.find((p) => p.id === "a")!.floatDays).toBe(-1);
    expect(result.phases.find((p) => p.id === "a")!.critical).toBe(true);
  });

  it("has nothing to say about a project with no dates at all", () => {
    const result = project.analyseSchedule([phase("a", null, null)]);
    expect(result.finish).toBeNull();
    expect(result.criticalPath).toEqual([]);
    expect(result.statement).toMatch(/No phase has a start and an end/);
  });
});

describe("dragging a phase", () => {
  const plan = [
    phase("demo", "2026-11-01", "2026-11-03"),
    phase("rough", "2026-11-04", "2026-11-08", "demo"),
    phase("close", "2026-11-09", "2026-11-12", "rough"),
    phase("paint", "2026-11-09", "2026-11-10", "rough"),
    phase("other", "2026-11-02", "2026-11-04"),
  ];

  it("moves everything that waits for it by the same days, keeping each one's length", () => {
    const decision = project.movePhase(plan, "rough", "2026-11-06");
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.shiftDays).toBe(2);
    expect(decision.moves).toEqual([
      { id: "rough", startsOn: "2026-11-06", endsOn: "2026-11-10" },
      { id: "close", startsOn: "2026-11-11", endsOn: "2026-11-14" },
      { id: "paint", startsOn: "2026-11-11", endsOn: "2026-11-12" },
    ]);
  });

  it("leaves alone the phases that do not wait for it", () => {
    const decision = project.movePhase(plan, "rough", "2026-11-06");
    if (!decision.ok) throw new Error(decision.reason);
    expect(decision.moves.map((m) => m.id)).not.toContain("other");
    expect(decision.moves.map((m) => m.id)).not.toContain("demo");
  });

  it("refuses a start on or before the day the phase it waits for ends, and names the earliest", () => {
    const decision = project.movePhase(plan, "rough", "2026-11-03");
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toContain("finishes on 2026-11-03");
    expect(decision.reason).toContain("earliest it can start is 2026-11-04");
  });

  it("moves earlier as readily as later, taking its followers with it", () => {
    const decision = project.movePhase(plan, "close", "2026-11-09");
    expect(decision).toEqual({ ok: true, shiftDays: 0, moves: [] });
    const earlier = project.movePhase(plan, "demo", "2026-10-30");
    if (!earlier.ok) throw new Error(earlier.reason);
    expect(earlier.moves.find((m) => m.id === "paint")).toEqual(
      { id: "paint", startsOn: "2026-11-07", endsOn: "2026-11-08" },
    );
  });

  it("refuses to move a finished phase, or one with a finished phase after it", () => {
    const done = plan.map((p) => (p.id === "demo" ? { ...p, status: "complete" as const } : p));
    expect(project.movePhase(done, "demo", "2026-11-05").ok).toBe(false);
    const after = plan.map((p) => (p.id === "close" ? { ...p, status: "complete" as const } : p));
    const decision = project.movePhase(after, "rough", "2026-11-05");
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain("close waits for rough and is already complete");
  });

  it("refuses a phase with no dates, which has nothing to drag", () => {
    const decision = project.movePhase([phase("a", null, null)], "a", "2026-11-01");
    expect(decision.ok).toBe(false);
  });
});

describe("a change order's effect on the contract", () => {
  it("adds up line by line to the cent, so the signed page adds up", () => {
    /** 3 x 33.333 is 99.999, rounded to 100.00; 1.5 x 12.345 is 18.5175, rounded to 18.52. */
    const totals = project.changeOrderTotals([
      { quantity: "3", unitPrice: "33.333", unitCost: "20" },
      { quantity: "1.5", unitPrice: "12.345", unitCost: null },
    ]);
    expect(totals.lineTotals).toEqual(["100.0000", "18.5200"]);
    expect(totals.amount).toBe("118.5200");
    expect(totals.cost).toBe("60.0000");
    expect(totals.costKnown).toBe(false);
  });

  it("takes a credit as a negative line", () => {
    const totals = project.changeOrderTotals([
      { quantity: "-2", unitPrice: "150", unitCost: "60" },
    ]);
    expect(totals.amount).toBe("-300.0000");
    expect(totals.cost).toBe("-120.0000");
  });

  const position: project.ContractPosition = {
    contractValue: "10000", budgetCost: "7000", billedToDate: "4000", scheduledValue: "9000",
    phase: null,
  };

  it("raises the contract and the budget, and the phase it lands on", () => {
    const decision = project.foldChangeOrder(
      { ...position, phase: { name: "Rough in", billingValue: "3000", budgetCost: "2000", billedAgainst: "1500" } },
      { amount: "1250", cost: "800" },
    );
    expect(decision).toEqual({
      ok: true, contractValue: "11250.0000", budgetCost: "7800.0000",
      phaseBillingValue: "4250.0000", phaseBudgetCost: "2800.0000",
    });
  });

  it("leaves a budget nobody set unset, rather than inventing one equal to the change", () => {
    const decision = project.foldChangeOrder({ ...position, budgetCost: null }, { amount: "500", cost: "300" });
    expect(decision.ok && decision.budgetCost).toBeNull();
  });

  it("refuses a change to a project with no agreed contract", () => {
    const decision = project.foldChangeOrder({ ...position, contractValue: null }, { amount: "500", cost: null });
    expect(decision.ok).toBe(false);
  });

  it("refuses a credit that names no phase", () => {
    const decision = project.foldChangeOrder(position, { amount: "-100", cost: null });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain("which phase it comes out of");
  });

  it("refuses a credit that takes the contract below what has been billed", () => {
    const decision = project.foldChangeOrder(
      { ...position, billedToDate: "9800", phase: { name: "Finish", billingValue: "3000", budgetCost: null, billedAgainst: "0" } },
      { amount: "-500", cost: null },
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain("already billed $9,800.00");
  });

  it("refuses a credit that takes a phase below what was billed against it", () => {
    const decision = project.foldChangeOrder(
      { ...position, phase: { name: "Finish", billingValue: "3000", budgetCost: null, billedAgainst: "2800" } },
      { amount: "-500", cost: null },
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain("already been billed against Finish");
  });

  it("gives back the contract as first agreed, from the log of agreed changes", () => {
    expect(project.originalContractSum("11250", ["1250", "-500", "500"])).toBe("10000.0000");
  });
});

describe("retainage on an application for payment", () => {
  /**
   * A 100,000 contract on two lines, 10% retainage on work and 5% on stored
   * materials. The previous application certified 20,000 of work on line 1
   * and had 5,000 of materials stored against line 2, and certified
   * 20,000 + 5,000 less retainage (2,000 + 250) = 22,750.
   *
   * This period: 10,000 more on line 1 and 8,000 installed on line 2, with
   * 2,000 of materials still stored there.
   *
   *   work to date     20,000 + 10,000 + 8,000 = 38,000
   *   stored now       2,000
   *   completed        40,000
   *   retainage        3,800 on work + 100 on stored = 3,900
   *   earned less ret  36,100
   *   payment due      36,100 - 22,750 = 13,350
   */
  const base: project.ApplicationInput = {
    lines: [
      { key: "a", description: "Rough in", scheduledValue: "60000", previousWork: "20000",
        previousStored: "0", workThisPeriod: "10000", storedNow: "0" },
      { key: "b", description: "Fixtures", scheduledValue: "40000", previousWork: "0",
        previousStored: "5000", workThisPeriod: "8000", storedNow: "2000" },
    ],
    contractSum: "100000",
    netChangeOrders: "4000",
    retainageRate: "0.1",
    storedRetainageRate: "0.05",
    retainageReleasedBefore: "0",
    retainageReleasedNow: "0",
    previousCertificates: "22750",
  };

  it("holds retainage on work and on stored materials at their own rates", () => {
    const result = project.computeApplication(base);
    if (!result.ok) throw new Error(result.problems.join(" "));
    expect(result.totals.totalCompletedAndStored).toBe("40000.0000");
    expect(result.totals.retainageOnWork).toBe("3800.0000");
    expect(result.totals.retainageOnStored).toBe("100.0000");
    expect(result.totals.totalRetainage).toBe("3900.0000");
    expect(result.totals.totalEarnedLessRetainage).toBe("36100.0000");
    expect(result.totals.currentPaymentDue).toBe("13350.0000");
    /** 100,000 less the 36,100 earned: the balance to finish includes the retainage still held. */
    expect(result.totals.balanceToFinish).toBe("63900.0000");
    expect(result.totals.originalContractSum).toBe("96000.0000");
  });

  it("reports each line the way the continuation sheet prints it", () => {
    const result = project.computeApplication(base);
    if (!result.ok) throw new Error(result.problems.join(" "));
    const fixtures = result.lines[1]!;
    expect(fixtures.completedAndStored).toBe("10000.0000");
    expect(fixtures.percentComplete).toBe("25.00");
    expect(fixtures.balanceToFinish).toBe("30000.0000");
    /** 10,000 now against 5,000 stored last time: 5,000 moved this period. */
    expect(fixtures.thisPeriod).toBe("5000.0000");
  });

  it("rounds retainage once on the total, to the cent", () => {
    /** 10% of 333.33 is 33.333, held as 33.33. */
    const result = project.computeApplication({
      ...base,
      lines: [{ key: "a", description: "All", scheduledValue: "1000", previousWork: "0",
        previousStored: "0", workThisPeriod: "333.33", storedNow: "0" }],
      contractSum: "1000", netChangeOrders: "0", previousCertificates: "0",
    });
    if (!result.ok) throw new Error(result.problems.join(" "));
    expect(result.totals.totalRetainage).toBe("33.3300");
    expect(result.totals.currentPaymentDue).toBe("300.0000");
  });

  it("releases retainage by lowering the rate, or by an amount, and refuses releasing more than is held", () => {
    const lowered = project.computeApplication({ ...base, retainageRate: "0.05" });
    if (!lowered.ok) throw new Error(lowered.problems.join(" "));
    /** 5% of 38,000 is 1,900, plus 100 on stored. */
    expect(lowered.totals.totalRetainage).toBe("2000.0000");

    const released = project.computeApplication({ ...base, retainageReleasedNow: "900" });
    if (!released.ok) throw new Error(released.problems.join(" "));
    expect(released.totals.totalRetainage).toBe("3000.0000");
    expect(released.totals.retainageReleased).toBe("900.0000");

    const tooMuch = project.computeApplication({ ...base, retainageReleasedNow: "5000" });
    expect(tooMuch.ok).toBe(false);
  });

  it("refuses a schedule of values that does not add up to the contract to date", () => {
    const result = project.computeApplication({ ...base, contractSum: "101000" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toContain("$1,000.00 short");
  });

  it("refuses a line billed past its value, and one that goes down, naming every one", () => {
    const result = project.computeApplication({
      ...base,
      lines: [
        { ...base.lines[0]!, workThisPeriod: "45000" },
        { ...base.lines[1]!, workThisPeriod: "0", storedNow: "1000" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.some((p) => p.startsWith("Rough in would be billed to $65,000.00"))).toBe(true);
    expect(result.problems.some((p) => p.startsWith("Fixtures was certified at $5,000.00"))).toBe(true);
  });
});

describe("the invoice an application becomes", () => {
  const input: project.ApplicationInput = {
    lines: [
      { key: "a", description: "Rough in", scheduledValue: "60000", previousWork: "20000",
        previousStored: "0", workThisPeriod: "10000", storedNow: "0" },
      { key: "b", description: "Fixtures", scheduledValue: "40000", previousWork: "0",
        previousStored: "5000", workThisPeriod: "8000", storedNow: "2000" },
    ],
    contractSum: "100000", netChangeOrders: "0",
    retainageRate: "0.1", storedRetainageRate: "0.05",
    retainageReleasedBefore: "0", retainageReleasedNow: "0",
    previousCertificates: "22750",
  };

  it("bills each line's movement net of its share of the retainage held, adding up to the payment due", () => {
    const application = project.computeApplication(input);
    if (!application.ok) throw new Error(application.problems.join(" "));
    /**
     * Retainage was 2,250 and is now 3,900: 1,650 held this period, shared
     * by movement 10,000 to 5,000, so 1,100 and 550.
     */
    const decision = project.paymentLines(application, "2250");
    if (!decision.ok) throw new Error(decision.reason);
    expect(decision.lines.map((l) => [l.key, l.amount])).toEqual([
      ["a", "8900.0000"],
      ["b", "4450.0000"],
    ]);
    expect(decision.total).toBe("13350.0000");
    expect(decision.lines[0]!.description).toContain("less $1,100.00 retainage held");
  });

  it("puts released retainage on a line of its own", () => {
    /** The final application: nothing more done, all 3,900 released. */
    const final = project.computeApplication({
      ...input,
      lines: input.lines.map((l) => ({
        ...l, previousWork: l.key === "a" ? "30000" : "8000", previousStored: l.key === "b" ? "2000" : "0",
        workThisPeriod: "0",
      })),
      retainageReleasedNow: "3900",
      previousCertificates: "36100",
    });
    if (!final.ok) throw new Error(final.problems.join(" "));
    expect(final.totals.currentPaymentDue).toBe("3900.0000");
    const decision = project.paymentLines(final, "3900");
    if (!decision.ok) throw new Error(decision.reason);
    expect(decision.lines).toEqual([expect.objectContaining({
      key: null, name: "Retainage released", amount: "3900.0000",
    })]);
  });

  it("refuses an application with nothing due", () => {
    const nothing = project.computeApplication({
      ...input,
      lines: input.lines.map((l) => ({ ...l, workThisPeriod: "0", storedNow: l.previousStored })),
      previousCertificates: "22750",
    });
    if (!nothing.ok) throw new Error(nothing.problems.join(" "));
    expect(project.paymentLines(nothing, "2250").ok).toBe(false);
  });

  it("allocates an awkward retainage without losing a cent", () => {
    /** Three equal movements of 100 with 10.00 held: 3.34, 3.33, 3.33. */
    const application = project.computeApplication({
      lines: ["a", "b", "c"].map((key) => ({
        key, description: key, scheduledValue: "100", previousWork: "0", previousStored: "0",
        workThisPeriod: "100", storedNow: "0",
      })),
      contractSum: "300", netChangeOrders: "0",
      retainageRate: "0.0333333", storedRetainageRate: "0",
      retainageReleasedBefore: "0", retainageReleasedNow: "0", previousCertificates: "0",
    });
    if (!application.ok) throw new Error(application.problems.join(" "));
    expect(application.totals.totalRetainage).toBe("10.0000");
    const decision = project.paymentLines(application, "0");
    if (!decision.ok) throw new Error(decision.reason);
    expect(decision.lines.map((l) => l.amount)).toEqual(["96.6600", "96.6700", "96.6700"]);
    expect(decision.total).toBe("290.0000");
  });
});

describe("the waiver checklist", () => {
  const payment = { invoiceId: "inv-1", label: "Application 1", amount: "13350", billedOn: "2026-11-30", paid: true };
  const waiver = (over: Partial<project.LienRecordLike>): project.LienRecordLike => ({
    id: "w", kind: "waiver", direction: "sent", condition: "conditional", scope: "progress",
    partyName: "Us", onDate: "2026-11-30", amount: "13350", invoiceId: "inv-1", ...over,
  });

  it("says plainly what is and is not on file, and nothing about the law", () => {
    const [none] = project.waiverChecklist([payment], []);
    expect(none!.notes).toEqual(["No waiver is on file against this payment."]);

    const [conditionalOnly] = project.waiverChecklist([payment], [waiver({})]);
    expect(conditionalOnly!.conditional).toHaveLength(1);
    expect(conditionalOnly!.notes).toEqual(["Paid, and only a conditional waiver is on file."]);

    const [both] = project.waiverChecklist([payment], [
      waiver({}), waiver({ id: "u", condition: "unconditional", amount: "13000" }),
    ]);
    expect(both!.notes).toEqual([
      "The unconditional waiver from Us is for $13,000.00, and this payment is $13,350.00.",
    ]);
  });

  it("does not count a notice as a waiver", () => {
    const [row] = project.waiverChecklist([payment], [
      waiver({ kind: "notice", condition: null, scope: null }),
    ]);
    expect(row!.notes).toEqual(["No waiver is on file against this payment."]);
  });
});
