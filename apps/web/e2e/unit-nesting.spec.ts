import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A UNIT'S PAGE EDITS WHAT IT IS INSIDE AND ITS OTHER DETAILS
 *
 * A riser holds a valve and the valve holds a gauge. From the riser's page, putting
 * it inside the gauge (three steps down) is refused in words and moves nothing;
 * the picker never offers the unit itself or anything inside it. From the gauge's
 * page it is put inside another unit, given other details a line at a time, and
 * taken out again, and the API says the same as the screen.
 */
test("a unit is nested, given details and taken out from its own page, and a loop is refused", async ({ owner }) => {
  const customerId = await newCustomer(owner, {
    name: `Nell Nester ${run}`, address: { street: "3 Pipe Lane", city: "Austin", state: "TX", zip: "78703" },
  });
  const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}`);
  const propertyId = ((await places.json()) as { data: { id: string }[] }).data[0]!.id;
  const make = async (tag: string, parentEquipmentId?: string) => {
    const response = await owner.request.post("/api/v1/equipment", {
      data: { propertyId, category: "plumbing", tag: `${tag} ${run}`, serialNumber: `${tag}${run}`.toUpperCase(), ...(parentEquipmentId ? { parentEquipmentId } : {}) },
    });
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { id: string }).id;
  };
  const riser = await make("Riser");
  const valve = await make("Valve", riser);
  const gauge = await make("Gauge", valve);
  const spare = await make("Spare");

  // The riser's picker offers the spare and nothing inside the riser or the riser itself.
  await owner.goto(`/equipment/${riser}`);
  await owner.getByText("Correct its details", { exact: true }).click();
  const inside = owner.getByLabel("It is inside");
  await expect(inside.getByRole("option", { name: `Spare ${run}` })).toHaveCount(1);
  for (const gone of ["Riser", "Valve", "Gauge"]) {
    await expect(inside.getByRole("option", { name: `${gone} ${run}` })).toHaveCount(0);
  }

  // The service still refuses a loop the screen did not offer, in words (the API route, as another caller would).
  const loop = await owner.request.patch(`/api/v1/equipment/${riser}`, { data: { parentEquipmentId: gauge } });
  expect(loop.status()).toBe(409);
  expect(((await loop.json()) as { error: string }).error).toContain("would make a loop");

  // The gauge goes inside the spare, with details a line at a time.
  await owner.goto(`/equipment/${gauge}`);
  await owner.getByText("Correct its details", { exact: true }).click();
  await owner.getByLabel("It is inside").selectOption({ label: `Spare ${run}` });
  await owner.getByLabel("Other details, one a line").fill("refrigerant: R-410A\npressure rating: 150 psi");
  await owner.getByRole("button", { name: "Save details" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await owner.goto(`/equipment/${gauge}`);
  await expect(owner.getByText("R-410A", { exact: true })).toBeVisible();
  await expect(owner.getByText("Part of").locator("xpath=..")).toContainText(`Spare ${run}`);
  let now = (await (await owner.request.get(`/api/v1/equipment/${gauge}`)).json()) as { parentEquipmentId: string | null; attributes: Record<string, unknown> };
  expect(now.parentEquipmentId).toBe(spare);
  expect(now.attributes).toEqual({ refrigerant: "R-410A", "pressure rating": "150 psi" });

  // A line with no colon is refused in words and nothing is saved.
  await owner.getByText("Correct its details", { exact: true }).click();
  await owner.getByLabel("Other details, one a line").fill("just some words");
  await owner.getByRole("button", { name: "Save details" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "needs a name, a colon and a value" })).toBeVisible();

  // A line taken out is taken off, and "nothing" takes it out of the spare.
  await owner.getByLabel("Other details, one a line").fill("refrigerant: R-410A");
  await owner.getByLabel("It is inside").selectOption({ label: "Nothing, it stands on its own" });
  await owner.getByRole("button", { name: "Save details" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  now = (await (await owner.request.get(`/api/v1/equipment/${gauge}`)).json()) as typeof now;
  expect(now.parentEquipmentId).toBeNull();
  expect(now.attributes).toEqual({ refrigerant: "R-410A" });
});
