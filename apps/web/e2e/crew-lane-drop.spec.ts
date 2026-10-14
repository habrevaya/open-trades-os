import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A PERSON'S VISIT DROPPED ON A CREW'S LANE, AND THE DAY REBALANCED WITH CREWS
 *
 * Two crews have work on a day three weeks out: the deck crew, whose people
 * are working, and the gutter crew, whose only person is off. A dispatcher
 * drags one of Sam's visits onto the gutter crew's lane and is told why in
 * words, with the card left where it was; dropped on the deck crew's lane it
 * goes to the deck crew, off Sam's day. "Rebalance the day" then shows each
 * crew's day beside the people's.
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

async function aVisit(owner: Page, name: string, street: string, day: string, technicianIds: string[] = []) {
  const customerId = await newCustomer(owner, { name, address: { street, city: "Austin", state: "TX", zip: "78702" } });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  /** On the map, so the rebalance can plan it. */
  await api(owner, "post", `/v1/properties/${data[0]!.id}/pin`, { latitude: 30.33, longitude: -97.70 });
  const start = new Date(`${day}T15:00:00Z`);
  const job = await api<{ visits: { id: string }[] }>(owner, "post", "/v1/jobs", {
    customerId, propertyId: data[0]!.id, summary: `Two hour job ${run}`,
    visit: {
      windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 3 * 3_600_000).toISOString(),
      ...(technicianIds.length > 0 ? { technicianIds } : {}),
    },
  });
  return job.visits[0]!.id;
}

test("A person's visit dropped on a crew's lane goes to the crew, or is refused in words", async ({ owner }) => {
  test.setTimeout(180_000);
  const DAY = plus(companyToday(), 23);
  /** Where every day starts, on the map, as the rebalance needs it. */
  const { locations } = await api<{ locations: { id: string; name: string }[] }>(owner, "get", "/v1/locations");
  const shop = locations.find((l) => l.name === "Shop") ?? locations[0]!;
  await api(owner, "post", `/v1/locations/${shop.id}/pin`, { latitude: 30.33, longitude: -97.72 });
  const { technicians } = await api<{ technicians: { id: string; displayName: string }[] }>(owner, "get", "/v1/technicians");
  const sam = technicians.find((t) => t.displayName === "Sam Reyes")!;
  const [first, second] = technicians.filter((t) => t.id !== sam.id);

  const deck = await api<{ id: string }>(owner, "post", "/v1/crews", { name: `Deck crew ${run}` });
  await api(owner, "put", `/v1/crews/${deck.id}/members`, { members: [{ technicianId: first!.id, isLead: true }] });
  const gutter = await api<{ id: string }>(owner, "post", "/v1/crews", { name: `Gutter crew ${run}` });
  await api(owner, "put", `/v1/crews/${gutter.id}/members`, { members: [{ technicianId: second!.id, isLead: true }] });

  /** Each crew has a job that day, so each has a lane; then the gutter crew's only person takes the day off. */
  await api(owner, "post", `/v1/visits/${await aVisit(owner, `Deck job ${run}`, `${run.slice(-4)} Deck Ln`, DAY)}/crew`, { crewId: deck.id });
  await api(owner, "post", `/v1/visits/${await aVisit(owner, `Gutter job ${run}`, `${run.slice(-4)} Gutter Ln`, DAY)}/crew`, { crewId: gutter.id });
  const off = await api<{ id: string }>(owner, "post", "/v1/time-off", {
    technicianId: second!.id, startsAt: `${DAY}T05:00:00Z`, endsAt: `${plus(DAY, 1)}T04:59:00Z`, reason: "Training",
  });
  await api(owner, "post", `/v1/time-off/${off.id}/approve`, {});

  const name = `Sams Visit ${run}`;
  await aVisit(owner, name, `${run.slice(-4)} Lane Rd`, DAY, [sam.id]);

  /** Wide enough that Sam's column and both crews' lanes are on screen together, as on an office monitor. */
  await owner.setViewportSize({ width: 2400, height: 1000 });
  await owner.goto(`/schedule?date=${DAY}`);
  const samColumn = owner.locator("section").filter({ has: owner.getByRole("heading", { name: "Sam Reyes", exact: true }) });
  const card = samColumn.getByRole("article").filter({ hasText: name });
  await expect(card).toBeVisible();

  /** The gutter crew's only person is off: refused, in the check's own words, and nothing moves. */
  await card.dragTo(owner.getByRole("region", { name: `Crew Gutter crew ${run}` }));
  await expect(owner.getByRole("alert").filter({ hasText: `Everybody on Gutter crew ${run} is on approved time off` })).toBeVisible();
  await expect(samColumn.getByText(name, { exact: true })).toBeVisible();

  /** The deck crew takes it, and it is off Sam's day. */
  await card.dragTo(owner.getByRole("region", { name: `Crew Deck crew ${run}` }));
  await expect(owner.getByRole("region", { name: `Crew Deck crew ${run}` }).getByText(name, { exact: true })).toBeVisible();
  await owner.reload();
  await expect(owner.getByRole("region", { name: `Crew Deck crew ${run}` }).getByText(name, { exact: true })).toBeVisible();
  await expect(samColumn.getByText(name, { exact: true })).toHaveCount(0);

  /** The single day rebalance plans the deck crew's day beside the people's. */
  await owner.getByRole("link", { name: "Rebalance the day" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: "Rebalance the day" })).toBeVisible();
  await expect(owner.getByRole("article", { name: `Crew Deck crew ${run}'s day` })).toContainText(name);
});
