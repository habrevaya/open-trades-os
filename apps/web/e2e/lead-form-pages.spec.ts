import { and, eq } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { test, expect, run } from "./fixtures";

/**
 * A LEAD FORM IN TWO PAGES, WITH A PHOTO, THAT SAYS THEIR NAME BACK
 *
 * The office splits a new form into two pages and adds a place for photos on
 * the second, with a thank you that names the person. A stranger meets the
 * first page, is told on Next what is missing, goes forward and back without
 * losing what they typed, sends a program called a photograph and is told so
 * on the page it is on, then sends the real photograph. The thank you says
 * their name, and the photograph is on their customer page in the office.
 */

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** The customer a phone number became, read the way the office's search would find them. */
async function customerWithPhone(e164: string): Promise<string | null> {
  const db = createClient();
  try {
    const [row] = await db.select({ id: schema.customer.id }).from(schema.customer)
      .where(and(eq(schema.customer.phone, e164))).limit(1);
    return row?.id ?? null;
  } finally {
    await db.$close();
  }
}

test("a lead form in two pages takes a photo, checks each page and thanks them by name", async ({ owner, stranger }) => {
  const slug = `pages-${run}`;
  await owner.goto("/marketing/forms");
  await owner.getByLabel("Title").fill(`Boiler trouble ${run}`);
  await owner.getByLabel("Short name").fill(slug);
  await owner.getByRole("button", { name: "Start form" }).click();
  await expect(owner).toHaveURL(new RegExp(`/marketing/forms/${slug}$`));

  await owner.getByRole("button", { name: "Split into pages" }).click();
  await owner.getByLabel("Page 2 heading").fill("Show us the problem");
  /** A new field goes on the last page. */
  await owner.getByRole("button", { name: "Add a field" }).click();
  await owner.getByLabel("Field 8 question").fill("Photos of the problem");
  await owner.getByLabel("Field 8 key").fill("photos");
  await owner.getByLabel("Field 8 kind").selectOption({ label: "Photos or PDFs" });
  await expect(owner.getByLabel("Field 8 page")).toHaveValue("1");
  await owner.getByLabel("What the page says").fill(`Thanks {{ name }}, we ring within the hour. ${run}`);
  await owner.getByLabel("Too fast to be a person (seconds)").fill("0");
  await owner.getByRole("button", { name: "Save form" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  const hosted = await owner.getByRole("link", { name: /^\/f\// }).getAttribute("href");

  const digits = String(Date.now()).slice(-7);
  const name = `Wren Pages ${run}`;
  await stranger.goto(hosted!);
  await expect(stranger.getByText("Page 1 of 2")).toBeVisible();
  await expect(stranger.getByLabel("Photos of the problem")).toBeHidden();
  await stranger.getByLabel("Your name").fill(name);
  await stranger.getByRole("button", { name: "Next" }).click();
  await expect(stranger.getByRole("alert").filter({ hasText: "Mobile number is needed." })).toBeVisible();
  await expect(stranger.getByText("Page 1 of 2")).toBeVisible();

  await stranger.getByLabel("Mobile number").fill(`737${digits}`);
  await stranger.getByRole("button", { name: "Next" }).click();
  await expect(stranger.getByRole("group", { name: "Show us the problem" })).toBeVisible();
  await stranger.getByRole("button", { name: "Back" }).click();
  await expect(stranger.getByLabel("Your name")).toHaveValue(name);
  await stranger.getByRole("button", { name: "Next" }).click();

  /** A program called a photograph is refused by the server, on the page it was picked on. */
  await stranger.getByLabel("Photos of the problem").setInputFiles({
    name: "boiler.jpg", mimeType: "image/jpeg", buffer: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]),
  });
  await stranger.getByRole("button", { name: "Send" }).click();
  await expect(stranger.getByRole("alert").filter({ hasText: "boiler.jpg was not sent: it is a program or a script" })).toBeVisible();
  await expect(stranger.getByText("Page 2 of 2")).toBeVisible();

  const photo = `leak-${run}.png`;
  await stranger.getByLabel("Photos of the problem").setInputFiles({ name: photo, mimeType: "image/png", buffer: PIXEL });
  await stranger.getByRole("button", { name: "Send" }).click();
  await expect(stranger.getByRole("status").filter({ hasText: `Thanks ${name}, we ring within the hour. ${run}` })).toBeVisible();

  let customerId: string | null = null;
  await expect.poll(async () => (customerId = await customerWithPhone(`+1737${digits}`))).not.toBeNull();
  await owner.goto(`/customers/${customerId!}`);
  const sent = owner.getByRole("region", { name: "Sent with a lead form" });
  await expect(sent.getByRole("link", { name: photo })).toBeVisible();
  const response = await owner.request.get((await sent.getByRole("link", { name: photo }).getAttribute("href"))!);
  expect(response.headers()["content-type"]).toContain("image/png");
});
