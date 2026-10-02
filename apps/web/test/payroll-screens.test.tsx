import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Register, type RegisterData } from "../src/app/(app)/payroll/Register";
import { NAV } from "../src/lib/nav";

/**
 * M17 ON A SCREEN: THE REGISTER BEFORE THE EXPORT
 */
const data = (over: Partial<RegisterData> = {}): RegisterData => ({
  rows: [{
    technicianId: "t1", technicianName: "Sam Ortiz", classification: "non_exempt",
    lines: [
      { kind: "regular", label: "Regular", explanation: "40 h at the base rate on each punch", hours: "40", rate: "28.0000", amount: "1120.0000" },
      { kind: "overtime", label: "Overtime", explanation: "Over 40 h in the week of 9 March", hours: "3.5", rate: "42.0000", amount: "147.0000" },
      { kind: "commission", label: "Commission", explanation: "5% of invoice 1041", hours: null, rate: null, amount: "60.0000" },
    ],
    gross: "1327.0000", carriedForward: "0.0000", warnings: ["A punch was edited after the shift"],
  }],
  problems: [],
  grossTotal: "1327.0000",
  ...over,
});

describe("the payroll register", () => {
  it("shows each person's lines with the reason for each, and the total", () => {
    const html = renderToStaticMarkup(<Register data={data()} />);
    expect(html).toContain("Sam Ortiz");
    expect(html).toContain("Over 40 h in the week of 9 March");
    expect(html).toContain("3.5 h");
    expect(html).toContain("5% of invoice 1041");
    expect(html).toContain("1,327.00");
    expect(html).toContain("A punch was edited after the shift");
  });

  it("names who cannot be paid before anything else", () => {
    const html = renderToStaticMarkup(<Register data={data({
      problems: [{ technicianId: "t2", technicianName: "Ana Diaz", messages: ["No wage scale covers 12 March."] }],
    })} />);
    expect(html).toContain("Cannot be paid yet");
    expect(html.indexOf("Ana Diaz")).toBeLessThan(html.indexOf("Sam Ortiz"));
  });

  it("is in the navigation for whoever may read payroll", () => {
    const item = NAV.flatMap((g) => g.items).find((i) => i.href === "/payroll");
    expect(item?.permission).toBe("payroll:read");
  });
});
