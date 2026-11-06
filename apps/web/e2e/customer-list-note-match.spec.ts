import { test, expect, run, newCustomer } from "./fixtures";

/**
 * THE CUSTOMER LIST SAYS WHEN IT WAS A NOTE THAT MATCHED
 *
 * The office remembers "the one with the gate code", not the name. The list
 * finds the customer by a word only in a note, and says so on the row with the
 * note's words, so nobody wonders why that name came up.
 */
const word = `wisteriagate${run}`;

test("A customer found by a note shows the note's words on the list", async ({ owner, errors }) => {
  const name = `Note Match ${run}`;
  const customerId = await newCustomer(owner, {
    name,
    address: { street: `${run} Wisteria Way`, city: "Austin", state: "TX", zip: "78701" },
  });
  const added = await owner.request.post(`/api/v1/customers/${customerId}/notes`, {
    headers: { "idempotency-key": `note-match-${run}` },
    data: { body: `Ring twice. The ${word} code is 4471 and the dog is friendly.` },
  });
  expect(added.ok(), await added.text()).toBe(true);

  await owner.goto("/customers");
  await owner.getByLabel("Search customers").fill(word);
  await owner.getByLabel("Search customers").press("Enter");
  await expect(owner).toHaveURL(/\/customers\?q=/);
  const row = owner.getByRole("row").filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("matched-note")).toContainText("From a note:");
  await expect(row.getByTestId("matched-note")).toContainText(`${word} code is 4471`);

  // Found by the name, the row explains itself and shows no note.
  await owner.goto(`/customers?q=${encodeURIComponent(name)}`);
  await expect(owner.getByRole("row").filter({ hasText: name }).getByTestId("matched-note")).toHaveCount(0);
  expect(errors).toEqual([]);
});
