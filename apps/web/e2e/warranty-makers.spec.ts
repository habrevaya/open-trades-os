import { test, expect, run, newCustomer } from "./fixtures";

/**
 * MAKERS WITH THEIR OWN REGISTRATION DAYS, AND TAKING A REGISTRATION BACK
 *
 * A maker is written down once with its days; a price book item says which maker
 * it comes from; and a registration recorded by mistake is taken back from the
 * unit's page, for a reason, which is kept.
 */
test("Makers: write one down, name it on an item, and take a registration back from a unit", async ({ owner, errors }) => {
  const maker = `Rheem Test ${run}`;
  await owner.goto("/pricebook/makers");
  await owner.getByLabel("Name", { exact: true }).last().fill(maker);
  await owner.getByLabel("Days to register", { exact: true }).fill("60");
  await owner.getByRole("button", { name: "Add maker" }).click();
  const table = owner.getByRole("table", { name: "Makers" });
  await expect(table.getByRole("row", { name: new RegExp(maker) })).toContainText("60");

  // A name already used is refused in words.
  await owner.getByLabel("Name", { exact: true }).last().fill(maker.toLowerCase());
  await owner.getByRole("button", { name: "Add maker" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "There is already a maker called" })).toBeVisible();

  // An item names it.
  const code = `MK-${run}`.toUpperCase();
  const created = await owner.request.post("/api/v1/pricebook/items", {
    data: { kind: "equipment", code, name: `Water heater ${run}`, price: "900.00", warrantyRegistrationDays: 30 },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const itemId = (await created.json() as { id: string }).id;
  await owner.goto(`/pricebook/items/${itemId}`);
  await owner.getByLabel("Maker it comes from").selectOption({ label: `${maker}, 60 days` });
  await owner.getByRole("button", { name: "Save", exact: true }).last().click();
  await expect(owner.getByText("Saved. No version was written")).toBeVisible();
  const read = await owner.request.get(`/api/v1/pricebook/items/${itemId}`);
  expect((await read.json() as { warrantyMakerId: string | null }).warrantyMakerId).not.toBeNull();

  // The maker cannot be taken off the list while the item names it.
  await owner.goto("/pricebook/makers");
  const row = owner.getByRole("table", { name: "Makers" }).getByRole("row", { name: new RegExp(maker) });
  await row.getByText("Change").click();
  await row.getByRole("button", { name: "Take it off the list" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "One item still comes from" })).toBeVisible();

  // A registration recorded on a unit is taken back, with a reason.
  const customerId = await newCustomer(owner, {
    name: `Maker Unit ${run}`, address: { street: `${run} Maker Way`, city: "Austin", state: "TX", zip: "78701" },
  });
  const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}&limit=5`);
  const propertyId = (await places.json() as { data: Array<{ id: string }> }).data[0]!.id;
  const unit = await owner.request.post("/api/v1/equipment", {
    data: { propertyId, category: "water heater", manufacturer: "Rheem", serialNumber: `MKU${run}`.toUpperCase() },
  });
  expect(unit.ok(), await unit.text()).toBe(true);
  const unitId = (await unit.json() as { id: string }).id;
  const recorded = await owner.request.post(`/api/v1/equipment/${unitId}/warranty-registration`, {
    data: { reference: "WRONG-1" },
  });
  expect(recorded.ok(), await recorded.text()).toBe(true);

  await owner.goto(`/equipment/${unitId}`);
  const section = owner.getByRole("region", { name: "Warranty registration" });
  await expect(section).toContainText("reference WRONG-1");
  await section.getByText("It was not registered after all").click();
  await section.getByLabel("Why").fill("It was the unit next door");
  await section.getByRole("button", { name: "Take it back and reopen the deadline" }).click();
  // The page is drawn again without the registration, so the form that took it back is gone with it.
  await expect(owner.getByRole("region", { name: "Warranty registration" })).toContainText("Nothing recorded");
  await expect(owner.getByRole("region", { name: "Warranty registration" })).not.toContainText("WRONG-1");
  expect(errors).toEqual([]);
});
