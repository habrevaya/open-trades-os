import { test, expect } from "./fixtures";

/**
 * SETTINGS → REVIEW POLICY: A SECOND REMINDER AND THE FOLLOW UP BY EMAIL (M20)
 *
 * The owner turns on a second reminder and the follow up by email beside the
 * first reminder, sees them said back, is refused a second reminder without a
 * first, and leaves all three off as the other specs expect.
 */
test("a second reminder and the follow up by email are set from Settings, Review policy", async ({ owner }) => {
  // A policy to hang the reminders on, as the other specs leave it.
  const policy = await owner.request.put("/api/v1/reviews/policy", { data: { timeZone: "America/Chicago" } });
  expect(policy.ok(), await policy.text()).toBe(true);

  await owner.goto("/settings/reviews");
  const reminder = owner.getByRole("region", { name: "The reminder" });
  const save = reminder.getByRole("button", { name: "Save the reminder" });

  // A second with no first is refused in words.
  await reminder.getByLabel(/Remind after this many days/).fill("");
  await reminder.getByLabel(/A second reminder this many days after the first/).fill("7");
  await save.click();
  await expect(reminder.getByRole("alert").filter({ hasText: "A second reminder follows the first" })).toBeVisible();

  await reminder.getByLabel(/Remind after this many days/).fill("5");
  await reminder.getByLabel(/A second reminder this many days after the first/).fill("7");
  await reminder.getByLabel(/Follow an unanswered text with the ask by email/).fill("4");
  await save.click();
  await expect(reminder.getByRole("status").filter({ hasText: "Saved. A reminder after 5 days, and a second 7 days after it." })).toBeVisible();
  await owner.reload();
  await expect(reminder).toContainText("A second, last one goes 7 days after the first.");
  await expect(reminder.getByLabel(/A second reminder this many days after the first/)).toHaveValue("7");
  await expect(reminder.getByLabel(/Follow an unanswered text with the ask by email/)).toHaveValue("4");
  const read = (await (await owner.request.get("/api/v1/reviews/reminders")).json()) as {
    afterDays: number | null; secondAfterDays: number | null; followUpAfterDays: number | null;
  };
  expect(read).toMatchObject({ afterDays: 5, secondAfterDays: 7, followUpAfterDays: 4 });

  // Off again, all three.
  await reminder.getByLabel(/Remind after this many days/).fill("");
  await reminder.getByLabel(/A second reminder this many days after the first/).fill("");
  await reminder.getByLabel(/Follow an unanswered text with the ask by email/).fill("");
  await save.click();
  await expect(reminder).toContainText("Off. Each customer is asked once.");
  const off = (await (await owner.request.get("/api/v1/reviews/reminders")).json()) as Record<string, unknown>;
  expect(off).toMatchObject({ afterDays: null, secondAfterDays: null, followUpAfterDays: null });

  // The answer-within table draws a row for each star rating.
  await expect(owner.getByLabel(/^Row \d+: up to$/)).toHaveCount(5);
});
