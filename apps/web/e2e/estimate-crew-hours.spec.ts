import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A JOB'S CREW HOUR BUDGET FROM ITS ESTIMATE
 *
 * A labour item in the price book is marked as counted in crew hours. An
 * estimate is written with a line of it and a second crew typed by hand, and
 * with an optional line the customer leaves alone. Converting the approved
 * estimate budgets the job with the hours the customer took, and the job's
 * page says where the figure came from. The office can still change it.
 */
test("converting an approved estimate budgets the job in crew hours, and the job says so", async ({ owner }) => {
  test.setTimeout(120_000);
  const code = `CREW${run.slice(-6).toUpperCase()}`;
  await owner.goto("/pricebook/items/new");
  await owner.getByLabel("Kind").selectOption("labor");
  await owner.getByLabel("Code").fill(code);
  await owner.getByLabel("Name").fill(`Install crew ${run}`);
  await owner.getByLabel("Price").fill("65.00");
  await owner.getByLabel(/Its quantity is crew hours/).check();
  await owner.getByRole("button", { name: "Add to the price book" }).click();
  await expect(owner).toHaveURL(/\/pricebook\/items\/[0-9a-f-]{36}$/);
  await expect(owner.getByText("Counted in crew hours")).toBeVisible();
  const itemId = owner.url().split("/").pop()!;

  const customerId = await newCustomer(owner, {
    name: `Crew Hours ${run}`, address: { street: `${run.slice(-4)} Elm St`, city: "Austin", state: "TX", zip: "78704" },
  });
  const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}`);
  const propertyId = ((await places.json()) as { data: { id: string }[] }).data[0]!.id;
  const made = await owner.request.post("/api/v1/estimates", {
    data: {
      customerId, propertyId, title: `Stone wall ${run}`,
      options: [{
        name: "Standard", isRecommended: true, lines: [
          { priceBookItemId: itemId, name: "Install crew", quantity: "16", unitPrice: "0", discountAmount: "0", taxable: false },
          { name: "Second crew, hand typed", quantity: "8", unitPrice: "520.00", quantityIsCrewHours: true, discountAmount: "0", taxable: false },
          { name: "Edging, not wanted", quantity: "5", unitPrice: "325.00", quantityIsCrewHours: true, discountAmount: "0", taxable: false, isOptional: true },
          { name: "Stone", quantity: "20", unitPrice: "40.00", discountAmount: "0", taxable: false },
        ],
      }],
    },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const estimate = (await made.json()) as { id: string; number: number; options: { id: string }[] };

  const approved = await owner.request.post(`/api/v1/estimates/${estimate.id}/approve`, {
    data: { optionId: estimate.options[0]!.id, selectedLineIds: [], signerName: "Crew Hours", capturedVia: "in_person" },
  });
  expect(approved.ok(), await approved.text()).toBe(true);

  await owner.goto(`/estimates/${estimate.id}`);
  await owner.getByRole("button", { name: "Convert to job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);

  const crew = owner.getByRole("region", { name: "Crew hours" });
  await expect(crew).toContainText("Budgeted 24 crew hours, added up from the crew hour lines of");
  await expect(crew.getByRole("link", { name: `estimate ${estimate.number}` })).toBeVisible();

  /** Still the office's to change before the first punch, and then it is theirs. */
  await crew.getByLabel("Crew hours budgeted (people times hours, with the drive)").fill("30");
  await crew.getByRole("button", { name: "Save the budget" }).click();
  await expect(crew).toContainText("Budgeted 30 crew hours.");
  await expect(crew).not.toContainText("added up from");
});
