import type { Page } from "@playwright/test";
import { createClient } from "@opentradesos/db";
import { sql } from "drizzle-orm";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * SERVICE REPORTS IN THE OFFICE
 *
 * A report as the technician's phone leaves it (submitted, one reading out of
 * range, one private note) is written straight into the tables, because the
 * phone's sync is not what is being tested. The office finds it under "Out of
 * range only", reads the answers, writes its note, publishes it to the
 * customer, takes it back with a reason, and keeps it from the retention purge.
 */
async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function capturedReport(owner: Page): Promise<{ id: string; customer: string }> {
  const customer = `Rhea Readings ${run}`;
  const customerId = await newCustomer(owner, {
    name: customer, address: { street: `${run.slice(-4)} Gauge Lane`, city: "Austin", state: "TX", zip: "78704" },
  });
  const propertyId = (await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`)).data[0]!.id;
  const job = await api<{ id: string }>(owner, "post", "/v1/jobs", {
    customerId, propertyId, summary: `Tune up ${run}`,
    visit: {
      windowStart: new Date(Date.now() - 3 * 3_600_000).toISOString(), windowEnd: new Date(Date.now() - 3_600_000).toISOString(),
      estimatedDurationMinutes: 120, technicianIds: [],
    },
  });
  const db = createClient();
  try {
    const [row] = await db.execute<{ id: string; organization_id: string }>(sql`
      insert into public.service_report
        (organization_id, visit_id, job_id, customer_id, property_id, summary, technician_notes, submitted_at)
      select v.organization_id, v.id, v.job_id, ${customerId}::uuid, ${propertyId}::uuid,
             'Cleaned the coil and checked the charge', 'Unit is tired, they did not want to hear it', now()
      from public.visit v where v.job_id = ${job.id}::uuid
      order by v.sequence limit 1
      returning id, organization_id`);
    if (!row) throw new Error("The job has no visit to report on");
    await db.execute(sql`
      insert into public.service_report_field
        (organization_id, report_id, property_id, key, label, kind, value_numeric, unit, customer_visible, out_of_range)
      values
        (${row.organization_id}::uuid, ${row.id}::uuid, ${propertyId}::uuid, 'superheat', 'Superheat', 'numeric', 42, 'F', true, true),
        (${row.organization_id}::uuid, ${row.id}::uuid, ${propertyId}::uuid, 'note', 'Filter size', 'numeric', 20, 'in', false, false)`);
    return { id: row.id, customer };
  } finally {
    await db.$close();
  }
}

test("the office finds a report with a reading out of range, writes on it, publishes it, takes it back and keeps it", async ({ owner }) => {
  const report = await capturedReport(owner);

  await owner.goto("/service-reports");
  await owner.getByLabel("Out of range only").check();
  await owner.getByRole("button", { name: "Show" }).click();
  await expect(owner).toHaveURL(/out=1/);
  const row = owner.getByRole("row").filter({ hasText: report.customer });
  await expect(row).toContainText("1 out of range");
  await expect(row).toContainText("Not shown to the customer");
  await row.getByRole("link").first().click();

  await expect(owner.getByRole("heading", { level: 1, name: "Service report" })).toBeVisible();
  const answers = owner.getByRole("table", { name: "Answers" });
  await expect(answers.getByRole("row").filter({ hasText: "Superheat" })).toContainText("42 F");
  await expect(answers.getByRole("row").filter({ hasText: "Superheat" })).toContainText("Out of range");
  await expect(answers.getByRole("row").filter({ hasText: "Filter size" })).toContainText("No");
  await expect(owner.getByRole("region", { name: "Technician's notes" })).toContainText("Unit is tired");

  const note = owner.getByRole("region", { name: "Office note" });
  await note.getByLabel("Office note").fill("Superheat high. Booked a refrigerant check for next visit.");
  await note.getByRole("button", { name: "Save", exact: true }).click();
  await expect(note.getByRole("status")).toHaveText("Saved.");

  const publish = owner.getByRole("region", { name: "Publish" });
  await expect(publish).toContainText("Not the technician's notes");
  await publish.getByRole("button", { name: "Publish to the customer" }).click();
  await expect(owner.getByText("Shown to the customer", { exact: true })).toBeVisible();
  await expect(note).toContainText("Take it back first to change it.");

  await owner.getByText("Take it back from the customer").click();
  await owner.getByLabel("Why it is taken back").fill("The superheat was typed wrong.");
  await owner.getByRole("button", { name: "Take it back", exact: true }).click();
  await expect(owner.getByText("Not shown to the customer", { exact: true })).toBeVisible();
  await expect(note.getByLabel("Office note")).toHaveValue(/Withdrawn: The superheat was typed wrong\./);

  const keep = owner.getByRole("region", { name: "Keep this report" });
  await keep.getByLabel("Why this report is kept").fill("The customer disputes the charge.");
  await keep.getByRole("button", { name: "Keep it" }).click();
  await expect(keep).toContainText("On hold: The customer disputes the charge.");

  const published = await api<{ status: string; observations: string }>(owner, "get", `/v1/service-reports/${report.id}`);
  expect(published.status).toBe("submitted");
});
