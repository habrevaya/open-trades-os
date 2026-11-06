import { test, expect } from "./fixtures";

/**
 * DAYS CHOSEN ON A DASHBOARD'S OWN SCREEN, AND A SECOND MEASURE ON A REPORT'S CHART
 *
 * On the Money dashboard the office chooses "Between two dates" for a month
 * long before the seed's own work: the page says which tiles show those days
 * and which keep their own ("Outstanding" is about how things stand), the
 * invoiced tile is cut to the month, and "Download as PDF" carries the same
 * days. Two days the wrong way round are refused in words. On the Revenue by
 * month report, "Also draw" puts the invoice count beside the revenue, and
 * "Nothing else" takes it off.
 */

test("Dashboards: days chosen on the screen and its PDF, and a second measure on a report's own chart", async ({ owner }) => {
  await owner.goto("/dashboards/money");
  const form = owner.getByRole("form", { name: "Dates for this dashboard" });
  await form.getByLabel("Days").selectOption("between");
  await form.getByLabel("First day").fill("2001-03-01");
  await form.getByLabel("Last day").fill("2001-03-31");
  await form.getByRole("button", { name: "Show" }).click();
  await expect(owner).toHaveURL(/dates=between/);
  const said = owner.getByRole("status").filter({ hasText: "Showing" });
  await expect(said).toContainText("Showing Mar 1, 2001 to Mar 31, 2001 on the tiles that follow the dashboard's dates.");
  await expect(said).toContainText("These keep their own dates: Outstanding");

  const pdf = owner.getByRole("link", { name: "Download as PDF" });
  await expect(pdf).toHaveAttribute("href", /\/dashboards\/money\/pdf\?dates=between&from=2001-03-01&to=2001-03-31/);
  const response = await owner.request.get((await pdf.getAttribute("href"))!);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/pdf");

  /** The wrong way round is refused in words, and the dashboard is drawn as it stands. */
  await owner.goto("/dashboards/money?dates=between&from=2001-03-31&to=2001-03-01");
  await expect(owner.getByRole("alert")).toContainText("The last day, Mar 1, 2001, is before the first, Mar 31, 2001. Swap them.");
  const refused = await owner.request.get("/dashboards/money/pdf?dates=between&from=2001-03-31&to=2001-03-01");
  expect(refused.status()).toBe(409);

  /** A second measure on the report's own chart. */
  await owner.goto("/reports/built-in/revenue-by-month");
  const also = owner.getByLabel("A second measure");
  await expect(also).toContainText("Also draw");
  await also.getByRole("link", { name: "Invoices" }).click();
  await expect(owner).toHaveURL(/second=count/);
  await expect(owner.getByLabel("A second measure").getByText("Invoices", { exact: true })).toBeVisible();
  await expect(owner.getByRole("link", { name: "Nothing else" })).toBeVisible();
  await owner.getByRole("link", { name: "Nothing else" }).click();
  await expect(owner).not.toHaveURL(/second=/);
});
