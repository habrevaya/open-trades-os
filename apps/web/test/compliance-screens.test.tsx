import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Counts, Documents, Filings } from "../src/app/(app)/compliance/ComplianceView";
import { NAV } from "../src/lib/nav";

/** M23 ON A SCREEN: WHAT IS ON FILE, WHAT HAS LAPSED, WHAT IS OWED */
describe("compliance", () => {
  it("gives counts and no verdict", () => {
    const html = renderToStaticMarkup(<Counts summary={{
      expired: 1, actNow: 2, upcoming: 3, noExpiry: 4, expiredAndRequiredForWork: 1,
    }} />);
    expect(html).toContain("Expired and needed for work");
    expect(html).toContain("not whether it is everything you need");
    expect(html.toLowerCase()).not.toContain("compliant");
  });

  it("lists documents with their standing and the sentence behind it", () => {
    const html = renderToStaticMarkup(<Documents
      rows={[{
        id: "d1", kind: "liability_insurance", name: "General liability", reference: "GL-77",
        issuerName: "Acme Mutual", expiresOn: "2026-10-15", requiredForWork: true,
        standing: "act_now", actBy: "2026-10-01", statement: "Renew by 1 October to stay covered.",
      }]}
      controls={(d) => <button>renew {d.id}</button>}
    />);
    expect(html).toContain("Renew now");
    expect(html).toContain("Needed for work");
    expect(html).toContain("Renew by 1 October to stay covered.");
    expect(html).toContain("renew d1");
  });

  it("marks a late filing and shows the authority's reference once acknowledged", () => {
    const html = renderToStaticMarkup(<Filings rows={[
      { id: "s1", kind: "epa_refrigerant_report", authorityName: "EPA", periodStart: "2026-01-01", periodEnd: "2026-06-30",
        state: "due", dueOn: "2026-09-01", overdue: true, acknowledgementReference: null, rejectionReason: null,
        statement: "Owed for the first half." },
      { id: "s2", kind: "state_license_renewal", authorityName: "TDLR", periodStart: null, periodEnd: null,
        state: "acknowledged", dueOn: "2026-08-01", overdue: false, acknowledgementReference: "CONF-123",
        rejectionReason: null, statement: "Filed." },
    ]} />);
    expect(html).toContain("Late");
    expect(html).toContain("Reference CONF-123");
  });

  it("is in the navigation", () => {
    expect(NAV.flatMap((g) => g.items).find((i) => i.href === "/compliance")?.permission).toBe("document:read");
  });
});
