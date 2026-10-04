import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../src/app/(portal)/financing-actions", () => ({ applyForFinancing: vi.fn() }));
vi.mock("../src/app/(app)/invoices/financing/actions", () => ({ offerFinancing: vi.fn(), checkFinancing: vi.fn() }));

import { PayOverTime } from "../src/app/(portal)/Financing";
import { FinancingPanel } from "../src/components/FinancingPanel";

/**
 * FINANCING ON A SCREEN
 *
 * The one rule both screens share: the monthly figure never appears without
 * the sentence that says it is subject to the lender's approval.
 */
const offer = {
  lender: "Wisetack", monthly: "316.7400", months: 60, aprPercent: "17.9",
  sentence: "As low as $316.74 a month over 60 months at 17.9% APR, if Wisetack approves the application. Subject to approval; the rate and term you are offered may be different.",
  short: "As low as $316.74/month with Wisetack, subject to approval",
};

const application = {
  id: "a1", provider: "wisetack", status: "funded" as const, statusLabel: "Funded", customerId: "c1", customerName: "Jamie",
  invoiceId: "i1", invoiceNumber: 1042, estimateId: null, estimateNumber: null, amount: "4800.0000",
  approvedAmount: "4800.0000", chosenOffer: { months: 60, aprPercent: "17.9", monthlyPayment: "121.63" },
  fundedAmount: "4800.0000", feeAmount: null, fundedAt: "2026-10-01T00:00:00.000Z", paymentId: "p1",
  applicationUrl: "https://lender.test/apply/x", sentVia: "sms", sentTo: "+15125550199",
  attention: "The lender did not say what fee it kept, so none was booked.", expiresAt: null,
  createdAt: "2026-09-30T15:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
};

describe("pay over time, on the customer's page", () => {
  it("shows the figure inside its caveat, and the button to apply", () => {
    const html = renderToStaticMarkup(
      <PayOverTime token="t" lender="Wisetack" application={null}
                   options={[{ optionId: null, name: null, offer, applicable: true }]} />,
    );
    expect(html).toContain("Subject to approval");
    expect(html).toContain("Apply for financing");
    expect(html).not.toContain("Continue your application");
  });

  it("sends a customer with an open application back to it rather than opening another", () => {
    const html = renderToStaticMarkup(
      <PayOverTime token="t" lender="Wisetack"
                   application={{ status: "applied", statusLabel: "Applied", applicationUrl: "https://lender.test/apply/x" }}
                   options={[{ optionId: null, name: null, offer, applicable: true }]} />,
    );
    expect(html).toContain("Continue your application");
    expect(html).toContain("with the lender");
  });

  it("offers nothing on an amount the lender does not finance", () => {
    const html = renderToStaticMarkup(
      <PayOverTime token="t" lender="Wisetack" application={null}
                   options={[{ optionId: null, name: null, offer: null, applicable: false }]} />,
    );
    expect(html).toBe("");
  });
});

describe("the office's financing panel", () => {
  it("points at the integrations screen when no lender is connected", () => {
    const html = renderToStaticMarkup(
      <FinancingPanel subject={{ invoiceId: "i1" }} connected={false} lender={null} offers={[]}
                      applications={[]} canSend timezone="America/Chicago" />,
    );
    expect(html).toContain("/settings/integrations");
  });

  it("lists an application with what the lender said, and an unreported fee as not reported", () => {
    const html = renderToStaticMarkup(
      <FinancingPanel subject={{ invoiceId: "i1" }} connected lender="Wisetack"
                      offers={[{ optionId: null, name: null, total: "0", sentence: null, applicable: false }]}
                      applications={[application]} canSend timezone="America/Chicago" />,
    );
    expect(html).toContain("Funded");
    expect(html).toContain("60 months at 17.9% APR");
    expect(html).toContain("Not reported");
    expect(html).toContain("did not say what fee");
    expect(html).not.toContain("Ask the lender");
  });
});
