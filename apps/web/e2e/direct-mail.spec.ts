import { test, expect, run, newCustomer } from "./fixtures";
import { fakeMarketing, pointAt } from "./marketing-fakes";

/**
 * A POSTCARD MAILING SENT, AND A VISIT FROM ONE OF ITS CARDS CREDITED
 *
 * Through the screens: the company's address on Settings (the return address);
 * Lob connected on Settings, Integrations with the name of its key; a customer
 * tagged for the mailing; a mailing drafted on Marketing, Direct mail to that
 * tag, previewed, and sent to the printer; the customer opening the address
 * printed on their card; and the job booked for them afterwards credited to
 * the mailing, whose page shows the visit and the job. Lob is the one thing
 * faked (e2e/marketing-fakes.ts).
 */
test("a mailing goes to the printer and a visit from its card is credited to it", async ({ owner, browser, baseURL }) => {
  const fake = await fakeMarketing();
  try {
    const tag = `mailer-${run}`;
    const mailing = `Fall tune up ${run}`;
    const name = `Nell Ortega ${run}`;

    await owner.goto("/settings");
    const details = owner.getByRole("region", { name: "Company details" });
    await details.getByLabel("Street address").fill("1 Main St");
    await details.getByLabel("Town or city").fill("Austin");
    await details.getByLabel("State").fill("TX");
    await details.getByLabel("ZIP code").fill("78701");
    await details.getByRole("button", { name: "Save company details" }).click();
    await expect(details.getByRole("status")).toContainText("Saved.");

    await owner.goto("/settings/integrations");
    const lob = owner.getByRole("listitem").filter({ has: owner.getByText("Lob", { exact: true }) });
    await lob.getByRole("button", { name: "Connect Lob" }).click();
    await lob.getByLabel("Lob secret API key, as the name of the secret holding it").fill("E2E_LOB_KEY");
    await lob.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(lob.getByText("Connected", { exact: true })).toBeVisible();
    await pointAt("lob", fake.base);

    const customerId = await newCustomer(owner, {
      name, phone: "512-555-0156", address: { street: "8 Cedar Ln", city: "Austin", state: "TX", zip: "78745" },
    });
    await owner.getByLabel("New tag").fill(tag);
    await owner.getByRole("button", { name: "Add tag" }).click();
    await expect(owner.getByRole("region", { name: "Tags" }).getByRole("link", { name: tag })).toBeVisible();

    await owner.goto("/marketing/mail");
    await owner.getByLabel("Name", { exact: true }).fill(mailing);
    await owner.locator('input[name="rule"][value="tagged_any"]').check();
    await owner.getByLabel("Tags, comma separated").fill(tag);
    await owner.getByLabel("Price per piece, from your mail house's price list").fill("0.72");
    await owner.getByLabel("Headline on their personal page (optional)").fill("Your fall tune up");
    await owner.getByRole("button", { name: "Save the draft" }).click();
    await expect(owner.getByRole("heading", { level: 1, name: mailing })).toBeVisible();

    await expect(owner.getByRole("note")).toContainText(`1 piece to post. Customers who are tagged "${tag}".`);
    await expect(owner.getByRole("note")).toContainText("$0.72");
    await owner.getByRole("button", { name: "Send to the printer" }).click();
    /** The send button goes with the draft, so what it did is read off the page that replaces it. */
    await expect(owner.getByText("Pieces sent").locator("..")).toContainText("1 of 1");
    expect(fake.postcards).toHaveLength(1);
    const card = fake.postcards[0] as { to: { name: string }; back: string; qr_code: { redirect_url: string } };
    expect(card.to.name).toBe(name);
    const personal = card.qr_code.redirect_url;
    expect(personal).toMatch(new RegExp(`^${baseURL}/m/[a-z0-9]{10}$`));
    expect(card.back).toContain(personal);

    // The customer opens the address on their card, in a browser of their own.
    const theirs = await browser.newContext();
    try {
      const page = await theirs.newPage();
      await page.goto(personal);
      await expect(page.getByRole("heading", { level: 1, name: "Your fall tune up" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Book online" })).toBeVisible();
    } finally {
      await theirs.close();
    }

    // The job booked for them afterwards is credited to the mailing.
    await owner.goto(`/customers/${customerId}`);
    await owner.getByRole("link", { name: "8 Cedar Ln, Austin" }).click();
    await owner.getByRole("link", { name: "Book a job here" }).click();
    await owner.getByLabel("Summary").fill(`Tune up ${run}`);
    await owner.getByRole("button", { name: "Book job" }).click();
    await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
    await expect(owner.getByRole("region", { name: "Where this job came from" })).toContainText(mailing);

    await owner.goto("/marketing/mail");
    await owner.getByRole("link", { name: mailing }).click();
    await expect(owner.getByText("Opened their address").locator("..")).toContainText("1");
    await expect(owner.getByText("Jobs credited to it").locator("..")).toContainText("1");
    await expect(owner.getByRole("table", { name: "Pieces" })).toContainText(name);
  } finally {
    await fake.close();
  }
});
