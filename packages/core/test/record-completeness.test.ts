import { describe, it, expect } from "vitest";
import { reporting as r } from "../src/index";

const REQUIRED = [
  { key: "product_applied", regulated: true },
  { key: "epa_reg_no", regulated: true },
  { key: "stations_serviced", regulated: false },
];

describe("an application record's completeness", () => {
  it("is complete when every regulated field it was required to capture was captured", () => {
    expect(r.recordCompletenessOf({ reports: [{ required: REQUIRED, captured: ["product_applied", "epa_reg_no"] }] }))
      .toBe("complete");
    expect(r.recordCompletenessOf({ reports: [{ required: REQUIRED, captured: ["product_applied", "stations_serviced"] }] }))
      .toBe("incomplete");
  });

  it("calls a completed visit with no record at all incomplete", () => {
    expect(r.recordCompletenessOf({ reports: [] })).toBe("incomplete");
  });

  it("leaves out a visit recorded with a no product applied reason", () => {
    expect(r.recordCompletenessOf({ reports: [{ required: REQUIRED, captured: [r.NO_PRODUCT_REASON] }] })).toBe("excluded");
  });

  it("does not read a report held to no regulated field as complete", () => {
    expect(r.recordCompletenessOf({ reports: [{ required: null, captured: ["product_applied", "epa_reg_no"] }] })).toBe("unknown");
    expect(r.recordCompletenessOf({ reports: [{ required: [{ key: "stations_serviced", regulated: false }], captured: [] }] }))
      .toBe("unknown");
  });

  it("judges a visit by the report on it that was held to a list, when it has more than one", () => {
    expect(r.recordCompletenessOf({ reports: [
      { required: null, captured: [] },
      { required: REQUIRED, captured: ["product_applied", "epa_reg_no"] },
    ] })).toBe("complete");
  });
});
