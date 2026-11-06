import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DepositsPanel, depositState, isHeld, type HeldDeposit } from "../src/components/DepositsPanel";

const action = async () => null;
const deposit = (over: Partial<HeldDeposit> = {}): HeldDeposit => ({
  id: "d1", status: "held", amountRequested: "500.0000", amountReceived: "500.0000", amountApplied: "0.0000",
  amountRefunded: "0.0000", amountForfeited: "0.0000", outstanding: "500.0000", appliedInvoiceId: null, ...over,
});
const render = (props: Partial<Parameters<typeof DepositsPanel>[0]>) => renderToStaticMarkup(
  <DepositsPanel deposits={[deposit()]} invoices={[{ id: "i1", number: "1042", balance: "1400.0000" }]}
                 allowed={{ apply: true, refund: true }} apply={action} dispose={action} back="/customers/c1" {...props} />,
);

/** A HELD DEPOSIT ON A SCREEN */
describe("the deposits panel", () => {
  it("offers to apply a held deposit, give it back or keep it, and says what each does to the money", () => {
    const html = render({});
    expect(html).toContain("Still held");
    expect(html).toContain("Apply to an invoice");
    expect(html).toContain("Invoice 1042, owing $1,400.00");
    expect(html).toContain("No new money comes in");
    expect(html).toContain("Refund or forfeit");
    expect(html).toContain("does not send any money and does not refund a card");
    expect(html).toContain("It counts as income now");
  });

  it("offers only what the person may do", () => {
    const html = render({ allowed: { apply: false, refund: false } });
    expect(html).toContain("Still held");
    expect(html).not.toContain("Apply to an invoice");
    expect(html).not.toContain("Refund or forfeit");
    expect(render({ allowed: { apply: true, refund: false } })).not.toContain("Refund or forfeit");
  });

  it("on an invoice, applies to that invoice without asking which", () => {
    const html = render({ here: { id: "i9", number: "AUS-7", balance: "80.0000" } });
    expect(html).toContain("Apply to this invoice");
    expect(html).toContain("Invoice AUS-7, owing");
    expect(html).not.toContain("Invoice 1042");
  });

  it("says plainly when there is no invoice to apply it to", () => {
    expect(render({ invoices: [] })).toContain("no issued invoice with money owing");
  });

  it("shows nothing for a deposit only asked for, and no actions once it is given back or kept", () => {
    expect(render({ deposits: [deposit({ status: "requested", amountReceived: "0.0000", outstanding: "0.0000" })] })).toBe("");
    const kept = render({ deposits: [deposit({ status: "forfeited", amountForfeited: "500.0000", outstanding: "0.0000" })] });
    expect(kept).toContain("Kept.");
    expect(kept).toContain("Nothing is held now.");
    expect(kept).not.toContain("Apply to an invoice");
    expect(kept).not.toContain("Refund or forfeit");
  });

  it("names each state in words", () => {
    expect(depositState(deposit({ status: "applied", amountApplied: "200.0000", outstanding: "300.0000" })))
      .toBe("Partly applied, the rest is held");
    expect(depositState(deposit({ status: "applied", amountApplied: "500.0000", outstanding: "0.0000" }))).toBe("Applied to an invoice");
    expect(depositState(deposit({ status: "refunded", amountRefunded: "500.0000", outstanding: "0.0000" }))).toBe("Given back");
    expect(isHeld(deposit({ status: "applied", outstanding: "300.0000" }))).toBe(true);
    expect(isHeld(deposit({ status: "refunded", outstanding: "100.0000" }))).toBe(false);
  });
});
