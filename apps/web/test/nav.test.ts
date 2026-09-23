import { describe, it, expect } from "vitest";
import { NAV, isActive } from "../src/lib/nav";

/**
 * WHERE YOU ARE
 *
 * The rail marks the current section, which is most of what a left rail is
 * for: eleven links that all look the same is a list you read rather than a
 * place you are.
 */
describe("marking the current section", () => {
  it("marks a section you are three clicks inside", () => {
    // Somebody on a job detail page is in Jobs, and a rail that forgets that
    // makes them feel lost in their own product.
    expect(isActive("/jobs", "/jobs")).toBe(true);
    expect(isActive("/jobs", "/jobs/8f2a-1234")).toBe(true);
    expect(isActive("/inbox", "/inbox/abc")).toBe(true);
  });

  it("does not mark Today on every screen in the product", () => {
    /**
     * The one that a prefix match gets wrong. Every path starts with a
     * slash, so `"/some/path".startsWith("/")` is true and the dashboard
     * would light up everywhere.
     */
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/", "/jobs")).toBe(false);
    expect(isActive("/", "/invoices/123")).toBe(false);
  });

  it("does not mark a section whose name is a prefix of another", () => {
    // `/job-types` is not inside `/jobs`, and a naive startsWith on the bare
    // string would say it was.
    expect(isActive("/jobs", "/jobsomething")).toBe(false);
    expect(isActive("/task", "/tasks")).toBe(false);
  });
});

describe("the navigation itself", () => {
  it("has no duplicate destinations", () => {
    const hrefs = NAV.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("gives every group a heading except the first", () => {
    // A heading is what makes a group a group. The first one is the daily
    // driver and sits above the first divider with nothing to say.
    expect(NAV[0]!.label).toBeNull();
    expect(NAV.slice(1).every((g) => typeof g.label === "string" && g.label.length > 0)).toBe(true);
  });

  it("puts the technician's own day first", () => {
    // For the person who holds that permission it is the only screen they
    // open, and anything above it is a thing they scroll past every morning.
    expect(NAV[0]!.items[0]!.href).toBe("/my-day");
  });
});
