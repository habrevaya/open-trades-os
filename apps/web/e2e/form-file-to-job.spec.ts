import type { Page } from "@playwright/test";
import { createClient } from "@opentradesos/db";
import { sql } from "drizzle-orm";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A FILE A LEAD SENT, PUT ON THE CUSTOMER'S JOB
 *
 * The photograph is written as a hosted form leaves it (on the customer the
 * form matched, under the form's own kind), because the form is not what is
 * tested. The office puts it on the customer's job from the customer's page;
 * it leaves the customer, shows on the job under the same heading, and is
 * still not offered to the customer.
 */
async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("the office puts a photo a lead sent onto the customer's job, and it stays private", async ({ owner }) => {
  const customerId = await newCustomer(owner, {
    name: `Lena Leak ${run}`, address: { street: `${run.slice(-4)} Drip Way`, city: "Austin", state: "TX", zip: "78704" },
  });
  const propertyId = (await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`)).data[0]!.id;
  const job = await api<{ id: string }>(owner, "post", "/v1/jobs", { customerId, propertyId, summary: `Leak under sink ${run}` });

  const fileName = `leak-${run}.png`;
  const db = createClient();
  try {
    const key = `form-${run}-${crypto.randomUUID()}.png`;
    await db.execute(sql`
      insert into public.stored_file (organization_id, storage_key, content_type, sha256, size_bytes, bytes, "references")
      select organization_id, ${key}, 'image/png', ${crypto.randomUUID()}, 4, ${Buffer.from("\x89PNG")}, 1
      from public.customer where id = ${customerId}::uuid`);
    await db.execute(sql`
      insert into public.attachment (organization_id, entity_type, entity_id, kind, storage_key, file_name, content_type, size_bytes)
      select organization_id, 'customer', id, 'form_file', ${key}, ${fileName}, 'image/png', 4
      from public.customer where id = ${customerId}::uuid`);
  } finally {
    await db.$close();
  }

  await owner.goto(`/customers/${customerId}`);
  const sent = owner.getByRole("region", { name: "Sent with a lead form" });
  await expect(sent).toContainText("never shown to the customer or on the technician's phone");
  const row = sent.getByTestId("form-file").filter({ hasText: fileName });
  await row.getByLabel(`Job for ${fileName}`).selectOption(job.id);
  await row.getByRole("button", { name: "Put it on the job" }).click();
  await expect(owner.getByRole("region", { name: "Sent with a lead form" })).toHaveCount(0);

  await owner.goto(`/jobs/${job.id}`);
  const onJob = owner.getByRole("region", { name: "Sent with a lead form" });
  await expect(onJob.getByTestId("form-file").filter({ hasText: fileName })).toBeVisible();
  await expect(onJob.getByRole("button")).toHaveCount(0);

  const attachments = await api<{ attachments: { fileName: string | null; kind: string; sharedWithCustomerAt?: string | null }[] }>(
    owner, "get", `/v1/attachments?entityType=job&entityId=${job.id}`);
  expect(attachments.attachments.find((a) => a.fileName === fileName)).toMatchObject({ kind: "form_file" });
});
