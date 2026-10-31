import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A CREW'S HOURS ON SATURDAYS, AND ITS LANE BEFORE IT HAS WORK
 *
 * The office gives a new crew Saturday hours of its own, seven until eleven,
 * on Crews and on call. On the board for a Saturday a month out the crew
 * already has a lane, with no work on it, saying it works seven to eleven
 * that day. A visit dragged from the unassigned pile onto the empty lane goes
 * to the crew. The crew is retired at the end, so no other test plans around
 * it.
 */

async function api<T>(page: Page, method: "get" | "post" | "put" | "patch", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

/** The first Saturday at least a month out, in the company's calendar. */
function saturdayAhead(): string {
  const d = new Date(`${companyToday()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 30);
  while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

test("a crew given Saturday hours, its empty lane on a Saturday, and its first visit dropped on it", async ({ owner }) => {
  test.setTimeout(120_000);
  const name = `Saturday crew ${run}`;
  const crew = await api<{ id: string }>(owner, "post", "/v1/crews", { name });
  const { technicians } = await api<{ technicians: { id: string; displayName: string }[] }>(owner, "get", "/v1/technicians");
  const member = technicians.find((t) => t.displayName !== "Sam Reyes")!;
  await api(owner, "put", `/v1/crews/${crew.id}/members`, { members: [{ technicianId: member.id, isLead: true }] });

  try {
    await owner.goto("/schedule/crews");
    const row = owner.getByRole("row").filter({ hasText: name });
    await row.getByText(`Hours by day for ${name}`).click();
    await row.getByLabel(`${name} starts on Saturday`).fill("07:00");
    await row.getByLabel(`${name} finishes on Saturday`).fill("11:00");
    await row.getByRole("button", { name: "Save hours by day" }).click();
    await expect(row).toContainText("Works the company's day, except Sat 07:00 to 11:00");

    /** Half a day is refused in words. */
    await row.getByLabel(`${name} starts on Friday`).fill("06:00");
    await row.getByRole("button", { name: "Save hours by day" }).click();
    await expect(row.getByRole("alert")).toContainText("Give Friday's start and finish");

    const day = saturdayAhead();
    const customerId = await newCustomer(owner, { name: `Gate job ${run}`, address: { street: `${run.slice(-4)} Gate Ln`, city: "Austin", state: "TX", zip: "78702" } });
    const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
    const start = new Date(`${day}T14:00:00Z`);
    await api(owner, "post", "/v1/jobs", {
      customerId, propertyId: data[0]!.id, summary: `Gate repair ${run}`,
      visit: { windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 2 * 3_600_000).toISOString() },
    });

    await owner.setViewportSize({ width: 2400, height: 1000 });
    await owner.goto(`/schedule?date=${day}`);
    const lane = owner.getByRole("region", { name: `Crew ${name}` });
    await expect(lane.getByLabel(`${name} works`)).toHaveText("Works 7:00 AM to 11:00 AM today");
    await expect(lane).toContainText("Nothing yet. Drop a visit here to send it to the crew.");

    const card = owner.getByRole("article").filter({ hasText: `Gate repair ${run}` });
    await card.dragTo(lane);
    await expect(lane.getByText(`Gate repair ${run}`)).toBeVisible();
    await owner.reload();
    await expect(owner.getByRole("region", { name: `Crew ${name}` }).getByText(`Gate repair ${run}`)).toBeVisible();
  } finally {
    await api(owner, "patch", `/v1/crews/${crew.id}`, { active: false });
  }
});
