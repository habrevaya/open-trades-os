import { test, expect, run, newCustomer } from "./fixtures";

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

test("Containers: the facility's fee is offered when a hire passes it on, added only when asked, and a chain is one invoice", async ({ owner }) => {
  const street = `${run.slice(-5)} Quarry Rd`;
  const facility = `Pass ${run}`;
  await newCustomer(owner, { name: `Chain Build ${run}`, address: { street, city: "Austin", state: "TX", zip: "78702" } });

  // A facility that charges by the ton.
  await owner.goto("/fleet/containers/facilities");
  const addFacility = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Add facility" }) });
  await addFacility.getByLabel("Name").fill(facility);
  await addFacility.getByLabel("Charges").selectOption({ label: "By the ton" });
  await addFacility.getByLabel("How much").fill("60");
  await addFacility.getByRole("button", { name: "Add facility" }).click();
  await expect(owner.getByRole("listitem", { name: facility })).toContainText("60.00 a ton");

  // Two cans for a chain, billed as one invoice, passing disposal on.
  await owner.goto("/fleet/containers");
  const register = owner.getByRole("table", { name: "The register" });
  const board = owner.getByRole("table", { name: "Out on hire" });
  const addForm = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Add", exact: true }) });
  const cans = [1, 2].map((n) => `${run.slice(-5)}${n}9`);
  for (const number of cans) {
    await addForm.getByPlaceholder("4012").fill(number);
    await addForm.getByPlaceholder("20 yard").fill("20 yard");
    await addForm.getByRole("button", { name: "Add", exact: true }).click();
    await expect(register.getByRole("row").filter({ hasText: number })).toBeVisible();
  }
  const yardRow = register.getByRole("row").filter({ hasText: cans[0]! });
  await yardRow.getByLabel("Site").selectOption({ label: `${street}, Austin` });
  await yardRow.getByLabel("Delivered on").fill("2026-06-01");
  await yardRow.getByPlaceholder("Days incl.").fill("7");
  await yardRow.getByPlaceholder("Day rate").fill("10");
  await yardRow.getByLabel("Invoice this hire as").selectOption({ label: "One invoice for the whole chain" });
  await yardRow.getByLabel("Pass the disposal fee on").check();
  await yardRow.getByRole("button", { name: "Deliver" }).click();
  /**
   * A hire's row, found by the can named in its first cell: another hire's
   * "Empty can" list names every can in the yard, so a row that merely
   * mentions the number can be somebody else's.
   */
  const hireOf = (can: string) => board.getByRole("row")
    .filter({ has: owner.locator("td:first-child .font-mono", { hasText: new RegExp(`^${can}$`) }) });
  const first = hireOf(cans[0]!);
  await expect(first).toContainText(street);

  // Swapped for the second can, which carries the terms forward.
  await first.getByLabel("Empty can").selectOption({ label: cans[1]! });
  await first.getByLabel("Swapped on").fill("2026-06-04");
  await first.getByLabel("Net tons on the full can").fill("1");
  await first.getByLabel("Facility the full can went to").selectOption({ label: facility });
  await first.getByRole("button", { name: "Swap" }).click();
  const second = hireOf(cans[1]!);
  await expect(second).toContainText("Swap");

  // Collected with its ticket: now the fee is offered, and nothing is invoiced yet.
  await second.getByLabel("Collected on").fill("2026-06-06");
  await second.getByLabel("Net tons collected").fill("2.5");
  await second.getByLabel("Facility the load went to").selectOption({ label: facility });
  await second.getByRole("button", { name: "Collect" }).click();
  await expect(second).toContainText(`Disposal fee to pass on: 150.00 at ${facility}`);
  await expect(second.getByRole("button", { name: "Raise invoice with the disposal fee" })).toBeVisible();
  await expect(second.getByRole("button", { name: "Raise invoice without the disposal fee" })).toBeVisible();

  // Asked for: one invoice for both cans with the fee of each on it. The form goes with the invoice,
  // so what is left on the row is the record that it was raised and that the fee went on.
  await second.getByRole("button", { name: "Raise invoice with the disposal fee" }).click();
  await expect(second).toContainText("Disposal fee passed on: 150.00");
  await expect(second).toContainText("Invoiced");
  await expect(second.getByRole("button", { name: "Raise invoice with the disposal fee" })).toHaveCount(0);
  // And the first can of the chain is on the same invoice, so it offers nothing more.
  await expect(first).toContainText("Invoiced");
});

test("Trucks: a kind says how many of each size it carries, and refuses words it cannot read", async ({ owner }) => {
  const kind = `Small hook ${run}`;
  await owner.goto("/fleet/containers/trucks");
  const addKind = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Add kind" }) });

  // Words that are not "how many of which size" are refused, with how to write it.
  await addKind.getByLabel("Name").fill(kind);
  await addKind.getByLabel("How many of each size").fill("lots of small ones");
  await addKind.getByRole("button", { name: "Add kind" }).click();
  await expect(addKind.getByRole("alert")).toContainText("2 of 10, 1 of 30");

  // Two 10 yard or one 30 yard.
  await addKind.getByLabel("Name").fill(kind);
  await addKind.getByLabel("How many of each size").fill("2 of 10, 1 of 30");
  await addKind.getByRole("button", { name: "Add kind" }).click();
  const listed = owner.getByRole("listitem").filter({ hasText: kind }).filter({ has: owner.getByRole("button", { name: "Remove" }) });
  await expect(listed).toContainText("Carries two 10 yard or one 30 yard, lifts 10, 30 yard");

  // Changed to two 30 yard, then back to one figure for every size.
  const change = listed.locator("form").filter({ has: owner.getByRole("button", { name: "Save" }) });
  await change.getByLabel("How many of each size").fill("2 of 30");
  await change.getByRole("button", { name: "Save" }).click();
  await expect(listed).toContainText("Carries two 30 yard, lifts");
  await change.getByLabel("How many of each size").fill("");
  await change.getByLabel("Containers carried").fill("2");
  await change.getByRole("button", { name: "Save" }).click();
  await expect(listed).toContainText("Carries 2 containers, lifts");

  await listed.getByRole("button", { name: "Remove" }).click();
  await expect(owner.getByRole("listitem").filter({ hasText: kind }).filter({ has: owner.getByRole("button", { name: "Remove" }) })).toHaveCount(0);
});
