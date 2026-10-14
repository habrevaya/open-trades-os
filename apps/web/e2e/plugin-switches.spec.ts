import { eq } from "drizzle-orm";
import type { APIRequestContext, Page } from "@playwright/test";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * THE OFFICE STOPS ONE THING AN APPLICATION ADDED, NOT THE APPLICATION
 *
 * An application registers a pricing rule and some job stages. On
 * "What apps changed" the owner turns the rule off with a reason: the next
 * invoice is priced without it and the page says who stopped it and why,
 * while the application is still connected. The same for the stages: the job
 * moves on past a gate that was holding it. Turned on again, both are back.
 * Every step is the screen a person uses.
 */

async function api<T>(page: Page, method: "get" | "post" | "patch", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function asApp<T>(request: APIRequestContext, token: string, path: string, data: unknown): Promise<T> {
  const response = await request.post(`/api${path}`, { data, headers: { authorization: `Bearer ${token}` } });
  expect(response.ok(), `POST ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("The owner turns one rule and one set of stages off and back on, and the application stays connected", async ({ owner, stranger }) => {
  test.setTimeout(180_000);

  const db = createClient();
  const [company] = await db.select({ id: schema.organization.id }).from(schema.organization)
    .where(eq(schema.organization.slug, "ridgeline")).limit(1);
  const [type] = await db.insert(schema.jobType).values({
    organizationId: company!.id, name: `Switch install ${run}`,
  }).returning({ id: schema.jobType.id });
  await db.$close();
  const fieldKey = `switch_permit_${run}`;
  const fieldLabel = `Switch permit ${run}`;
  await api(owner, "post", "/v1/custom-fields", { entityType: "job", key: fieldKey, label: fieldLabel, dataType: "text" });

  const appName = `Switch Planner ${run}`;
  const app = await api<{ app: string }>(owner, "post", "/v1/apps", {
    name: appName, publisher: "Planner Ltd",
    permissions: ["settings:write", "job:read", "pricebook:write", "customer:read"],
    scopes: { customer: "all", job: "all" },
  });
  const { token } = await api<{ token: string }>(owner, "post", `/v1/apps/${app.app}/tokens`, { label: "e2e" });
  await asApp(stranger.request, token, "/v1/plugins/job-workflows", {
    key: "switch_stages", name: `Switch stages ${run}`, jobTypeId: type!.id,
    stages: [
      { key: "survey", name: "Survey", statuses: ["lead", "estimating", "scheduled"], gates: [{ kind: "field", key: fieldKey }] },
      { key: "fit", name: "Fit", statuses: ["in_progress", "on_hold"] },
      { key: "closed", name: "Closed", statuses: ["completed", "invoiced", "paid", "cancelled"] },
    ],
  });
  const tag = `switch tag ${run}`;
  await asApp(stranger.request, token, "/v1/plugins/pricing-rules", {
    key: "switch_loyal", name: `Switch loyal ${run}`, rule: { kind: "customer_tag", tag, percent: "-10" },
  });

  const customerId = await newCustomer(owner, {
    name: `Switch Sam ${run}`, address: { street: `${run.slice(-4)} Switch St`, city: "Austin", state: "TX", zip: "78702" },
  });
  await api(owner, "patch", `/v1/customers/${customerId}`, { tags: [tag] });
  const { data: places } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const job = await api<{ id: string }>(owner, "post", "/v1/jobs", {
    customerId, propertyId: places[0]!.id, summary: `Switch job ${run}`, jobTypeId: type!.id,
  });
  await api(owner, "patch", `/v1/jobs/${job.id}`, { status: "scheduled" });
  const { data: items } = await api<{ data: { id: string; name: string; price: string }[] }>(owner, "get", "/v1/pricebook/items?limit=50");
  const item = items.find((i) => Number(i.price) > 0)!;
  const invoiceTotal = async () => {
    const invoice = await api<{ total: string }>(owner, "post", "/v1/invoices", {
      customerId, jobId: job.id, draft: true,
      lines: [{ priceBookItemId: item.id, name: item.name, quantity: "1", unitPrice: item.price, discountAmount: "0", taxable: false }],
    });
    return Number(invoice.total);
  };

  const full = Number(item.price);
  expect(await invoiceTotal()).toBeCloseTo(full * 0.9, 2);

  await owner.goto("/settings/apps/added");
  await expect(owner.getByRole("heading", { level: 1, name: "What applications changed" })).toBeVisible();
  const rules = owner.getByRole("table", { name: "Pricing rules" });
  const stages = owner.getByRole("table", { name: "Job stages" });
  const rule = rules.getByRole("row").filter({ hasText: `Switch loyal ${run}` });
  const flow = stages.getByRole("row").filter({ hasText: `Switch stages ${run}` });
  await expect(rule).toContainText(appName);
  await expect(rule).toContainText("On");
  await expect(flow).toContainText("Version 1");

  /* The rule off, with a reason: the next invoice is full price and the page says who and why. */
  await rule.getByLabel(`Why Switch loyal ${run} is being turned off`).fill("Not for this season");
  await rule.getByRole("button", { name: "Turn off" }).click();
  await expect(rule).toContainText("Turned off");
  await expect(rule).toContainText("Not for this season");
  await expect(rule.getByRole("button", { name: "Turn on" })).toBeVisible();
  expect(await invoiceTotal()).toBeCloseTo(full, 2);
  // The stages carry on, and so does the application.
  await expect(flow).toContainText("On");
  await owner.goto("/settings/apps");
  await expect(owner.getByRole("heading", { level: 3, name: appName })).toContainText("Connected");

  /* The stages off: the job moves on past the gate that was holding it, and its page shows no stages. */
  await owner.goto("/settings/apps/added");
  await owner.getByRole("table", { name: "Job stages" }).getByRole("row").filter({ hasText: `Switch stages ${run}` })
    .getByRole("button", { name: "Turn off" }).click();
  await expect(owner.getByRole("table", { name: "Job stages" }).getByRole("row").filter({ hasText: `Switch stages ${run}` }))
    .toContainText("Turned off");
  await owner.goto(`/jobs/${job.id}`);
  await expect(owner.getByRole("region", { name: "Stages" })).toHaveCount(0);
  await owner.getByRole("button", { name: "Mark job complete" }).click();
  await expect(owner.getByRole("button", { name: "Reopen job" })).toBeVisible();

  /* Both back on: the rule prices again, and the application never noticed. */
  await owner.goto("/settings/apps/added");
  for (const [table, name] of [["Pricing rules", `Switch loyal ${run}`], ["Job stages", `Switch stages ${run}`]] as const) {
    const row = owner.getByRole("table", { name: table }).getByRole("row").filter({ hasText: name });
    await row.getByRole("button", { name: "Turn on" }).click();
    await expect(row.getByRole("button", { name: "Turn off" })).toBeVisible();
  }
  expect(await invoiceTotal()).toBeCloseTo(full * 0.9, 2);
});
