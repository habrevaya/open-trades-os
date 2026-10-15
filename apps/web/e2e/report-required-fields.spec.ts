import type { Page } from "@playwright/test";
import { test, expect, run } from "./fixtures";

async function api<T>(page: Page, method: "post", path: string, data: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

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
  /** A template of this run's own, with no kind of job, so no other spec's reports read it. */
  const name = `Application record ${run}`;
  await api(owner, "post", "/v1/service-report-templates", {
    name,
    fields: [
      { key: "product_applied", label: "Product applied", kind: "chemical", regulated: true },
      { key: "stations_serviced", label: "Stations serviced", kind: "numeric" },
    ],
  });

  await owner.goto("/settings/service-reports");
  await expect(owner.getByRole("heading", { level: 1, name: "Service reports" })).toBeVisible();
  const template = owner.getByRole("region", { name });
  await expect(template).toContainText("version 1");
  await expect(template.getByRole("listitem").filter({ hasText: "Product applied" })).toContainText("Regulator asks for it");
  await expect(template.getByRole("listitem").filter({ hasText: "Stations serviced" })).not.toContainText("Regulator asks for it");

  await template.getByRole("checkbox", { name: "Product applied" }).check();
  await template.getByRole("button", { name: "Save what is required" }).click();
  await expect(template.getByRole("status").filter({ hasText: "Saved. Reports written from now on are held to it." })).toBeVisible();

  await owner.reload();
  await expect(template).toContainText("version 2");
  await expect(template.getByRole("checkbox", { name: "Product applied" })).toBeChecked();
  await expect(template.getByRole("checkbox", { name: "Stations serviced" })).not.toBeChecked();
  /** Which fields a regulator asks for survives the save. */
  await expect(template.getByRole("listitem").filter({ hasText: "Product applied" })).toContainText("Regulator asks for it");
});
