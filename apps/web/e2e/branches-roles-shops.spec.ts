import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A ROLE THAT NEEDS THE WHOLE COMPANY, AND WHERE A VISIT GOES OUT FROM
 *
 * A role that names no scope is how the roles screen saved "the whole
 * company" before it wrote that choice out, so the screen lists it, says
 * what it has been doing, and fixes it only when the owner ticks that this
 * is what it was for. And a visit given to a crew based at a shop says on
 * the job which shop it goes out from.
 *
 * The role, the shop, the crew and the job are made through the API,
 * because they are not what is being tested.
 */
test("the roles screen lists a role that names no scope and gives it the whole company once the owner confirms", async ({ owner }) => {
  const name = `Old office ${run}`;
  const made = await owner.request.post("/api/v1/roles", {
    data: { name, basedOn: "office_manager", permissions: ["job:read", "customer:read"] },
  });
  expect(made.ok()).toBe(true);

  await owner.goto("/settings/roles");
  const check = owner.getByRole("region", { name: "Roles to check" });
  await expect(check).toContainText("have been seeing only their own work");
  const button = check.getByRole("button", { name: `Give ${name} the whole company` });
  await expect(button).toBeVisible();

  // Nothing happens without the tick: the box is required.
  await button.click();
  await expect(check.getByRole("button", { name: `Give ${name} the whole company` })).toBeVisible();
  const roles = await (await owner.request.get("/api/v1/roles")).json() as { roles: { name: string; namesNoScope: boolean }[] };
  expect(roles.roles.find((r) => r.name === name)?.namesNoScope).toBe(true);

  await check.getByLabel(`Yes, people with ${name} should see every job, customer, invoice and report.`).check();
  await check.getByRole("button", { name: `Give ${name} the whole company` }).click();

  // Fixed: it leaves the roles to check, and its row says what its holders now see.
  const row = owner.getByRole("row").filter({ hasText: name });
  await expect(row).toContainText("The whole company");
  await expect(owner.getByRole("button", { name: `Give ${name} the whole company` })).toHaveCount(0);
  await owner.reload();
  await expect(row).toContainText("The whole company");
  await expect(row).not.toContainText("Check this");
});

test("a visit sent to a crew based at a shop says on the job that it goes out from there", async ({ owner }) => {
  const shopName = `East yard ${run}`;
  const shop = await owner.request.post("/api/v1/locations", { data: { name: shopName } });
  expect(shop.ok()).toBe(true);
  const shopId = (await shop.json() as { id: string }).id;
  const crew = await owner.request.post("/api/v1/crews", { data: { name: `East crew ${run}`, homeLocationId: shopId } });
  expect(crew.ok()).toBe(true);
  const crewId = (await crew.json() as { id: string }).id;

  const customerId = await newCustomer(owner, {
    name: `Shop Customer ${run}`, address: { street: "7 Yard Way", city: "Austin", state: "TX", zip: "78702" },
  });
  const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}`);
  const propertyId = ((await places.json()) as { data: { id: string }[] }).data[0]!.id;
  const job = await owner.request.post("/api/v1/jobs", { data: { customerId, propertyId, summary: `Fence run ${run}` } });
  expect(job.ok()).toBe(true);
  const jobId = (await job.json() as { id: string }).id;
  const start = new Date(Date.now() + 2 * 86_400_000);
  const visit = await owner.request.post(`/api/v1/jobs/${jobId}/visits`, {
    data: {
      windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 3 * 3600_000).toISOString(),
      technicianIds: [], crewId,
    },
  });
  expect(visit.ok()).toBe(true);
  expect((await visit.json() as { locationName: string | null }).locationName).toBe(shopName);

  await owner.goto(`/jobs/${jobId}`);
  await expect(owner.getByText(`From ${shopName}`)).toBeVisible();
});
