import { eq } from "drizzle-orm";
import type { Page } from "@playwright/test";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * AN OFFER TAKEN BACK, AND ANOTHER OFFERED AFTER A NO
 *
 * A customer asks to move a visit and the office offers a different time,
 * then takes it back with a word to the customer, whose link says so. The
 * office offers another from the same request; the customer says no to it;
 * the office offers a third from the job's page, which the customer takes.
 * The visit does not move until that yes.
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

test("The office takes back a time it offered, and offers another after the customer says no", async ({ owner, stranger }) => {
  const name = `Offer Again ${run}`;
  const customerId = await newCustomer(owner, {
    name, address: { street: `${run.slice(-4)} Again Way`, city: "Austin", state: "TX", zip: "78702" },
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
    customerId, propertyId: data[0]!.id, jobTypeId: offered!.jobTypeId, summary: `Tune up again ${run}`,
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

  // An offer, then taken back with a word to them.
  await owner.goto(`/jobs/${created.id}`);
  const request = owner.getByRole("region", { name: `${name} asks to move a visit` });
  await request.getByLabel("Another time").selectOption({ index: 1 });
  await request.getByRole("button", { name: "Offer this time instead" }).click();
  const waiting = owner.getByRole("region", { name: `The time offered to ${name}` });
  await expect(waiting.getByRole("note")).toContainText("the visit stays where it is");
  await waiting.getByLabel("What to tell them").fill("Our technician is off that day after all.");
  await waiting.getByRole("button", { name: "Take this time back" }).click();
  await expect(owner.getByRole("region", { name: `The time offered to ${name}` })).toHaveCount(0);

  await stranger.reload();
  await expect(stranger.getByRole("region", { name: "Another time offered" })).toHaveCount(0);
  await expect(stranger.getByText(/took back the time they offered, so your visit stays where it was: Our technician is off that day after all\./))
    .toBeVisible();

  // Another from the same request, which the customer turns down.
  const again = owner.getByRole("region", { name: `Offer ${name} another time` });
  await expect(again).toContainText("You took back");
  await again.getByLabel("Another time").selectOption({ index: 2 });
  await again.getByRole("button", { name: "Offer this time" }).click();
  await expect(owner.getByRole("region", { name: `The time offered to ${name}` })).toBeVisible();

  await stranger.reload();
  const offer = stranger.getByRole("region", { name: "Another time offered" });
  await offer.getByRole("button", { name: "No, that does not work" }).click();
  await expect(stranger.getByText("You said no to the time the office offered. They will be in touch.")).toBeVisible();

  // A third, from the job's page, which they take.
  await owner.reload();
  const third = owner.getByRole("region", { name: `Offer ${name} another time` });
  await expect(third).toContainText(`${name} said no to`);
  await third.getByLabel("Another time").selectOption({ index: 3 });
  await third.getByRole("button", { name: "Offer this time" }).click();
  await expect(owner.getByRole("region", { name: `The time offered to ${name}` })).toBeVisible();
  const before = await api<{ windowStart: string }>(owner, "get", `/v1/visits/${visitId}`);
  expect(before.windowStart).toBe(start.toISOString());

  await stranger.reload();
  await stranger.getByRole("region", { name: "Another time offered" }).getByRole("button", { name: /^Yes, move it to/ }).click();
  await expect(stranger.getByText("You took the time the office offered, and your visit was moved to it.")).toBeVisible();
  const after = await api<{ windowStart: string; status: string }>(owner, "get", `/v1/visits/${visitId}`);
  expect(after.windowStart).not.toBe(start.toISOString());
  expect(after.status).toBe("unassigned");
});
