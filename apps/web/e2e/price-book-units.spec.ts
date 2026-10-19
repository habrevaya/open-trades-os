import { test, expect, run } from "./fixtures";

/**
 * AN ITEM BOUGHT BY THE GALLON AND USED BY THE OUNCE
 *
 * Added on the price book's own form with the cost on the supplier's bill,
 * 40.00 a gallon, and 128 ounces to the gallon. The item's page says what an
 * ounce costs, and a price change carries the units forward.
 */
test("a price book item bought in one unit and used in another is costed per use unit", async ({ owner }) => {
  const code = `CONC${run.slice(-6).toUpperCase()}`;
  await owner.goto("/pricebook/items/new");
  await owner.getByLabel("Kind").selectOption("material");
  await owner.getByLabel("Code").fill(code);
  await owner.getByLabel("Name").fill(`Concentrate ${run}`);
  await owner.getByLabel("Price").fill("1.50");
  await owner.getByLabel("Cost to us").fill("40.00");
  await owner.getByLabel("Bought by the, like gal").fill("gal");
  await owner.getByLabel("Used by the, like oz").fill("oz");
  /** Two of three is refused in words before anything is saved. */
  await owner.getByRole("button", { name: "Add to the price book" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "Say all three" })).toBeVisible();
  await owner.getByLabel("How many in one, like 128").fill("128");
  await owner.getByRole("button", { name: "Add to the price book" }).click();
  await expect(owner).toHaveURL(/\/pricebook\/items\/[0-9a-f-]{36}$/);

  const said = owner.getByText(/costs \$40\.00 per gal/);
  await expect(said).toContainText("$0.31 per oz, 128 to the gal");
  await expect(owner.getByText(/\$1\.50\s*per oz/)).toBeVisible();

  const change = owner.getByRole("region", { name: "Change the price or wording" });
  await expect(change.getByLabel("How many in one, like 128")).toHaveValue("128");
  await change.getByLabel("Price").fill("1.75");
  await change.getByRole("button", { name: "Save as a new version" }).click();
  await expect(change.getByRole("status")).toContainText("Saved as a new version");
  await owner.reload();
  await expect(owner.getByText(/\$1\.75\s*per oz/)).toBeVisible();
  await expect(owner.getByText(/costs \$40\.00 per gal/)).toBeVisible();
});
