import { test, expect, run } from "./fixtures";
import { connectQuickBooks, disconnectQuickBooks, fakeQuickBooks } from "./quickbooks";

/**
 * A SYNC RUN FROM THE SCREEN, WHAT IT SENT AND REFUSED, AND CLOSING A MONTH (M14)
 *
 * The owner runs a pass from Settings, Accounting against the QuickBooks fake
 * and reads what it did: the customers went, and the invoices were refused
 * here before sending because no account is mapped, each with the sentence
 * saying which. Then, on Books, the owner closes a long past month, is
 * refused closing behind it in words, and reopens it with a reason.
 *
 * The month is in 2001, before anything the seed or another spec posts, and
 * it is reopened before the spec ends, so nothing after this is refused for
 * a closed month.
 */
test("running the sync now, reading what it sent and refused, and closing a month", async ({ owner }) => {
  const books = await fakeQuickBooks();
  const connectionId = await connectQuickBooks(books);
  try {
    await owner.goto("/settings/accounting");
    const syncs = owner.getByRole("region", { name: "Syncs" });
    await expect(syncs.getByText("No syncs yet")).toBeVisible();

    await syncs.getByRole("button", { name: "Sync now" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "The sync has run." })).toBeVisible();

    // The pass is in the history, finished, with what it did in words.
    const row = syncs.getByRole("row").filter({ hasText: "Finished" });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(/Sent \d+/);
    await expect(row).toContainText(/refused \d+/);

    // And opened: the refusals first, each with its reason, then what went.
    const documents = owner.getByRole("region", { name: "Documents in this sync" });
    const refusedInvoice = documents.getByRole("row").filter({ hasText: /^Invoice \d+/ }).first();
    await expect(refusedInvoice).toContainText("Refused");
    await expect(refusedInvoice).toContainText("is not mapped to anything in the accounting system");
    const sentCustomer = documents.getByRole("row").filter({ hasText: /^Customer / }).first();
    await expect(sentCustomer).toContainText("Sent");
    // Customers reached the books and nothing else did: every invoice was held back here.
    expect(books.creates.length).toBeGreaterThan(0);
    expect(new Set(books.creates)).toEqual(new Set(["Customer"]));
    // Running it read only the change feed: nothing about the chart.
    expect(books.queries).toEqual([]);

    // The refused invoices wait on the problems list, to be sent again once mapped.
    const problems = owner.getByRole("region", { name: "Documents that did not go" });
    await expect(problems.getByRole("row").filter({ hasText: /^Invoice \d+/ }).first())
      .toContainText("Refused, and tried again on each sync");

    // Closing a month is on Books.
    await owner.getByRole("link", { name: "Closing a month" }).click();
    await expect(owner.getByRole("heading", { level: 1, name: "Closing the books" })).toBeVisible();
    await expect(owner.getByRole("status").filter({ hasText: "No month is closed." })).toBeVisible();

    const close = owner.getByRole("region", { name: "Close a month" });
    await close.getByLabel("Last day to close").fill("2001-01-31");
    await close.getByLabel("Note (optional)").fill("January 2001 filed.");
    await close.getByRole("button", { name: "Close the books through this day" }).click();
    await expect(close.getByRole("status").filter({ hasText: "Closed through Jan 31, 2001." })).toBeVisible();
    await expect(owner.getByRole("status").filter({ hasText: "The books are closed through Jan 31, 2001." })).toBeVisible();

    // Behind the close is refused, in words.
    await close.getByLabel("Last day to close").fill("2000-12-31");
    await close.getByRole("button", { name: "Close the books through this day" }).click();
    await expect(close.getByRole("alert").filter({ hasText: "already closed through 2001-01-31" })).toBeVisible();

    // Reopened, with the reason kept beside it.
    const closes = owner.getByRole("region", { name: "Closes so far" });
    const reopen = owner.getByRole("button", { name: "Reopen Jan 31, 2001" });
    const closed = closes.getByRole("row").filter({ has: reopen });
    await expect(closed).toHaveCount(1);
    const reason = `Closed the wrong year (${run}).`;
    await closed.getByLabel("Why it is being reopened").fill(reason);
    await closed.getByRole("button", { name: "Reopen Jan 31, 2001" }).click();
    await expect(closes.getByRole("row").filter({ hasText: reason })).toContainText("Reopened");
    await expect(owner.getByRole("status").filter({ hasText: "No month is closed." })).toBeVisible();
  } finally {
    await disconnectQuickBooks(connectionId);
    await books.close();
  }
});
