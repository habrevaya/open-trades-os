import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A MERGE TAKEN BACK
 *
 * Two records share a phone number and the office merges them, then finds
 * they are a landlord and her tenant. The kept record's page lists the merge
 * with what it brought, and "Undo this merge" makes the other one a customer
 * of their own again, with their own page.
 */
test("the office merges two records, then undoes the merge from the kept record's page", async ({ owner }) => {
  // Digits from the run suffix, so two runs do not share a number and find each other.
  const digits = [...run.slice(-4)].map((c) => c.charCodeAt(0) % 10).join("");
  const phone = `512556${digits}`;
  const kept = await newCustomer(owner, { name: `Lena Landlord ${run}`, phone });
  const other = await newCustomer(owner, { name: `Lena Tenant ${run}`, phone });

  await owner.goto(`/customers/${other}`);
  const notes = owner.getByRole("region", { name: "Notes" });
  await notes.getByLabel("New note").fill(`Rents the back unit ${run}`);
  await notes.getByRole("button", { name: "Add note" }).click();
  await expect(notes.getByRole("listitem").filter({ hasText: `Rents the back unit ${run}` })).toBeVisible();

  await owner.goto(`/customers/${kept}`);
  await owner.getByRole("button", { name: /Merge a duplicate into this one/ }).click();
  await owner.getByLabel("Which record is the duplicate").selectOption(other);
  await owner.getByRole("button", { name: `Merge into Lena Landlord ${run}` }).click();

  const merged = owner.getByRole("region", { name: "Merged into this record" });
  await expect(merged).toContainText(`Lena Tenant ${run} was merged in on`);
  await expect(merged).toContainText("1 note");
  // The note came with it.
  await expect(owner.getByRole("region", { name: "Notes" })).toContainText(`Rents the back unit ${run}`);

  await merged.getByLabel("Why, if you want to say").fill("Landlord and tenant");
  await merged.getByRole("button", { name: "Undo this merge" }).click();
  // The page answers by saying so on the merge, which is where the button was.
  await expect(merged).toContainText(/Undone on .*"Landlord and tenant"/);
  await expect(owner.getByRole("region", { name: "Notes" })).not.toContainText(`Rents the back unit ${run}`);

  await merged.getByRole("link", { name: `Lena Tenant ${run}` }).click();
  await expect(owner.getByRole("heading", { level: 1, name: `Lena Tenant ${run}` })).toBeVisible();
  await expect(owner.getByRole("region", { name: "Notes" })).toContainText(`Rents the back unit ${run}`);
});
