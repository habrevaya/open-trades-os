import { test, expect, run } from "./fixtures";

/**
 * AN ITEM'S PICTURE AND COMMISSION RATE, FROM ITS OWN SCREEN
 *
 * Saved as a new version like a price change: the page says "Saved as a new
 * version", the API reads the same, a later price change keeps both, an address
 * that is not https is refused in words, and clearing the boxes takes both off.
 * The commission is typed as a percent and kept as a share.
 */
test("an item's picture and commission rate are changed through a revision", async ({ owner }) => {
  const code = `PIC-${run}`.toUpperCase();
  const created = await owner.request.post("/api/v1/pricebook/items", {
    data: { kind: "material", code, name: `Capacitor ${run}`, price: "40.00" },
  });
  expect(created.ok()).toBe(true);
  const id = ((await created.json()) as { id: string }).id;
  const item = async () => (await (await owner.request.get(`/api/v1/pricebook/items/${id}`)).json()) as {
    version: number; price: string; imageUrl: string | null; commissionRate: string | null;
  };
  const form = () => owner.getByRole("region", { name: "Change the price or wording" });

  await owner.goto(`/pricebook/items/${id}`);
  await form().getByLabel("Picture (a web address starting with https://)").fill("https://images.example.com/capacitor.jpg");
  await form().getByLabel("Commission on this item, percent").fill("8.5");
  await form().getByRole("button", { name: "Save as a new version" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved as a new version" })).toBeVisible();
  expect(await item()).toMatchObject({ version: 2, imageUrl: "https://images.example.com/capacitor.jpg", commissionRate: "0.085000" });

  // The page shows what is on file, as a percent.
  await owner.goto(`/pricebook/items/${id}`);
  await expect(form().getByLabel("Commission on this item, percent")).toHaveValue("8.5");

  // A price change that touches neither keeps both.
  await form().getByLabel("Price", { exact: true }).fill("45.00");
  await form().getByRole("button", { name: "Save as a new version" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved as a new version" })).toBeVisible();
  expect(await item()).toMatchObject({ version: 3, price: "45.0000", imageUrl: "https://images.example.com/capacitor.jpg", commissionRate: "0.085000" });

  // Said in words when it is wrong, and nothing is saved.
  await owner.goto(`/pricebook/items/${id}`);
  await form().getByLabel("Picture (a web address starting with https://)").fill("http://images.example.com/plain.jpg");
  await form().getByRole("button", { name: "Save as a new version" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "starts with https://" })).toBeVisible();
  await form().getByLabel("Picture (a web address starting with https://)").fill("https://images.example.com/capacitor.jpg");
  await form().getByLabel("Commission on this item, percent").fill("150");
  await form().getByRole("button", { name: "Save as a new version" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "more than 100 percent" })).toBeVisible();
  expect((await item()).version).toBe(3);

  // Empty boxes take both off.
  await form().getByLabel("Picture (a web address starting with https://)").fill("");
  await form().getByLabel("Commission on this item, percent").fill("");
  await form().getByRole("button", { name: "Save as a new version" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved as a new version" })).toBeVisible();
  expect(await item()).toMatchObject({ version: 4, imageUrl: null, commissionRate: null });
});
