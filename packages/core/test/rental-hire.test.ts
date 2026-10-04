import { describe, it, expect } from "vitest";
import * as rt from "../src/rental/index.js";

/**
 * A HIRE AFTER THE CAN HAS GONE OUT: when it is due back, what the period
 * bills as, and a facility's file of scale tickets.
 */
const ZONE = "America/Chicago";

describe("when a hire is due back", () => {
  it("is the last day the price covers, counting the delivery day as day one", () => {
    // 7pm Central on 31 May is 1 June in UTC; the hire still started on 31 May.
    expect(rt.collectionDueOn(new Date("2026-06-01T00:00:00Z"), 7, ZONE)).toBe("2026-06-06");
    expect(rt.collectionDueOn(new Date("2026-06-01T17:00:00Z"), 7, ZONE)).toBe("2026-06-07");
    expect(rt.collectionDueOn(new Date("2026-06-01T17:00:00Z"), 1, ZONE)).toBe("2026-06-01");
    expect(rt.collectionDueOn(new Date("2026-06-01T17:00:00Z"), null, ZONE)).toBeNull();
  });

  it("schedules what is due by the date asked, late ones today, and nothing twice", () => {
    const delivered = new Date("2026-06-01T17:00:00Z");
    const result = rt.collectionsDue({
      hires: [
        { id: "due", deliveredAt: delivered, includedDays: 7, collectionVisitId: null },
        { id: "late", deliveredAt: new Date("2026-05-20T17:00:00Z"), includedDays: 7, collectionVisitId: null },
        { id: "later", deliveredAt: delivered, includedDays: 28, collectionVisitId: null },
        { id: "booked", deliveredAt: delivered, includedDays: 7, collectionVisitId: "V" },
        { id: "standing", deliveredAt: delivered, includedDays: null, collectionVisitId: null },
      ],
      through: "2026-06-07",
      today: "2026-06-03",
      zone: ZONE,
    });
    expect(result.schedule).toEqual([
      { rentalId: "late", dueOn: "2026-05-26", collectOn: "2026-06-03", daysLate: 8, agreed: false },
      { rentalId: "due", dueOn: "2026-06-07", collectOn: "2026-06-07", daysLate: 0, agreed: false },
    ]);
    expect(result.skipped.map((s) => s.rentalId).sort()).toEqual(["booked", "standing"]);
  });

  it("goes on the day agreed with the customer, early or late, and a standing hire with one is collected", () => {
    const delivered = new Date("2026-06-01T17:00:00Z");
    const result = rt.collectionsDue({
      hires: [
        /** Finished early: due on the seventh, collected on the fourth as asked. */
        { id: "early", deliveredAt: delivered, includedDays: 7, collectionVisitId: null, agreedOn: "2026-06-04" },
        /** Asked for two more days: not on the seventh, and not inside this run at all. */
        { id: "extended", deliveredAt: delivered, includedDays: 7, collectionVisitId: null, agreedOn: "2026-06-09" },
        { id: "standing", deliveredAt: delivered, includedDays: null, collectionVisitId: null, agreedOn: "2026-06-05" },
        /** An agreed day that has passed is today, and late from that day. */
        { id: "missed", deliveredAt: delivered, includedDays: 28, collectionVisitId: null, agreedOn: "2026-06-02" },
      ],
      through: "2026-06-07",
      today: "2026-06-03",
      zone: ZONE,
    });
    expect(result.schedule).toEqual([
      { rentalId: "missed", dueOn: "2026-06-28", collectOn: "2026-06-03", daysLate: 1, agreed: true },
      { rentalId: "early", dueOn: "2026-06-07", collectOn: "2026-06-04", daysLate: 0, agreed: true },
      { rentalId: "standing", dueOn: null, collectOn: "2026-06-05", daysLate: 0, agreed: true },
    ]);
    expect(result.skipped).toEqual([]);
  });
});

describe("the rental period line", () => {
  it("bills days inside the included period at the day rate and leaves the rest to the overage meter", () => {
    expect(rt.periodLine({ days: 10, includedDays: 7, dailyRate: "15.50" })).toEqual({ days: 7, rate: "15.50", amount: "108.5000" });
    expect(rt.periodLine({ days: 3, includedDays: 7, dailyRate: "15.50" })).toEqual({ days: 3, rate: "15.50", amount: "46.5000" });
    expect(rt.periodLine({ days: 40, includedDays: null, dailyRate: "9.50" })?.days).toBe(40);
  });

  it("has no line when the hire is priced by the job's own flat line", () => {
    expect(rt.periodLine({ days: 10, includedDays: 7, dailyRate: null })).toBeNull();
  });
});

describe("a facility's scale tickets", () => {
  it("reads net tons, net pounds, or gross and tare, under the headers facilities use", () => {
    const tons = rt.parseScaleTickets("Ticket #,Date,Can No,Net Tons,Material\nT1,6/14/2026,4012,3.1,C&D\n");
    expect(tons.rows[0]).toMatchObject({ ticketNumber: "T1", date: "2026-06-14", container: "4012", netTons: "3.1000", material: "C&D" });

    const lbs = rt.parseScaleTickets("ticket,weigh date,container,gross lbs,tare lbs\nT2,2026-06-15,\"4,013\",\"36,400\",\"28,200\"\n");
    expect(lbs.rows[0]).toMatchObject({ ticketNumber: "T2", netTons: "4.1000", container: "4,013" });
  });

  it("refuses a file with no weight column, and a row it cannot read, with the line", () => {
    expect(rt.parseScaleTickets("ticket,date,container\nT1,2026-06-14,4012").problems[0]!.message).toContain("weight");
    const bad = rt.parseScaleTickets("ticket,date,container,net tons\nT1,14/06/2026,4012,3\nT2,2026-06-14,4012,heavy\n");
    expect(bad.rows).toEqual([]);
    expect(bad.problems.map((p) => p.line)).toEqual([2, 3]);
  });

  it("matches a ticket to the haul on its day or the day before, and never overwrites", () => {
    const parsed = rt.parseScaleTickets([
      "ticket,date,container,net tons",
      "A1,2026-06-15,4012,3.1", // weighed the morning after a collection
      "A2,2026-06-14,4013,2.0", // a different ticket already on that haul
      "A3,2026-06-14,4014,5.5", // typed in at a different weight
      "A4,2026-06-14,9999,1.0", // no such haul
      "A1,2026-06-15,4012,3.1", // twice in the file
      "A5,2026-06-14,4015,1.25", // already on the haul at the same weight
    ].join("\n"));
    const plans = rt.planTickets(parsed.rows, [
      { rentalId: "R12", container: "4012", collectedOn: "2026-06-14", ticketNumber: null, weightTons: null },
      { rentalId: "R13", container: "4013", collectedOn: "2026-06-14", ticketNumber: "OLD", weightTons: "2.0" },
      { rentalId: "R14", container: "4014", collectedOn: "2026-06-14", ticketNumber: null, weightTons: "4.5" },
      { rentalId: "R15", container: "4015", collectedOn: "2026-06-14", ticketNumber: "A5", weightTons: "1.25" },
    ]);
    expect(plans.map((p) => p.action)).toEqual(["attach", "skip", "skip", "skip", "skip", "unchanged"]);
    expect(plans[0]).toMatchObject({ rentalId: "R12" });
    expect(plans[1]!.why).toContain("already carries ticket OLD");
    expect(plans[2]!.why).toContain("4.5");
    expect(plans[3]!.why).toContain("No collection or swap");
    expect(plans[4]!.why).toContain("twice");
  });
});
