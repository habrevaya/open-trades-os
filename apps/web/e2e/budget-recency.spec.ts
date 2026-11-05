import { test, expect } from "./fixtures";

/**
 * A RUN RATE THAT COUNTS RECENT MONTHS FOR MORE, AND A BLEND FOR ONE LINE
 *
 * In a year nobody else's spec touches, the owner sets Revenue,
 * ticks the box that makes the run rate count recent months for more and sees
 * it kept, gives Revenue a blend of its own and reads it beside the line and
 * in the list, is refused in words for a line not in the budget, and takes it
 * all off again so a rerun starts from the same place.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const YEAR = 2004;

test("the run rate can count recent months for more, and one line can have its own blend", async ({ owner }) => {
  await owner.goto(`/books/budget?year=${YEAR}`);
  const lines = owner.getByRole("region", { name: "Set a line" });
  await lines.getByLabel("Line").fill("Revenue");
  /** The first form is the new line; a rerun also shows the line already there to change. */
  for (const name of MONTHS) await lines.getByLabel(name, { exact: true }).first().fill("1000");
  await lines.getByRole("button", { name: "Save line" }).click();
  await expect(owner.getByRole("table").first()).toContainText("Revenue");

  const forecast = owner.getByRole("region", { name: "The forecast" });
  await forecast.getByLabel("The months to come").selectOption("run_rate");
  await forecast.getByLabel("Run rate: count recent months for more").check();
  await forecast.getByRole("button", { name: "Use this" }).click();
  await expect(owner.getByText("The forecast now uses the run rate.")).toBeVisible();
  await owner.reload();
  await expect(forecast.getByLabel("Run rate: count recent months for more")).toBeChecked();

  const own = owner.getByRole("region", { name: "A blend for one line" });
  await own.getByLabel("Line for its own blend").fill("Labour");
  await own.getByLabel("Its budget (%)").fill("50");
  await own.getByLabel("The run rate (%)").fill("50");
  await own.getByRole("button", { name: "Use for this line" }).click();
  await expect(own.getByRole("alert").filter({ hasText: "Labour is not in the 2004 budget" })).toBeVisible();

  await own.getByLabel("Line for its own blend").fill("Revenue");
  await own.getByRole("button", { name: "Use for this line" }).click();
  await expect(own.getByRole("status").filter({ hasText: "That line now has a blend of its own." })).toBeVisible();
  await owner.reload();
  await expect(own.getByRole("list", { name: "Lines with a blend of their own" })).toContainText("Revenue: 50% at its budget and 50% at the run rate");
  await expect(owner.getByTestId("budget-forecast").first()).toContainText("Its own blend: 50% at its budget and 50% at the run rate");

  // Back as it was.
  await own.getByRole("button", { name: "Take off the blend for Revenue" }).click();
  await expect(own.getByRole("list", { name: "Lines with a blend of their own" })).toHaveCount(0);
  await forecast.getByLabel("The months to come").selectOption("budget");
  await forecast.getByLabel("Run rate: count recent months for more").uncheck();
  await forecast.getByRole("button", { name: "Use this" }).click();
  await expect(owner.getByText("The forecast now uses the budget.")).toBeVisible();
});
