import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { work } from "@opentradesos/core";
import { CalledOffFields } from "../src/components/CalledOffFields";

/**
 * WHO ASKED, AND WHY WE DID: asked of the company only. The reason boxes are
 * not on the page until "We called it off" is chosen, so a customer's own
 * cancellation is never asked why.
 */
describe("who asked to call it off", () => {
  it("asks only who, with no default, until the company is chosen", () => {
    const html = renderToStaticMarkup(<CalledOffFields name="by" label="Who asked" strict reasons={work.CANCEL_REASONS} />);
    expect(html).toContain("Who asked");
    expect(html).toContain("The customer asked");
    expect(html).toContain("We called it off");
    expect(html).not.toContain("Why we called it off");
    expect(html).not.toContain("cancelReason");
  });

  it("asks why, from the fixed list, once the company is the one who did", () => {
    const html = renderToStaticMarkup(<CalledOffFields name="by" label="Who asked" strict initial="company" reasons={work.CANCEL_REASONS} />);
    expect(html).toContain("Why we called it off");
    for (const label of ["Rain or weather", "Crew short", "Equipment", "Something else"]) expect(html).toContain(label);
    expect(html).toContain('name="cancelReasonNote"');
    expect(html).not.toMatch(/[\u2014\u2013]/);
  });

  it("does not ask why of the customer", () => {
    const html = renderToStaticMarkup(<CalledOffFields name="cancelledBy" label="Who asked" initial="customer" reasons={work.CANCEL_REASONS} />);
    expect(html).not.toContain("Why we called it off");
  });
});
