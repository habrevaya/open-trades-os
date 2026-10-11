import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RoutePreview, type Proposal } from "../src/app/(app)/schedule/Proposals";

/**
 * A DRIVER'S DAY THROUGH THE DISPOSAL FACILITY, AS MARKUP
 *
 * The preview names the facility, each run to it with the time the truck gets
 * there, and a run that reaches it after it has closed in the words the service
 * refused it with.
 */

const V1 = "00000000-0000-4000-8000-000000000011";
const V2 = "00000000-0000-4000-8000-000000000012";
const names = new Map([[V1, "Dana Whitfield"], [V2, "Tolu Okafor"]]);

const summary = { order: [V1, V2], driveMinutes: 40, waitMinutes: 0, lateCount: 0, lateMinutes: 0, finishAt: "2026-10-05T22:00:00.000Z" };
const proposal = (truck: Partial<NonNullable<Proposal["truck"]>>): Proposal => ({
  technicianId: V1, date: "2026-10-05", startKnown: true, startLabel: "Yard",
  current: summary, proposed: summary, improved: false, missed: [], locked: [], pinned: [], unplaced: [],
  applyOrder: [V1, V2], declaredLegs: 0, travel: { averageKmh: 40, roadFactor: 1.3, dayStartsAt: "08:00" },
  driveSource: "estimate", driveNote: "estimates",
  truck: {
    byTruck: true, note: "Ordered by what is on the truck.", containersPerTruck: 1, yardMinutes: 20,
    source: "company", truckLabel: null, kindName: null, sizes: [], notCarried: [],
    facility: { id: V1, name: "Austin Transfer", address: "9 Landfill Rd, Austin, TX", hoursText: "Mon to Fri 7:00 AM to 4:30 PM", tipMinutes: 15, used: true, note: "Full containers are tipped at Austin Transfer, 9 Landfill Rd, Austin, TX. Mon to Fri 7:00 AM to 4:30 PM." },
    facilityRuns: [], currentYardRuns: 0, yardRuns: [], startLoad: { empties: 0, fulls: 0 },
    ...truck,
  },
} as unknown as Proposal);

const show = (p: Proposal) => renderToStaticMarkup(
  <RoutePreview proposal={p} technicianName="Ray Ortiz" customerOf={names} canApply onApply={() => {}} onClose={() => {}} />,
);

describe("the route through the disposal facility", () => {
  it("names the facility, its address and hours, and each run to it", () => {
    const html = show(proposal({
      facilityRuns: [{ afterVisitId: V1, beforeVisitId: V2, tipped: 1, arriveAt: "2026-10-05T16:30:00.000Z", waitMinutes: 0, closed: null }],
    }));
    expect(html).toContain("Full containers are tipped at Austin Transfer, 9 Landfill Rd, Austin, TX.");
    expect(html).toContain("After Dana Whitfield: to Austin Transfer to tip the full container");
    expect(html).toContain("then Tolu Okafor.");
  });

  it("shows a run that would reach a closed gate in the service's words, and a wait for the gate", () => {
    const html = show(proposal({
      facilityRuns: [
        { afterVisitId: V1, beforeVisitId: V2, tipped: 1, arriveAt: "2026-10-05T22:40:00.000Z", waitMinutes: 0,
          closed: "Austin Transfer is closed at 5:40 PM on Monday: it is open 7:00 AM to 4:30 PM that day." },
        { afterVisitId: V2, beforeVisitId: null, tipped: 2, arriveAt: "2026-10-05T12:00:00.000Z", waitMinutes: 25, closed: null },
      ],
    }));
    expect(html).toContain("Austin Transfer is closed at 5:40 PM on Monday");
    expect(html).toContain("to tip 2 full containers at the end of the day");
    expect(html).toContain("About 25 min waiting for the gate to open.");
  });

  it("says when the facility is not on the map and the yard tipped instead", () => {
    const html = show(proposal({
      facility: { id: V1, name: "Austin Transfer", address: "", hoursText: "Hours not recorded", tipMinutes: 20, used: false,
        note: "Austin Transfer is not on the map yet, so this day was planned as if the yard tips. Place its pin on Disposal facilities." },
    }));
    expect(html).toContain("not on the map yet");
  });
});
