import { test, expect } from "./fixtures";

/**
 * ASKING FOR A REVIEW BY TEXT, BY EMAIL, OR BY TEXT AND THEN EMAIL
 *
 * The recommended automation takes the way of asking as a choice when it is
 * turned on. This turns it on from the screen with the third way, opens it as
 * an ordinary automation, and checks its send step carries the choice. What
 * reaches a customer by each way, and the worker sending a request the office
 * queued, is in packages/api/test/review-asks.integration.test.ts.
 */
test("the review ask is turned on with a way of asking, and opens as an ordinary automation that says it", async ({ owner }) => {
  // The review rules and a review site with its link, which the automation cannot be turned on without.
  const policy = await owner.request.put("/api/v1/reviews/policy", {
    data: { timeZone: "America/Chicago", delayMinutes: 120, customerCooldownDays: 90, requirePaid: true, maxJobAgeDays: 14, earliestHour: 9, latestHour: 19 },
  });
  expect(policy.ok(), await policy.text()).toBe(true);
  const platform = await owner.request.post("/api/v1/reviews/platforms", {
    data: {
      platform: "google", displayName: "Google", reviewUrl: "https://g.page/r/ridgeline/review",
      prohibits: ["incentives", "bulk_requests", "templated_replies"], note: "Checked their policy this month.",
    },
  });
  expect(platform.ok(), await platform.text()).toBe(true);

  await owner.goto("/automations");
  const card = owner.getByRole("region", { name: "Ask for a review after a paid job" });
  await expect(card).toContainText("by text, by email, or by text first and then email");
  const how = card.getByLabel("How to ask");
  await expect(how).toHaveValue("sms");
  await expect(how.locator("option")).toHaveText([
    "By text", "By email", "By text, and by email if the text cannot be sent",
  ]);
  await how.selectOption("sms_then_email");
  await card.getByRole("button", { name: "Turn on" }).click();
  await expect(card.getByText("On", { exact: true })).toBeVisible();

  await card.getByRole("link", { name: "Open it" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: "Ask for a review after a paid job" })).toBeVisible();
  await expect(owner.getByText("by text, then by email if the text cannot be sent")).toBeVisible();
  await expect(owner.getByRole("region", { name: /step 3, .*review/i })).toBeVisible();
});
