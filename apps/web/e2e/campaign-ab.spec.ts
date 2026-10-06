import { test, expect, run } from "./fixtures";

/**
 * A CAMPAIGN WITH TWO VERSIONS, THROUGH THE SCREENS
 *
 * The office writes a second way of saying it, reads both versions as the first
 * person on the list would, sends, and compares. The seeded company has no
 * texting consent on its customers, so nobody is actually sent either version;
 * what this checks is the part a person sees: that version B is saved and
 * checked against version A, that both read back before sending, that every
 * recipient row says which version it was, and that the comparison says
 * plainly that there is nothing to compare yet instead of naming a leader. The
 * counts, the split and the test itself are in
 * packages/api/test/campaign-ab.integration.test.ts.
 */
test("Campaigns: a second version is checked, read back beside the first, and compared without naming a winner nobody has earned", async ({ owner }) => {
  await owner.goto("/marketing/campaigns");
  const form = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Save as a draft" }) });
  const body = "Comfort Co here: $89 tune ups this month. Reply STOP to opt out.";

  // Version B that says what version A says is refused: there is nothing to test.
  await form.getByLabel("Name").fill(`Same words ${run}`);
  await form.getByRole("checkbox").and(form.locator('[value="served_at_least_once"]')).check();
  await form.getByRole("textbox", { name: "Message" }).fill(body);
  await form.getByRole("textbox", { name: "Version B message" }).fill(body);
  await form.getByRole("button", { name: "Save as a draft" }).click();
  await expect(form.getByRole("alert").filter({ hasText: "nothing to test" })).toBeVisible();

  // With different words it saves, and the list says it is a test.
  const name = `Tune up test ${run}`;
  await form.getByLabel("Name").fill(name);
  await form.getByRole("checkbox").and(form.locator('[value="served_at_least_once"]')).check();
  await form.getByRole("textbox", { name: "Message" }).fill(body);
  await form.getByRole("textbox", { name: "Version B message" })
    .fill("Comfort Co here: tune up special, $79 until Friday. Reply STOP to opt out.");
  await form.getByRole("button", { name: "Save as a draft" }).click();
  const row = owner.getByRole("table", { name: "Campaigns" }).getByRole("row").filter({ hasText: name });
  await expect(row).toContainText("two versions");

  // Both versions read back before anybody is sent either.
  await row.getByRole("link", { name: "Who it reaches" }).click();
  const audience = owner.locator("section").filter({ hasText: "Who it reaches" });
  await expect(audience).toContainText("Version A.");
  await expect(audience).toContainText("Version B.");
  await expect(audience).toContainText("$79 until Friday");

  // Sent, then compared. Nobody could be texted, so there are no counts to read and no winner is named.
  await owner.getByRole("table", { name: "Campaigns" }).getByRole("row").filter({ hasText: name })
    .getByRole("button", { name: "Send a batch" }).click();
  const sent = owner.getByRole("table", { name: "Campaigns" }).getByRole("row").filter({ hasText: name });
  await expect(sent).toContainText("sent");
  await sent.getByRole("link", { name: "Compare the versions" }).click();
  const compare = owner.locator("section").filter({ hasText: `The two versions: ${name}` });
  await expect(compare.getByRole("table", { name: "The two versions" })).toContainText("Clicked the link");
  await expect(compare).toContainText("Nobody has been sent a version yet.");
  await expect(compare).not.toContainText("did better");

  // Every recipient row says which version it was.
  await owner.goto("/marketing/campaigns");
  await owner.getByRole("table", { name: "Campaigns" }).getByRole("row").filter({ hasText: name })
    .getByRole("link", { name: "Who it went to" }).click();
  await expect(owner.getByRole("table", { name: "Recipients" }).getByRole("columnheader", { name: "Version" })).toBeVisible();
});
