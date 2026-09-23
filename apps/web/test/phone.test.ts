import { describe, it, expect } from "vitest";
import { formatPhone } from "@opentradesos/ui";

/**
 * E.164 is the right thing to store and the wrong thing to show. These get
 * read aloud off a screen while somebody dials, and `+15125550143` is a
 * string a person has to parse a digit at a time.
 *
 * Tested from here rather than from the ui package, which has no test runner
 * of its own. Adding one for a single pure function would be more
 * configuration than coverage.
 */
describe("formatting a phone number", () => {
  it("groups a US number the way a US reader expects", () => {
    expect(formatPhone("+15125550143")).toBe("(512) 555-0143");
  });

  it("leaves a number from anywhere else alone", () => {
    /**
     * A +44 number rendered with American grouping is worse than an
     * unformatted one: it looks authoritative and it is wrong. Guessing a
     * country's convention from a prefix we have not implemented is how a
     * screen confidently shows somebody a number they cannot dial.
     */
    expect(formatPhone("+442071234567")).toBe("+442071234567");
    expect(formatPhone("+61291234567")).toBe("+61291234567");
  });

  it("does not format something that is not a full US number", () => {
    // Ten digits with no country code, or an extension on the end.
    expect(formatPhone("5125550143")).toBe("5125550143");
    expect(formatPhone("+15125550143x22")).toBe("+15125550143x22");
  });

  it("renders nothing for a missing number rather than a stray bracket", () => {
    expect(formatPhone(null)).toBe("");
    expect(formatPhone(undefined)).toBe("");
    expect(formatPhone("")).toBe("");
  });
});
