import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { optionsFromForm, rateFromPercent } from "../src/lib/estimate-form";
import { EstimateActions, Options, type EstimateView } from "../src/app/(app)/estimates/[id]/Panels";
import { EstimateComposer } from "../src/app/(app)/estimates/Composer";

const action = async () => null;
const all = { send: true, deposit: true, approve: true, write: true, convert: true };
const estimate = (status: string): EstimateView => ({
  id: "e1", customerId: "c1", status, jobId: status === "converted" ? "j1" : null,
  options: [
    { id: "o2", name: "Replace", isRecommended: true, total: "5480.0000", optionalTotal: "350.0000", lines: [
      { id: "l2", name: "3 ton condenser, installed", quantity: "1.0000", unitPrice: "5480.0000", lineTotal: "5480.0000", isOptional: false },
      { id: "l3", name: "Surge protector", quantity: "1.0000", unitPrice: "350.0000", lineTotal: "350.0000", isOptional: true },
    ] },
    { id: "o1", name: "Repair", isRecommended: false, total: "289.0000", optionalTotal: "0", lines: [
      { id: "l1", name: "Replace compressor contactor", quantity: "1.0000", unitPrice: "289.0000", lineTotal: "289.0000", isOptional: false },
    ] },
  ],
});

/** ESTIMATES ON A SCREEN */
describe("the estimate composer's options", () => {
  it("reads options and their lines in screen order, with the recommended one and optional lines marked", () => {
    const form = new FormData();
    form.set("optionKeys", "5,0,9");
    form.set("recommended", "0");
    form.set("option.5.name", "Repair");
    form.set("option.5.lineKeys", "1");
    form.set("line.5.1.name", "Contactor");
    form.set("line.5.1.unitPrice", "289");
    form.set("option.0.name", "Replace");
    form.set("option.0.lineKeys", "2,3,4");
    form.set("line.0.2.name", "Condenser");
    form.set("line.0.2.unitPrice", "$5,480.00");
    form.set("line.0.3.priceBookItemId", "surge");
    form.set("line.0.3.optional", "on");
    form.set("line.0.4.name", "");
    form.set("option.9.name", "Empty");
    form.set("option.9.lineKeys", "1");
    const options = optionsFromForm(form);
    expect(options.map((o) => o.name)).toEqual(["Repair", "Replace"]);
    expect(options[1]!.isRecommended).toBe(true);
    expect(options[1]!.lines).toEqual([
      { name: "Condenser", quantity: "1", unitPrice: "5480.00", discountAmount: "0", taxable: false, isOptional: false },
      { priceBookItemId: "surge", name: "Price book item", quantity: "1", unitPrice: "0", discountAmount: "0", taxable: false, isOptional: true },
    ]);
  });

  it("turns a typed percentage into the rate the contract takes", () => {
    expect(rateFromPercent("8.25")).toBe("0.0825");
    expect(rateFromPercent("")).toBe("0");
    expect(rateFromPercent("6.25%")).toBe("0.0625");
  });

  it("starts with one option called Good and offers more", () => {
    const html = renderToStaticMarkup(
      <EstimateComposer action={action} hidden={{ customerId: "c" }} items={[]}
                        properties={[{ id: "p", label: "9 Pecan St, Austin" }]} />,
    );
    expect(html).toContain('value="Good"');
    expect(html).toContain("Add an option");
    expect(html).toContain("Optional, option 1 line 1");
  });
});

describe("an estimate in the office", () => {
  it("shows each option with its optional extras outside the total", () => {
    const html = renderToStaticMarkup(<Options estimate={estimate("sent")} />);
    expect(html).toContain("recommended");
    expect(html).toContain("(optional)");
    expect(html).toContain("not in the total");
  });

  it("offers an open estimate's link, a deposit, and a yes or no taken by phone", () => {
    const html = renderToStaticMarkup(
      <EstimateActions action={action} estimate={estimate("draft")} deposits={[]} allowed={all} />,
    );
    expect(html).toContain("Get the approval link");
    expect(html).toContain("Ask for deposit");
    expect(html).toContain("Record approval");
    expect(html).toContain("Record decline");
    expect(html).not.toContain("Convert to job");
  });

  it("offers an approved one to be converted, and nothing that would re-send it", () => {
    const html = renderToStaticMarkup(
      <EstimateActions action={action} estimate={estimate("approved")} allowed={all}
                       deposits={[{ id: "d", status: "requested", amountRequested: "500.0000", amountReceived: "0" }]} />,
    );
    expect(html).toContain("Convert to job");
    expect(html).toContain("asked for");
    expect(html).not.toContain("Get the approval link");
  });

  it("links a converted estimate to its job", () => {
    const html = renderToStaticMarkup(
      <EstimateActions action={action} estimate={estimate("converted")} deposits={[]} allowed={all} />,
    );
    expect(html).toContain('href="/jobs/j1"');
    expect(html).not.toContain("<form");
  });
});
