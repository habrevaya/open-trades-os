import { eq } from "drizzle-orm";
import type { APIRequestContext, Page } from "@playwright/test";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * AN APPLICATION ADDS STAGES AND A PRICING RULE, AND THE OFFICE SEES BOTH
 *
 * The whole path a third party takes: the owner lets an application in and
 * hands it a credential, the application registers a job workflow and a
 * pricing rule over HTTP with that credential and nothing else, and the
 * office meets them where they work: the stages on the job, a move refused
 * in words until the gate is met, the rule on the invoice line it touched,
 * and all of it listed under the application on Settings, Applications.
 *
 * Everything the application adds is narrowed to this run (its own job type
 * and its own customer tag), so specs running beside it price and move their
 * own work exactly as before.
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

test("An application's stages hold a job until its gate is met, and its pricing rule is said on the invoice", async ({ owner, stranger }) => {
  test.setTimeout(180_000);

  /* A kind of work only this run has, and a field the gate waits on. */
  const db = createClient();
  const [company] = await db.select({ id: schema.organization.id }).from(schema.organization)
    .where(eq(schema.organization.slug, "ridgeline")).limit(1);
  const [type] = await db.insert(schema.jobType).values({
    organizationId: company!.id, name: `Heat pump install ${run}`,
  }).returning({ id: schema.jobType.id });
  await db.$close();
  const fieldKey = `permit_${run}`;
  const fieldLabel = `Permit ${run}`;
  await api(owner, "post", "/v1/custom-fields", { entityType: "job", key: fieldKey, label: fieldLabel, dataType: "text" });

  /* The owner lets the application in and gives it a credential. */
  const app = await api<{ app: string }>(owner, "post", "/v1/apps", {
    name: `Install Planner ${run}`, publisher: "Planner Ltd",
    permissions: ["settings:write", "job:read", "pricebook:write", "customer:read"],
    scopes: { customer: "all", job: "all" },
  });
  const { token } = await api<{ token: string }>(owner, "post", `/v1/apps/${app.app}/tokens`, { label: "e2e" });

  /* The application registers, with its own token and no session. */
  await asApp(stranger.request, token, "/v1/plugins/job-workflows", {
    key: "install_stages", name: "Install stages", jobTypeId: type!.id,
    stages: [
      { key: "survey", name: "Survey", statuses: ["lead", "estimating", "scheduled"], gates: [{ kind: "field", key: fieldKey }] },
      { key: "fit", name: "Fit", statuses: ["in_progress", "on_hold"] },
      { key: "closed", name: "Closed", statuses: ["completed", "invoiced", "paid", "cancelled"] },
    ],
  });
  const tag = `planner ${run}`;
  await asApp(stranger.request, token, "/v1/plugins/pricing-rules", {
    key: "loyal", name: "Loyal customer", rule: { kind: "customer_tag", tag, percent: "-10" },
  });

  /* A job of that kind, for a customer carrying the tag. */
  const name = `Plug In ${run}`;
  const customerId = await newCustomer(owner, { name, address: { street: `${run.slice(-4)} Stage St`, city: "Austin", state: "TX", zip: "78702" } });
  await api(owner, "patch", `/v1/customers/${customerId}`, { tags: [tag] });
  const { data: places } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const job = await api<{ id: string }>(owner, "post", "/v1/jobs", {
    customerId, propertyId: places[0]!.id, summary: `New heat pump ${run}`, jobTypeId: type!.id,
  });
  /** Booked, which is inside the first stage, so no gate is asked about. */
  await api(owner, "patch", `/v1/jobs/${job.id}`, { status: "scheduled" });

  /* The office sees the stages, and the move past the gate is refused in words. */
  await owner.goto(`/jobs/${job.id}`);
  const stages = owner.getByRole("region", { name: "Stages" });
  await expect(stages).toContainText("Install stages, set by Install Planner");
  await expect(stages).toContainText("Here now");
  await expect(stages).toContainText(`Waiting on: "${fieldLabel}" filled in`);
  await owner.getByRole("button", { name: "Mark job complete" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "cannot leave" }))
    .toContainText(`This job cannot leave "Survey" yet: fill in "${fieldLabel}" on the job.`);

  /* Filled in, the same move goes through. */
  await api(owner, "patch", `/v1/jobs/${job.id}`, { customFields: { [fieldKey]: "B-2219" } });
  await owner.goto(`/jobs/${job.id}`);
  await expect(owner.getByRole("region", { name: "Stages" })).toContainText(`Done: "${fieldLabel}" filled in`);
  await owner.getByRole("button", { name: "Mark job complete" }).click();
  await expect(owner.getByRole("button", { name: "Reopen job" })).toBeVisible();

  /* The rule on the invoice line it touched. */
  const { data: items } = await api<{ data: { id: string; name: string; price: string }[] }>(owner, "get", "/v1/pricebook/items?limit=50");
  const item = items.find((i) => Number(i.price) > 0)!;
  const invoice = await api<{ id: string }>(owner, "post", "/v1/invoices", {
    customerId, jobId: job.id, draft: true,
    lines: [{ priceBookItemId: item.id, name: item.name, quantity: "1", unitPrice: item.price, discountAmount: "0", taxable: false }],
  });
  await owner.goto(`/invoices/${invoice.id}`);
  await expect(owner.getByText(`Loyal customer (Install Planner ${run}), taken off:`)).toBeVisible();

  /* And both are listed under the application. */
  await owner.goto("/settings/apps");
  const listed = owner.getByRole("table", { name: `What Install Planner ${run} added` });
  await expect(listed).toContainText("Install stages");
  await expect(listed).toContainText("Loyal customer");
  await expect(listed).toContainText(`10% off for customers tagged "${tag}"`);
});
