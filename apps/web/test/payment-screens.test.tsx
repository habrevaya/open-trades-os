import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { allocationsFromForm } from "../src/lib/payment-form";
import { Payments, type PaymentRow } from "../src/app/(app)/customers/[id]/Payments";

const action = async () => null;
const payment = (over: Partial<PaymentRow>): PaymentRow => ({
  id: "p1", method: "check", amount: "500.0000", refundedAmount: "0.0000", unappliedAmount: "0.0000",
  receivedOn: "Oct 1, 2026", checkNumber: "1044", processorPaymentId: null,
  allocations: [{ invoiceNumber: 1042, amount: "500.0000" }], ...over,
});

/** TAKING MONEY ON A SCREEN */
describe("where a payment goes", () => {
  it("applies the boxes filled in and nothing else, so the rest is held", () => {
    const form = new FormData();
    form.set("apply.inv-1", "$1,200.00");
    form.set("apply.inv-2", "");
    form.set("apply.inv-3", "0");
    form.set("amount", "1500");
    expect(allocationsFromForm(form)).toEqual([{ invoiceId: "inv-1", amount: "1200.00" }]);
  });

  it("is an empty list, not nothing, when no box is filled, which holds the whole amount", () => {
    expect(allocationsFromForm(new FormData())).toEqual([]);
  });
});

describe("a customer's payments", () => {
  it("lists what was paid and towards what, and offers held money to be applied or given back", () => {
    const html = renderToStaticMarkup(
      <Payments customerId="c" apply={action} refund={action} canCollect canRefund
                open={[{ id: "inv-2", number: 1043, balance: "300.0000" }]}
                payments={[payment({ unappliedAmount: "200.0000", allocations: [{ invoiceNumber: 1042, amount: "300.0000" }] })]} />,
    );
    expect(html).toContain("Record a payment");
    expect(html).toContain("Cheque");
    expect(html).toContain("#1042");
    expect(html).toContain("Apply held money");
    expect(html).toContain("Apply held money to invoice 1043");
    expect(html).toContain("Record refund");
    expect(html).toContain("How it went back");
  });

  it("refunds a card through the processor rather than recording one by hand", () => {
    const html = renderToStaticMarkup(
      <Payments customerId="c" apply={action} refund={action} canCollect canRefund open={[]}
                payments={[payment({ method: "card", processorPaymentId: "pi_123", checkNumber: null })]} />,
    );
    expect(html).toContain("Refund through the processor");
    expect(html).not.toContain("How it went back");
  });

  it("shows somebody who may not refund no refund", () => {
    const html = renderToStaticMarkup(
      <Payments customerId="c" apply={action} refund={action} canCollect={false} canRefund={false} open={[]}
                payments={[payment({})]} />,
    );
    expect(html).not.toContain("Refund");
    expect(html).not.toContain("Record a payment");
  });
});

describe("taking a card in the office", () => {
  it("opens the same Payment Element the customer's link uses, worded for the office, and starts nothing until pressed", async () => {
    const { PayNow } = await import("../src/app/(portal)/PayNow");
    let started = 0;
    const html = renderToStaticMarkup(
      <PayNow start={async () => { started += 1; return { ok: false, message: "no" }; }}
              balance="$259.11" label="invoice 1042" cta="Take card payment of $259.11" />,
    );
    expect(html).toContain("Take card payment of $259.11");
    expect(html).toContain("Card details go straight to Stripe");
    expect(started).toBe(0);
  });
});
