import { describe, it, expect } from "vitest";
import { reporting } from "../src/index";

/** M21: THE RECORDS API TAKES HOW MANY TO A PAGE, BOUNDED, A THOUSAND BY DEFAULT */
describe("how many records to a page", () => {
  it("is a thousand unless one to a thousand was asked for", () => {
    expect(reporting.askedPerPage(undefined)).toBe(1000);
    expect(reporting.askedPerPage("")).toBe(1000);
    expect(reporting.askedPerPage(25)).toBe(25);
    expect(reporting.askedPerPage("50")).toBe(50);
    expect(reporting.askedPerPage(1)).toBe(1);
    expect(reporting.askedPerPage(1000)).toBe(1000);
    // Never more than a thousand, never none, never a fraction.
    for (const wrong of [0, -5, 1001, 2.5, "lots"]) expect(reporting.askedPerPage(wrong)).toBe(1000);
    expect(reporting.drillPage(5, 3, 2)).toEqual({ page: 3, pages: 3, perPage: 2, offset: 4 });
  });
});
