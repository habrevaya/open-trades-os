import { describe, it, expect } from "vitest";
import { deadlines } from "../src/index";

/**
 * THE CLOCKS A CONTRACT STARTS
 *
 * One primitive for SLAs, invoicing windows and claim deadlines. What matters
 * is that each clock starts at the right fact, is met by the right fact, and
 * exists only when the contract and the job say it should.
 */
const received = new Date("2026-10-06T14:00:00Z");
const terms: deadlines.ClockTerms = {
  sla: [
    { kind: "respond", minutes: 120 },
    { kind: "arrive", minutes: 240 },
    { kind: "arrive", minutes: 60, priority: "emergency" },
    { kind: "complete", minutes: 1440 },
  ],
  invoiceWithinDays: 30,
  claimWithinDays: 60,
};

const facts = (over: Partial<deadlines.JobFacts> = {}): deadlines.JobFacts => ({
  receivedAt: received, priority: 0,
  respondedAt: null, arrivedAt: null, completedAt: null, invoicedAt: null, claimFiledAt: null,
  billsThirdParty: false,
  ...over,
});

const kinds = (clocks: deadlines.Clock[]) => clocks.map((c) => c.kind);

describe("the SLA clocks", () => {
  it("start when the work arrived", () => {
    const clocks = deadlines.clocksFor(terms, facts());
    expect(kinds(clocks)).toEqual(["sla.respond", "sla.arrive", "sla.complete"]);
    expect(clocks[1]!.dueAt.toISOString()).toBe("2026-10-06T18:00:00.000Z");
    expect(clocks.every((c) => c.metAt === null)).toBe(true);
  });

  it("run shorter for an emergency when the contract says so", () => {
    const arrive = deadlines.clocksFor(terms, facts({ priority: 2 })).find((c) => c.kind === "sla.arrive")!;
    expect(arrive.dueAt.toISOString()).toBe("2026-10-06T15:00:00.000Z");
  });

  it("are met by the fact, and say which", () => {
    const arrived = new Date("2026-10-06T16:30:00Z");
    const arrive = deadlines.clocksFor(terms, facts({ arrivedAt: arrived })).find((c) => c.kind === "sla.arrive")!;
    expect(arrive.metAt).toEqual(arrived);
    expect(arrive.metBy).toMatch(/technician arrived/);
  });

  it("warn a quarter of the window before, and never less than fifteen minutes", () => {
    const respond = deadlines.clocksFor(terms, facts()).find((c) => c.kind === "sla.respond")!;
    expect(respond.escalateAt.toISOString()).toBe("2026-10-06T15:30:00.000Z");
    const tight = deadlines.escalateAtFor(received, new Date(received.getTime() + 20 * 60_000));
    expect(tight.toISOString()).toBe("2026-10-06T14:05:00.000Z");
  });
});

describe("the money clocks", () => {
  it("do not exist until the work is finished", () => {
    expect(kinds(deadlines.clocksFor(terms, facts({ billsThirdParty: true })))).not.toContain("invoice.submit_by");
  });

  it("count the invoicing window from the finish", () => {
    const done = new Date("2026-10-07T20:00:00Z");
    const invoice = deadlines.clocksFor(terms, facts({ completedAt: done })).find((c) => c.kind === "invoice.submit_by")!;
    expect(invoice.dueAt.toISOString()).toBe("2026-11-06T20:00:00.000Z");
  });

  it("raise a claim clock only when somebody else is paying", () => {
    const done = new Date("2026-10-07T20:00:00Z");
    expect(kinds(deadlines.clocksFor(terms, facts({ completedAt: done })))).not.toContain("claim.file_by");
    const claim = deadlines.clocksFor(terms, facts({ completedAt: done, billsThirdParty: true }))
      .find((c) => c.kind === "claim.file_by")!;
    expect(claim.consequence).toMatch(/60 days/);
  });
});

describe("the terms", () => {
  it("are refused when nobody could be held to them", () => {
    expect(deadlines.termsProblem({ ...terms, sla: [{ kind: "acknowledge", minutes: 60 }] })).toMatch(/respond, arrive or complete/);
    expect(deadlines.termsProblem({ ...terms, sla: [{ kind: "arrive", minutes: 0 }] })).toMatch(/not one anybody/);
    expect(deadlines.termsProblem({ ...terms, sla: [{ kind: "arrive", minutes: 60 }, { kind: "arrive", minutes: 90 }] })).toMatch(/Two arrive/);
    expect(deadlines.termsProblem({ ...terms, invoiceWithinDays: -1 })).toMatch(/not a window/);
    expect(deadlines.termsProblem(terms)).toBeNull();
  });
});
