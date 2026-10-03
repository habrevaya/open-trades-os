import { describe, it, expect } from "vitest";
import { cardLinesFromText, cardTermsFromForm, fractionOf, minutesOf, slaTermsFromForm } from "@/lib/contract-forms";

/**
 * A rate card is typed by somebody reading a client's schedule: per cents as
 * per cents, times as times, prices pasted from a spreadsheet. The services
 * take fractions, minutes and rows. Every mistake in between is silent.
 */
const form = (values: Record<string, string>) => (name: string) => values[name] ?? null;

describe("the rate card forms", () => {
  it("reads a per cent as the fraction a service takes", () => {
    expect(fractionOf("50")).toBe("0.5000");
    expect(fractionOf("12.5%")).toBe("0.1250");
    expect(fractionOf("")).toBeNull();
    expect(() => fractionOf("lots")).toThrow(/not a percentage/);
  });

  it("reads a time as minutes past midnight", () => {
    expect(minutesOf("07:30")).toBe(450);
    expect(minutesOf("seven")).toBeNull();
  });

  it("skips empty rows, so a form's spare rows are not rates of nothing", () => {
    const terms = cardTermsFromForm(form({
      rate0: "95.00", band0: "standard", minimum0: "60",
      rate1: "", band1: "after_hours",
      upTo0: "100", markup0: "50", markup1: "20",
      day1: "on", day2: "on", standardStart: "07:00", standardEnd: "17:00",
      holidays: "2026-12-25, 2027-01-01", tripCharge: "45",
    }));
    expect(terms.labourRates).toEqual([{ jobTypeId: null, band: "standard", hourlyRate: "95.00", minimumMinutes: 60, incrementMinutes: null }]);
    expect(terms.materialMarkup).toEqual([{ upToCost: "100", percent: "0.5000" }, { upToCost: null, percent: "0.2000" }]);
    expect(terms.standardDays).toEqual([1, 2]);
    expect(terms.standardStartMinute).toBe(420);
    expect(terms.holidays).toEqual(["2026-12-25", "2027-01-01"]);
  });

  it("maps a pasted code to our item when we have it, and keeps theirs when we do not", () => {
    const lines = cardLinesFromText("cap-45, Run capacitor, $175.00\nAH-DIAG\tAfter hours diagnostic\t210\t60\n\n", new Map([["CAP-45", "item-1"]]));
    expect(lines).toEqual([
      { externalCode: null, priceBookItemId: "item-1", description: "Run capacitor", price: "175.00", allowedMinutes: null },
      { externalCode: "AH-DIAG", priceBookItemId: null, description: "After hours diagnostic", price: "210", allowedMinutes: 60 },
    ]);
  });

  it("reads response times in hours", () => {
    expect(slaTermsFromForm(form({ slaKind0: "arrive", slaHours0: "4", slaKind1: "arrive", slaHours1: "1", slaPriority1: "emergency", slaKind2: "" })))
      .toEqual([{ kind: "arrive", minutes: 240 }, { kind: "arrive", minutes: 60, priority: "emergency" }]);
  });
});
