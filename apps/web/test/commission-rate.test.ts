import { describe, it, expect } from "vitest";
import { percentOf, shareOf } from "../src/lib/commission-rate";

/** AN ITEM'S COMMISSION RATE: said as a percent, kept as a share of the line. */
describe("showing it", () => {
  it("writes the share as a percent without trailing zeros", () => {
    expect(percentOf("0.080000")).toBe("8");
    expect(percentOf("0.0825")).toBe("8.25");
    expect(percentOf("1.000000")).toBe("100");
    expect(percentOf("0.000000")).toBe("0");
    expect(percentOf(null)).toBe("");
    expect(percentOf("")).toBe("");
  });
});

describe("reading it", () => {
  it("turns a percent into a share", () => {
    expect(shareOf("8")).toEqual({ ok: true, share: "0.08" });
    expect(shareOf(" 7.5 % ")).toEqual({ ok: true, share: "0.075" });
    expect(shareOf("8.25")).toEqual({ ok: true, share: "0.0825" });
    expect(shareOf("100")).toEqual({ ok: true, share: "1" });
    expect(shareOf("0")).toEqual({ ok: true, share: "0" });
    expect(shareOf("0.0001")).toEqual({ ok: true, share: "0.000001" });
  });

  it("is none when empty, which goes back to the person's own plan", () => {
    expect(shareOf("")).toEqual({ ok: true, share: null });
    expect(shareOf(undefined)).toEqual({ ok: true, share: null });
  });

  it("round trips what it shows", () => {
    for (const share of ["0.08", "0.0825", "0.5", "1", "0.123456"]) {
      expect(shareOf(percentOf(share))).toEqual({ ok: true, share });
    }
  });

  it("refuses in words", () => {
    expect(shareOf("abc")).toEqual({ ok: false, error: "Type the commission as a percent, like 8 or 7.5, with at most four places." });
    expect(shareOf("-1")).toMatchObject({ ok: false });
    expect(shareOf("8.12345")).toMatchObject({ ok: false });
    expect(shareOf("101")).toEqual({ ok: false, error: "A commission cannot be more than 100 percent of the line." });
  });
});
