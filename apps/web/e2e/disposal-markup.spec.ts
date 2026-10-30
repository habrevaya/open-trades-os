import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A MARKUP ON THE FACILITY'S FEE, ADDED WITHOUT ASKING
 *
 * The company sets a 15% markup on disposal fees passed on, and says to add
 * the fee without asking. A hire whose terms pass the fee on is collected
 * with its ticket: the row offers 172.50, says it is 150.00 plus the markup
 * and that the settings add it, and raising the invoice puts it on. The
 * settings are put back afterwards, because every other spec's hires are the
 * same company's.
 */
test("Containers: a disposal fee passed on carries the company's markup, and is added without asking when it says so", async ({ owner }) => {
  test.setTimeout(150_000);
  const street = `${run.slice(-5)} Shale Rd`;
  const facility = `Shale ${run}`;
  await newCustomer(owner, { name: `Shale Build ${run}`, address: { street, city: "Austin", state: "TX", zip: "78702" } });

  await owner.goto("/fleet/containers/facilities");
  const addFacility = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Add facility" }) });
  await addFacility.getByLabel("Name").fill(facility);
  await addFacility.getByLabel("Charges").selectOption({ label: "By the ton" });
  await addFacility.getByLabel("How much").fill("60");
  await addFacility.getByRole("button", { name: "Add facility" }).click();
  await expect(owner.getByRole("listitem", { name: facility })).toContainText("60.00 a ton");

  try {
    await owner.goto("/fleet/containers");
    const passing = owner.locator("section").filter({ has: owner.getByRole("heading", { name: "Disposal fees passed on" }) });
    await expect(passing).toContainText("at cost");
    await passing.getByLabel("Markup on the facility's fee, per cent").fill("150");
    await passing.getByRole("button", { name: "Save disposal fees" }).click();
    await expect(passing.getByRole("alert")).toContainText("at most 100%");
    await passing.getByLabel("Markup on the facility's fee, per cent").fill("15");
    await passing.getByLabel("Add the fee to the invoice without asking").check();
    await passing.getByRole("button", { name: "Save disposal fees" }).click();
    await expect(passing.getByRole("status")).toContainText("Saved. Disposal fees are passed on with a 15% markup, added without asking.");

    const register = owner.getByRole("table", { name: "The register" });
    const board = owner.getByRole("table", { name: "Out on hire" });
    const addForm = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Add", exact: true }) });
    const can = `${run.slice(-5)}37`;
    await addForm.getByPlaceholder("4012").fill(can);
    await addForm.getByPlaceholder("20 yard").fill("20 yard");
    await addForm.getByRole("button", { name: "Add", exact: true }).click();
    const yardRow = register.getByRole("row").filter({ hasText: can });
    await expect(yardRow).toBeVisible();
    await yardRow.getByLabel("Site").selectOption({ label: `${street}, Austin` });
    await yardRow.getByLabel("Delivered on").fill("2026-06-01");
    await yardRow.getByPlaceholder("Days incl.").fill("7");
    await yardRow.getByPlaceholder("Day rate").fill("10");
    await yardRow.getByLabel("Pass the disposal fee on").check();
    await yardRow.getByRole("button", { name: "Deliver" }).click();
    const hire = board.getByRole("row")
      .filter({ has: owner.locator("td:first-child .font-mono", { hasText: new RegExp(`^${can}$`) }) });
    await expect(hire).toContainText(street);

    await hire.getByLabel("Collected on").fill("2026-06-06");
    await hire.getByLabel("Net tons collected").fill("2.5");
    await hire.getByLabel("Facility the load went to").selectOption({ label: facility });
    await hire.getByRole("button", { name: "Collect" }).click();
    await expect(hire).toContainText(`Disposal fee to pass on: 172.50 at ${facility}`);
    await expect(hire).toContainText("150.00 plus your 15% markup");
    await expect(hire).toContainText("Your settings add it without asking.");

    await hire.getByRole("button", { name: "Raise invoice with the disposal fee" }).click();
    await expect(hire).toContainText("Disposal fee passed on: 172.50");
  } finally {
    await owner.goto("/fleet/containers");
    const passing = owner.locator("section").filter({ has: owner.getByRole("heading", { name: "Disposal fees passed on" }) });
    await passing.getByLabel("Markup on the facility's fee, per cent").fill("");
    await passing.getByLabel("Add the fee to the invoice without asking").uncheck();
    await passing.getByRole("button", { name: "Save disposal fees" }).click();
    await expect(passing.getByRole("status")).toContainText("at cost, and you are asked each time.");
  }
});
