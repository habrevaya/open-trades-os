import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, companyToday } from "./fixtures";

/**
 * A MILEAGE RATE FOR REIMBURSEMENTS
 *
 * The owner sets what one mile is paid on Pay rules; a technician with no rate set cannot claim
 * miles; once there is one, they put in the miles they drove and the office sees the amount worked
 * out at the rate, with the miles beside it, and approves it like any expense.
 */

const plus = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Only the mileage lines of the company's pay settings, so what other specs set beside them is left alone. */
async function clearMileageRates() {
  const db = createClient();
  try {
    await db.execute(sql`
      update public.organization
         set settings = jsonb_set(settings, '{payExtras,mileageRates}', '[]'::jsonb)
       where slug = 'ridgeline' and settings #> '{payExtras}' is not null`);
  } finally {
    await db.$close();
  }
}

test("the owner sets a mileage rate and a technician claims miles at it", async ({ owner, tech }) => {
  test.setTimeout(120_000);
  await clearMileageRates();
  try {
    const what = `Drive to the supply house ${run}`;

    // With no rate there is no box for miles.
    await tech.goto("/me/expenses");
    await expect(tech.getByRole("heading", { level: 1, name: "Money I spent" })).toBeVisible();
    await expect(tech.getByLabel("Or the miles you drove")).toHaveCount(0);

    // The owner sets one from a month ago.
    const from = plus(companyToday(), -30);
    await owner.goto("/payroll/pay-rules");
    const mileage = owner.getByRole("region", { name: "Mileage" });
    await expect(mileage).toContainText("No rate has started, so nobody can claim miles");
    await mileage.getByLabel("Starting on").fill(from);
    await mileage.getByLabel("Dollars for one mile").fill("seventy cents");
    await mileage.getByRole("button", { name: "Add the rate" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: "dollars" })).toBeVisible();
    await mileage.getByLabel("Dollars for one mile").fill("0.725");
    await mileage.getByRole("button", { name: "Add the rate" }).click();
    await expect(mileage.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await expect(mileage).toContainText("$0.725");
    await expect(mileage.getByRole("table", { name: "Mileage rates" })).toContainText("$0.725");
    // A day cannot have two.
    await mileage.getByLabel("Starting on").fill(from);
    await mileage.getByLabel("Dollars for one mile").fill("0.80");
    await mileage.getByRole("button", { name: "Add the rate" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: "already a rate from" })).toBeVisible();

    // The technician now has the box, and the rate said beside it.
    await tech.reload();
    await expect(tech.getByText("Miles are paid at $0.725 a mile")).toBeVisible();
    await tech.getByLabel("Or the miles you drove").fill("12.5");
    await tech.getByLabel("What it was for").fill(what);
    // Both is refused in words.
    await tech.getByLabel("What you paid (dollars)").fill("9.00");
    await tech.getByRole("button", { name: "Save it" }).click();
    await expect(tech.getByRole("alert").filter({ hasText: "not both" })).toBeVisible();
    await tech.getByLabel("What you paid (dollars)").fill("");
    await tech.getByRole("button", { name: "Save it" }).click();
    await expect(tech.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    const mine = tech.getByRole("listitem").filter({ hasText: what });
    await expect(mine).toContainText("$9.06");
    await expect(mine).toContainText("12.5 miles at $0.725 a mile");

    // The office sees the miles and the rate beside the amount, and approves it.
    await owner.goto("/timesheets/expenses");
    const row = owner.getByRole("table", { name: "Expenses" }).getByRole("row").filter({ hasText: what });
    await expect(row).toContainText("12.5 miles at $0.725 a mile");
    await expect(row).toContainText("$9.06");
    await row.getByRole("button", { name: new RegExp(`^Approve Ray Ortiz's ${what}`) }).click();
    await expect(row).toHaveCount(0);

    // Taking the rate off leaves the claim as it was worked out.
    await owner.goto("/payroll/pay-rules");
    await owner.getByRole("button", { name: /^Take off the rate from/ }).click();
    await expect(owner.getByRole("region", { name: "Mileage" })).toContainText("No rate has started, so nobody can claim miles");
    await tech.goto("/me/expenses");
    await expect(tech.getByLabel("Or the miles you drove")).toHaveCount(0);
    await expect(tech.getByRole("listitem").filter({ hasText: what })).toContainText("$9.06");
  } finally {
    await clearMileageRates();
  }
});
