import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Crews, OnCall, type CrewRow } from "../src/app/(app)/schedule/crews/CrewView";
import { Routes, Stops, Fit, type RouteRow, type DensityRow } from "../src/app/(app)/schedule/routes/RouteView";
import { Plans, Bases, type PlanRow } from "../src/app/(app)/payroll/commissions/CommissionView";
import { labor } from "@opentradesos/core";
import { NAV } from "../src/lib/nav";

const at = (iso: string) => iso.slice(0, 16).replace("T", " ");

const crew = (over: Partial<CrewRow> = {}): CrewRow => ({
  id: "c1", name: "Tree crew", productionRatePerDay: null, productionUnit: null,
  skills: [], color: null, active: true,
  members: [{ technicianId: "t1", displayName: "Ana Reyes", isLead: true, active: true }],
  ...over,
});

const route = (over: Partial<RouteRow> = {}): RouteRow => ({
  id: "r1", name: "Tuesday north", dayName: "Tuesday", technicianId: "t1", crewId: null,
  targetStopCount: 14, startsAt: "07:30", travelMinutesBetweenStops: 8,
  stopCount: 15, active: true, ...over,
});

const density = (over: Partial<DensityRow> = {}): DensityRow => ({
  stopCount: 15, targetStopCount: 14, overTarget: true,
  serviceMinutes: 360, travelMinutes: 112, totalMinutes: 472, travelDeclared: true,
  travelSource: "declared", travelComplete: true,
  travelNote: "The route's own drive time, 8 minutes between stops.",
  overtimeAfterMinutes: 480, minutesOverThreshold: null, runsIntoOvertime: false,
  explanation: "Eight minutes between fifteen stops at twenty four minutes each.",
  ...over,
});

/** CREWS, ROUTES AND COMMISSION PLANS: THREE THINGS THAT HAD NO SCREEN */
describe("crews and the rota", () => {
  it("names the lead, because the lead is who the office rings", () => {
    const html = renderToStaticMarkup(<Crews crews={[crew()]} />);
    expect(html).toContain("Ana Reyes");
    expect(html).toContain("lead");
  });

  it("calls out a crew with people and no lead", () => {
    /** A crew without one looks complete on every other screen. */
    const html = renderToStaticMarkup(<Crews crews={[crew({
      members: [{ technicianId: "t1", displayName: "Ana Reyes", isLead: false, active: true }],
    })]} />);
    expect(html).toContain("No lead");
  });

  it("calls out somebody on a crew who is no longer active", () => {
    const html = renderToStaticMarkup(<Crews crews={[crew({
      members: [{ technicianId: "t1", displayName: "Departed Sam", isLead: true, active: false }],
    })]} />);
    expect(html).toContain("no longer active");
  });

  it("shows a production rate only with its unit", () => {
    /**
     * "Eight hundred a day" is not a number anybody can schedule with: it is
     * eight hundred square feet, or linear feet, or cubic yards, and the three
     * are different jobs. The service refuses one without the other.
     */
    const both = renderToStaticMarkup(<Crews crews={[crew({
      productionRatePerDay: "800.0000", productionUnit: "square feet",
    })]} />);
    /**
     * Trimmed. The column is `numeric(14,4)` like every other number here, so the
     * value arrives as "800.0000" and the first version of this screen printed it,
     * which a browser test caught. Four decimals are right for money and wrong for
     * a count of square feet: an operator reads it as a system that does not know
     * what it is measuring.
     */
    expect(both).toContain("800 square feet a day");
    expect(both).not.toContain("800.0000");

    /** A half kept, because half a linear foot an hour is a real cadence. */
    const half = renderToStaticMarkup(<Crews crews={[crew({
      productionRatePerDay: "12.5000", productionUnit: "linear feet",
    })]} />);
    expect(half).toContain("12.5 linear feet a day");

    const neither = renderToStaticMarkup(<Crews crews={[crew()]} />);
    expect(neither).toContain("Not declared");
  });

  it("says nobody is on call in words rather than leaving a blank", () => {
    /**
     * A blank where a name should be reads as "fine" to the person looking at it.
     * The honest reading is that a call tonight reaches no one.
     */
    const html = renderToStaticMarkup(
      <OnCall now={null} shifts={[]} zone="UTC" formatAt={at} windowDays={30} />,
    );
    expect(html).toContain("Nobody is on call right now");
    expect(html).toContain("reaches no one");
  });

  it("says how far ahead the rota list looks", () => {
    /**
     * The service windows the rota deliberately: a rotation table is one row per
     * weekend forever. But an empty list with no window stated is ambiguous
     * between "nobody is scheduled" and "nothing in the next month", and a browser
     * test hit exactly that: a shift scheduled outside the window read as no rota
     * at all.
     */
    const empty = renderToStaticMarkup(
      <OnCall now={null} shifts={[]} zone="UTC" formatAt={at} windowDays={30} />,
    );
    expect(empty).toContain("Nothing rostered in the next 30 days");

    const full = renderToStaticMarkup(<OnCall
      now={{ technicianName: "Ana Reyes" }} zone="UTC" formatAt={at} windowDays={30}
      shifts={[{ id: "s1", technicianId: "t1", technicianName: "Ana Reyes",
        startsAt: "2026-06-05T18:00:00.000Z", endsAt: "2026-06-08T06:00:00.000Z",
        rateMultiplier: null }]}
    />);
    expect(full).toContain("The next 30 days.");
  });

  it("shows a shift with no multiplier as normal rather than as blank", () => {
    const html = renderToStaticMarkup(<OnCall
      now={{ technicianName: "Ana Reyes" }}
      zone="UTC" formatAt={at} windowDays={30}
      shifts={[
        { id: "s1", technicianId: "t1", technicianName: "Ana Reyes",
          startsAt: "2026-06-05T18:00:00.000Z", endsAt: "2026-06-08T06:00:00.000Z",
          rateMultiplier: "1.5" },
        { id: "s2", technicianId: "t2", technicianName: "Ben Cole",
          startsAt: "2026-06-08T06:00:00.000Z", endsAt: "2026-06-12T18:00:00.000Z",
          rateMultiplier: null },
      ]}
    />);
    expect(html).toContain("On call now:");
    expect(html).toContain("1.5");
    expect(html).toContain("Normal");
  });

  it("is under Schedule in the navigation", () => {
    const schedule = NAV.flatMap((g) => g.items).find((i) => i.href === "/schedule");
    expect(schedule?.children?.map((c) => c.href)).toContain("/schedule/crews");
  });
});

