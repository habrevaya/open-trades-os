import { test, expect, run } from "./fixtures";

/**
 * A CAMPAIGN WITH THREE VERSIONS IN CHOSEN SHARES, THROUGH THE SCREENS
 *
 * The office writes three ways of saying it and gives the old words most of
 * the list. Shares that do not fit the versions are refused in words; once they
 * fit, the list says it is a three way test, every version reads back as the
 * first person would read it with the split said plainly, and after sending the
 * comparison has a column per version with its share. The seeded company has
 * no texting consent, so nobody is actually sent anything: the split itself
 * and the test are in packages/api/test/campaign-versions.integration.test.ts.
 */
test("Campaigns: three versions in shares of 80, 10 and 10 are checked, read back and compared column by column", async ({ owner }) => {
  await owner.goto("/marketing/campaigns");
  const form = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Save as a draft" }) });
  const name = `Three ways ${run}`;
  const fill = async (shares: string) => {
    await form.getByLabel("Name").fill(name);
    await form.getByRole("checkbox").and(form.locator('[value="served_at_least_once"]')).check();
    await form.getByRole("textbox", { name: "Message" }).fill("Comfort Co: $89 tune ups this month. Reply STOP to opt out.");
    await form.getByRole("textbox", { name: "Version B words" }).fill("Comfort Co: tune ups, $79 until Friday. Reply STOP to opt out.");
    await form.getByRole("textbox", { name: "Version C words (optional)" }).fill("Comfort Co: beat the summer rush, book a tune up. Reply STOP to opt out.");
    await form.getByLabel("How to split the list, in percent, version A first (blank splits it evenly)").fill(shares);
  };

  await fill("80, 20");
  await form.getByRole("button", { name: "Save as a draft" }).click();
  await expect(form.getByRole("alert").filter({ hasText: "There are 3 versions, so give 3 shares, one for each." })).toBeVisible();

  await fill("80, 10, 10");
  await form.getByRole("button", { name: "Save as a draft" }).click();
  const row = owner.getByRole("table", { name: "Campaigns" }).getByRole("row").filter({ hasText: name });
  await expect(row).toContainText("three versions");

  await row.getByRole("link", { name: "Who it reaches" }).click();
  const audience = owner.locator("section").filter({ hasText: "Who it reaches" });
  await expect(audience).toContainText("Version C.");
  await expect(audience).toContainText("beat the summer rush");
  await expect(audience).toContainText("80% get version A, 10% get version B and 10% get version C.");

  await owner.getByRole("table", { name: "Campaigns" }).getByRole("row").filter({ hasText: name })
    .getByRole("button", { name: "Send a batch" }).click();
  const sent = owner.getByRole("table", { name: "Campaigns" }).getByRole("row").filter({ hasText: name });
  await expect(sent).toContainText("sent");
  await sent.getByRole("link", { name: "Compare the versions" }).click();
  const compare = owner.locator("section").filter({ hasText: `The three versions: ${name}` });
  const table = compare.getByRole("table", { name: "The three versions" });
  await expect(table.getByRole("columnheader", { name: "Version A (80%)" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Version C (10%)" })).toBeVisible();
  await expect(compare).toContainText("Each version is compared with version A");
  await expect(compare).toContainText("Nobody has been sent a version yet.");
  await expect(compare).not.toContainText("did better");
});
