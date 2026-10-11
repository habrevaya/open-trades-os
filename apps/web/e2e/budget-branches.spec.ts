import { test, expect, run, companyToday } from "./fixtures";

/**
 * A BRANCH'S BUDGET AGAINST WHAT ITS BOOKS SAY
 *
 * The owner opens the budget for one branch, sets its revenue for this month,
 * and reads it against the revenue the ledger put in that branch, with the
 * page saying how much of the year carries no branch. The company's own
 * budget does not have the branch's figure added into it.
 *
 * The branch and the revenue are made through the API (a journal crediting
 * revenue in the branch), because they are not what is being tested.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

test("a branch's budget is read against the revenue booked in that branch", async ({ owner }) => {
  const branchName = `Pflugerville ${run}`;
  const branch = await owner.request.post("/api/v1/business-units", { data: { name: branchName } });
  expect(branch.ok()).toBe(true);
  const branchId = (await branch.json() as { id: string }).id;

  const today = companyToday();
  const [year, month] = today.split("-").map(Number) as [number, number];
  const posted = await owner.request.post("/api/v1/ledger/journal-entries", {
    data: {
      occurredOn: today, memo: `Revenue booked in ${branchName}`,
      lines: [
        { accountCode: "1000", debit: "2468.00" },
        { accountCode: "4000", credit: "2468.00", businessUnitId: branchId },
      ],
    },
  });
  expect(posted.ok()).toBe(true);

  await owner.goto(`/books/budget?year=${year}`);
  await owner.getByLabel("Branch").selectOption({ label: branchName });
  await owner.getByRole("button", { name: "Show" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: `Budget ${year}, ${branchName}` })).toBeVisible();
  await expect(owner.getByText(`No budget for ${year} for ${branchName} yet`)).toBeVisible();
  // It says what a branch's figures cannot hold.
  await expect(owner.getByTestId("budget-branch-coverage")).toContainText("carry no");

  const section = owner.getByRole("region", { name: "Set a line" });
  await section.getByLabel("Line").fill("Revenue");
  await section.getByLabel(MONTHS[month - 1]!, { exact: true }).fill("3000");
  await section.getByRole("button", { name: "Save line" }).click();

  const table = owner.getByRole("table", { name: `Budget against actual, ${year}` });
  const revenue = table.getByRole("row").filter({ hasText: "Revenue" });
  await expect(revenue).toContainText("$3,000.00");
  await expect(revenue).toContainText("$2,468.00");
  await expect(owner.getByRole("heading", { level: 1, name: `Budget ${year}, ${branchName}` })).toBeVisible();

  // The whole company's budget is its own lines: the branch's figure is not added in.
  await owner.getByLabel("Branch").selectOption({ label: "The whole company" });
  await owner.getByRole("button", { name: "Show" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: `Budget ${year}` })).toBeVisible();
  await expect(owner.getByText("A branch's lines are its own and are not added in here.")).toBeVisible();
  await expect(owner.getByText("$3,000.00")).toHaveCount(0);
});
