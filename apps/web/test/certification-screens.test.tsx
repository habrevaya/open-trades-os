import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExpiringList, HoldingsByPerson, type Holding } from "../src/app/(app)/certifications/Holdings";
import { NAV } from "../src/lib/nav";

/** M24 ON A SCREEN: WHO HOLDS WHAT, AND WHAT IS RUNNING OUT */
const held = (over: Partial<Holding>): Holding => ({
  id: "c1", technicianId: "t1", technicianName: "Sam Ortiz", name: "EPA 608 Universal",
  authority: "EPA", grantsSkills: ["refrigerant"], reference: "A-1234",
  issuedOn: "2024-01-01", expiresOn: "2026-11-01", status: "active", statusReason: null,
  current: true, lapseReason: null, verifiedAt: null, ...over,
});

describe("certifications", () => {
  it("lists what is running out and what already has", () => {
    const html = renderToStaticMarkup(<ExpiringList rows={[
      { ...held({}), daysRemaining: 31 },
      { ...held({ id: "c2", technicianName: "Ana Diaz", current: false, lapseReason: "expired" }), daysRemaining: -3 },
    ]} />);
    expect(html).toContain("31 days left");
    expect(html).toContain("Expired 3 days ago");
  });

  it("keeps the revoked on the record, says why, and says whether anybody saw the card", () => {
    const html = renderToStaticMarkup(<HoldingsByPerson rows={[
      held({}),
      held({ id: "c3", name: "Gas fitter", status: "revoked", current: false, lapseReason: "revoked",
        statusReason: "Licence withdrawn by the state board", verifiedAt: "2025-01-01T00:00:00Z" }),
    ]} controls={(h) => <button>act {h.id}</button>} />);
    expect(html).toContain("Unlocks refrigerant");
    expect(html).toContain("Revoked");
    expect(html).toContain("Licence withdrawn by the state board");
    expect(html).toContain("Not verified");
    expect(html).toContain("Card seen");
    expect(html).toContain("act c3");
  });

  it("is in the navigation for whoever may read compliance", () => {
    expect(NAV.flatMap((g) => g.items).find((i) => i.href === "/certifications")?.permission)
      .toBe("compliance:read");
  });
});
