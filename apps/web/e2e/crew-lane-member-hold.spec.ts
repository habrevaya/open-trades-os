import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A VISIT DROPPED ON A CREW'S LANE WHEN ONE OF ITS PEOPLE'S LAST HOUR IS KEPT FOR MEMBERS
 *
 * A plan that promises priority holds a quarter of each window. Ray is on a
 * crew of his own, which has an afternoon job so it has a lane on the board,
 * and he already has three visits of his own in the morning window, so the
 * one hour of his morning left is the quarter kept for members. A visit for
 * somebody who is not a member, dragged onto the crew's lane, is refused in
 * words naming Ray, and the card stays where it was; "Send anyway" puts it on
 * the crew. The plan is retired and the crew stood down at the end, so
 * nothing is held for the specs after this one.
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

async function api<T>(page: Page, method: "get" | "post" | "put" | "patch", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("a visit dragged onto a crew whose person's time is kept for members is refused in words, and can be sent anyway", async ({ owner }) => {
  test.setTimeout(180_000);
  const DAY = weekdayFrom(plus(companyToday(), 53));
  const { technicians } = await api<{ technicians: { id: string; displayName: string }[] }>(owner, "get", "/v1/technicians");
  const ray = technicians.find((t) => t.displayName === "Ray Ortiz")!;

  const plan = await api<{ id: string }>(owner, "post", "/v1/agreement-plans", {
    name: `Crew Priority Club ${run}`, price: "199.00", billingFrequency: "annual", termMonths: 12,
    includedVisitsPerTerm: 2, priorityDispatch: true, memberHoldPercent: 25,
  });
  const crewName = `Ray's crew ${run}`;
  const crew = await api<{ id: string }>(owner, "post", "/v1/crews", { name: crewName });
  try {
    await api(owner, "put", `/v1/crews/${crew.id}/members`, { members: [{ technicianId: ray.id, isLead: true }] });
    const visitFor = async (customer: string, phone: string, start: Date, technicianIds: string[]) => {
      const customerId = await newCustomer(owner, {
        name: customer, phone, address: { street: `${phone.slice(-4)} Crew Hold Ln`, city: "Austin", state: "TX", zip: "78702" },
      });
      const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
      const job = await api<{ visits: { id: string }[] }>(owner, "post", "/v1/jobs", {
        customerId, propertyId: data[0]!.id, summary: `Crew hold job ${run}`,
        visit: {
          windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 2 * 3_600_000).toISOString(),
          estimatedDurationMinutes: 60, ...(technicianIds.length > 0 ? { technicianIds } : {}),
        },
      });
      return job.visits[0]!.id;
    };
    /** Inside the morning window whether the day is on daylight time or not. */
    const morning = new Date(`${DAY}T15:00:00Z`);
    for (let i = 1; i <= 3; i += 1) await visitFor(`Crew Early Stranger ${i} ${run}`, `+1512555032${i}`, morning, [ray.id]);
    /** The crew's own afternoon job, so it has a lane on the board that day. */
    const afternoon = await visitFor(`Crew Afternoon ${run}`, "+15125550324", new Date(`${DAY}T20:00:00Z`), []);
    await api(owner, "post", `/v1/visits/${afternoon}/crew`, { crewId: crew.id });
    const name = `Crew Late Stranger ${run}`;
    await visitFor(name, "+15125550325", morning, []);

    await owner.setViewportSize({ width: 2400, height: 1000 });
    await owner.goto(`/schedule?date=${DAY}`);
    const lane = owner.getByRole("region", { name: `Crew ${crewName}` });
    const unassigned = owner.getByRole("article").filter({ hasText: name });
    await expect(unassigned).toBeVisible();

    await unassigned.dragTo(lane);
    const held = owner.getByRole("group", { name: "Held for members" });
    await expect(held.getByRole("alert")).toContainText(
      `${crewName} would take Ray Ortiz's time in the 8am to 12pm window on ${DAY}, which is kept for members`,
    );
    await expect(lane.getByText(name)).toHaveCount(0);

    await held.getByRole("button", { name: "Send anyway" }).click();
    await expect(held).toHaveCount(0);
    await owner.reload();
    await expect(lane.getByText(name)).toBeVisible();
  } finally {
    await api(owner, "post", `/v1/agreement-plans/${plan.id}/retire`, {});
    await api(owner, "patch", `/v1/crews/${crew.id}`, { active: false });
  }
});
