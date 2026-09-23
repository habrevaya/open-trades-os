import { describe, it, expect } from "vitest";
import { NAV, isActive, isOpen, activeChild } from "../src/lib/nav";

/**
 * WHERE YOU ARE
 *
 * The rail marks the current section, which is most of what a left rail is
 * for: fourteen links that all look the same is a list you read rather than
 * a place you are.
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

/**
 * SUBSECTIONS
 *
 * A child only exists inside its parent, so the two questions are whether
 * the parent is open and which child is lit. Both are cheap to get subtly
 * wrong in a way nothing else notices: a rail that says you are in two
 * places at once still renders.
 */
describe("subsections", () => {
  const reports = NAV.flatMap((g) => g.items).find((i) => i.href === "/reports")!;

  it("opens the parent you are anywhere inside", () => {
    expect(isOpen(reports, "/reports")).toBe(true);
    expect(isOpen(reports, "/reports/new")).toBe(true);
    // Not a child of anything, and still belongs under Reports.
    expect(isOpen(reports, "/reports/saved/8f2a")).toBe(true);
  });

  it("closes it when you leave", () => {
    // A section that stays open turns the rail into a list of every screen
    // in the product, which is what the groups exist to prevent.
    expect(isOpen(reports, "/jobs")).toBe(false);
  });

  it("never opens an item with no children", () => {
    const jobs = NAV.flatMap((g) => g.items).find((i) => i.href === "/jobs")!;
    expect(isOpen(jobs, "/jobs/8f2a")).toBe(false);
  });

  it("lights one child, not every child whose href is a prefix", () => {
    /**
     * `/reports` is a prefix of `/reports/new`, so testing each child on its
     * own marks both of them on the builder. Longest match wins.
     */
    expect(activeChild(reports, "/reports/new")).toBe("/reports/new");
    expect(activeChild(reports, "/reports")).toBe("/reports");
  });

  it("lights none when you are somewhere the children do not cover", () => {
    // The parent is open, because you are inside it, and no child is the
    // page. Claiming one would be a lie the reader has no way to check.
    expect(isOpen(reports, "/reports/saved/8f2a")).toBe(true);
    expect(activeChild(reports, "/reports/saved/8f2a")).toBeNull();
  });

  it("gives every child a distinct destination under its parent", () => {
    for (const item of NAV.flatMap((g) => g.items)) {
      const hrefs = (item.children ?? []).map((c) => c.href);
      expect(new Set(hrefs).size, item.label).toBe(hrefs.length);
      // A child pointing outside its parent is a top level item filed in the
      // wrong place, and it would light the wrong section when opened.
      for (const href of hrefs) expect(isActive(item.href, href), href).toBe(true);
    }
  });
});

/**
 * The rail collapses to icons only, where the icon IS the label. An item
 * with no icon is invisible in that state rather than merely plain, and two
 * items sharing one are two doors a person cannot tell apart.
 */
describe("the collapsed rail", () => {
  it("gives every item an icon", () => {
    for (const item of NAV.flatMap((g) => g.items)) {
      expect(item.icon, item.label).toBeTruthy();
    }
  });

  it("gives no two items the same icon", () => {
    const icons = NAV.flatMap((g) => g.items).map((i) => i.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});
