import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A CHANGE ORDER'S DAYS MOVE THE VISITS BOOKED ON THE PHASES THEY MOVE
 *
 * Rough in, then fixtures, a month and more ahead, each with its job. Nia is
 * booked on a fixtures visit. An agreed change order adds three days to rough
 * in, so fixtures moves three days later and Nia's visit with it: the change
 * order's page lists the visit with its time now and after before anything
 * moves, and once a person applies it the visit is at its new time and the
 * page says it moved.
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

test("a change order's days move the visits booked on the phases they move, as shown first", async ({ owner }) => {
  test.setTimeout(180_000);
  const start = plus(companyToday(), 40);
  const customer = `Hillcrest Partners ${run}`;
  const customerId = await newCustomer(owner, {
    name: customer, phone: "+15125550311", address: { street: `${run.slice(-4)} Hillcrest Rd`, city: "Austin", state: "TX", zip: "78701" },
  });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const project = await api<{ id: string }>(owner, "post", "/v1/projects", {
    customerId, propertyId: data[0]!.id, name: `Hillcrest fit out ${run}`, contractValue: "100000.00",
  });
  const rough = await api<{ id: string }>(owner, "post", `/v1/projects/${project.id}/phases`, {
    name: "Rough in", billingValue: "60000.00", startsOn: start, endsOn: plus(start, 4),
  });
  const fixtures = await api<{ id: string }>(owner, "post", `/v1/projects/${project.id}/phases`, {
    name: "Fixtures", billingValue: "40000.00", dependsOnPhaseId: rough.id, startsOn: plus(start, 7), endsOn: plus(start, 9),
  });
  const made = await api<{ created: { jobId: string; phaseId: string }[] }>(owner, "post", `/v1/projects/${project.id}/materialise`, {});
  const fixturesJob = made.created.find((c) => c.phaseId === fixtures.id)!.jobId;
  const { technicians } = await api<{ technicians: { id: string; displayName: string }[] }>(owner, "get", "/v1/technicians");
  const nia = technicians.find((t) => t.displayName === "Nia Osei")!;
  /** Ten in the morning in Austin, on fixtures' first day. */
  const at = new Date(`${plus(start, 7)}T16:00:00Z`);
  await api(owner, "post", `/v1/jobs/${fixturesJob}/visits`, {
    windowStart: at.toISOString(), windowEnd: new Date(at.getTime() + 2 * 3_600_000).toISOString(),
    estimatedDurationMinutes: 120, technicianIds: [nia.id],
  });

  const order = await api<{ id: string }>(owner, "post", `/v1/projects/${project.id}/change-orders`, {
    title: "Two more circuits", phaseId: rough.id, scheduleDays: 3,
  });
  await api(owner, "post", `/v1/project-change-orders/${order.id}/lines`, { name: "Two more circuits", quantity: "1", unitPrice: "900.00" });
  await api(owner, "post", `/v1/project-change-orders/${order.id}/decision`, { decision: "approved", signerName: "Pat Owner" });

  await owner.goto(`/projects/${project.id}/change-orders/${order.id}`);
  const schedule = owner.getByRole("region", { name: "The schedule" });
  const moving = schedule.getByRole("table", { name: "Visits that move" });
  await expect(moving.getByRole("row").filter({ hasText: customer })).toContainText("Nia Osei");
  const words = (d: Date) => new Intl.DateTimeFormat("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
  }).format(d);
  /** The proposal says where it goes: the same time of day, three days on, in the company's calendar. */
  const proposal = await api<{ proposal: { visits: { moves: { start: string }[] } } }>(
    owner, "get", `/v1/project-change-orders/${order.id}/schedule-days`,
  );
  const after = new Date(proposal.proposal.visits.moves[0]!.start);
  expect(new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone: "America/Chicago" }).format(after))
    .toBe(new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone: "America/Chicago" }).format(at));
  await expect(moving.getByRole("row").filter({ hasText: customer })).toContainText(words(at));
  await expect(moving.getByRole("row").filter({ hasText: customer })).toContainText(words(after));

  await schedule.getByRole("button", { name: "Apply to the schedule" }).click();
  const moved = owner.getByRole("table", { name: "Visits moved" });
  await expect(moved.getByRole("row").filter({ hasText: customer })).toContainText(words(after));
  await expect(owner.getByText(/days were put on the schedule on/)).toBeVisible();

  const job = await api<{ visits: { windowStart: string }[] }>(owner, "get", `/v1/jobs/${fixturesJob}`);
  expect(job.visits.map((v) => new Date(v.windowStart).getTime())).toContain(after.getTime());
});
