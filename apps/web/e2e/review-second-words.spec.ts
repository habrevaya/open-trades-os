import { test, expect } from "./fixtures";

/**
 * SETTINGS → REVIEW POLICY: THE SECOND REMINDER'S OWN WORDS (M20)
 *
 * The owner writes the words the second reminder goes in, is refused words that
 * offer something for a review in a sentence that names the second reminder, sees
 * their own words after a reload, and puts ours back with one press. The first
 * reminder's words are not touched by any of it.
 */
test("the second reminder's words are written, refused when they break the rules, and put back", async ({ owner }) => {
  const policy = await owner.request.put("/api/v1/reviews/policy", { data: { timeZone: "America/Chicago" } });
  expect(policy.ok(), await policy.text()).toBe(true);
  const clean = { afterDays: null, secondAfterDays: null, followUpAfterDays: null, wording: null, secondWording: null };
  expect((await owner.request.put("/api/v1/reviews/reminders", { data: clean })).ok()).toBe(true);

  await owner.goto("/settings/reviews");
  const reminder = owner.getByRole("region", { name: "The reminder" });
  const save = reminder.getByRole("button", { name: "Save the reminder" });
  await expect(reminder).toContainText("These are the words we wrote, which say it is the last one.");

  await reminder.getByLabel(/Remind after this many days/).fill("5");
  await reminder.getByLabel(/A second reminder this many days after the first/).fill("7");
  await reminder.getByLabel("Second reminder, text message").fill("Hi {{ customer.name }}, a coupon for your review: {{ review.url }}");
  await save.click();
  await expect(reminder.getByRole("alert").filter({ hasText: "The second reminder: The text offers something for a review" })).toBeVisible();

  await reminder.getByLabel("Second reminder, text message").fill("Hi {{ customer.name }}, one more try from {{ organization.name }}: {{ review.url }}");
  await reminder.getByLabel("Second reminder, email subject").fill("One more try, {{ customer.name }}");
  await reminder.getByLabel("Second reminder, email body").fill("Hi {{ customer.name }},\n\nOne more try from {{ organization.name }}.\n\n{{ review.url }}\n\nThank you.");
  await save.click();
  await expect(reminder.getByRole("status").filter({ hasText: "Saved. A reminder after 5 days" })).toBeVisible();

  await owner.reload();
  await expect(reminder).toContainText("These are your own words.");
  await expect(reminder.getByLabel("Second reminder, email subject")).toHaveValue("One more try, {{ customer.name }}");
  const read = (await (await owner.request.get("/api/v1/reviews/reminders")).json()) as {
    wording: { custom: boolean }; secondWording: { custom: boolean; emailSubject: string };
  };
  expect(read.secondWording).toMatchObject({ custom: true, emailSubject: "One more try, {{ customer.name }}" });
  expect(read.wording.custom).toBe(false);

  await reminder.getByRole("button", { name: "Put back the words we wrote for the second reminder" }).click();
  await expect(reminder).toContainText("These are the words we wrote, which say it is the last one.");
  const back = (await (await owner.request.get("/api/v1/reviews/reminders")).json()) as { secondWording: { custom: boolean } };
  expect(back.secondWording.custom).toBe(false);

  expect((await owner.request.put("/api/v1/reviews/reminders", { data: clean })).ok()).toBe(true);
});
