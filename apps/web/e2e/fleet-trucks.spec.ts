import { test, expect, run } from "./fixtures";

/**
 * THE ROLL OFF COMPANY'S TRUCKS, DISPOSAL AND INVOICE, THROUGH THE FORMS
 *
 * Each screen replaced an API call, and a render test cannot prove the form
 * posts what the server action accepts. One real submit for each thing a
 * person types here, as the seeded owner.
 */

test("Trucks: a kind of truck is added, given to a vehicle, and cannot be removed while a truck has it", async ({ owner }) => {
  const label = `Hook truck ${run}`;
  const kind = `Hook lift ${run}`;

  // A vehicle on the register to be the truck.
  await owner.goto("/fleet");
  const add = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Add", exact: true }) });
  await add.locator('select[name="kind"]').selectOption({ label: "Vehicle" });
  await add.getByPlaceholder("Van 3").fill(label);
  await add.getByRole("button", { name: "Add", exact: true }).click();
  await expect(owner.getByRole("listitem").filter({ hasText: label }).first()).toBeVisible();

  await owner.goto("/fleet/containers/trucks");
  await expect(owner.getByRole("heading", { level: 1, name: "Trucks" })).toBeVisible();

  // A kind: two cans at a time, 10 and 20 yard only, thirty five minutes at the yard.
  const addKind = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Add kind" }) });
  await addKind.getByLabel("Name").fill(kind);
  await addKind.getByLabel("Containers carried").fill("2");
  await addKind.getByLabel("Sizes lifted, in yards").fill("10, 20");
  await addKind.getByLabel("Minutes at the yard").fill("35");
  await addKind.getByRole("button", { name: "Add kind" }).click();
  const listed = owner.getByRole("listitem").filter({ hasText: kind }).filter({ has: owner.getByRole("button", { name: "Remove" }) });
  await expect(listed).toContainText("Carries 2 containers, lifts 10, 20 yard, 35 minutes at the yard");

  // The same name twice is refused in words.
  await addKind.getByLabel("Name").fill(kind);
  await addKind.getByRole("button", { name: "Add kind" }).click();
  await expect(addKind.getByRole("alert")).toContainText("already on the list");

  // Given to the vehicle.
  const vehicle = owner.getByRole("listitem").filter({ has: owner.getByRole("button", { name: "Set kind" }) }).filter({ hasText: label });
  await vehicle.getByLabel(`Kind of ${label}`).selectOption({ label: kind });
  await vehicle.getByRole("button", { name: "Set kind" }).click();
  await expect(vehicle).toContainText(kind);
  await expect(listed).toContainText(`Trucks: ${label}`);

  // Not removable while it has a truck.
  await listed.getByRole("button", { name: "Remove" }).click();
  await expect(listed.getByRole("alert").filter({ hasText: "still a" })).toContainText(`${label} is still a ${kind}`);

  // Take it off the truck and it can go.
  await vehicle.getByLabel(`Kind of ${label}`).selectOption({ label: "None, the company's figures" });
  await vehicle.getByRole("button", { name: "Set kind" }).click();
  await expect(listed).toContainText("No truck has this kind");
  await listed.getByRole("button", { name: "Remove" }).click();
  await expect(owner.getByRole("listitem").filter({ hasText: kind }).filter({ has: owner.getByRole("button", { name: "Remove" }) })).toHaveCount(0);
});

test("Disposal facilities: a facility is recorded with its hours and rate, pinned by hand, and made the default", async ({ owner }) => {
  const name = `Tip ${run}`;
  await owner.goto("/fleet/containers/facilities");
  await expect(owner.getByRole("heading", { level: 1, name: "Disposal facilities" })).toBeVisible();

  const add = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Add facility" }) });
  await add.getByLabel("Name").fill(name);
  await add.getByLabel("Street").fill("9 Landfill Rd");
  await add.getByLabel("City").fill("Austin");
  await add.getByLabel("State").fill("TX");
  await add.getByLabel("Charges").selectOption({ label: "By the ton" });
  await add.getByLabel("How much").fill("62.50");
  await add.getByLabel("At least, for any load").fill("40");
  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
    await add.getByLabel(`${day} opens`).fill("07:00");
    await add.getByLabel(`${day} closes`).fill("16:30");
  }
  await add.getByRole("button", { name: "Add facility" }).click();

  const card = owner.getByRole("listitem", { name });
  await expect(card).toContainText("9 Landfill Rd, Austin, TX");
  await expect(card).toContainText("Mon to Fri 7:00 AM to 4:30 PM");
  await expect(card).toContainText("62.50 a ton, at least 40.00");

  // Half a day is refused in words rather than saved as a day it is closed.
  const change = card.locator("form").filter({ has: owner.getByRole("button", { name: "Save changes" }) });
  await change.getByLabel("Saturday opens").fill("08:00");
  await change.getByRole("button", { name: "Save changes" }).click();
  await expect(change.getByRole("alert")).toContainText("Saturday: give both the time it opens and the time it closes");

  // Pinned by hand, which is what lets a day be planned through it.
  const pin = card.locator("form").filter({ has: owner.getByRole("button", { name: "Place pin" }) });
  await pin.getByLabel("Latitude").fill("30.2672");
  await pin.getByLabel("Longitude").fill("-97.7431");
  await pin.getByRole("button", { name: "Place pin" }).click();
  await expect(card).toContainText("On the map, pinned by hand");

  // Latitude and longitude of the sea are refused.
  await pin.getByLabel("Latitude").fill("0");
  await pin.getByLabel("Longitude").fill("0");
  await pin.getByRole("button", { name: "Place pin" }).click();
  await expect(pin.getByRole("alert")).toContainText("not a place on the map");

  // And it can be made the default, which the first one already is only when it was first.
  const makeDefault = card.getByRole("button", { name: "Make the default" });
  if (await makeDefault.count()) await makeDefault.click();
  await expect(card).toContainText("Default");
});
