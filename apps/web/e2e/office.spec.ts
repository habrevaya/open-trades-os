import { test, expect, run, newCustomer } from "./fixtures";

/**
 * THE OFFICE: TAGS, DUPLICATES, PRICES, WARRANTIES AND THE QUEUE'S OWN RULES
 *
 * Each driven the way a person meets it, on the screens. The API is used
 * only where a step has no screen: registering a unit on an address, and
 * creating a price book item.
 */

/** A calendar day, some days from today, as the API takes it. */
const daysFromNow = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

test("a tag goes on a customer, filters the list, and is renamed across the book", async ({ owner }) => {
  const name = `Tara Tagged ${run}`;
  const id = await newCustomer(owner, { name });
  const tag = `storm${run}`;

  await owner.getByLabel("New tag").fill(tag);
  await owner.getByRole("button", { name: "Add tag" }).click();
  const tags = owner.getByRole("region", { name: "Tags" });
  await expect(tags.getByRole("link", { name: tag })).toBeVisible();

  await tags.getByRole("link", { name: tag }).click();
  await expect(owner).toHaveURL(new RegExp(`/customers\\?tag=${tag}`));
  await expect(owner.getByRole("link", { name })).toBeVisible();

  await owner.goto("/customers/tags");
  await owner.getByLabel(`New name for ${tag}`).fill(`Storm list ${run}`);
  await owner.getByRole("row", { name: new RegExp(tag) }).getByRole("button", { name: "Rename" }).click();
  const renamed = owner.getByRole("table", { name: "Tags in use" }).getByRole("row", { name: new RegExp(`Storm list ${run}`) });
  await expect(renamed).toContainText("1");
  await expect(owner.getByRole("table", { name: "Tags in use" }).getByRole("link", { name: tag, exact: true })).toHaveCount(0);

  await owner.goto(`/customers/${id}`);
  await expect(owner.getByRole("region", { name: "Tags" }).getByRole("link", { name: `Storm list ${run}` })).toBeVisible();
});

test("likely duplicates across the book: one pair set aside, one merged", async ({ owner }) => {
  const digits = String(Date.now()).slice(-7);
  const phoneA = `+1512${digits}`;
  const phoneB = `+1737${digits}`;
  const make = async (name: string, phone: string) => {
    const made = await owner.request.post("/api/v1/customers", {
      data: { type: "residential", name, phone },
    });
    expect(made.ok()).toBe(true);
  };
  await make(`Aardvark Landlord ${run}`, phoneA);
  await make(`Aardvark Tenant ${run}`, phoneA);
  await make(`Aaberg Robert ${run}`, phoneB);
  await make(`Aaberg Bob ${run}`, phoneB);

  await owner.goto("/customers/duplicates");
  /**
   * The pair by BOTH names. A record from an earlier run of this suite has a
   * name close enough to this run's to be a likely duplicate of it too, so
   * one name alone can match two rows on a database that is not fresh.
   */
  const landlordPair = owner.getByRole("listitem")
    .filter({ hasText: `Aardvark Landlord ${run}` }).filter({ hasText: `Aardvark Tenant ${run}` });
  await expect(landlordPair).toContainText("Same phone number");
  await landlordPair.getByRole("textbox").fill("Landlord and tenant");
  await landlordPair.getByRole("button", { name: "Not the same person" }).click();
  await expect(landlordPair).toHaveCount(0);

  const bobPair = owner.getByRole("listitem")
    .filter({ hasText: `Aaberg Robert ${run}` }).filter({ hasText: `Aaberg Bob ${run}` });
  await bobPair.getByRole("button", { name: `Keep Aaberg Robert ${run}, merge the other in` }).click();
  // Merged, so the pair is no longer a pair; the kept record is still a customer.
  await expect(bobPair).toHaveCount(0);
  await owner.goto(`/customers?q=${encodeURIComponent(`Aaberg Robert ${run}`)}`);
  await expect(owner.getByRole("link", { name: `Aaberg Robert ${run}` })).toBeVisible();
  await owner.goto(`/customers?q=${encodeURIComponent(`Aaberg Bob ${run}`)}`);
  await expect(owner.getByRole("link", { name: `Aaberg Bob ${run}` })).toHaveCount(0);
});

