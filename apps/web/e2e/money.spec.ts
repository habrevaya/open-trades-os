import { and, desc, eq } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * THE COMPANY'S OWN FIELDS, ITS WEBHOOKS AND ITS PAY RULES, ON THE SCREENS
 *
 * Three things that were in the API with nothing a person could open: a
 * required field the company declared and no form that asked for it, a
 * receiver that was failing with nowhere to read why or send it again, and an
 * overtime rule and wage scales the timesheet needed and nobody could set.
 * Each is driven the way the office meets it, with the API used only where
 * there is no screen for a step (declaring a custom field) and the database
 * only to stand in for a worker pass that already happened.
 */

test("a required field of the company's own is asked for, refused when empty, and kept", async ({ owner }) => {
  const defined: string[] = [];
  try {
    for (const field of [
      { entityType: "customer", key: `acct_${run}`, label: `Account reference ${run}`, required: true },
      { entityType: "customer", key: `units_${run}`, label: `Units ${run}`, dataType: "number" },
    ]) {
      const made = await owner.request.post("/api/v1/custom-fields", { data: field });
      expect(made.ok()).toBe(true);
      defined.push((await made.json() as { id: string }).id);
    }

    await owner.goto("/customers/new");
    await owner.getByLabel("Name").fill(`Field Customer ${run}`);
    await owner.getByRole("button", { name: "Save customer" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: `Account reference ${run} is required.` })).toBeVisible();

    await owner.getByLabel(`Account reference ${run}`).fill("ACC-77");
    await owner.getByRole("button", { name: "Save customer" }).click();
    await expect(owner.getByRole("heading", { level: 1, name: `Field Customer ${run}` })).toBeVisible();

    const panel = owner.getByRole("region", { name: "Your fields" });
    await expect(panel.getByLabel(`Account reference ${run}`)).toHaveValue("ACC-77");
    await panel.getByLabel(`Units ${run}`).fill("3");
    await panel.getByRole("button", { name: "Save fields" }).click();
    await expect(panel.getByRole("status")).toHaveText("Saved.");
    await owner.reload();
    await expect(owner.getByRole("region", { name: "Your fields" }).getByLabel(`Units ${run}`)).toHaveValue("3");

    /** Clearing a required field this record holds is a change, and refused. */
    await owner.getByRole("region", { name: "Your fields" }).getByLabel(`Account reference ${run}`).fill("");
    await owner.getByRole("region", { name: "Your fields" }).getByRole("button", { name: "Save fields" }).click();
    await expect(owner.getByRole("alert").filter({ hasText: `Account reference ${run} is required.` })).toBeVisible();
  } finally {
    /** The database is shared by every spec after this one, and a required field would refuse their customers. */
    for (const id of defined) await owner.request.delete(`/api/v1/custom-fields/${id}?force=true`);
  }
});