describe("service routes", () => {
  it("puts the weekday on the row, because a route is a weekday", () => {
    const html = renderToStaticMarkup(<Routes routes={[route()]} servicerName={() => "Ana Reyes"} />);
    expect(html).toContain("Tuesday");
    expect(html).toContain("15");
    expect(html).toContain("of 14");
  });

  it("says who drives it rather than leaving the cell blank", () => {
    /**
     * Exactly one servicer by construction: a route with neither materialises
     * visits nobody is responsible for, which looks exactly like unassigned work
     * and will sit there. Saying "nobody" is how one would be noticed.
     */
    const html = renderToStaticMarkup(<Routes routes={[route({ technicianId: null })]}
                                              servicerName={(r) => r.technicianId ? "Ana" : "nobody"} />);
    expect(html).toContain("nobody");
  });

  it("answers the fit question with three values, not two", () => {
    /**
     * Null is a real answer: the question cannot be settled from what the company
     * has declared, which is a different thing from a day that fits. Rendering
     * null as "fits" is the mistake this screen exists to avoid.
     */
    const fits = renderToStaticMarkup(<Fit density={density()} />);
    expect(fits).toContain("Fits the working day");

    const over = renderToStaticMarkup(<Fit density={density({
      runsIntoOvertime: true, minutesOverThreshold: 40,
    })} />);
    expect(over).toContain("Runs into overtime by 40 minutes");

    const unknown = renderToStaticMarkup(<Fit density={density({
      runsIntoOvertime: null, overtimeAfterMinutes: null,
    })} />);
    expect(unknown).toContain("Cannot tell from what has been declared");
    expect(unknown).not.toContain("Fits the working day");
  });

  it("calls an undeclared drive a floor rather than treating it as zero", () => {
    /** Treating the drive as zero tells somebody a fifteen stop day fits. */
    const html = renderToStaticMarkup(<Fit density={density({
      travelDeclared: false, travelSource: "none", travelComplete: false, travelMinutes: null,
      totalMinutes: 360, runsIntoOvertime: null,
    })} />);
    expect(html).toContain("driving not declared");
    expect(html).toContain("At least 360 minutes");
  });

  it("says the drive is by road when it is, and a floor when some of it could not be counted", () => {
    const road = renderToStaticMarkup(<Fit density={density({
      travelDeclared: false, travelSource: "road", travelComplete: true, travelMinutes: 95, totalMinutes: 455,
      travelNote: "By road between the stops in their order, and out from where the day starts and back, from your OSRM server.",
    })} />);
    expect(road).toContain("95 minutes driving by road");
    expect(road).toContain("from your OSRM server");
    expect(road).not.toContain("At least");

    const partly = renderToStaticMarkup(<Fit density={density({
      travelDeclared: false, travelSource: "road", travelComplete: false, travelMinutes: 80, totalMinutes: 440,
      runsIntoOvertime: null,
    })} />);
    expect(partly).toContain("at least 80 minutes driving by road");
    expect(partly).toContain("At least 440 minutes");
  });

  it("shows a stop that is not due with its date rather than hiding it", () => {
    /**
     * `nextDueOn` is counted from the last visit ACTUALLY serviced, so a stop can
     * be on a route and not due today. Somebody looking at a short day needs to
     * see why.
     */
    const html = renderToStaticMarkup(<Stops stops={[
      { id: "s1", propertyId: "p1", addressLine1: "14 Elm", sequence: 1, estimatedMinutes: 24,
        intervalDays: 14, lastServicedOn: "2026-05-28", nextDueOn: "2026-06-11",
        pricePerStop: "65.0000", active: true },
      { id: "s2", propertyId: "p2", addressLine1: "9 Oak", sequence: 2, estimatedMinutes: null,
        intervalDays: null, lastServicedOn: null, nextDueOn: null, pricePerStop: null,
        active: false },
    ]} />);
    expect(html).toContain("2026-06-11");
    expect(html).toContain("last 2026-05-28");
    expect(html).toContain("$65.00");
    expect(html).toContain("Whenever the route runs");
    expect(html).toContain("Skipped");
  });

  it("is under Schedule in the navigation", () => {
    const schedule = NAV.flatMap((g) => g.items).find((i) => i.href === "/schedule");
    expect(schedule?.children?.map((c) => c.href)).toContain("/schedule/routes");
  });
});

