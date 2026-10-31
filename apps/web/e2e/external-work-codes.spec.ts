import { and, eq } from "drizzle-orm";
import type { Page } from "@playwright/test";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A CLIENT'S OWN CODES BECOME THE JOB (M31)
 *
 * The office writes down what one client's codes mean (a kind of work, an item
 * and how many), an order from that client arrives over the API with two codes,
 * one of them on the list and one not, and the order's page proposes the job:
 * the line the mapped code adds and the other named in words. Nothing is made
 * until the office presses Accept and make the job; then the job carries the
 * line with the client's code on it and the order is accepted with the job.
 *
 * Everything is this run's own: the client, the kind of work and the item.
 */
async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("an order's codes propose the job, the office confirms it, and the job carries the client's code", async ({ owner }) => {
  test.setTimeout(120_000);
  const client = `Harbor Retail ${run}`;
  const customerId = await newCustomer(owner, {
    name: client,
    address: { street: `412 Market St ${run}`, city: "Austin", state: "TX", zip: "78704" },
  });

  const db = createClient();
  let typeName = "";
  try {
    const [company] = await db.select({ id: schema.organization.id }).from(schema.organization)
      .where(eq(schema.organization.slug, "ridgeline")).limit(1);
    typeName = `Plumbing ${run}`;
    await db.insert(schema.jobType).values({ organizationId: company!.id, name: typeName });
  } finally {
    await db.$close();
  }
  const itemName = `Tap washer ${run}`;
  await api(owner, "post", "/v1/pricebook/items", {
    kind: "material", code: `WASH-${run}`, name: itemName, price: "12.00", cost: "1.50",
  });

  /* The client's list: one code, a plumbing job and two washers. */
  await owner.goto(`/contracts/external/codes/${customerId}`);
  await expect(owner.getByRole("heading", { level: 1, name: `${client}'s codes` })).toBeVisible();
  await owner.getByLabel("Code, row 1").fill("PLB-07");
  await owner.getByLabel("What it means, row 1").fill("Leaking tap");
  await owner.getByLabel("Kind of work, row 1").selectOption({ label: typeName });
  await owner.getByLabel("Item, row 1").selectOption({ label: `${itemName} (WASH-${run})` });
  await owner.getByLabel("How many, row 1").fill("2");
  await owner.getByRole("button", { name: "Save the codes" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved. 1 code on the list." })).toBeVisible();

  /* An order from their network, for them, with a code on the list and one that is not. */
  const order = await api<{ id: string }>(owner, "post", "/v1/external-work-orders", {
    sourceSystem: "servicechannel", externalId: `SC-${run}`, externalNumber: `WO-${run}`, externalStatus: "Open",
    customerId, codes: [{ code: "PLB-07" }, { code: "HVAC-3", description: "No heat" }],
  });

  await owner.goto("/contracts/external");
  await owner.getByRole("link", { name: `WO-${run}` }).click();
  await expect(owner.getByRole("heading", { level: 1, name: `ServiceChannel order WO-${run}` })).toBeVisible();

  const proposal = owner.getByRole("region", { name: "Make the job from their codes" });
  const lines = proposal.getByRole("table", { name: "Lines the codes add" });
  await expect(lines.getByRole("row").filter({ hasText: itemName })).toContainText("PLB-07");
  await expect(lines.getByRole("row").filter({ hasText: itemName }).getByRole("cell").nth(2)).toHaveText("2");
  await expect(proposal.getByRole("note")).toContainText(`HVAC-3 (No heat) is not on ${client}'s list of codes.`);
  await expect(proposal.getByLabel("Kind of work")).toHaveValue(/.+/);

  await proposal.getByRole("button", { name: "Accept and make the job" }).click();
  await expect(owner.getByRole("link", { name: "Open the job" })).toBeVisible();
  await expect(proposal).toContainText("This order already has a job.");

  const check = createClient();
  try {
    const [row] = await check.select({ jobId: schema.externalWorkOrder.jobId, state: schema.externalWorkOrder.state })
      .from(schema.externalWorkOrder).where(eq(schema.externalWorkOrder.id, order.id)).limit(1);
    expect(row!.state).toBe("accepted");
    const lineRows = await check.select({ name: schema.jobLine.name, quantity: schema.jobLine.quantity, code: schema.jobLine.clientCode })
      .from(schema.jobLine).where(and(eq(schema.jobLine.jobId, row!.jobId!)));
    expect(lineRows).toEqual([{ name: itemName, quantity: "2.0000", code: "PLB-07" }]);
  } finally {
    await check.$close();
  }

  await owner.getByRole("link", { name: "Open the job" }).click();
  await expect(owner.getByText("Not mapped: HVAC-3 (No heat)", { exact: false })).toBeVisible();
});
