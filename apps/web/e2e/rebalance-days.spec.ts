import { test, expect, run, newCustomer, companyToday } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * SEVERAL DAYS REBALANCED, IN A BROWSER
 *
 * Sam's day twelve days out is five two hour jobs, which runs past the
 * overtime the company allows, and everybody else is off that day. One of
 * those customers agreed to either of two days, which the office records on
 * the visit's page. From the board, "Rebalance several days" proposes that
 * visit on the next day, shown as each day before and after; the dispatcher
 * applies it, and the visit is on its new day at the same times.
 */

const ZONE = "America/Chicago";
const plus = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
/** A wall clock time on a day in Austin, as an instant. */
const at = (day: string, hour: number) => {
  const local = new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, timeZoneName: "shortOffset" })
    .formatToParts(local).find((p) => p.type === "timeZoneName")!.value;
  return new Date(local.getTime() - Number(offset.replace("GMT", "") || "0") * 3_600_000).toISOString();
};
const longDay = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
  weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
});

async function api<T>(page: Page, method: "get" | "post" | "put" | "patch", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("Rebalancing several days moves a visit to a day its customer agreed to, and only that one", async ({ owner }) => {
  test.setTimeout(180_000);
  const DAY = plus(companyToday(), 12);
  const NEXT = plus(DAY, 1);

  const { locations } = await api<{ locations: { id: string; name: string }[] }>(owner, "get", "/v1/locations");
  const shop = locations.find((l) => l.name === "Shop") ?? locations[0]!;
  await api(owner, "post", `/v1/locations/${shop.id}/pin`, { latitude: 30.33, longitude: -97.72 });
  const { technicians } = await api<{ technicians: { id: string; displayName: string }[] }>(owner, "get", "/v1/technicians");
  const sam = technicians.find((t) => t.displayName === "Sam Reyes")!;
  for (const t of technicians) await api(owner, "patch", `/v1/technicians/${t.id}`, { homeLocationId: shop.id });

  /** Everybody but Sam is off that day, so the day's overflow cannot simply go to somebody else. */
  for (const t of technicians.filter((x) => x.id !== sam.id)) {
    const off = await api<{ id: string }>(owner, "post", "/v1/time-off", {
      technicianId: t.id, startsAt: at(DAY, 0), endsAt: at(DAY, 23), reason: "Training",
    });
    await api(owner, "post", `/v1/time-off/${off.id}/approve`, {});
  }

  /** Five two hour jobs close to the shop: the last one would finish past the overtime allowed. */
  const visitIds: string[] = [];
  for (const [i, lng] of [-97.715, -97.71, -97.705, -97.70, -97.695].entries()) {
    const name = i === 4 ? `Flexible ${run}` : `Fixed ${i} ${run}`;
    const customerId = await newCustomer(owner, {
      name, address: { street: `${run.slice(-4)}${i} Days Rd`, city: "Austin", state: "TX", zip: "78723" },
    });
    const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
    await api(owner, "post", `/v1/properties/${data[0]!.id}/pin`, { latitude: 30.33, longitude: lng });
    const job = await api<{ visits: { id: string }[] }>(owner, "post", "/v1/jobs", {
      customerId, propertyId: data[0]!.id, summary: `Two hour job ${i} ${run}`,
      visit: { windowStart: at(DAY, 8), windowEnd: at(DAY, 17), estimatedDurationMinutes: 120, technicianIds: [sam.id] },
    });
    visitIds.push(job.visits[0]!.id);
  }
  const flexible = visitIds[4]!;

  /** The office records, on the visit, the two days the customer agreed to. */
  await owner.goto(`/visits/${flexible}`);
  const agreed = owner.getByRole("region", { name: "Days it may move to" });
  await agreed.getByLabel("From").fill(DAY);
  await agreed.getByLabel("To").fill(NEXT);
  await agreed.getByRole("button", { name: "Save" }).click();
  await expect(agreed.getByRole("status")).toContainText("Saved.");

  /** From the board, to the proposal for several days. Nothing has moved yet. */
  await owner.goto(`/schedule?date=${DAY}`);
  await owner.getByRole("link", { name: "Rebalance several days" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: "Rebalance several days" })).toBeVisible();
  const moved = owner.getByRole("table", { name: "Moved to another day" });
  const row = moved.getByRole("row").filter({ hasText: `Flexible ${run}` });
  await expect(row).toContainText("A range of days");
  await expect(moved.getByRole("row").filter({ hasText: `Fixed 0 ${run}` })).toHaveCount(0);
  const before = owner.getByRole("region", { name: longDay(DAY) });
  await expect(before).toContainText("As it is");
  await expect(before.getByRole("article", { name: `Sam Reyes on ${longDay(DAY)}` })).toContainText(`moves to`);
  await expect(owner.getByRole("region", { name: longDay(NEXT) })).toContainText(`Flexible ${run}`);

  const windowOf = async () => (await api<{ windowStart: string }>(owner, "get", `/v1/visits/${flexible}`)).windowStart;
  expect(await windowOf()).toBe(at(DAY, 8));

  /** Applied by the person looking at it. */
  await owner.getByRole("button", { name: "Apply these changes" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Done." })).toContainText("1 visit is on a new day");
  expect(await windowOf()).toBe(at(NEXT, 8));

  /** And on the board on the new day. */
  await owner.goto(`/schedule?date=${NEXT}`);
  await expect(owner.getByText(`Flexible ${run}`, { exact: true })).toBeVisible();
});
