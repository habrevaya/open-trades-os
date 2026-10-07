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
