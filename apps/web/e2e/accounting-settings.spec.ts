import { test, expect, run } from "./fixtures";
import { connectQuickBooks, disconnectQuickBooks, fakeQuickBooks, refusedInvoice } from "./quickbooks";

/**
 * SETTINGS → ACCOUNTING (M14)
 *
 * An owner whose books are connected chooses where an account goes, gives a
 * branch a class, and sends again an invoice QuickBooks refused, all on the
 * screen. QuickBooks is a local fake that counts its reads, because a read is
 * what QuickBooks meters: the page reads the chart and the classes only when
 * the owner presses the button that asks, and saving does not read again.
 *
 * The connection and the refused invoice are written directly, because
 * Intuit's consent screen and a refusal from QuickBooks are not what is being
 * tested; the branch is made through the API for the same reason.
 */
test("the account mappings, a branch's class and a refused invoice, from Settings, Accounting", async ({ owner }) => {
  // Before the books are connected, the page says where to connect them.
  await owner.goto("/settings/accounting");
  await expect(owner.getByText("No books connected")).toBeVisible();
  await expect(owner.getByRole("link", { name: "Settings, Integrations" })).toHaveAttribute("href", "/settings/integrations");

  const books = await fakeQuickBooks();
  const connectionId = await connectQuickBooks(books);
  try {
    const branchName = `Round Rock ${run}`;
    const branch = await owner.request.post("/api/v1/business-units", { data: { name: branchName } });
    expect(branch.ok()).toBe(true);
    const refused = await refusedInvoice(connectionId, "Account 4000 is not mapped to an account in QuickBooks.");

    await owner.goto("/settings/accounting");
    await expect(owner.getByRole("heading", { level: 1, name: "Accounting" })).toBeVisible();
    await expect(owner.getByText("Connected to QuickBooks Online.")).toBeVisible();
    const accounts = owner.getByRole("region", { name: "Where each account goes" });
    await expect(accounts.getByRole("row").filter({ hasText: "Revenue from work" })).toContainText("Not mapped");
    // An ordinary visit reads nothing from the books.
    expect(books.queries).toEqual([]);

    // The chart, read because the owner asked: accounts and items, two reads.
    await accounts.getByRole("link", { name: "Read the accounts from QuickBooks Online to change these" }).click();
    await expect(accounts.getByLabel("Account 4000 goes to")).toBeVisible();
    expect(books.queries).toHaveLength(2);
    await expect(accounts.getByLabel("Account 4000 goes to").locator("option", { hasText: "Retired Income" })).toHaveCount(0);
    await accounts.getByLabel("Account 4000 goes to").selectOption({ label: "4010 Sales of Service" });
    await accounts.getByLabel("Account 1000 goes to").selectOption({ label: "Undeposited Funds" });
    await accounts.getByRole("button", { name: "Save the mappings" }).click();

    await expect(owner.getByRole("status").filter({ hasText: "Saved. Documents on those accounts go on the next sync." })).toBeVisible();
    await expect(accounts.getByRole("row").filter({ hasText: "Revenue from work" })).toContainText("Sales of Service");
    await expect(accounts.getByRole("row").filter({ hasText: "Undeposited funds" })).toContainText("Undeposited Funds");
    // Saving went back to the plain page, so nothing was read again.
    expect(books.queries).toHaveLength(2);

    // The branch, sent as a class chosen from the list QuickBooks holds.
    const branches = owner.getByRole("region", { name: "Branches in the books" });
    await expect(branches.getByRole("row").filter({ hasText: branchName })).toContainText("Sent without one");
    await branches.getByRole("link", { name: "Read the classes from QuickBooks Online to change these" }).click();
    await branches.getByLabel(`${branchName} goes as`).selectOption({ label: "Round Rock shop" });
    await branches.getByRole("button", { name: "Save the branches" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "From the next sync" })).toBeVisible();
    await expect(branches.getByRole("row").filter({ hasText: branchName })).toContainText("Round Rock shop");
    expect(books.queries).toHaveLength(3);

    await branches.getByRole("button", { name: `Stop sending ${branchName}` }).click();
    await expect(owner.getByRole("status").filter({ hasText: "sent without one from the next sync" })).toBeVisible();
    await expect(branches.getByRole("row").filter({ hasText: branchName })).toContainText("Sent without one");

    // The invoice QuickBooks refused, with its reason, sent again.
    const problems = owner.getByRole("region", { name: "Documents that did not go" });
    const row = problems.getByRole("row").filter({ hasText: `Invoice ${refused.number}` });
    await expect(row).toContainText("Account 4000 is not mapped to an account in QuickBooks.");
    await expect(row).toContainText("Stopped after 5 tries");
    await row.getByRole("button", { name: "Send it again" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "It goes again on the next sync." })).toBeVisible();
    await expect(problems.getByRole("row").filter({ hasText: `Invoice ${refused.number}` })).toContainText("Goes again on the next sync");
    expect(books.queries).toHaveLength(3);
  } finally {
    await disconnectQuickBooks(connectionId);
    await books.close();
  }
});
