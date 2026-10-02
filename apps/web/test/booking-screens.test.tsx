import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VisitFields } from "../src/components/VisitFields";

/** BOOKING A JOB ON A SCREEN: WHEN, AND WHO GOES */
describe("the visit fields on a booking", () => {
  it("asks for the day, the arrival window and who goes, marking anybody off today", () => {
    const html = renderToStaticMarkup(
      <VisitFields defaultDate="2026-10-14" technicians={[
        { id: "t1", displayName: "Ana Ruiz" },
        { id: "t2", displayName: "Ben Okafor", away: true },
      ]} />,
    );
    for (const label of ["Day", "Arrives from", "Arrival window", "Expected to take (minutes)", "Who goes"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('value="2026-10-14"');
    expect(html).toContain('name="technicianIds" value="t1"');
    expect(html).toMatch(/Ben Okafor.*off today/);
    expect(html).not.toMatch(/Ana Ruiz<span[^>]*>off today/);
  });

  it("says a visit with nobody ticked goes on the board unassigned, and says so when nobody is set up", () => {
    expect(renderToStaticMarkup(<VisitFields technicians={[]} />)).toContain("goes on the board unassigned");
  });

  it("lets a lead be booked with no day when the visit is optional", () => {
    const html = renderToStaticMarkup(<VisitFields technicians={[]} optional />);
    expect(html).toContain("book it as a lead");
    expect(html).not.toContain("required");
  });
});
