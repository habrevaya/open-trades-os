import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * THE BACK OFFICE PAYS PEOPLE BESIDE THEIR HOURS
 *
 * What a technician paid for the company, put in from the phone sized pages
 * and decided by the office; a day away at the company's rate. Each is driven
 * the way the person meets it, with the database used only to read what a
 * screen cannot show (the row, its receipt) and to find a job to name.
 */

/** A real PNG header, so the sniffer has something true to find. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 7]);

async function anyJobNumber(): Promise<number> {
  const db = createClient();
  try {
    const rows = await db.execute<{ number: number }>(sql`
      select j.number from public.job j join public.organization o on o.id = j.organization_id
       where o.slug = 'ridgeline' order by j.created_at limit 1`);
    return Number(rows[0]!.number);
  } finally {
    await db.$close();
  }
}

test("a technician puts in what they paid with a receipt, and the office approves it", async ({ owner, tech }) => {
  const what = `Capacitor ${run}`;
  await tech.goto("/me/expenses");
  await expect(tech.getByRole("heading", { level: 1, name: "Money I spent" })).toBeVisible();
  await tech.getByLabel("What you paid (dollars)").fill("42.50");
  await tech.getByLabel("What it was for").fill(what);
  await tech.getByLabel("Photo of the receipt").setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: PNG });
  await tech.getByRole("button", { name: "Save it" }).click();
  await expect(tech.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();

  const mine = tech.getByRole("listitem").filter({ hasText: what });
  await expect(mine).toContainText("$42.50");
  await expect(mine).toContainText("Waiting for the office");
  await expect(mine.getByRole("link", { name: "receipt" })).toBeVisible();

  // The office sees it, with its receipt, and approves it.
  await owner.goto("/timesheets/expenses");
  const row = owner.getByRole("table", { name: "Expenses" }).getByRole("row").filter({ hasText: what });
  await expect(row).toContainText("Ray Ortiz");
  await expect(row).toContainText("$42.50");
  const receipt = await owner.request.get(await row.getByRole("link", { name: "Receipt" }).getAttribute("href") ?? "");
  expect(receipt.status()).toBe(200);
  expect(receipt.headers()["content-type"]).toBe("image/png");
  await row.getByRole("button", { name: new RegExp(`^Approve Ray Ortiz's ${what}`) }).click();
  // It leaves the waiting list and is on the approved one.
  await expect(row).toHaveCount(0);
  await owner.goto("/timesheets/expenses?status=approved");
  await expect(owner.getByRole("table", { name: "Expenses" }).getByRole("row").filter({ hasText: what })).toContainText("Approved");

  await tech.reload();
  await expect(tech.getByRole("listitem").filter({ hasText: what })).toContainText("Approved");
});

test("a refusal needs a reason, and the technician reads it", async ({ owner, tech }) => {
  const what = `Lunch ${run}`;
  await tech.goto("/me/expenses");
  await tech.getByLabel("What you paid (dollars)").fill("18");
  await tech.getByLabel("What it was for").fill(what);
  await tech.getByRole("button", { name: "Save it" }).click();
  await expect(tech.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();

  await owner.goto("/timesheets/expenses");
  const row = owner.getByRole("table", { name: "Expenses" }).getByRole("row").filter({ hasText: what });
  await expect(row.getByText("No receipt")).toBeVisible();
  await row.getByLabel(`Why Ray Ortiz's ${what} is refused`).fill("Lunch on a job in town is not paid back.");
  await row.getByRole("button", { name: "Refuse" }).click();
  await expect(row).toHaveCount(0);
  await owner.goto("/timesheets/expenses?status=refused");
  await expect(owner.getByRole("table", { name: "Expenses" }).getByRole("row").filter({ hasText: what }))
    .toContainText("Lunch on a job in town is not paid back.");

  await tech.reload();
  const mine = tech.getByRole("listitem").filter({ hasText: what });
  await expect(mine).toContainText("Not approved");
  await expect(mine).toContainText("Lunch on a job in town is not paid back.");
});

test("an expense typed on the day page is kept in the queue, sent, and waiting for the office", async ({ owner, tech }) => {
  const what = `Gloves ${run}`;
  await tech.goto("/my-day");
  const panel = tech.getByRole("region", { name: "Money I spent" });
  await panel.getByRole("button", { name: "Add one" }).click();
  await panel.getByLabel("What you paid").fill("9.99");
  await panel.getByLabel("What it was for").fill(what);
  await panel.getByLabel("Photo of the receipt").setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: PNG });
  await panel.getByRole("button", { name: "Save it" }).click();
  await expect(panel.getByRole("status")).toContainText("Saved.");
  await expect(panel).toContainText(what);
  await expect(tech.getByText(/All sent/)).toBeVisible();

  await owner.goto("/timesheets/expenses");
  const row = owner.getByRole("table", { name: "Expenses" }).getByRole("row").filter({ hasText: what });
  await expect(row).toContainText("$9.99");
  await expect(row.getByRole("link", { name: "Receipt" })).toBeVisible();

  // And a slip is said on the page before anything is kept.
  await panel.getByLabel("What you paid").fill("lots");
  await panel.getByLabel("What it was for").fill("Something");
  await panel.getByRole("button", { name: "Save it" }).click();
  await expect(panel.getByRole("alert").filter({ hasText: "dollars and cents" })).toBeVisible();
});

test("a day away is paid at the company's rate once somebody says what it is worth", async ({ owner }) => {
  const number = await anyJobNumber();
  await owner.goto("/timesheets/expenses");
  await expect(owner.getByText("No rate is set, so no day away is paid.")).toBeVisible();

  await owner.goto("/payroll/pay-rules");
  await owner.getByLabel("A day away is worth (dollars)").fill("75");
  await owner.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByRole("status").filter({ hasText: /^Saved\./ })).toBeVisible();

  await owner.goto("/timesheets/expenses");
  const day = "2026-02-03";
  await owner.getByLabel("Who was away").selectOption({ label: "Ray Ortiz" });
  await owner.getByLabel("Job number").fill(String(number));
  await owner.getByLabel("First day away").fill(day);
  await owner.getByLabel("Last day away").fill("2026-02-04");
  await owner.getByRole("button", { name: "Record the days" }).click();
  await expect(owner.getByRole("status").filter({ hasText: /2 days recorded at 75\.00/ })).toBeVisible();

  const days = owner.getByRole("table", { name: "Days away" });
  await expect(days.getByRole("row").filter({ hasText: "Feb 3, 2026" })).toContainText("$75.00");

  // Taking one back out, which is allowed while its pay period is open.
  await days.getByRole("row").filter({ hasText: "Feb 4, 2026" }).getByRole("button", { name: /^Take out Ray Ortiz's 2026-02-04/ }).click();
  await expect(days.getByRole("row").filter({ hasText: "Feb 4, 2026" })).toHaveCount(0);

  // The rate is put back, so nothing after this spec pays a day away.
  await owner.goto("/payroll/pay-rules");
  await owner.getByLabel("A day away is worth (dollars)").fill("");
  await owner.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByRole("status").filter({ hasText: /^Saved\./ })).toBeVisible();
});

test("the office puts a cash tip on a technician's pay and changes it, and the technician reads both with the reasons", async ({ owner, tech }) => {
  const why = `Mrs Oyelaran rang to say she gave Ray twenty dollars ${run}`;
  await owner.goto("/timesheets/tips");
  await expect(owner.getByRole("heading", { level: 1, name: "Cash tips" })).toBeVisible();
  await owner.getByLabel("Who was tipped").selectOption({ label: "Ray Ortiz" });
  await owner.getByLabel("The tip (dollars)").fill("20");
  await owner.getByLabel("Why you are recording it").fill(why);
  await owner.getByRole("button", { name: "Put it on their pay" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Put on Ray Ortiz's pay." })).toBeVisible();

  // A second of the same amount that day is refused as a likely duplicate.
  await owner.getByLabel("Who was tipped").selectOption({ label: "Ray Ortiz" });
  await owner.getByLabel("The tip (dollars)").fill("20");
  await owner.getByLabel("Why you are recording it").fill("Again");
  await owner.getByRole("button", { name: "Put it on their pay" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "already have a tip of that amount on that day" })).toBeVisible();

  await owner.reload();
  const row = owner.getByRole("table", { name: "Cash tips" }).getByRole("row").filter({ hasText: why });
  await expect(row).toContainText("$20.00");
  await row.getByLabel(/^New amount for Ray Ortiz's tip/).fill("25");
  await row.getByLabel(/^Why Ray Ortiz's tip on .* is changed/).fill("She meant twenty five");
  await row.getByRole("button", { name: /^Change Ray Ortiz's/ }).click();
  await expect(owner.getByRole("status").filter({ hasText: /^Changed\./ })).toBeVisible();

  await tech.goto("/me/pay");
  const kept = tech.getByRole("region", { name: "Cash tips on your pay" });
  const line = kept.getByRole("listitem").filter({ hasText: why });
  await expect(line).toContainText("$25.00");
  await expect(line).toContainText("Changed from $20.00 to $25.00");
  await expect(line).toContainText("She meant twenty five");

  // A tip that was never given comes off their pay by being corrected to nothing.
  await owner.reload();
  const again = owner.getByRole("table", { name: "Cash tips" }).getByRole("row").filter({ hasText: why });
  await again.getByLabel(/^New amount for Ray Ortiz's tip/).fill("0");
  await again.getByLabel(/^Why Ray Ortiz's tip on .* is changed/).fill("Never given after all");
  await again.getByRole("button", { name: /^Change Ray Ortiz's/ }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Taken off their pay." })).toBeVisible();
  await tech.reload();
  await expect(tech.getByRole("region", { name: "Cash tips on your pay" }).getByRole("listitem").filter({ hasText: why })).toContainText("$0.00");
});

test("how a tip is shared is chosen on the pay rules, and kept", async ({ owner }) => {
  await owner.goto("/payroll/pay-rules");
  await owner.getByLabel("Share a tip").selectOption("hours");
  await owner.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByRole("status").filter({ hasText: /^Saved\. Tips are shared this way from the next one/ })).toBeVisible();
  await owner.reload();
  await expect(owner.getByText("By the hours each person worked on the job").first()).toBeVisible();
  await expect(owner.getByLabel("Share a tip")).toHaveValue("hours");

  // Put back, so the tips every later spec takes are shared as they always were.
  await owner.getByLabel("Share a tip").selectOption("even");
  await owner.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByRole("status").filter({ hasText: /^Saved\./ })).toBeVisible();
  await owner.reload();
  await expect(owner.getByLabel("Share a tip")).toHaveValue("even");
});
