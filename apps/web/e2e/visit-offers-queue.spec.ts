import { eq } from "drizzle-orm";
import type { Page } from "@playwright/test";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A NO TO A TIME, ANSWERED FROM THE OFFICE QUEUE
 *
 * A customer asks to move a visit, the office offers a time, and the customer
 * says no. The task that says so is in the queue and offers the next free
 * times with one press each, and sends nothing until one is pressed. The time
 * then offered waits in the queue, where it can be taken back, and a time
 * taken back stays in the queue to be offered again.
 */

const plus = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("the queue offers the next free times after a no, takes an offer back and offers again", async ({ owner, stranger }) => {
  const name = `Queue Offer ${run}`;
  const customerId = await newCustomer(owner, {
    name, address: { street: `${run.slice(-4)} Queue Way`, city: "Austin", state: "TX", zip: "78702" },
  });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const db = createClient();
  const [offered] = await db.select({ jobTypeId: schema.bookableService.jobTypeId })
    .from(schema.bookableService)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.bookableService.organizationId))
    .where(eq(schema.organization.slug, "ridgeline")).limit(1);
  await db.$close();

  const start = new Date(`${plus(companyToday(), 7)}T15:00:00Z`);
  const created = await api<{ id: string; visits: { id: string }[] }>(owner, "post", "/v1/jobs", {
    customerId, propertyId: data[0]!.id, jobTypeId: offered!.jobTypeId, summary: `Queue tune up ${run}`,
    visit: { windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 4 * 3_600_000).toISOString() },
  });
  const visitId = created.visits[0]!.id;
  const { url } = await api<{ url: string }>(owner, "post", "/v1/portal/grants", {
    customerId, scope: "job", subjectId: created.id, expiresInDays: 30,
  });

  await stranger.goto(`${url}/change`);
  await stranger.getByRole("button", { name: "Move it to another time" }).click();
  await stranger.getByRole("radio").first().check();
  await stranger.getByRole("button", { name: "Ask to move it" }).click();
  await expect(stranger.getByText(/You have asked to move this visit to/)).toBeVisible();

  // The office offers a time and the customer says no.
  await owner.goto(`/jobs/${created.id}`);
  const request = owner.getByRole("region", { name: `${name} asks to move a visit` });
  await request.getByLabel("Another time").selectOption({ index: 1 });
  await request.getByRole("button", { name: "Offer this time instead" }).click();
  await expect(owner.getByRole("region", { name: `The time offered to ${name}` })).toBeVisible();
  await stranger.reload();
  await stranger.getByRole("region", { name: "Another time offered" })
    .getByRole("button", { name: "No, that does not work" }).click();
  await expect(stranger.getByText("You said no to the time the office offered. They will be in touch.")).toBeVisible();

  // Nothing was offered by itself: the queue's task offers the next times and waits for a press.
  await owner.goto("/tasks?view=all");
  const again = owner.getByRole("region", { name: `Offer ${name} another time` });
  await expect(again).toContainText(`${name} said no to`);
  const next = again.getByRole("group", { name: "The next free times" });
  await expect(next.getByRole("button")).toHaveCount(3);
  await expect(owner.getByRole("region", { name: `The time offered to ${name}` })).toHaveCount(0);

  // One press: that time goes to the customer, the task is done, and the offer waits in the queue.
  await next.getByRole("button").first().click();
  await expect(owner.getByRole("region", { name: `The time offered to ${name}` })).toBeVisible();
  await expect(owner.getByRole("region", { name: `Offer ${name} another time` })).toHaveCount(0);
  const waiting = owner.getByRole("region", { name: `The time offered to ${name}` });
  await expect(waiting).toContainText("Waiting for them to say yes or no");
  const before = await api<{ windowStart: string }>(owner, "get", `/v1/visits/${visitId}`);
  expect(before.windowStart).toBe(start.toISOString());

  // Taken back from the queue, with a word to the customer.
  await waiting.getByLabel("What to tell them").fill("Our technician is off that day after all.");
  await waiting.getByRole("button", { name: "Take this time back" }).click();
  await owner.reload();
  await expect(owner.getByRole("region", { name: `The time offered to ${name}` })).toHaveCount(0);
  await stranger.reload();
  await expect(stranger.getByText(/took back the time they offered, so your visit stays where it was: Our technician is off that day after all\./))
    .toBeVisible();

  // The time taken back stays in the queue, and another is offered from there.
  const taken = owner.getByRole("region", { name: `Offer ${name} another time` });
  await expect(taken).toContainText("You took back");
  await taken.getByRole("group", { name: "The next free times" }).getByRole("button").first().click();
  await expect(owner.getByRole("region", { name: `The time offered to ${name}` })).toBeVisible();
  await expect(owner.getByRole("region", { name: `Offer ${name} another time` })).toHaveCount(0);
});
