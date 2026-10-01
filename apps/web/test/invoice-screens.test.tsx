import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { linesFromForm } from "../src/lib/invoice-form";
import { InvoiceActions } from "../src/app/(app)/invoices/[id]/Panels";
import { Composer } from "../src/app/(app)/invoices/Composer";

const action = async () => null;
const all = { write: true, send: true, void: true, writeOff: true };
const invoice = (status: string, amountPaid = "0", balance = "259.1100") =>
  ({ id: "inv", number: 1042, status, amountPaid, balance });

/** INVOICING ON A SCREEN */
describe("the composer's lines", () => {
  it("reads rows in screen order, skips an empty one, and sends a price book row as the item", () => {
    const form = new FormData();
    form.set("lineKeys", "3,0,7");
    form.set("line.3.name", "Diagnostic fee");
    form.set("line.3.quantity", "1");
    form.set("line.3.unitPrice", "$129.00");
    form.set("line.0.priceBookItemId", "item-1");
    form.set("line.0.quantity", "3");
    form.set("line.0.jobLineId", "jl-1");
    form.set("line.0.taxable", "on");
    form.set("line.7.name", "");
    expect(linesFromForm(form)).toEqual([
      { name: "Diagnostic fee", quantity: "1", unitPrice: "129.00", discountAmount: "0", taxable: false },
      {
        priceBookItemId: "item-1", jobLineId: "jl-1", name: "Price book item",
        quantity: "3", unitPrice: "0", discountAmount: "0", taxable: true,
      },
    ]);
  });

  it("keeps a typed price as typed, commas and all removed, and leaves a bad one for the contract to refuse", () => {
    const form = new FormData();
    form.set("lineKeys", "0");
    form.set("line.0.name", "Condenser");
    form.set("line.0.unitPrice", "5,480.00");
    form.set("line.0.discountAmount", "abc");
    expect(linesFromForm(form)[0]).toMatchObject({ unitPrice: "5480.00", discountAmount: "abc" });
  });
});

describe("what can be done with an invoice", () => {
  it("offers a draft to be edited, issued or deleted, and nothing that needs it issued", () => {
    const html = renderToStaticMarkup(
      <InvoiceActions action={action} invoice={invoice("draft")} allowed={all} customerEmail="a@b.test" sentBefore={false} />,
    );
    expect(html).toContain("Edit draft");
    expect(html).toContain("Issue invoice");
    expect(html).toContain("Delete draft");
    expect(html).not.toContain("Email invoice");
    expect(html).not.toContain("Void");
  });

  it("offers an open invoice to be sent, written off or voided, to whoever holds each", () => {
    const html = renderToStaticMarkup(
      <InvoiceActions action={action} invoice={invoice("open")} allowed={all} customerEmail="a@b.test" sentBefore />,
    );
    expect(html).toContain("Email invoice");
    expect(html).toContain("Send it again");
    expect(html).toContain("Get a link instead");
    expect(html).toContain("Write off");
    expect(html).toContain("Void invoice");

    const clerk = renderToStaticMarkup(
      <InvoiceActions action={action} invoice={invoice("open")} customerEmail={null} sentBefore={false}
                      allowed={{ write: true, send: true, void: false, writeOff: false }} />,
    );
    expect(clerk).not.toContain("Write off");
    expect(clerk).not.toContain("Void invoice");
    expect(clerk).toContain("no email on file");
  });

  it("does not offer to void an invoice with money paid against it", () => {
    const html = renderToStaticMarkup(
      <InvoiceActions action={action} invoice={invoice("partially_paid", "100.0000", "159.1100")} allowed={all}
                      customerEmail={null} sentBefore={false} />,
    );
    expect(html).not.toContain("Void invoice");
    expect(html).toContain("Write off");
  });

  it("offers nothing on a void invoice", () => {
    const html = renderToStaticMarkup(
      <InvoiceActions action={action} invoice={invoice("void", "0", "0")} allowed={all} customerEmail={null} sentBefore={false} />,
    );
    expect(html).not.toContain("<form");
  });
});

describe("the composer", () => {
  it("opens with the job's unbilled lines, each keeping the job line it bills", () => {
    const html = renderToStaticMarkup(
      <Composer action={action} hidden={{ customerId: "c" }} submit="Create invoice"
                items={[{ id: "i", name: "Capacitor", price: "43.3700", taxable: true }]}
                lines={[{ jobLineId: "jl-1", name: "Capacitor", quantity: "3", unitPrice: "43.37", discountAmount: "", taxable: true }]} />,
    );
    expect(html).toContain('name="line.0.jobLineId" value="jl-1"');
    expect(html).toContain("Used on the job.");
    expect(html).toContain("Save as a draft to finish later");
    expect(html).toContain("Adjustment amount (negative takes money off)");
  });
});