test("a category is added, and a price change is previewed, applied and undone", async ({ owner }) => {
  await owner.goto("/pricebook/categories");
  const shelf = `Shelf ${run}`;
  await owner.getByRole("region", { name: "Add a category" }).getByLabel("Name").fill(shelf);
  await owner.getByRole("button", { name: "Add category" }).click();
  await expect(owner.getByRole("table", { name: "Categories" }).getByRole("link", { name: shelf })).toBeVisible();

  const code = `E2E-${run}`.toUpperCase();
  const item = await owner.request.post("/api/v1/pricebook/items", {
    data: { kind: "service", code, name: `Coil clean ${run}`, price: "100.00", cost: "40.00" },
  });
  expect(item.ok()).toBe(true);

  await owner.goto(`/pricebook/changes?q=${code}&mode=percent&value=10&ending=95`);
  const preview = owner.getByRole("region", { name: "Preview" });
  await expect(preview.getByRole("heading")).toHaveText("Up 10%, rounded up to the next .95");
  const row = preview.getByRole("row", { name: new RegExp(code) });
  await expect(row).toContainText("$100.00");
  await expect(row).toContainText("$110.95");
  await expect(row).toContainText("60.0%");
  await owner.getByRole("button", { name: "Apply these prices" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "prices changed" }).or(owner.getByRole("status").filter({ hasText: "price changed" })))
    .toContainText("1 price changed");

  await owner.goto(`/pricebook?q=${code}`);
  await expect(owner.getByRole("row", { name: new RegExp(code) })).toContainText("$110.95");

  await owner.goto("/pricebook/changes");
  const change = owner.getByRole("table", { name: "Changes made" })
    .getByRole("row", { name: /Up 10%, rounded up to the next \.95/ }).first();
  await change.getByRole("button", { name: "Undo" }).click();
  await expect(owner.getByRole("heading", { level: 1 })).toHaveText("Undid \"Up 10%, rounded up to the next .95\"");
  await expect(owner.getByRole("table", { name: "Prices" }).getByRole("row", { name: new RegExp(code) }))
    .toContainText("$100.00");

  await owner.goto(`/pricebook?q=${code}`);
  await expect(owner.getByRole("row", { name: new RegExp(code) })).toContainText("$100.00");
});

test("a lapsing warranty is on the watch, by customer, and a follow up goes in the queue once", async ({ owner }) => {
  const name = `Wanda Warranty ${run}`;
  const customerId = await newCustomer(owner, {
    name, address: { street: "4 Cover Court", city: "Austin", state: "TX", zip: "78701" },
  });
  const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}`);
  const propertyId = ((await places.json()) as { data: { id: string }[] }).data[0]!.id;
  const unit = await owner.request.post("/api/v1/equipment", {
    data: {
      propertyId, category: "furnace", manufacturer: "Carrier", model: `W${run}`,
      warrantyPartsExpiresOn: daysFromNow(10),
    },
  });
  expect(unit.ok()).toBe(true);

  await owner.goto("/customers/warranties?view=30");
  const theirs = owner.getByRole("region", { name });
  await expect(theirs).toContainText("4 Cover Court");
  // Ten days in UTC, which is ten or eleven in the company's own calendar depending on the hour.
  await expect(theirs).toContainText(/Ends in 1[01] days/);
  await expect(theirs.getByRole("link", { name: "Estimate a replacement" })).toBeVisible();
  await theirs.getByRole("button", { name: "Raise a follow up task" }).click();
  // The button gives way to the fact, so a second press is not offered.
  await expect(theirs).toContainText("A follow up is already in the task queue.");
  await expect(theirs.getByRole("button", { name: "Raise a follow up task" })).toHaveCount(0);

  // And the task opens the unit's own page.
  const unitId = (await unit.json() as { id: string }).id;
  await owner.goto("/tasks?view=all");
  const task = owner.getByRole("listitem").filter({ hasText: `Warranty: Carrier W${run} at 4 Cover Court` });
  await expect(task.getByRole("link", { name: "Open the unit" })).toHaveAttribute("href", `/equipment/${unitId}`);
});

test("a task with a checklist closes only when ticked or with a reason, and the queue's rules are set", async ({ owner }) => {
  const title = `Open the shop ${run}`;
  await owner.goto("/tasks");
  await owner.getByText("Add a task").click();
  await owner.getByLabel("What needs doing").fill(title);
  await owner.getByLabel("Checklist, one item a line").fill("Alarm off\nLights on");
  await owner.getByRole("button", { name: "Add task" }).click();
  const queued = owner.getByRole("listitem").filter({ hasText: title });
  await expect(queued).toContainText("0 of 2 ticked");

  await queued.getByRole("link", { name: title }).click();
  await expect(owner.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await owner.getByRole("button", { name: "Tick Alarm off" }).click();
  await expect(owner.getByRole("button", { name: "Untick Alarm off" })).toBeVisible();

  const close = owner.getByRole("region", { name: "Close it" });
  await close.getByLabel("What happened").first().fill("Opened up");
  await close.getByLabel("Why it is done with items unticked").fill("Bulb gone in the yard light");
  await close.getByRole("button", { name: "Done" }).click();
  await expect(owner.getByText("Bulb gone in the yard light")).toBeVisible();

  await owner.goto("/tasks/recurring");
  await owner.getByLabel("What needs doing").fill(`Check the vans ${run}`);
  await owner.getByLabel("How often").selectOption("weekly");
  await owner.getByLabel("On (weekly)").selectOption("1");
  await owner.getByLabel("Checklist, one item a line").fill("Tyres\nOil");
  await owner.getByRole("button", { name: "Add recurring task" }).click();
  await expect(owner.getByRole("row", { name: new RegExp(`Check the vans ${run}`) })).toContainText("Every Monday");

  await owner.goto("/tasks/escalation");
  await owner.getByLabel("Name", { exact: true }).fill(`Late call backs ${run}`);
  await owner.getByLabel("Hours late").fill("4");
  await owner.getByLabel("Tell").selectOption("role");
  await owner.getByLabel("Role (if a role)").selectOption("office_manager");
  await owner.getByRole("button", { name: "Add rule" }).click();
  await expect(owner.getByRole("row", { name: new RegExp(`Late call backs ${run}`) }))
    .toContainText("When a task is 4 hours late, tell the office managers.");
});
