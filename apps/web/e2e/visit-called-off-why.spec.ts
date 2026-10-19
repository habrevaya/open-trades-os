import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * A DAY THE COMPANY CALLED OFF SAYS WHY
 *
 * Calling off a visit asks who asked. Choosing "We called it off" asks why, from
 * a fixed list, and "something else" asks for words; choosing the customer asks
 * nothing. The reason shows on the visit. Cancelling a job with its visits asks
 * the same once and puts the one reason on every visit it calls off.
 */
async function api<T>(page: Page, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

const plus = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function aJob(owner: Page, name: string, street: string, visitDays: number[]) {
  const customerId = await newCustomer(owner, {
    name, address: { street, city: "Austin", state: "TX", zip: "78704" },
  });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
  const first = new Date(`${plus(companyToday(), visitDays[0]!)}T15:00:00Z`);
  const job = await api<{ id: string; visits: { id: string }[] }>(owner, "post", "/v1/jobs", {
    customerId, propertyId: data[0]!.id, summary: `Weekly clean ${run}`,
    visit: { windowStart: first.toISOString(), windowEnd: new Date(first.getTime() + 2 * 3_600_000).toISOString() },
  });
  const visitIds = [job.visits[0]!.id];
  for (const days of visitDays.slice(1)) {
    const at = new Date(`${plus(companyToday(), days)}T15:00:00Z`);
    const added = await api<{ id: string }>(owner, "post", `/v1/jobs/${job.id}/visits`, {
      windowStart: at.toISOString(), windowEnd: new Date(at.getTime() + 2 * 3_600_000).toISOString(),
    });
    visitIds.push(added.id);
  }
  return { id: job.id, visitIds };
}

test("a visit the company calls off asks why, and the visit says so", async ({ owner }) => {
  test.setTimeout(90_000);
  const job = await aJob(owner, `Rained Out Rhea ${run}`, `${run.slice(-4)} Gutter Ln`, [9]);
  const visitId = job.visitIds[0]!;

  await owner.goto(`/visits/${visitId}`);
  await owner.getByText("Call off this visit").click();

  /** The customer is never asked why. */
  await owner.getByLabel("Who asked").selectOption("customer");
  await expect(owner.getByLabel("Why we called it off")).toHaveCount(0);

  /** The company is, from a fixed list, and "something else" wants words. */
  await owner.getByLabel("Who asked").selectOption("company");
  const why = owner.getByLabel("Why we called it off");
  await expect(why.locator("option")).toHaveText(["Choose", "Rain or weather", "Crew short", "Equipment", "Something else"]);
  await why.selectOption("other");
  await expect(owner.getByLabel("What was the reason?")).toBeVisible();
  await owner.getByLabel("What was the reason?").fill("The van was stolen");
  await owner.getByRole("button", { name: "Call it off" }).click();

  await expect(owner.getByText(/We called it off, .*\. Something else: The van was stolen/)).toBeVisible();
  const visit = await api<{ cancellation: { by: string; reason: { code: string; words: string } | null } }>(
    owner, "get", `/v1/visits/${visitId}`);
  expect(visit.cancellation).toMatchObject({ by: "company", reason: { code: "other", words: "Something else: The van was stolen" } });
});

test("cancelling a job with its visits puts the company's one reason on each of them", async ({ owner }) => {
  test.setTimeout(90_000);
  const job = await aJob(owner, `Iced In Ivan ${run}`, `${run.slice(-4)} Frost Ct`, [9, 10]);

  await owner.goto(`/jobs/${job.id}`);
  await owner.getByText("Cancel this job").click();
  await owner.getByLabel("Who asked to call them off").selectOption("company");
  /** Not choosing a reason is refused in words. */
  await owner.getByRole("button", { name: "Cancel the job" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "Say why we called the visits off" })).toBeVisible();

  await owner.getByLabel("Why we called it off").selectOption("weather");
  await owner.getByLabel("More about it, if you like").fill("Ice storm");
  await owner.getByRole("button", { name: "Cancel the job" }).click();
  await expect(owner.getByText("Cancel this job")).toHaveCount(0);

  for (const id of job.visitIds) {
    const visit = await api<{ status: string; cancellation: { by: string; reason: { words: string } | null } }>(owner, "get", `/v1/visits/${id}`);
    expect(visit.status).toBe("cancelled");
    expect(visit.cancellation).toMatchObject({ by: "company", reason: { words: "Rain or weather: Ice storm" } });
  }
});
