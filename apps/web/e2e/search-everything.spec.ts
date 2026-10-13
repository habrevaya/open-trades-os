import { test, expect, run, newCustomer } from "./fixtures";

/**
 * FIND ANYTHING, ON THE SCREENS
 *
 * The office types two words into the box at the top of every screen and
 * finds the job by what it was and the address by its street, five of each,
 * with "See all" opening the job list filtered by the same words. The
 * technician typing the same words finds nothing, because they were never
 * sent there: the box shows only what their own lists would.
 */

const street = `${run} Quince St`;

test("The search box finds jobs by their words and addresses by street, See all opens the filtered list, and the technician finds none of it", async ({ owner, tech, errors }) => {
  const customerId = await newCustomer(owner, {
    name: `Zinnia Search ${run}`,
    address: { street, city: "Austin", state: "TX", zip: "78701" },
  });
  const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}&limit=5`);
  expect(places.ok()).toBe(true);
  const propertyId = (await places.json() as { data: Array<{ id: string }> }).data[0]!.id;
  for (let n = 1; n <= 6; n += 1) {
    const made = await owner.request.post("/api/v1/jobs", {
      headers: { "idempotency-key": `search-${run}-${n}` },
      data: { customerId, propertyId, summary: `Quince boiler ${run} visit ${n}` },
    });
    expect(made.ok(), await made.text()).toBe(true);
  }

  await owner.goto("/jobs");
  const box = owner.locator('input[aria-label="Find anything"]:visible');
  await box.fill(`QUINCE ${run}`);
  await box.press("Enter");
  await expect(owner).toHaveURL(/\/search\?q=/);

  const jobs = owner.getByRole("region", { name: "Jobs" });
  await expect(jobs.getByRole("link")).toHaveCount(6);
  await expect(jobs.getByRole("listitem")).toHaveCount(5);
  await expect(jobs).toContainText(`Zinnia Search ${run}`);
  await expect(owner.getByRole("region", { name: "Addresses" })).toContainText(street);

  await jobs.getByRole("link", { name: /^See all jobs matching/ }).click();
  await expect(owner).toHaveURL(/\/jobs\?q=/);
  await expect(owner.getByRole("searchbox", { name: "Search jobs" })).toHaveValue(`QUINCE ${run}`);
  await expect(owner.getByRole("table")).toContainText(`Quince boiler ${run} visit 6`);
  await expect(owner.getByRole("table").getByRole("row")).toHaveCount(7);

  // The technician was never sent to any of these, so the same words find nothing.
  await tech.goto(`/search?q=${encodeURIComponent(`quince ${run}`)}`);
  await expect(tech.getByText("Nothing found")).toBeVisible();
  await expect(tech.getByText(street)).toHaveCount(0);
  expect(errors).toEqual([]);
});
