import { eq } from "drizzle-orm";
import type { Page } from "@playwright/test";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A CREW'S CARD HANDED TO A PERSON, A JOB CALLED OFF, AND ANOTHER TIME OFFERED
 *
 * Three things the office does from a screen. Drags a crew's visit onto one
 * person on the board, so it is theirs and off the crew's lane. Cancels a
 * job and, ticked for it, the visits it still had to come. And answers a
 * customer's ask to move with a different time, which the customer takes
 * from their link before anything moves.
 */

const plus = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function api<T>(page: Page, method: "get" | "post" | "put" | "patch", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function aCustomer(owner: Page, name: string, street: string) {
  const customerId = await newCustomer(owner, { name, address: { street, city: "Austin", state: "TX", zip: "78702" } });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  return { customerId, propertyId: data[0]!.id };
}

test("A crew's visit dragged onto one person on the board becomes theirs", async ({ owner }) => {
  const DAY = plus(companyToday(), 16);
  const { technicians } = await api<{ technicians: { id: string; displayName: string }[] }>(owner, "get", "/v1/technicians");
  const sam = technicians.find((t) => t.displayName === "Sam Reyes")!;
  const others = technicians.filter((t) => t.id !== sam.id).slice(0, 2);
  const crew = await api<{ id: string }>(owner, "post", "/v1/crews", { name: `Fence crew ${run}` });
  await api(owner, "put", `/v1/crews/${crew.id}/members`, {
    members: [{ technicianId: others[0]!.id, isLead: true }, ...(others[1] ? [{ technicianId: others[1].id }] : [])],
  });

  const name = `Crew Card ${run}`;
  const { customerId, propertyId } = await aCustomer(owner, name, `${run.slice(-4)} Crew Ln`);
  const start = new Date(`${DAY}T15:00:00Z`);
  const job = await api<{ visits: { id: string }[] }>(owner, "post", "/v1/jobs", {
    customerId, propertyId, summary: `Fence section ${run}`,
    visit: { windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 3 * 3_600_000).toISOString() },
  });
  const visitId = job.visits[0]!.id;
  await api(owner, "post", `/v1/visits/${visitId}/crew`, { crewId: crew.id });

  await owner.goto(`/schedule?date=${DAY}`);
  const lane = owner.getByRole("region", { name: `Crew Fence crew ${run}` });
  const card = lane.getByRole("article").filter({ hasText: name });
  await expect(card).toBeVisible();
  const samColumn = owner.locator("section").filter({ has: owner.getByRole("heading", { name: "Sam Reyes", exact: true }) });
  await card.dragTo(samColumn);

  /** On Sam's day, and the crew has nothing left that day, so its lane is gone. */
  await expect(samColumn.getByText(name, { exact: true })).toBeVisible();
  await owner.reload();
  await expect(owner.getByRole("region", { name: `Crew Fence crew ${run}` })).toHaveCount(0);
  await expect(owner.locator("section").filter({ has: owner.getByRole("heading", { name: "Sam Reyes", exact: true }) })
    .getByText(name, { exact: true })).toBeVisible();
});

test("Cancelling a job offers to cancel its visits still to come, and leaves the rest", async ({ owner }) => {
  const name = `Called Off ${run}`;
  const { customerId, propertyId } = await aCustomer(owner, name, `${run.slice(-4)} Off St`);
  const start = new Date(`${plus(companyToday(), 9)}T15:00:00Z`);
  const job = await api<{ id: string; visits: { id: string }[] }>(owner, "post", "/v1/jobs", {
    customerId, propertyId, summary: `Called off ${run}`,
    visit: { windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 2 * 3_600_000).toISOString() },
  });

  await owner.goto(`/jobs/${job.id}`);
  await owner.getByText("Cancel this job").click();
  const tick = owner.getByLabel(/Also cancel its visit still to come/);
  await expect(tick).toBeChecked();
  await owner.getByRole("button", { name: "Cancel the job" }).click();
  await expect(owner.getByText("Cancel this job")).toHaveCount(0);

  const visit = await api<{ status: string }>(owner, "get", `/v1/visits/${job.visits[0]!.id}`);
  expect(visit.status).toBe("cancelled");
});

test("The office offers another time, and nothing moves until the customer takes it", async ({ owner, stranger }) => {
  const name = `Offer Otto ${run}`;
  const { customerId, propertyId } = await aCustomer(owner, name, `${run.slice(-4)} Offer Ave`);
  const db = createClient();
  const [offered] = await db.select({ jobTypeId: schema.bookableService.jobTypeId })
    .from(schema.bookableService)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.bookableService.organizationId))
    .where(eq(schema.organization.slug, "ridgeline")).limit(1);
  await db.$close();

  const start = new Date(`${plus(companyToday(), 6)}T15:00:00Z`);
  const created = await api<{ id: string; visits: { id: string }[] }>(owner, "post", "/v1/jobs", {
    customerId, propertyId, jobTypeId: offered!.jobTypeId, summary: `Tune up ${run}`,
    visit: { windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 4 * 3_600_000).toISOString() },
  });
  const visitId = created.visits[0]!.id;
  const { url } = await api<{ url: string }>(owner, "post", "/v1/portal/grants", {
    customerId, scope: "job", subjectId: created.id, expiresInDays: 30,
  });

  // The customer asks to move it.
  await stranger.goto(`${url}/change`);
  await stranger.getByRole("button", { name: "Move it to another time" }).click();
  await stranger.getByRole("radio").first().check();
  await stranger.getByRole("button", { name: "Ask to move it" }).click();
  await expect(stranger.getByText(/You have asked to move this visit to/)).toBeVisible();

  // The office offers a different time instead.
  await owner.goto(`/jobs/${created.id}`);
  const request = owner.getByRole("region", { name: `${name} asks to move a visit` });
  const choice = request.getByLabel("Another time");
  const options = await choice.locator("option").allTextContents();
  await choice.selectOption({ index: Math.min(2, options.length - 1) });
  await request.getByLabel("What to tell them").last().fill("That day is full, but this one is free.");
  await request.getByRole("button", { name: "Offer this time instead" }).click();
  /** Answered, so the request leaves the page, and the offer waiting on the customer is said instead. */
  await expect(request).toHaveCount(0);
  await expect(owner.getByRole("note").filter({ hasText: `${name} was offered` })).toContainText("the visit stays where it is");

  const before = await api<{ windowStart: string }>(owner, "get", `/v1/visits/${visitId}`);
  expect(before.windowStart).toBe(start.toISOString());

  // The customer sees the offer on the same link and takes it.
  await stranger.reload();
  const offer = stranger.getByRole("region", { name: "Another time offered" });
  await expect(offer).toContainText("That day is full, but this one is free.");
  await expect(offer).toContainText("Your visit stays where it is until you say yes.");
  await offer.getByRole("button", { name: /^Yes, move it to/ }).click();
  await expect(stranger.getByText("You took the time the office offered, and your visit was moved to it.")).toBeVisible();

  const after = await api<{ windowStart: string; status: string }>(owner, "get", `/v1/visits/${visitId}`);
  expect(after.windowStart).not.toBe(start.toISOString());
  expect(after.status).toBe("unassigned");
});
