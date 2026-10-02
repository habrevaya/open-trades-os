import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountView, type AccountViewData } from "../src/app/(portal)/c/[token]/AccountView";
import { DepositView, type DepositViewData } from "../src/app/(portal)/pay/[token]/DepositView";

/**
 * THE TWO PORTAL PAGES THAT DID NOT EXIST, RENDERED
 *
 * The services behind them are tested against Postgres; this is what a
 * customer sees, rendered from the same shapes without a database.
 */
const account = (over: Partial<AccountViewData> = {}): AccountViewData => ({
  organizationName: "Acme HVAC",
  customerName: "Dana Reyes",
  visits: [{
    id: "v1", jobNumber: 12, summary: "Spring tune-up", status: "scheduled",
    windowStart: new Date(Date.now() + 864e5).toISOString(),
    windowEnd: new Date(Date.now() + 864e5 + 72e5).toISOString(),
    technicianName: "Sam Ortiz",
  }],
  invoices: [
    { id: "i1", number: 1041, status: "open", issuedOn: "2026-09-01", dueOn: "2026-09-15",
      currency: "USD", total: "458.0000", balance: "458.0000", payable: true },
    { id: "i2", number: 1002, status: "paid", issuedOn: "2026-03-01", dueOn: null,
      currency: "USD", total: "120.0000", balance: "0.0000", payable: false },
  ],
  estimates: [{ id: "e1", number: 77, title: "New condenser", status: "sent", sentAt: null }],
  agreements: [{ id: "a1", planName: "Comfort Club", status: "active", startedOn: "2026-01-01", endsOn: "2027-01-01" }],
  deposits: [],
  onlinePaymentAvailable: true,
  ...over,
});

describe("the account page", () => {
  it("shows what is owed with a way to pay it, what is coming, and the history", () => {
    const html = renderToStaticMarkup(
      <AccountView account={account()} pay={(i) => <button>pay {i.number}</button>} />,
    );
    expect(html).toContain("Dana Reyes");
    expect(html).toContain("Invoice #1041");
    expect(html).toContain("$458.00");
    expect(html).toContain("pay 1041");
    expect(html).not.toContain("pay 1002");
    expect(html).toContain("Spring tune-up");
    expect(html).toContain("with Sam");
    expect(html).toContain("Comfort Club");
    expect(html).toContain("Waiting for you");
  });

  it("says how to pay when no processor is connected, rather than a button that fails", () => {
    const html = renderToStaticMarkup(
      <AccountView account={account({ onlinePaymentAvailable: false })} pay={() => <button>pay</button>} />,
    );
    expect(html).not.toContain("<button>pay</button>");
    expect(html).toContain("does not take card payments online yet");
  });
});

const deposit = (over: Partial<DepositViewData> = {}): DepositViewData => ({
  organizationName: "Acme HVAC", estimateNumber: 77, estimateTitle: "New condenser",
  status: "requested", currency: "USD", amountRequested: "500.0000", amountReceived: "0.0000",
  outstanding: "500.0000", payable: true, onlinePaymentAvailable: true, ...over,
});

describe("the deposit page", () => {
  it("shows the deposit due and the card form", () => {
    const html = renderToStaticMarkup(
      <DepositView deposit={deposit()} returned={null} pay={<button>card form</button>} />,
    );
    expect(html).toContain("Deposit due");
    expect(html).toContain("$500.00");
    expect(html).toContain("estimate #77");
    expect(html).toContain("card form");
  });

  it("thanks the customer once it is held, and offers nothing to pay", () => {
    const html = renderToStaticMarkup(
      <DepositView
        deposit={deposit({ status: "held", amountReceived: "500.0000", outstanding: "0.00", payable: false })}
        returned={null}
        pay={<button>card form</button>}
      />,
    );
    expect(html).toContain("Deposit received");
    expect(html).not.toContain("card form");
  });
});
