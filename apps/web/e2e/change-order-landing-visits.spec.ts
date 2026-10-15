import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * THE VISITS ON THE PHASE A CHANGE ORDER'S DAYS LAND ON
 *
 * Rough in, five weeks and more ahead, with two of Nia's visits on it: one
 * on its first day and one on its fourth. An agreed change order adds two
 * days to rough in. Left as it is, the days go on the end of rough in and
 * neither visit moves. Told the extra work starts on rough in's third day,
 * the page shows the fourth day's visit going two days later and the first
 * day's staying; applied, it has moved and the page says from which day the
 * days landed.
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

test("a change order's days move the visits on the phase they land on from the day the office chooses", async ({ owner }) => {
  test.setTimeout(180_000);
  const start = plus(companyToday(), 36);
  const customer = `Oak Ridge Partners ${run}`;
  const customerId = await newCustomer(owner, {
    name: customer, phone: "+15125550326", address: { street: `${run.slice(-4)} Oak Ridge Rd`, city: "Austin", state: "TX", zip: "78701" },
  });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const project = await api<{ id: string }>(owner, "post", "/v1/projects", {
    customerId, propertyId: data[0]!.id, name: `Oak Ridge fit out ${run}`, contractValue: "100000.00",
  });
  const rough = await api<{ id: string }>(owner, "post", `/v1/projects/${project.id}/phases`, {
    name: "Rough in", billingValue: "100000.00", startsOn: start, endsOn: plus(start, 4),
  });
  const made = await api<{ created: { jobId: string; phaseId: string }[] }>(owner, "post", `/v1/projects/${project.id}/materialise`, {});
  const roughJob = made.created.find((c) => c.phaseId === rough.id)!.jobId;
  const { technicians } = await api<{ technicians: { id: string; displayName: string }[] }>(owner, "get", "/v1/technicians");
  const nia = technicians.find((t) => t.displayName === "Nia Osei")!;
  /** Eleven in the morning in Austin, on rough in's first day and its fourth. */
  const visitOn = async (date: string) => {
    const at = new Date(`${date}T17:00:00Z`);
    await api(owner, "post", `/v1/jobs/${roughJob}/visits`, {
      windowStart: at.toISOString(), windowEnd: new Date(at.getTime() + 2 * 3_600_000).toISOString(),
      estimatedDurationMinutes: 120, technicianIds: [nia.id],
    });
    return at;
  };
  const first = await visitOn(start);
  const fourth = await visitOn(plus(start, 3));

  const order = await api<{ id: string }>(owner, "post", `/v1/projects/${project.id}/change-orders`, {
    title: "Another bathroom", phaseId: rough.id, scheduleDays: 2,
  });
  await api(owner, "post", `/v1/project-change-orders/${order.id}/lines`, { name: "Another bathroom", quantity: "1", unitPrice: "2400.00" });
  await api(owner, "post", `/v1/project-change-orders/${order.id}/decision`, { decision: "approved", signerName: "Pat Owner" });

  await owner.goto(`/projects/${project.id}/change-orders/${order.id}`);
  const schedule = owner.getByRole("region", { name: "The schedule" });
  await expect(schedule.getByText("The 2 days go on the end of Rough in, so its own visits stay.")).toBeVisible();
  await expect(schedule.getByRole("table", { name: "Visits that move" })).toHaveCount(0);

  await schedule.getByLabel("The extra days start on").fill(plus(start, 2));
  await schedule.getByRole("button", { name: "Show what would move" }).click();
  await expect(schedule.getByText(/Rough in's visits from .* go 2 days later\. Its visits before then stay\./)).toBeVisible();
  const words = (d: Date) => new Intl.DateTimeFormat("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
  }).format(d);
  const moving = schedule.getByRole("table", { name: "Visits that move" });
  await expect(moving.getByRole("row").filter({ hasText: customer })).toHaveCount(1);
  await expect(moving.getByRole("row").filter({ hasText: customer })).toContainText(words(fourth));

  await schedule.getByRole("button", { name: "Apply to the schedule" }).click();
  await expect(owner.getByText(`They landed on Rough in from ${plus(start, 2)}.`, { exact: false })).toBeVisible();
  const job = await api<{ visits: { windowStart: string }[] }>(owner, "get", `/v1/jobs/${roughJob}`);
  const starts = job.visits.map((v) => new Date(v.windowStart).toISOString().slice(0, 10)).sort();
  expect(starts).toEqual([first.toISOString().slice(0, 10), plus(start, 5)]);
});