test("a failing receiver's answer is readable, filtered, and sent again from the history", async ({ owner }) => {
  const url = `https://hooks.example.test/${run}`;
  await owner.goto("/settings/webhooks");
  await owner.getByLabel("Address").fill(url);
  await owner.getByRole("checkbox", { name: /^job\.completed/ }).check();
  await owner.getByRole("button", { name: "Add endpoint" }).click();
  await expect(owner.getByText("This is the signing secret for that endpoint.")).toBeVisible();

  /**
   * One attempt the worker made and the receiver refused, written where the
   * delivery pass writes it: there is no worker in this run.
   */
  const db = createClient();
  const [endpoint] = await db.select({ id: schema.webhookEndpoint.id, organizationId: schema.webhookEndpoint.organizationId })
    .from(schema.webhookEndpoint).where(eq(schema.webhookEndpoint.url, url)).limit(1);
  /** A job completed earlier in the run, or one written now if this spec runs alone. */
  let [event] = await db.select({ id: schema.domainEvent.id, sequence: schema.domainEvent.sequence })
    .from(schema.domainEvent)
    .where(and(
      eq(schema.domainEvent.organizationId, endpoint!.organizationId),
      eq(schema.domainEvent.name, "job.completed"),
    ))
    .orderBy(desc(schema.domainEvent.sequence)).limit(1);
  if (!event) {
    const [last] = await db.select({ sequence: schema.domainEvent.sequence }).from(schema.domainEvent)
      .where(eq(schema.domainEvent.organizationId, endpoint!.organizationId))
      .orderBy(desc(schema.domainEvent.sequence)).limit(1);
    [event] = await db.insert(schema.domainEvent).values({
      organizationId: endpoint!.organizationId, sequence: (last?.sequence ?? 0) + 1,
      name: "job.completed", entityType: "job", payload: {},
    }).returning({ id: schema.domainEvent.id, sequence: schema.domainEvent.sequence });
  }
  await db.insert(schema.webhookDelivery).values({
    organizationId: endpoint!.organizationId, endpointId: endpoint!.id,
    eventId: event!.id, eventSequence: event!.sequence, eventName: "job.completed", attempt: 1,
    requestedAt: new Date(), durationMs: 120, responseStatus: 503,
    responseExcerpt: `upstream is down ${run}`, error: "HTTP 503", ok: false,
  });
  await db.$close();

  await owner.getByRole("link", { name: url }).click();
  const filters = owner.getByRole("navigation", { name: "Filter by what happened" });
  await filters.getByRole("link", { name: "Delivered" }).click();
  await expect(owner.getByText("Nothing like that in the last thirty days")).toBeVisible();
  await filters.getByRole("link", { name: "Refused" }).click();

  const history = owner.getByRole("table", { name: "Delivery history" });
  const row = history.getByRole("row").filter({ hasText: "job.completed" });
  await expect(row).toContainText("HTTP 503");
  await row.getByText("What it said").click();
  await expect(row).toContainText(`upstream is down ${run}`);
  await row.getByRole("button", { name: "Send again" }).click();
  await expect(row.getByRole("status")).toContainText("Queued");

  await owner.reload();
  await expect(owner.getByRole("table", { name: "Sent again on request" })).toContainText("Waiting");

  const queued = createClient();
  const replays = await queued.select({ status: schema.webhookReplay.status })
    .from(schema.webhookReplay)
    .where(and(eq(schema.webhookReplay.endpointId, endpoint!.id), eq(schema.webhookReplay.eventId, event!.id)));
  await queued.$close();
  expect(replays).toEqual([{ status: "pending" }]);

  /** Changed their mind before the worker came round: stopped, and nothing more of it goes. */
  const asked = owner.getByRole("table", { name: "Sent again on request" }).getByRole("row").filter({ hasText: "Waiting" });
  await asked.getByRole("button", { name: "Stop it" }).click();
  await expect(asked.getByRole("status")).toContainText("Stopped. Nothing more of it is sent.");
  await owner.reload();
  const stoppedRow = owner.getByRole("table", { name: "Sent again on request" }).getByRole("row").filter({ hasText: "Stopped" });
  await expect(stoppedRow).toContainText("before anything went");
  await expect(stoppedRow.getByRole("button", { name: "Stop it" })).toHaveCount(0);

  /** And off again, so nothing in this database keeps a receiver that does not exist. */
  await owner.getByRole("table", { name: "Endpoints" }).getByRole("row").filter({ hasText: url })
    .getByRole("button", { name: "Remove" }).click();
  await expect(owner.getByRole("link", { name: url })).toHaveCount(0);
});

test("the overtime rule is declared and a wage scale is loaded and changed from a date", async ({ owner }) => {
  const classification = `Journeyman ${run}`;
  await owner.goto("/payroll/pay-rules");
  await expect(owner.getByRole("heading", { level: 1, name: "Pay rules" })).toBeVisible();

  const overtime = owner.getByRole("region", { name: "Overtime" });
  const declare = overtime.locator("details");
  if (await declare.getAttribute("open") === null) await declare.locator("summary").click();
  await overtime.getByLabel("Name").fill(`Federal ${run}`);
  await overtime.getByLabel("Time on call").selectOption("separate_rate_not_hours_worked");
  await overtime.getByLabel("Why this is the right rule").fill("Forty hours a week at time and a half.");
  await overtime.getByRole("button", { name: "Declare overtime rule" }).click();
  await expect(overtime.getByRole("status")).toContainText("Declared");
  await owner.reload();
  await expect(owner.getByRole("region", { name: "Overtime" })).toContainText(`Federal ${run}`);

  const scales = owner.getByRole("region", { name: "Wage scales" });
  const load = scales.locator("details").last();
  if (await load.getAttribute("open") === null) await load.locator("summary").click();
  await load.getByLabel("Classification").fill(classification);
  await load.getByLabel("Hourly rate").fill("42.00");
  await load.getByLabel("From (optional)").fill("2026-01-01");
  await load.getByRole("button", { name: "Load scale" }).click();
  await expect(load.getByRole("status")).toContainText("Loaded");
  await owner.reload();

  const row = owner.getByRole("table", { name: "Wage scales" }).getByRole("row").filter({ hasText: classification });
  await expect(row).toContainText("$42.00");
  await row.getByText("Change or retire").click();
  await row.getByLabel("New hourly rate").fill("45.50");
  await row.getByLabel("From").fill("2026-09-01");
  await row.getByRole("button", { name: "Change rate" }).click();

  /** The page itself is the answer: the old rate retired the day before, the new one in effect. */
  const rows = owner.getByRole("table", { name: "Wage scales" }).getByRole("row").filter({ hasText: classification });
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "$45.50" })).toContainText("Still in effect");
  await expect(rows.filter({ hasText: "$42.00" })).toContainText("Retired");
});
