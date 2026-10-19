import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A TYPO IN THE SEARCH BOX
 *
 * The office types "furnice" with a customer on the phone. The furnace job is
 * found anyway, after anything spelled exactly that way, and the page says it
 * is close to what was typed rather than what was typed. A customer's note is
 * found the same way, in its own group, linking to the customer.
 */
test("the search box finds the furnace job and a customer's note through a typo, and says so", async ({ owner, errors }) => {
  const name = `Ingrid Search ${run}`;
  const customerId = await newCustomer(owner, {
    name,
    address: { street: `${run} Larch Lane`, city: "Austin", state: "TX", zip: "78701" },
  });
  const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}&limit=5`);
  expect(places.ok()).toBe(true);
  const propertyId = (await places.json() as { data: Array<{ id: string }> }).data[0]!.id;
  const made = await owner.request.post("/api/v1/jobs", {
    headers: { "idempotency-key": `search-close-${run}` },
    data: { customerId, propertyId, summary: `Furnace tune up ${run}` },
  });
  expect(made.ok(), await made.text()).toBe(true);

  await owner.goto(`/customers/${customerId}`);
  const notes = owner.getByRole("region", { name: "Notes" });
  await notes.getByLabel("New note").fill(`Thermostat is behind the coat rack ${run}`);
  await notes.getByRole("button", { name: "Add note" }).click();
  await expect(notes.getByRole("listitem").filter({ hasText: `behind the coat rack ${run}` })).toBeVisible();

  await owner.goto(`/search?q=${encodeURIComponent(`${run} furnice`)}`);
  const jobs = owner.getByRole("region", { name: "Jobs" });
  /**
   * Other specs in the same run make furnace jobs with the run in them too, so
   * the one this test made is found by its words rather than by being alone.
   */
  const ours = jobs.getByRole("listitem").filter({ hasText: `Furnace tune up ${run}` });
  await expect(ours).toHaveCount(1);
  await expect(ours).toContainText("Close to what you typed");

  await owner.goto(`/search?q=${encodeURIComponent(`${run} thermstat`)}`);
  const found = owner.getByRole("region", { name: "Customer notes" });
  await expect(found).toContainText(`behind the coat rack ${run}`);
  await expect(found).toContainText("Close to what you typed");
  await found.getByRole("link", { name }).click();
  await expect(owner.getByRole("heading", { level: 1, name })).toBeVisible();
  expect(errors).toEqual([]);
});
