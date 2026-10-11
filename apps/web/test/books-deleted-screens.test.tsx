import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../src/lib/books-actions", () => ({ sendToBooksAgain: vi.fn() }));

import { DeletedInBooks } from "../src/components/DeletedInBooks";
import { Payments, type PaymentRow } from "../src/app/(app)/customers/[id]/Payments";

/**
 * A RECORD THE BOOKS NO LONGER HOLD (M14)
 *
 * Said on the record itself: that it was deleted in the books, that nothing
 * was sent again or taken back here, and, to somebody who runs the sync, a
 * button to send it again. Nobody else is offered the button.
 */
const flag = { linkId: "l1", books: "QuickBooks Online", noticedAt: "2026-10-07T15:00:00.000Z" };
const action = async () => null;
const payment: PaymentRow = {
  id: "p1", method: "check", amount: "500.0000", refundedAmount: "75.0000", unappliedAmount: "0.0000",
  receivedOn: "Oct 1, 2026", checkNumber: "1044", processorPaymentId: null,
  allocations: [{ invoiceNumber: 1042, amount: "425.0000" }],
};

describe("a record deleted in the books", () => {
  it("says so on the record, and offers to send it again to somebody who runs the sync", () => {
    const html = renderToStaticMarkup(
      <DeletedInBooks flag={flag} what="Journal 12" path="/books" timezone="America/Chicago" canSend />,
    );
    expect(html).toContain("Journal 12 was deleted in QuickBooks Online");
    expect(html).toContain("Nothing has been sent");
    expect(html).toContain("Send it to QuickBooks Online again");
  });

  it("offers nobody else the button", () => {
    const html = renderToStaticMarkup(
      <DeletedInBooks flag={flag} what="Journal 12" path="/books" timezone="America/Chicago" canSend={false} />,
    );
    expect(html).toContain("the bookkeeper has a task");
    expect(html).not.toContain("Send it to");
  });

  it("marks a payment whose refund the books no longer hold, and only that payment", () => {
    const html = renderToStaticMarkup(
      <Payments customerId="c" apply={action} refund={action} canCollect canRefund open={[]}
                payments={[payment, { ...payment, id: "p2" }]}
                refundsDeletedInBooks={{ p1: [{ books: "Xero", noticedAt: flag.noticedAt }] }} />,
    );
    expect(html.match(/A refund of this payment was deleted in Xero/g)).toHaveLength(1);
  });
});
