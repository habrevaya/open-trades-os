import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Territories, Coverage, type TerritoryRow } from "../src/app/(app)/settings/service-area/ServiceAreaView";
import { SETUP_STEPS } from "../src/app/(setup)/setup/steps";
import { NAV } from "../src/lib/nav";

const row = (over: Partial<TerritoryRow> = {}): TerritoryRow => ({
  id: "t1", name: "North side", postalCodes: ["78701", "78702"],
  travelFee: "45.0000", active: true, ...over,
});

/** M02's SERVICE AREA: THE STEP THE WIZARD ASKED FOR AND COULD NOT REACH */
describe("the service area", () => {
  it("names a territory, its codes and its trip charge", () => {
    const html = renderToStaticMarkup(<Territories rows={[row()]} />);
    expect(html).toContain("North side");
    expect(html).toContain("78701, 78702");
    expect(html).toContain("$45.00");
    expect(html).toContain("In use");
  });

  it("says an empty trip charge is the company default and not free", () => {
    /**
     * The distinction this screen exists to make readable. A blank cell where
     * money goes reads as nothing charged, and it means the opposite: whatever
     * the company charges everywhere else applies here too.
     */
    const html = renderToStaticMarkup(<Territories rows={[row({ travelFee: null })]} />);
    expect(html).toContain("Company default");
    expect(html).not.toContain("$0.00");
  });

  it("says a territory with no codes matches nothing", () => {
    /**
     * A territory with an empty code list is a row that looks configured and
     * does nothing: `services/properties.ts` resolves by code, so no code is no
     * match. Silence here is how somebody spends an afternoon wondering why the
     * trip charge never applies.
     */
    const html = renderToStaticMarkup(<Territories rows={[row({ postalCodes: [] })]} />);
    expect(html).toContain("No codes, so no address matches it");
  });

  it("stops listing codes once nobody is reading them", () => {
    const codes = Array.from({ length: 30 }, (_, i) => String(78700 + i));
    const html = renderToStaticMarkup(<Territories rows={[row({ postalCodes: codes })]} />);
    expect(html).toContain("78700");
    expect(html).toContain("and 18 more");
    /** The twentieth is past the cut and is not in the cell. */
    expect(html).not.toContain("78720");
  });

  it("tells somebody with nothing declared what the consequence is", () => {
    const html = renderToStaticMarkup(<Territories rows={[]} />);
    expect(html).toContain("No territories yet");
    expect(html).toContain("every address is in no territory");
  });

  it("counts only live territories in the coverage figures", () => {
    /**
     * A retired territory keeps its codes, deliberately, so nothing silently
     * re-matches somewhere else. Counting those codes as covered would tell an
     * owner they serve an area they have stopped serving.
     */
    const html = renderToStaticMarkup(
      <Coverage rows={[row(), row({ id: "t2", name: "South", postalCodes: ["78745"], active: false })]} />,
    );
    expect(html).toContain("Territories in use");
    /** One live territory, two codes, both from the live one. */
    expect(html).toMatch(/Territories in use<\/dt><dd[^>]*>1</);
    expect(html).toMatch(/Postal codes covered<\/dt><dd[^>]*>2</);
  });

  it("says when some territories ride the company default", () => {
    const html = renderToStaticMarkup(
      <Coverage rows={[row(), row({ id: "t2", name: "South", postalCodes: ["78745"], travelFee: null })]} />,
    );
    expect(html).toContain("1 of 2");
    expect(html).toContain("The rest use the company default.");
  });

  it("is reachable from the rail", () => {
    const hrefs = NAV.flatMap((g) => g.items.flatMap((i) => [i.href, ...(i.children ?? []).map((c) => c.href)]));
    expect(hrefs).toContain("/settings/service-area");
  });
});

/**
 * THE WIZARD'S LINKS, WHICH WERE NINE 404s
 *
 * `routes.test.ts` now catches a dead one. This catches the other half: a step
 * that quietly loses its destination, or a new step added without one. The href
 * being required in the type covers the second at build time; this covers the
 * first, and states which screen each step was decided to go to.
 */
describe("the setup wizard", () => {
  it("sends every step somewhere", () => {
    for (const step of SETUP_STEPS) {
      expect(step.href, step.key).toMatch(/^\//);
    }
  });

  it("gives every step a page of its own, and says where the setting lives afterwards", () => {
    for (const step of SETUP_STEPS) {
      expect(step.href, step.key).toBe(`/setup/${step.key}`);
      expect(step.later.href, step.key).toMatch(/^\//);
    }
    const step = SETUP_STEPS.find((s) => s.key === "service-area");
    expect(step?.later.href).toBe("/settings/service-area");
  });

  it("no longer promises tax jurisdictions", () => {
    /**
     * There is no jurisdiction table and no rate table, and determining a rate
     * is on BUILD.md's list of things this project will not build. The step used
     * to offer "jurisdictions, rates", which is a screen nobody will ever write.
     */
    const tax = SETUP_STEPS.find((s) => s.key === "tax");
    expect(tax?.summary).not.toMatch(/jurisdiction/i);
    expect(tax?.summary).toMatch(/taxable/);
  });
});