describe("commission plans", () => {
  const plan = (over: Partial<PlanRow> = {}): PlanRow => ({
    id: "p1", label: "Service commission", basis: "percent_of_revenue",
    rate: "0.08", flatAmount: null,
    note: "Eight per cent of what the job invoiced, paid when the invoice is paid.",
    active: true, wrongAbout: "It rewards selling the expensive option, not the right one.",
    ...over,
  });

  it("shows a rate as a percentage, not as the stored decimal", () => {
    /** "0.08" on a screen about pay is a number somebody reads as eight dollars. */
    const html = renderToStaticMarkup(<Plans plans={[plan()]} />);
    expect(html).toContain("8%");
    expect(html).not.toContain("0.08");
  });

  it("shows a flat amount as money", () => {
    const html = renderToStaticMarkup(<Plans plans={[plan({
      basis: "flat_per_job", rate: null, flatAmount: "45.0000",
    })]} />);
    expect(html).toContain("$45.00");
  });

  it("carries what the basis is wrong about onto every plan", () => {
    /**
     * The service publishes `wrongAbout` with the plan rather than keeping it for
     * a help page, and this screen keeps it there. Somebody picking a basis is
     * writing the instruction their technicians follow for years.
     */
    const html = renderToStaticMarkup(<Plans plans={[plan()]} />);
    expect(html).toContain("rewards selling the expensive option");
  });

  it("marks a superseded plan rather than hiding it", () => {
    /**
     * Earned rows freeze the basis and the rate, so a superseded plan is the
     * explanation of money already paid. Hiding it would leave those numbers
     * unexplained.
     */
    const html = renderToStaticMarkup(<Plans plans={[plan({ active: false })]} />);
    expect(html).toContain("Superseded");
  });

  it("offers no edit control, because a plan is superseded rather than edited", () => {
    /**
     * Editing one reprices commissions already earned and, on a plan edited
     * downward, already paid. The service has no edit; neither does the screen.
     */
    const html = renderToStaticMarkup(<Plans plans={[plan()]} controls={() => null} />);
    expect(html).not.toContain("Edit");
  });

  it("shows every basis with its caveat and what it needs", () => {
    const bases = labor.COMMISSION_BASES.map((key) => {
      const spec = labor.COMMISSION_BASIS[key];
      return { key, label: spec.label, meaning: spec.meaning, wrongAbout: spec.wrongAbout, needs: spec.needs };
    });
    const html = renderToStaticMarkup(<Bases bases={bases} />);
    /** All four, so a basis added to core cannot be missing from the choice. */
    for (const basis of bases) {
      expect(html).toContain(basis.label);
      expect(html).toContain("Rewards instead:");
    }
    expect(html).toContain("Needs:");
  });

  it("is under Payroll in the navigation", () => {
    const payroll = NAV.flatMap((g) => g.items).find((i) => i.href === "/payroll");
    expect(payroll?.children?.map((c) => c.href)).toContain("/payroll/commissions");
  });
});
