import { test, expect, companyToday } from "./fixtures";

/**
 * ON CALL FOR THE OFFICE
 *
 * The owner sends failed automatic payments to whoever is on call, puts
 * themselves on call today, sees their name as on call and the line on their
 * own page, then takes the turn off and puts the notice back to everybody, so
 * no other test finds a rota it did not make.
 */
test("the owner puts themselves on call for the office, sees it, and puts it back", async ({ owner }) => {
  const today = companyToday();
  await owner.goto("/settings/office-on-call");
  await expect(owner.getByText("Nobody is on call today, so everybody who can deal with these notices is told.")).toBeVisible();

  const kinds = owner.getByRole("region", { name: "Notices that go to whoever is on call" });
  await kinds.getByLabel(/An automatic payment that failed/).check();
  await kinds.getByRole("button", { name: "Save" }).click();
  await expect(kinds.getByText("Saved. The ticked notices go to whoever is on call, or to everybody when nobody is.")).toBeVisible();

  const add = owner.getByRole("region", { name: "Put somebody on call" });
  await add.getByLabel("Person").selectOption({ label: "Hollis Grant" });
  await add.getByLabel("First day").fill(today);
  await add.getByLabel("Last day").fill(today);
  await add.getByLabel("Note").fill("Covering the phones");
  await add.getByRole("button", { name: "Put on call" }).click();
  await expect(add.getByText(`Hollis Grant is on call from ${today} to ${today}.`)).toBeVisible();

  await owner.reload();
  await expect(owner.getByRole("region", { name: "Who is on call today" }).getByText("On call: Hollis Grant.")).toBeVisible();
  const rota = owner.getByRole("region", { name: "The rota" });
  await expect(rota.getByText("Covering the phones")).toBeVisible();
  await expect(owner.getByRole("region", { name: "Notices that go to whoever is on call" })
    .getByLabel(/An automatic payment that failed/)).toBeChecked();

  await owner.goto("/me");
  await expect(owner.locator("#notices").getByText(`You are on call for the office today (${today}).`)).toBeVisible();

  // Back to where every company starts.
  await owner.goto("/settings/office-on-call");
  const row = owner.getByRole("region", { name: "The rota" }).getByRole("row").filter({ hasText: "Covering the phones" });
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(owner.getByRole("region", { name: "The rota" }).getByText("Nobody is on the rota")).toBeVisible();
  const again = owner.getByRole("region", { name: "Notices that go to whoever is on call" });
  await again.getByLabel(/An automatic payment that failed/).uncheck();
  await again.getByRole("button", { name: "Save" }).click();
  await expect(again.getByText("Saved. Every one of these notices goes to everybody who handles it.")).toBeVisible();
});
