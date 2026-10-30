import { test, expect } from "./fixtures";

/**
 * NOTICE SETUP: THE COMPANY'S DEFAULTS FOR EVERYBODY, AND A PERSON'S OWN HOUR
 *
 * The owner takes the toolbox talk off the phone app in the defaults, is
 * told how many people already here would change and that their own choices
 * are kept, says yes and applies it, then puts the default back and applies
 * that too, so nobody is left changed. On their own page they choose the
 * hour of their daily email and go back to the company's morning.
 */
test("the owner gives the company's notice defaults to everybody, asking first, and puts them back", async ({ owner }) => {
  await owner.goto("/settings");
  const region = owner.getByRole("region", { name: "What new people are told" });
  const phone = region.getByLabel("A toolbox talk to sign: on the phone app");
  await phone.uncheck();
  await region.getByRole("button", { name: "Save" }).first().click();
  await expect(region.getByText(/^Saved\. People you add from now on start with these\./)).toBeVisible();

  await owner.reload();
  const people = owner.getByRole("group", { name: "People already here" });
  await expect(people.getByText(/would change\. A choice a person made on their own page is kept/)).toBeVisible();
  /** Not without saying yes. */
  await people.getByRole("button", { name: "Apply to everybody" }).click();
  await expect(people.getByText(/have the company's defaults now/)).toHaveCount(0);
  await people.getByLabel("Yes, give everybody these, except where they chose their own.").check();
  await people.getByRole("button", { name: "Apply to everybody" }).click();
  await expect(people.getByText(/^Done\. \d+ (person has|people have) the company's defaults now\./)).toBeVisible();

  // Back to where every company starts, for everybody.
  await owner.reload();
  const again = owner.getByRole("region", { name: "What new people are told" });
  await again.getByLabel("A toolbox talk to sign: on the phone app").check();
  await again.getByRole("button", { name: "Save" }).first().click();
  await expect(again.getByText(/^Saved\. People you add from now on start with these\./)).toBeVisible();
  await owner.reload();
  const back = owner.getByRole("group", { name: "People already here" });
  await back.getByLabel("Yes, give everybody these, except where they chose their own.").check();
  await back.getByRole("button", { name: "Apply to everybody" }).click();
  await expect(back.getByText(/^Done\./)).toBeVisible();
});

test("a person chooses the hour of their daily email and goes back to the company's morning", async ({ owner }) => {
  await owner.goto("/me");
  const told = owner.locator("#notices");
  await told.getByLabel("When it comes").selectOption({ label: "2 in the afternoon" });
  await told.getByRole("button", { name: "Save the hour" }).click();
  await expect(told.getByText("Saved. It comes at the hour you chose.")).toBeVisible();
  await owner.reload();
  await expect(told.getByText(/each day at 2 in the afternoon/)).toBeVisible();
  await expect(told.getByLabel("When it comes")).toHaveValue("14");

  await told.getByLabel("When it comes").selectOption({ label: "The company's morning (8 in the morning)" });
  await told.getByRole("button", { name: "Save the hour" }).click();
  await expect(told.getByText("Saved. It comes at the company's morning hour.")).toBeVisible();
  await owner.reload();
  await expect(told.getByText(/each morning at 8 in the morning/)).toBeVisible();
});
