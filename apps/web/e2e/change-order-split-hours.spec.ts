import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A CHANGE ORDER'S CREW HOURS SPLIT ACROSS JOBS, AND THE PAGE THE CUSTOMER SIGNS
 *
 * Work spread over two of a project's jobs is one change order with hours on
 * each. The office puts the hours on both jobs on the change order's page, the
 * change order is priced and sent, and the customer's page lists the hours job
 * by job above the total. The office's page lists them too.
 */
async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("hours on two jobs of a project are listed on the change order and on the page the customer signs", async ({ owner, browser }) => {
  test.setTimeout(120_000);
  const customerId = await newCustomer(owner, {
    name: `Split Hours ${run}`, email: `split+${run}@example.test`,
    address: { street: `${run.slice(-4)} Alder St`, city: "Austin", state: "TX", zip: "78704" },
  });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const propertyId = data[0]!.id;
  const kitchen = await api<{ id: string; number: number }>(owner, "post", "/v1/jobs", { customerId, propertyId, summary: `Kitchen ${run}` });
  const bath = await api<{ id: string; number: number }>(owner, "post", "/v1/jobs", { customerId, propertyId, summary: `Bath ${run}` });
  const project = await api<{ id: string }>(owner, "post", "/v1/projects", { customerId, propertyId, name: `Remodel ${run}`, contractValue: "20000" });
  await api(owner, "post", `/v1/projects/${project.id}/jobs`, { jobId: kitchen.id });
  await api(owner, "post", `/v1/projects/${project.id}/jobs`, { jobId: bath.id });

  await owner.goto(`/projects/${project.id}/change-orders`);
  await owner.getByLabel("What is the change").fill("Two more circuits");
  await owner.getByRole("button", { name: "Log change" }).click();
  await expect(owner).toHaveURL(/\/change-orders\/[0-9a-f-]{36}$/);

  // Hours on the first job, and on another.
  const hours = owner.getByRole("region", { name: "Crew hours it adds" });
  await hours.getByLabel("Crew hours", { exact: true }).fill("6");
  await hours.getByLabel("On which job").selectOption({ label: `Job ${kitchen.number}, Kitchen ${run}` });
  await hours.getByRole("button", { name: "Save crew hours" }).click();
  await expect(owner.getByText("Adds 6 on")).toBeVisible();

  await hours.getByLabel("Hours on another job").fill("2.5");
  await hours.getByLabel("Another job").selectOption({ label: `Job ${bath.number}, Bath ${run}` });
  await hours.getByRole("button", { name: "Save crew hours" }).click();
  await expect(owner.getByText("Adds 8.5 in all:")).toBeVisible();
  const byJob = owner.getByRole("list", { name: "Crew hours by job" });
  await expect(byJob).toContainText(`6 on job ${kitchen.number}`);
  await expect(byJob).toContainText(`2.5 on job ${bath.number}`);

  // A row with hours and no job is refused in words.
  await hours.getByLabel("Crew hours", { exact: true }).fill("7");
  await hours.getByLabel("On which job").selectOption({ label: "No job" });
  await hours.getByRole("button", { name: "Save crew hours" }).click();
  await expect(owner.getByRole("alert")).toContainText("needs the hours and the job");
  await owner.reload();
  await expect(owner.getByText("Adds 8.5 in all:")).toBeVisible();

  // Priced and sent, the customer's page lists the hours by job.
  const orderId = owner.url().split("/").pop()!;
  await api(owner, "post", `/v1/project-change-orders/${orderId}/lines`, { name: "Circuits", quantity: "2", unitPrice: "450.00" });
  const sent = await api<{ url: string }>(owner, "post", `/v1/project-change-orders/${orderId}/send`, { channel: "link" });
  const customer = await (await browser.newContext()).newPage();
  await customer.goto(new URL(sent.url).pathname);
  const listed = customer.getByLabel("Crew hours");
  await expect(listed).toContainText("Crew hours this change adds");
  await expect(listed).toContainText(`Job ${kitchen.number}`);
  await expect(listed).toContainText("6 hours");
  await expect(listed).toContainText(`Job ${bath.number}`);
  await expect(listed).toContainText("2.5 hours");
  await customer.close();
});
