import { test, expect } from "./fixtures";

/**
 * WHAT A TECHNICIAN MUST FILL IN ON A REPORT
 *
 * Pest control's application record completeness counts the regulated fields
 * the operator required, and what was required was a template setting only the
 * API could change. Settings, Service reports lists each template's fields,
 * says which a regulator asks for, and ticks the ones the company requires; a
 * save bumps the template's version, and each report keeps the list it was
 * held to when it was written.
 */
test("the company says which report fields are required, and the template moves to a new version", async ({ owner }) => {
  await owner.goto("/settings/service-reports");
  await expect(owner.getByRole("heading", { level: 1, name: "Service reports" })).toBeVisible();
  const template = owner.getByRole("region").filter({ has: owner.getByRole("button", { name: "Save what is required" }) }).first();
  await expect(template).toBeVisible();
  const version = Number((await template.getByText(/version \d+/).textContent())!.match(/version (\d+)/)![1]);

  const box = template.getByRole("checkbox").first();
  const was = await box.isChecked();
  await box.setChecked(!was);
  await template.getByRole("button", { name: "Save what is required" }).click();
  await expect(template.getByRole("status").filter({ hasText: "Saved. Reports written from now on are held to it." })).toBeVisible();

  await owner.reload();
  const again = owner.getByRole("region").filter({ has: owner.getByRole("button", { name: "Save what is required" }) }).first();
  await expect(again.getByText(`version ${version + 1}`, { exact: false })).toBeVisible();
  expect(await again.getByRole("checkbox").first().isChecked()).toBe(!was);

  /** Put it back, so the seeded company's reports ask what they asked before. */
  await again.getByRole("checkbox").first().setChecked(was);
  await again.getByRole("button", { name: "Save what is required" }).click();
  await expect(again.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
});
