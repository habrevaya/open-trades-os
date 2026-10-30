import { test, expect } from "./fixtures";

/**
 * A TIP RULE FOR ONE PERSON
 *
 * The owner gives one of the seeded technicians a rule of their own on Pay
 * rules, by the hours on the visit, reads it back in the table with the
 * reason, and takes it off again, so the seeded company goes back to the
 * company's rule for everybody and a rerun starts from the same place.
 */
test("a person can be given a tip rule of their own, and have it taken off", async ({ owner }) => {
  await owner.goto("/payroll/pay-rules");
  const section = owner.getByRole("region", { name: "Tips on one job, or for one person" });
  const person = section.getByLabel("For this person");
  const options = await person.locator("option").allTextContents();
  const name = options.find((o) => o !== "Nobody, a job instead")!;
  await person.selectOption({ label: name });
  await section.getByLabel("Share their tips").selectOption({ label: "By the hours each person worked on the visit the tip was for" });
  await section.getByLabel("Why (optional)").fill("Apprentice, shares by the visit");
  await section.getByRole("button", { name: "Set the rule" }).click();
  await expect(section.getByRole("status")).toContainText(`Tips for ${name} are shared this way from the next one.`);

  const row = section.getByRole("table", { name: "Tip rules of their own" }).getByRole("row").filter({ hasText: name });
  await expect(row).toContainText("By the hours each person worked on the visit the tip was for");
  await expect(row).toContainText("Apprentice, shares by the visit");

  await row.getByRole("button", { name: "Take off" }).click();
  await expect(section.getByRole("table", { name: "Tip rules of their own" }).getByRole("row").filter({ hasText: name })).toHaveCount(0);
});

test("a job number that is not one is refused in words", async ({ owner }) => {
  await owner.goto("/payroll/pay-rules");
  const section = owner.getByRole("region", { name: "Tips on one job, or for one person" });
  await section.getByLabel("Or this job number").fill("twelve");
  await section.getByRole("button", { name: "Set the rule" }).click();
  await expect(section.getByText("A job number is the digits it is printed with, like 1042.")).toBeVisible();
});
