import { test, expect, run, newCustomer } from "./fixtures";

/**
 * AN ADDRESS'S OWN PEOPLE, A CUSTOMER LIST THAT READS NOTES, AND AN UNDO
 * THAT SAYS THE TWO ARE DIFFERENT PEOPLE
 */
test("the office keeps a person on an address page, and finds a customer by a word in a note", async ({ owner }) => {
  const customer = `Pia Porch ${run}`;
  const street = `${run.slice(-4)} Landing Way`;
  const id = await newCustomer(owner, {
    name: customer, phone: "(512) 555-0188", address: { street, city: "Austin", state: "TX", zip: "78745" },
  });

  // A word only a note has.
  const notes = owner.getByRole("region", { name: "Notes" });
  await notes.getByLabel("New note").fill(`Lockbox on the sundial ${run}`);
  await notes.getByRole("button", { name: "Add note" }).click();
  await expect(notes.getByRole("listitem").filter({ hasText: `Lockbox on the sundial ${run}` })).toBeVisible();
  await owner.goto(`/customers?q=${encodeURIComponent(`sundial ${run}`)}`);
  await expect(owner.getByRole("link", { name: customer })).toBeVisible();

  // The address's page keeps the tenant.
  await owner.goto(`/customers/${id}`);
  await owner.getByRole("link", { name: `${street}, Austin` }).click();
  const people = owner.getByRole("region", { name: "People at this address" });
  await expect(people).toContainText("Nobody is kept for this address on its own");
  await people.getByLabel("Name", { exact: true }).first().fill(`Tess Tenant ${run}`);
  await people.getByLabel("Phone").first().fill("512-555-0199");
  await people.getByRole("button", { name: "Add somebody here" }).click();
  const tess = people.getByRole("listitem").filter({ hasText: `Tess Tenant ${run}` });
  await expect(tess).toContainText("This address only");
  await expect(tess).toContainText("Gets the text");

  // Refused in words when there is no way to reach them.
  await people.getByLabel("Name", { exact: true }).last().fill(`Nobody ${run}`);
  await people.getByRole("button", { name: "Add somebody here" }).last().click();
  await expect(people.getByRole("alert")).toContainText("phone number or an email");

  await tess.getByRole("button", { name: "Remove" }).click();
  await expect(people).not.toContainText(`Tess Tenant ${run}`);
});

test("an undone merge can mark the two as different people, and the duplicates screen stops offering them", async ({ owner }) => {
  const digits = [...run.slice(-4)].map((c) => c.charCodeAt(0) % 10).join("");
  const phone = `512557${digits}`;
  const kept = await newCustomer(owner, { name: `Dale Father ${run}`, phone });
  const other = await newCustomer(owner, { name: `Dale Son ${run}`, phone });

  await owner.goto("/customers/duplicates");
  await expect(owner.getByRole("list", { name: "Pairs to look at" }).getByRole("listitem")
    .filter({ hasText: `Dale Son ${run}` })).toBeVisible();

  await owner.goto(`/customers/${kept}`);
  await owner.getByRole("button", { name: /Merge a duplicate into this one/ }).click();
  await owner.getByLabel("Which record is the duplicate").selectOption(other);
  await owner.getByRole("button", { name: `Merge into Dale Father ${run}` }).click();
  const merged = owner.getByRole("region", { name: "Merged into this record" });
  await expect(merged).toContainText(`Dale Son ${run} was merged in on`);

  await merged.getByLabel("Why, if you want to say").fill("Father and son");
  await merged.getByLabel(/They are different people/).check();
  await merged.getByRole("button", { name: "Undo this merge" }).click();
  await expect(merged).toContainText(/Undone on .*"Father and son"/);

  // Out of the list to look at, and in the list of pairs set aside, with the reason.
  await owner.goto("/customers/duplicates");
  await expect(owner.getByRole("list", { name: "Pairs to look at" }).getByRole("listitem")
    .filter({ hasText: `Dale Son ${run}` })).toHaveCount(0);
  await expect(owner.getByRole("list", { name: "Pairs marked as different people" }).getByRole("listitem")
    .filter({ hasText: `Dale Son ${run}` })).toContainText("Father and son");
});
