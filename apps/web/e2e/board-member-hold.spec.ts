import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A VISIT DRAGGED ONTO A PERSON WHOSE LAST FREE HOUR IS KEPT FOR MEMBERS
 *
 * A plan that promises priority holds a quarter of each window. Ray already
 * has three visits in the morning window of a weekday seven weeks out, so the
 * one hour of his morning left is the quarter kept for members. A fourth
 * visit for somebody who is not a member, dragged onto him, is refused in
 * words naming who could take it instead, and the card stays where it was;
 * "Send anyway" puts it on him. The plan is retired at the end, so nothing is
 * held for the specs after this one.
 */
const plus = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** A weekday, because the seeded windows are weekdays only. */
function weekdayFrom(date: string): string {
  let day = date;
  while ([0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay())) day = plus(day, 1);
  return day;
}

async function api<T>(page: Page, method: "get" | "post" | "put", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("a visit dragged onto time kept for members is refused, names who could take it, and can be sent anyway", async ({ owner }) => {
  test.setTimeout(180_000);
  const DAY = weekdayFrom(plus(companyToday(), 49));
  const { technicians } = await api<{ technicians: { id: string; displayName: string }[] }>(owner, "get", "/v1/technicians");
  const ray = technicians.find((t) => t.displayName === "Ray Ortiz")!;

  const plan = await api<{ id: string }>(owner, "post", "/v1/agreement-plans", {
    name: `Priority Club ${run}`, price: "199.00", billingFrequency: "annual", termMonths: 12,
    includedVisitsPerTerm: 2, priorityDispatch: true, memberHoldPercent: 25,
  });
  try {
    /** Inside the morning window whether the day is on daylight time or not. */
    const start = new Date(`${DAY}T15:00:00Z`);
    const visitFor = async (customer: string, phone: string, technicianIds: string[]) => {
      const customerId = await newCustomer(owner, {
        name: customer, phone, address: { street: `${phone.slice(-4)} Hold Ln`, city: "Austin", state: "TX", zip: "78702" },
      });
      const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
      await api(owner, "post", "/v1/jobs", {
        customerId, propertyId: data[0]!.id, summary: `Morning job ${run}`,
        visit: {
          windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 2 * 3_600_000).toISOString(),
          estimatedDurationMinutes: 60, ...(technicianIds.length > 0 ? { technicianIds } : {}),
        },
      });
    };
    for (let i = 1; i <= 3; i += 1) await visitFor(`Early Stranger ${i} ${run}`, `+1512555030${i}`, [ray.id]);
    const name = `Late Stranger ${run}`;
    await visitFor(name, "+15125550305", []);

    await owner.setViewportSize({ width: 2400, height: 1000 });
    await owner.goto(`/schedule?date=${DAY}`);
    const rayColumn = owner.locator("section").filter({ has: owner.getByRole("heading", { name: "Ray Ortiz", exact: true }) });
    const unassigned = owner.getByRole("article").filter({ hasText: name });
    await expect(unassigned).toBeVisible();

    await unassigned.dragTo(rayColumn);
    const held = owner.getByRole("group", { name: "Held for members" });
    await expect(held.getByRole("alert")).toContainText(`Ray Ortiz's time in the 8am to 12pm window on ${DAY} is kept for members`);
    await expect(held.getByRole("alert")).toContainText("could take it instead");
    await expect(rayColumn.getByText(name)).toHaveCount(0);

    await held.getByRole("button", { name: "Send anyway" }).click();
    await expect(held).toHaveCount(0);
    await owner.reload();
    await expect(rayColumn.getByText(name)).toBeVisible();
  } finally {
    await api(owner, "post", `/v1/agreement-plans/${plan.id}/retire`, {});
  }
});
