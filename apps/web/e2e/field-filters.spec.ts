import { test, expect, run } from "./fixtures";

/**
 * NARROWING THE CUSTOMER BOOK BY TWO OF THE COMPANY'S OWN FIELDS
 *
 * "Customers on the Annual plan who have pets" is two fields, and both have
 * to hold. Driven the way the office does it: pick a field and a value, then
 * add a second, then take the first one off again, with the address carrying
 * every step so the list is a link somebody can send. The fields and the
 * customers are made through the API, because declaring a field is not what
 * this is about.
 */
test("the customer list is filtered by two custom fields at once, and one comes off again", async ({ owner }) => {
  const defined: string[] = [];
  const plan = `Plan ${run}`;
  const pets = `Pets ${run}`;
  try {
    for (const field of [
      { entityType: "customer", key: `plan_${run}`, label: plan, dataType: "select", options: ["Annual", "Monthly"] },
      { entityType: "customer", key: `pets_${run}`, label: pets, dataType: "boolean" },
    ]) {
      const made = await owner.request.post("/api/v1/custom-fields", { data: field });
      expect(made.ok()).toBe(true);
      defined.push((await made.json() as { id: string }).id);
    }
    const households = [
      { name: `Annie Annual ${run}`, values: { [`plan_${run}`]: "Annual", [`pets_${run}`]: true } },
      { name: `Albert Annual ${run}`, values: { [`plan_${run}`]: "Annual", [`pets_${run}`]: false } },
      { name: `Molly Monthly ${run}`, values: { [`plan_${run}`]: "Monthly", [`pets_${run}`]: true } },
    ];
    for (const household of households) {
      const made = await owner.request.post("/api/v1/customers", {
        data: { type: "residential", name: household.name, customFields: household.values },
      });
      expect(made.ok()).toBe(true);
    }
    const [annie, albert, molly] = households.map((h) => h.name) as [string, string, string];
    const listed = (name: string) => owner.getByRole("row").filter({ hasText: name });

    await owner.goto("/customers");
    const filter = owner.getByRole("form", { name: "Filter by a custom field" });
    await filter.locator("select[name=field]").selectOption({ label: plan });
    await filter.getByLabel("Is").fill("Annual");
    await filter.getByRole("button", { name: "Filter" }).click();
    await expect(owner.getByText(`Showing customers whose ${plan} is Annual.`)).toBeVisible();
    await expect(listed(annie)).toBeVisible();
    await expect(listed(albert)).toBeVisible();
    await expect(listed(molly)).toHaveCount(0);

    // A second field is added to the first, not put in its place.
    await filter.locator("select[name=field]").selectOption({ label: pets });
    await filter.getByLabel("Is").fill("yes");
    await filter.getByRole("button", { name: "Add this filter" }).click();
    await expect(owner.getByText(`Showing customers whose ${plan} is Annual, and whose ${pets} is yes.`)).toBeVisible();
    await expect(listed(annie)).toBeVisible();
    await expect(listed(albert)).toHaveCount(0);
    await expect(listed(molly)).toHaveCount(0);
    const address = new URL(owner.url());
    expect(address.searchParams.getAll("field")).toEqual([`plan_${run}`, `pets_${run}`]);
    expect(address.searchParams.getAll("value")).toEqual(["Annual", "yes"]);

    // The address is the filter: opened fresh, it is the same list.
    await owner.goto(address.toString());
    await expect(listed(annie)).toBeVisible();
    await expect(listed(albert)).toHaveCount(0);

    // Taking the plan off leaves everybody with pets.
    await owner.getByRole("link", { name: `Stop filtering by ${plan}` }).click();
    await expect(owner.getByText(`Showing customers whose ${pets} is yes.`)).toBeVisible();
    await expect(listed(annie)).toBeVisible();
    await expect(listed(molly)).toBeVisible();
    await expect(listed(albert)).toHaveCount(0);

    // A field nobody declared is said in words above an unfiltered list, never an error page.
    await owner.goto(`/customers?field=plan_${run}&value=Annual&field=nothing_${run}&value=x`);
    await expect(owner.getByRole("alert").filter({ hasText: `no customer field called "nothing_${run}"` })).toBeVisible();
    await expect(listed(molly)).toBeVisible();
  } finally {
    for (const id of defined) await owner.request.delete(`/api/v1/custom-fields/${id}?force=true`);
  }
});
