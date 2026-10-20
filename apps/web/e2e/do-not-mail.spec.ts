import { test, expect, run, newCustomer } from "./fixtures";

/**
 * THE DO NOT MAIL LIST
 *
 * A customer rings to say stop the postcards. The office puts them on the list
 * from their own page with the reason, an address a landlord wrote about is
 * typed onto the list under Direct mail, a second try at the same address is
 * refused in words, and taking the customer off puts them back in the mail.
 * (What a mailing does with the list is tested against a fake of the printer.)
 */
test("the office puts a customer and an address on the do not mail list, and takes the customer off", async ({ owner }) => {
  test.setTimeout(120_000);
  const name = `Nomail ${run}`;
  const street = `${run.slice(-4)} Quiet Ln`;
  const customerId = await newCustomer(owner, {
    name, address: { street, city: "Austin", state: "TX", zip: "78704" },
  });

  await owner.goto(`/customers/${customerId}`);
  const mail = owner.getByRole("region", { name: "Mail" });
  await expect(mail).toContainText("They get your mailings");
  await mail.getByLabel("Why (printed on any piece it stops)").fill("Asked on the phone");
  await mail.getByRole("button", { name: "Do not mail this customer" }).click();
  await expect(mail).toContainText("On your do not mail list: Asked on the phone. No mailing posts to them, wherever they live.");

  await owner.goto("/marketing/mail");
  const list = owner.getByRole("table", { name: "Do not mail list" });
  await expect(list).toContainText(name);
  await expect(list).toContainText(`${street}, Austin, TX, 78704`);

  /** An address typed in, written the way the landlord wrote it. */
  const landlord = `${run.slice(-4)} Landlord Road`;
  const section = owner.getByRole("region", { name: "Do not mail" });
  await section.getByLabel("Street").fill(landlord);
  await section.getByLabel("City").fill("Austin");
  await section.getByLabel("State").fill("tx");
  await section.getByLabel("ZIP").fill("78704");
  await section.getByLabel("Why (printed on the piece it stops)").fill("Letter from the landlord");
  await section.getByRole("button", { name: "Add this address" }).click();
  await expect(owner.getByRole("table", { name: "Do not mail list" })).toContainText(landlord);

  /** The same door again, in other words, is refused. */
  await section.getByLabel("Street").fill(landlord.replace("Road", "Rd"));
  await section.getByLabel("City").fill("Austin");
  await section.getByLabel("State").fill("TX");
  await section.getByLabel("ZIP").fill("78704");
  await section.getByRole("button", { name: "Add this address" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "is already on your do not mail list" })).toBeVisible();

  /** Taking the customer off leaves the address on. */
  await owner.getByRole("row").filter({ hasText: name }).getByRole("button", { name: "Take off the list" }).click();
  await expect(owner.getByRole("table", { name: "Do not mail list" })).not.toContainText(name);
  await expect(owner.getByRole("table", { name: "Do not mail list" })).toContainText(landlord);

  await owner.goto(`/customers/${customerId}`);
  await expect(owner.getByRole("region", { name: "Mail" })).toContainText("They get your mailings");
});
