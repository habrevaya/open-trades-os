import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ComplianceList, MaintenanceList, Register } from "../src/app/(app)/fleet/FleetView";
import { NAV } from "../src/lib/nav";

/** M22 ON A SCREEN: WHO HAS IT, WHAT IS DUE, WHAT EXPIRES */
describe("the fleet", () => {
  it("says who holds each thing and what its meter last said", () => {
    const html = renderToStaticMarkup(<Register
      holderName={(kind) => (kind === "technician" ? "Sam Ortiz" : "a place")}
      assets={[
        { id: "a1", kindLabel: "Vehicle", label: "Van 3", identifier: "TX ABC123", meterUnit: "miles",
          retired: false, heldBy: { custodianKind: "technician", custodianId: "t1", since: "2026-09-01" },
          latestReading: { value: 84210, unit: "miles", takenOn: "2026-09-30" }, missingObligations: ["inspection"] },
        { id: "a2", kindLabel: "Power tool", label: "Core drill", identifier: null, meterUnit: null,
          retired: false, heldBy: null, latestReading: null, missingObligations: [] },
      ]}
      controls={(a) => <button>controls {a.label}</button>}
    />);
    expect(html).toContain("With Sam Ortiz since 2026-09-01");
    expect(html).toContain("84,210 miles");
    expect(html).toContain("No inspection on file");
    expect(html).toContain("Not checked out");
    expect(html).toContain("controls Core drill");
  });

  it("puts what to act on first and says what is missing", () => {
    const html = renderToStaticMarkup(<ComplianceList
      alerts={[
        { assetId: "a1", assetLabel: "Van 3", kind: "registration", status: "act_now",
          expiresOn: "2026-10-20", actBy: "2026-10-06", explanation: "Renew by the 6th.", groundsTheAsset: true },
        { assetId: "a2", assetLabel: "Meter", kind: "calibration", status: "clear",
          expiresOn: "2027-06-01", actBy: "2027-04-01", explanation: "", groundsTheAsset: false },
      ]}
      missing={[{ assetId: "a3", assetLabel: "Trailer", kind: "insurance", explanation: "No policy recorded." }]}
    />);
    expect(html).toContain("Act now");
    expect(html).toContain("Act by 2026-10-06");
    expect(html).not.toContain("Meter");
    expect(html).toContain("Nothing on file");
  });

  it("says when a service is due, and when nobody can tell", () => {
    const html = renderToStaticMarkup(<MaintenanceList plans={[
      { planId: "p1", assetId: "a1", assetLabel: "Van 3", label: "Oil change", lastServicedOn: "2026-06-01",
        status: { basis: "meter", state: "due_now", unit: "miles", unitsOverdue: 400, explanation: "5,400 miles since." } },
      { planId: "p2", assetId: "a2", assetLabel: "Van 4", label: "Tyres", lastServicedOn: null,
        status: { basis: "meter", state: "cannot_project", unit: "miles", explanation: "No reading for six weeks." } },
    ]} />);
    expect(html).toContain("Due now, 400 miles over");
    expect(html).toContain("Cannot tell");
    expect(html).toContain("No reading for six weeks.");
  });

  it("is in the navigation", () => {
    expect(NAV.flatMap((g) => g.items).find((i) => i.href === "/fleet")?.permission).toBe("asset:read");
  });
});
