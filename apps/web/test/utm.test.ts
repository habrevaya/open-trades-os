import { describe, expect, it } from "vitest";
import { utmOf } from "../src/lib/utm";

describe("the utm tags of a landing query", () => {
  it("keeps the utm_ ones, clipped, and nothing else", () => {
    expect(utmOf("utm_source=google&x=1&utm_medium=" + "a".repeat(300))).toEqual({
      utm_source: "google",
      utm_medium: "a".repeat(200),
    });
    expect(utmOf(undefined)).toEqual({});
  });

  it("cannot be made to write to an object's prototype", () => {
    const out = utmOf("__proto__=polluted&utm___proto__=x&constructor=y&utm_constructor=z&utm_source=s");
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(out["utm_source"]).toBe("s");
    expect(Object.keys(out).every((key) => key.startsWith("utm_"))).toBe(true);
  });
});
