import { test, expect } from "./fixtures";

/**
 * SETTINGS → REVIEW POLICY (M20)
 *
 * The owner sets how the company asks for reviews and how soon it answers
 * them on a screen, which was an API call, and is refused a time zone that is
 * not one. Then the one reminder's words: a placeholder that cannot be filled
 * and an offer for a review are refused in words, the company's own words are
 * kept and said to be theirs, and the shipped words go back with one button.
 *
 * Other specs set the policy through the API, so this starts from whatever is
 * there and leaves the policy as they set it and the reminder off.
 */
test("the review policy and the reminder's words, set from Settings, Review policy", async ({ owner }) => {
  await owner.goto("/settings/reviews");
  await expect(owner.getByRole("heading", { level: 1, name: "Review policy" })).toBeVisible();

  const asking = owner.getByRole("group", { name: "Asking for a review" });
  const save = owner.getByRole("button", { name: /(Save|Set) the review policy/ });
  await asking.getByLabel("Time zone the hours are in").fill("America/Springfield");
  await save.click();
  await expect(owner.getByRole("alert").filter({ hasText: '"America/Springfield" is not a time zone.' })).toBeVisible();

  await asking.getByLabel("Time zone the hours are in").fill("America/Chicago");
  await asking.getByLabel("Ask the same customer at most once every (days)").fill("75");
  await asking.getByLabel("Not after").selectOption({ label: "6 PM" });
  await save.click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved. Asking and answering follow it from now." })).toBeVisible();
  await owner.reload();
  await expect(asking.getByLabel("Ask the same customer at most once every (days)")).toHaveValue("75");
  await expect(asking.getByLabel("Not after")).toHaveValue("18");
  const policy = await owner.request.get("/api/v1/reviews/policy");
  expect(((await policy.json()) as { policy: { customerCooldownDays: number; latestHour: number } }).policy)
    .toMatchObject({ customerCooldownDays: 75, latestHour: 18 });

  // The reminder, in the company's own words, checked as the ask's are.
  const reminder = owner.getByRole("region", { name: "The reminder" });
  await expect(reminder).toContainText("It goes in the words we wrote.");
  await reminder.getByLabel(/Remind after this many days/).fill("5");
  await reminder.getByLabel("The text").fill("Hi {{ customer.first }}, one last nudge: {{ review.url }}");
  await reminder.getByRole("button", { name: "Save the reminder" }).click();
  await expect(reminder.getByRole("alert").filter({ hasText: "The text uses {{ customer.first }}" })).toBeVisible();

  await reminder.getByLabel("The text").fill("Hi {{ customer.name }}, $10 off your next visit for a review: {{ review.url }}");
  await reminder.getByRole("button", { name: "Save the reminder" }).click();
  await expect(reminder.getByRole("alert").filter({ hasText: "offers something for a review" })).toBeVisible();

  await reminder.getByLabel("The text").fill("Hi {{ customer.name }}, one last nudge from {{ organization.name }}: {{ review.url }}");
  await reminder.getByRole("button", { name: "Save the reminder" }).click();
  await expect(reminder.getByRole("status").filter({ hasText: "Saved. One reminder after 5 days, in your words." })).toBeVisible();
  await expect(reminder).toContainText("It goes in your own words.");
  const read = await owner.request.get("/api/v1/reviews/reminders");
  expect(((await read.json()) as { wording: { sms: string; custom: boolean } }).wording)
    .toMatchObject({ sms: "Hi {{ customer.name }}, one last nudge from {{ organization.name }}: {{ review.url }}", custom: true });

  await reminder.getByRole("button", { name: "Put back the words we wrote" }).click();
  await expect(reminder).toContainText("It goes in the words we wrote.");

  // Off again, and the policy as the other specs set it.
  await reminder.getByLabel(/Remind after this many days/).fill("");
  await reminder.getByRole("button", { name: "Save the reminder" }).click();
  await expect(reminder).toContainText("Off. Each customer is asked once.");
  const back = await owner.request.put("/api/v1/reviews/policy", { data: { timeZone: "America/Chicago" } });
  expect(back.ok(), await back.text()).toBe(true);
});
