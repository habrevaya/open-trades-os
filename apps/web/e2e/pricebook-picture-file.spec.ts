import type { Locator } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * AN ITEM'S PICTURE, UPLOADED, ON THE ITEM, IN THE COMPOSER AND ON THE CUSTOMER'S PROPOSAL
 *
 * The office uploads a picture on the item's own screen, which saves a new
 * version. The estimate composer draws it beside a line of the item; the
 * customer's proposal draws it through their own link, and the PDF prints it.
 * The link serves only pictures of items on that estimate, and the office's
 * picture route is not open to somebody who is not signed in.
 */

/** A one pixel JPEG. */
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xd2, 0xcf, 0x20, 0xff, 0xd9,
]);

/** The picture arrived and was drawn, rather than a broken image with the right name. */
const drawn = (image: Locator) => expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

test("an item's uploaded picture is drawn on the item, in the composer and on the customer's proposal", async ({ owner, stranger }) => {
  const code = `PICF-${run}`.toUpperCase();
  const name = `Condenser ${run}`;
  const made = await owner.request.post("/api/v1/pricebook/items", {
    data: { kind: "equipment", code, name, price: "3800.00" },
  });
  expect(made.ok()).toBe(true);
  const id = ((await made.json()) as { id: string }).id;
  const other = await owner.request.post("/api/v1/pricebook/items", {
    data: { kind: "equipment", code: `${code}-B`, name: `Coil ${run}`, price: "900.00" },
  });
  const otherId = ((await other.json()) as { id: string }).id;

  // Uploaded on the item's screen, as a new version.
  await owner.goto(`/pricebook/items/${id}`);
  const picture = owner.getByRole("region", { name: "Picture" });
  await expect(picture).toContainText("No picture yet.");
  await picture.getByLabel("Picture file").setInputFiles({ name: "condenser.jpg", mimeType: "image/jpeg", buffer: JPEG });
  await picture.getByRole("button", { name: "Upload the picture" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Picture saved as a new version" })).toBeVisible();
  const item = (await (await owner.request.get(`/api/v1/pricebook/items/${id}`)).json()) as { version: number; versionId: string; hasPicture: boolean };
  expect(item).toMatchObject({ version: 2, hasPicture: true });
  await owner.goto(`/pricebook/items/${id}`);
  await drawn(owner.getByRole("region", { name: "Picture" }).getByRole("img", { name: `Picture of ${name}` }));

  // A file that is not a picture is refused in words, and nothing is saved.
  await owner.getByRole("region", { name: "Picture" }).getByLabel("Picture file")
    .setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%notes\n") });
  await owner.getByRole("region", { name: "Picture" }).getByRole("button", { name: "Upload a new picture" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "a JPEG, a PNG, a GIF or a WebP" })).toBeVisible();

  // Picked in the composer, the line shows it.
  const customerId = await newCustomer(owner, {
    name: `Robin Picture ${run}`, address: { street: "4 Lens Rd", city: "Austin", state: "TX", zip: "78702" },
  });
  await owner.goto(`/customers/${customerId}`);
  await owner.getByRole("link", { name: "New estimate" }).click();
  await owner.getByLabel("Price book item, option 1 line 1").selectOption({ label: `${name} ($3800.00)` });
  await drawn(owner.getByRole("img", { name: `Picture of ${name}` }));
  await owner.getByLabel("Option 1 name").fill("Replace it");
  await owner.getByRole("button", { name: "Save estimate" }).click();
  await expect(owner).toHaveURL(/\/estimates\/[0-9a-f-]{36}$/);
  const estimateId = owner.url().split("/").pop()!;

  // The office's proposal draws it under the estimate's own read.
  await owner.goto(`/estimates/${estimateId}/proposal`);
  await drawn(owner.getByRole("article", { name: "Proposal" }).getByRole("img", { name: `Picture of ${name}` }));

  // The customer's proposal draws it through their link, and the PDF prints it.
  const sent = await owner.request.post(`/api/v1/estimates/${estimateId}/send`, { data: { channel: "link", expiresInDays: 30 } });
  expect(sent.ok()).toBe(true);
  const approvalUrl = ((await sent.json()) as { approvalUrl: string }).approvalUrl;
  const path = new URL(approvalUrl, "http://x").pathname;
  await stranger.goto(`${path}/proposal`);
  await drawn(stranger.getByRole("article", { name: "Proposal" }).getByRole("img", { name: `Picture of ${name}` }));
  const file = await stranger.request.get(`${path}/pdf`);
  expect(file.ok()).toBe(true);
  expect((await file.body()).toString("latin1")).toContain("/Subtype /Image");

  // The link serves the pictures of items on this estimate and nothing else.
  expect((await stranger.request.get(`${path}/proposal/photos/item-${item.versionId}`)).status()).toBe(200);
  const otherVersion = ((await (await owner.request.get(`/api/v1/pricebook/items/${otherId}`)).json()) as { versionId: string }).versionId;
  expect((await stranger.request.get(`${path}/proposal/photos/item-${otherVersion}`)).status()).toBe(404);
  // The office's route is not for somebody who is not signed in.
  const office = await stranger.request.get(`/pricebook/pictures/${item.versionId}`, { maxRedirects: 0 });
  expect(office.status()).not.toBe(200);

  // Taken off as a new version; the estimate already written keeps it.
  await owner.goto(`/pricebook/items/${id}`);
  await owner.getByRole("region", { name: "Picture" }).getByRole("button", { name: "Take the picture off" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Picture taken off as a new version" })).toBeVisible();
  expect((await stranger.request.get(`${path}/proposal/photos/item-${item.versionId}`)).status()).toBe(200);
});
