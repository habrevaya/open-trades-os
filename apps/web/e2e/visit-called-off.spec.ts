import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A VISIT CALLED OFF SAYS WHO ASKED, AND WHEN
 *
 * Cleaning's cancellation rate counts a customer's late cancellation and leaves
 * the company's own out, so calling off a visit asks which, and the company's
 * notice window is set once on Settings and frozen on each visit called off.
 */

async function api<T>(page: Page, method: "get" | "post" | "patch", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("a visit called off from its page says the customer asked, inside the notice window the company set", async ({ owner }) => {
  await owner.goto("/settings");
  const notice = owner.getByRole("region", { name: "Late cancellations" });
  await notice.getByLabel("Hours of notice").fill("48");
  await notice.getByRole("button", { name: "Save" }).click();
  await expect(notice.getByText(/less than 48 hours before the visit/)).toBeVisible();

  try {
    const customerId = await newCustomer(owner, {
      name: `Called Off Cleo ${run}`, address: { street: `${run.slice(-4)} Linen Ln`, city: "Austin", state: "TX", zip: "78704" },
    });
    const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${customerId}`);
    /** A day and a bit from now: inside a two day notice window. */
    const start = new Date(Date.now() + 30 * 3_600_000);
    const job = await api<{ id: string; visits: { id: string }[] }>(owner, "post", "/v1/jobs", {
      customerId, propertyId: data[0]!.id, summary: `Weekly clean ${run}`,
      visit: { windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 2 * 3_600_000).toISOString() },
    });
    const visitId = job.visits[0]!.id;

    await owner.goto(`/visits/${visitId}`);
    await owner.getByText("Call off this visit").click();
    /** Who asked has no default: pressing without choosing is refused. */
    await owner.getByRole("button", { name: "Call it off" }).click();
    await owner.getByLabel("Who asked").selectOption("customer");
    await owner.getByRole("button", { name: "Call it off" }).click();
    /** The page comes back with the visit cancelled, saying who asked and that it was late. */
    await expect(owner.getByText(/The customer asked, .*, inside the 48 hour notice window/)).toBeVisible();
    await expect(owner.getByText("Call off this visit")).toHaveCount(0);

    const visit = await api<{ status: string; cancellation: { by: string; noticeHours: number; late: boolean } }>(
      owner, "get", `/v1/visits/${visitId}`);
    expect(visit.status).toBe("cancelled");
    expect(visit.cancellation).toMatchObject({ by: "customer", noticeHours: 48, late: true });
  } finally {
    await api(owner, "patch", "/v1/cancellation-notice", { hours: 24 });
  }
});
