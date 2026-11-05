import { test, expect, run } from "./fixtures";

/**
 * A MARKUP FOR ONE MATERIAL
 *
 * The owner gives a material only this run uses a markup of its own on
 * Containers, reads it back in the list, is refused in words for a markup
 * that is not a per cent, and takes it off again, so no other spec's hire is
 * charged by it.
 */
test("Containers: a material can have a disposal markup of its own, and have it taken off", async ({ owner }) => {
  const material = `Tile ${run}`;
  await owner.goto("/fleet/containers");
  const passing = owner.locator("section").filter({ has: owner.getByRole("heading", { name: "Disposal fees passed on" }) });
  const form = passing.locator("form").filter({ has: owner.getByRole("button", { name: "Save this markup" }) });

  await form.getByLabel("Or this material").fill(material);
  await form.getByLabel("Its markup, per cent").fill("ten");
  await form.getByRole("button", { name: "Save this markup" }).click();
  await expect(form.getByRole("alert")).toContainText("Write the markup as a per cent");

  await form.getByLabel("Its markup, per cent").fill("10");
  await form.getByRole("button", { name: "Save this markup" }).click();
  await expect(form.getByRole("status")).toContainText("Saved. Invoices raised from now on use it.");
  const list = passing.getByRole("list", { name: "Markups of their own" });
  await expect(list.getByRole("listitem").filter({ hasText: material })).toContainText(`${material}: 10%`);

  await list.getByRole("button", { name: `Take off the markup for ${material}` }).click();
  await expect(passing.getByRole("listitem").filter({ hasText: material })).toHaveCount(0);
});
