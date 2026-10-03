import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountView, type AccountViewData } from "../src/app/(portal)/c/[token]/AccountView";
import { DepositView, type DepositViewData } from "../src/app/(portal)/pay/[token]/DepositView";
import { PayInvoice } from "../src/app/(portal)/PayInvoice";
import { SignInForm } from "../src/app/(portal)/portal/[slug]/SignInForm";

/** The server actions behind the sign in form, which need a request and a database. Rendering does not call them. */
vi.mock("../src/app/(portal)/portal/[slug]/actions", () => ({ sendCode: vi.fn(), checkCode: vi.fn() }));

/**
 * THE TWO PORTAL PAGES THAT DID NOT EXIST, RENDERED
 *
 * The services behind them are tested against Postgres; this is what a
 * customer sees, rendered from the same shapes without a database.
 */
const NO_TIP = { available: false, presets: [], for: [] };

const account = (over: Partial<AccountViewData> = {}): AccountViewData => ({
  organizationName: "Acme HVAC",
  customerName: "Dana Reyes",
  properties: [{ id: "p1", line1: "14 Live Oak St", line2: null, city: "Austin", state: "TX", postalCode: "78704" }],
  jobs: [{ id: "j1", number: 12, summary: "Water heater", status: "completed", completedAt: "2026-03-14T18:00:00Z" }],
  visits: [{
    id: "v1", jobNumber: 12, summary: "Spring tune-up", status: "scheduled",
    windowStart: new Date(Date.now() + 864e5).toISOString(),
    windowEnd: new Date(Date.now() + 864e5 + 72e5).toISOString(),
    technicianName: "Sam Ortiz",
  }],
  invoices: [
    { id: "i1", number: 1041, status: "open", issuedOn: "2026-09-01", dueOn: "2026-09-15",
      currency: "USD", total: "458.0000", balance: "458.0000", payable: true, tipping: NO_TIP },
    { id: "i2", number: 1002, status: "paid", issuedOn: "2026-03-01", dueOn: null,
      currency: "USD", total: "120.0000", balance: "0.0000", payable: false, tipping: NO_TIP },
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

describe("the signed in account", () => {
  it("shows the customer's homes and work, and opens a record only where the page offers it", () => {
    const linkPage = renderToStaticMarkup(<AccountView account={account()} pay={() => null} />);
    expect(linkPage).toContain("14 Live Oak St");
    expect(linkPage).toContain("Water heater");
    // An account link offers no way to open an estimate as an approval link.
    expect(linkPage).not.toContain("Look and approve");

    const signedIn = renderToStaticMarkup(
      <AccountView
        account={account()}
        pay={() => null}
        open={(kind, id, label) => <button>{`${label} ${kind} ${id}`}</button>}
        top={<button>Sign out</button>}
      />,
    );
    expect(signedIn).toContain("Look and approve estimate e1");
    expect(signedIn).toContain("Details and photos job j1");
    expect(signedIn).toContain("See invoice invoice i2");
    expect(signedIn).toContain("Sign out");
  });
});

describe("paying an invoice", () => {
  const start = async () => ({ ok: false as const, message: "not in a test" });

  it("offers the company's tips, in dollars, for the technicians by name", () => {
    const html = renderToStaticMarkup(
      <PayInvoice
        balance="200.0000" currency="USD" start={start}
        tipping={{ available: true, presets: [{ percent: 15, amount: "30.0000" }], for: ["Sam", "Priya"] }}
      />,
    );
    expect(html).toContain("Add a tip for Sam and Priya?");
    expect(html).toContain("15% ($30.00)");
    expect(html).toContain("No tip");
    expect(html).toContain("Pay $200.00 now");
  });

  it("offers no tip when the company does not take them, and a saved card when there is one", () => {
    const html = renderToStaticMarkup(
      <PayInvoice
        balance="80.0000" currency="USD" start={start} tipping={NO_TIP}
        savedCards={[{ id: "c1", label: "Visa ending 4242" }]}
        payWithSaved={async () => ({ ok: false, message: "not in a test" })}
      />,
    );
    expect(html).not.toContain("Add a tip");
    expect(html).toContain("Pay $80.00 with Visa ending 4242");
  });
});

describe("signing in", () => {
  it("asks for the address the company has, and says a code will be sent rather than a password", () => {
    const html = renderToStaticMarkup(<SignInForm slug="acme" organizationName="Acme HVAC" />);
    expect(html).toContain("Email or mobile number");
    expect(html).toContain("The one Acme HVAC has for you");
    expect(html).toContain("Send me a code");
    expect(html).not.toContain("password");
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
