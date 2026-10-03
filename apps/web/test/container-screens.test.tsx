import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Numbers, Register, Hires, Overage,
  type Report, type ContainerRow, type HireRow,
} from "../src/app/(app)/fleet/containers/ContainerView";
import { NAV } from "../src/lib/nav";

const report = (over: Partial<Report> = {}): Report => ({
  from: "2026-06-01", to: "2026-06-30", windowDays: 30,
  utilisationRate: "68.7", rentedDays: 412, availableDays: 600, outOfServiceUnits: 2,
  averageDurationDays: "6.40", rentalsEnded: 25,
  averageTonsPerHaul: "2.85", haulsWithTicket: 22, haulsWithoutTicket: 3,
  overageCaptureRate: "80.0", exceededRentals: 10, billableRentals: 8,
  ...over,
});

const container = (over: Partial<ContainerRow> = {}): ContainerRow => ({
  id: "c1", assetType: "roll_off_container", identifier: "4001", size: "20 yard",
  status: "available", currentAddress: null, active: true, ...over,
});

const hire = (over: Partial<HireRow> = {}): HireRow => ({
  id: "r1", assetIdentifier: "4001", assetSize: "20 yard", propertyAddress: "14 Elm, Austin",
  deliveredAt: "2026-06-01T15:00:00.000Z", pickedUpAt: null, open: true,
  daysSoFar: 4, includedDays: 7, dailyRate: "12.0000", weightTons: null, includedTons: "2.0000",
  disposalTicketNumber: null, previousRentalId: null, ...over,
});

/** M22's RENTAL HALF ON A SCREEN: THE RATIO IS THE DAILY QUESTION */
describe("the container fleet", () => {
  it("shows each figure with what it is made of", () => {
    /**
     * A utilisation rate on its own is a number somebody either believes or does
     * not. "412 rented days of 600 available" is one they can check against the
     * board, which is the only way a fleet metric earns a purchase decision.
     */
    const html = renderToStaticMarkup(<Numbers report={report()} />);
    expect(html).toContain("68.7%");
    expect(html).toContain("412 rented days of 600 available");
    /** Including the units that are out, because they are why the rate is low. */
    expect(html).toContain("2 out for repair");
    expect(html).toContain("6.40 days");
    expect(html).toContain("22 with a scale ticket");
    expect(html).toContain("3 without one");
  });

  it("says nothing to measure rather than nought per cent for an empty fleet", () => {
    /**
     * An empty fleet is not nought per cent utilised and a month with no hauls
     * has no average tonnage. Reporting either as zero sends an owner looking for
     * a problem in a report that is working correctly.
     */
    const html = renderToStaticMarkup(<Numbers report={report({
      utilisationRate: null, averageTonsPerHaul: null, averageDurationDays: null,
      overageCaptureRate: null, rentedDays: 0, availableDays: 0, haulsWithTicket: 0,
      haulsWithoutTicket: 0, rentalsEnded: 0, exceededRentals: 0, billableRentals: 0,
    })} />);
    expect(html).not.toContain("0.0%");
    expect(html.match(/Nothing to measure/g)).toHaveLength(4);
  });

  it("says where each can is by address, and marks one out for repair", () => {
    const html = renderToStaticMarkup(<Register containers={[
      container({ identifier: "4001", status: "on_site", currentAddress: "14 Elm, Austin" }),
      container({ id: "c2", identifier: "4002" }),
      container({ id: "c3", identifier: "4003", status: "out_of_service", size: "30 yard" }),
    ]} />);
    expect(html).toContain("On a site");
    expect(html).toContain("14 Elm, Austin");
    expect(html).toContain("In the yard");
    /** The one thing that changes the utilisation denominator, so it is named. */
    expect(html).toContain("Out for repair");
    expect(html).toContain("Roll off");
  });

  it("heads the days column so nobody bills from a number that moves", () => {
    /**
     * For an open hire the figure is counted to today and changes every midnight.
     * A column headed "Days" with a number that moves is the one somebody copies
     * onto an invoice, so the header says what it is.
     */
    const html = renderToStaticMarkup(<Hires hires={[hire()]} />);
    expect(html).toContain("Days so far");
    expect(html).toContain("of 7");
    expect(html).toContain("Still out");
  });

  it("marks a hire that has passed its included period", () => {
    /**
     * Unbilled days are the leak this trade is known for, and today an operator
     * finds them by reading two columns and doing the subtraction.
     */
    const over = renderToStaticMarkup(<Hires hires={[hire({ daysSoFar: 9, includedDays: 7 })]} />);
    expect(over).toContain("Over");
    const within = renderToStaticMarkup(<Hires hires={[hire({ daysSoFar: 7, includedDays: 7 })]} />);
    expect(within).not.toContain(">Over<");
  });

  it("marks a swap, so a chain of them is not four separate hires", () => {
    /**
     * Without the link a four week construction hire with three swaps reads as
     * four unrelated week long rentals, and the pack's average duration comes out
     * at a quarter of the truth.
     */
    const html = renderToStaticMarkup(<Hires hires={[hire({ previousRentalId: "r0" })]} />);
    expect(html).toContain("Swap");
  });

  it("calls out a collected hire with no scale ticket", () => {
    /**
     * The ticket is the support behind the largest line on the invoice and the
     * largest line in the cost of goods. A closed hire without one is a figure
     * nobody can defend when a customer questions the tonnage.
     */
    const html = renderToStaticMarkup(<Hires hires={[hire({
      open: false, pickedUpAt: "2026-06-05T15:00:00.000Z", disposalTicketNumber: null,
    })]} />);
    expect(html).toContain("No ticket");
  });

  it("keeps the two meters apart rather than summing them into one line", () => {
    /**
     * One is a scheduling argument and the other is a scale ticket. An operator
     * disputing a figure needs them separately, and a single total shows neither.
     */
    const html = renderToStaticMarkup(<Overage days={9} total="54.0000" lines={[
      { meter: "rental_days", overBy: "2", rate: "12.0000", amount: "24.0000" },
      { meter: "disposal_tons", overBy: "0.5", rate: "60.0000", amount: "30.0000" },
    ]} />);
    expect(html).toContain("9 container days");
    expect(html).toContain("Extra days");
    expect(html).toContain("Extra tonnage");
    expect(html).toContain("$24.00");
    expect(html).toContain("$30.00");
    expect(html).toContain("$54.00");
  });

  it("says nothing is owed rather than showing an empty list", () => {
    const html = renderToStaticMarkup(<Overage days={5} total="0.0000" lines={[]} />);
    expect(html).toContain("Nothing beyond what was quoted");
  });

  it("is a child of Fleet rather than a filter on it", () => {
    const fleet = NAV.flatMap((g) => g.items).find((i) => i.href === "/fleet");
    expect(fleet?.children?.map((c) => c.href)).toEqual(["/fleet", "/fleet/containers", "/fleet/containers/tickets"]);
    expect(fleet?.permission).toBe("asset:read");
  });
});
