import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * The page has hydrated: `HeldSubmits` sets this once React owns the page.
 * Waited for before a press that submits, so the press lands on the form
 * React is managing rather than on server HTML it may be about to replace.
 */
const ready = (page: Page) => page.waitForFunction(() => (window as { __otsReady?: boolean }).__otsReady === true);

/** One white pixel as a JPEG, which is all a cover photograph needs to be. */
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xd2, 0xcf, 0x20, 0xff, 0xd9,
]);

/**
 * CUSTOMISING THE PRODUCT TO THE BUSINESS, ON THE SCREENS
 *
 * The two things an owner does first when the product does not quite fit:
 * keep a list of something it never heard of (a permit, on the job it is
 * for), and make the proposal read the way they sell. Both are driven here
 * the way an owner meets them, from the settings screen to the job and the
 * estimate a customer sees.
 */

test("a kind of record is defined with its fields and used on a job", async ({ owner }) => {
  const key = `permit_${run}`;
  const name = `Morgan Permit ${run}`;

  // Defined: what one is called, what each is named, and that it belongs on a job.
  await owner.goto("/settings/records");
  const define = owner.getByRole("region", { name: "Define a kind of record" });
  await define.getByLabel("Key it is stored under").fill(key);
  await define.getByLabel("What one is called").fill("Permit");
  await define.getByLabel("More than one").fill("Permits");
  await define.getByLabel("What each one's name is").fill("Permit number");
  await define.getByLabel("A customer").check();
  await define.getByLabel("An address").check();
  await define.getByLabel("A job").check();
  await ready(owner);
  await define.getByRole("button", { name: "Define it" }).click();
  await expect(owner).toHaveURL(new RegExp(`/settings/records/${key}$`));
  await expect(owner.getByRole("heading", { level: 1, name: "Permits" })).toBeVisible();

  // Its fields, added the way a field on a customer is.
  const addField = owner.getByRole("region", { name: "Add a field" });
  await addField.getByLabel("Kind of answer").selectOption("select");
  await addField.getByLabel("Label people read").fill("Status");
  await addField.getByLabel("Key it is stored under").fill("status");
  await addField.getByLabel("Choices, one per line (for a list)").fill("applied\napproved\nfailed");
  await addField.getByLabel(/Required/).check();
  await ready(owner);
  await addField.getByRole("button", { name: "Add the field" }).click();
  await expect(addField.getByRole("status").filter({ hasText: "Added." })).toBeVisible();
  await addField.getByLabel("Kind of answer").selectOption("date");
  await addField.getByLabel("Label people read").fill("Inspected on");
  await addField.getByLabel("Key it is stored under").fill("inspected_on");
  await ready(owner);
  await addField.getByRole("button", { name: "Add the field" }).click();
  // Waited for, rather than reloaded away from: reloading straight away can
  // abort the action's request, and then the second field was never added.
  await expect(owner.getByRole("table")).toContainText("Inspected on");
  await owner.reload();
  await expect(owner.getByRole("table")).toContainText("Status");
  await expect(owner.getByRole("table")).toContainText("Inspected on");

  // A job to put one on.
  const customerId = await newCustomer(owner, {
    name, address: { street: "12 Permit Pl", city: "Austin", state: "TX", zip: "78703" },
  });
  await owner.getByRole("link", { name: "12 Permit Pl, Austin" }).click();
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await owner.getByLabel("Summary").fill(`Panel upgrade ${run}`);
  await owner.getByRole("button", { name: "Book job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const jobUrl = owner.url();

  // On the job: its own section, and "Add a permit" carries the job in.
  const panel = owner.getByRole("region", { name: "Permits" });
  await expect(panel).toContainText("None yet.");
  await panel.getByRole("link", { name: "Add a permit" }).click();
  await expect(owner.getByRole("heading", { level: 1, name: "Add a permit" })).toBeVisible();
  await expect(owner.getByText(`Panel upgrade ${run}`)).toBeVisible();

  // Refused in words first: the status is required.
  await owner.getByLabel("Permit number").fill(`BP-${run}`);
  await ready(owner);
  await owner.getByRole("button", { name: "Add the permit" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "Status is required." })).toBeVisible();

  await owner.getByLabel(/^Status/).selectOption("approved");
  await owner.getByLabel(/^Inspected on/).fill("2026-09-15");
  await ready(owner);
  await owner.getByRole("button", { name: "Add the permit" }).click();
  await expect(owner).toHaveURL(jobUrl);
  const onJob = owner.getByRole("region", { name: "Permits" });
  await expect(onJob.getByRole("link", { name: `BP-${run}` })).toBeVisible();
  await expect(onJob).toContainText("Status: approved");

  // On the customer it came from too, because a job carries its customer onto the record.
  await owner.goto(`/customers/${customerId}`);
  await expect(owner.getByRole("region", { name: "Permits" }).getByRole("link", { name: `BP-${run}` })).toBeVisible();

  // The kind's own list finds it by a value, and filters by its field.
  await owner.goto(`/records/${key}?q=2026-09-15`);
  await expect(owner.getByRole("table", { name: "Permits" })).toContainText(`BP-${run}`);
  await owner.goto(`/records/${key}?field=status&value=failed`);
  await expect(owner.getByText("No permits match")).toBeVisible();
  await expect(owner.getByRole("link", { name: "Download as CSV" })).toHaveAttribute("href", `/records/${key}/export`);
  const csv = await owner.request.get(`/records/${key}/export`);
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain(`BP-${run},2026-09-15,approved`);

  // Opened and changed.
  await owner.goto(`/records/${key}`);
  await owner.getByRole("link", { name: `BP-${run}` }).click();
  await expect(owner.getByRole("heading", { level: 1, name: `Permit BP-${run}` })).toBeVisible();
  await owner.getByLabel(/^Status/).selectOption("failed");
  await ready(owner);
  await owner.getByRole("button", { name: "Save", exact: true }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await owner.goto(jobUrl);
  await expect(owner.getByRole("region", { name: "Permits" })).toContainText("Status: failed");
});

test("a proposal layout is designed and applied to an estimate, and the proposal follows it", async ({ owner }) => {
  const layout = `Installs ${run}`;
  const name = `Riley Layout ${run}`;

  // Started from a layout worth editing, then edited: the cover, about us, and the warranty moved above the options.
  await owner.goto("/estimates/templates");
  const start = owner.getByRole("region", { name: "Start a layout" });
  await start.getByLabel("Name").fill(layout);
  await ready(owner);
  await start.getByRole("button", { name: "Start it" }).click();
  await expect(owner).toHaveURL(/\/estimates\/templates\/[0-9a-f-]{36}$/);
  await expect(owner.getByRole("heading", { level: 1, name: layout })).toBeVisible();

  await owner.getByLabel("Headline").fill(`Your new system ${run}`);
  const about = owner.getByRole("group", { name: "Section 1" });
  await about.getByLabel("Heading").fill("Who we are");
  await about.getByLabel(/Words under it/).fill(`Family owned since 1998 ${run}.`);
  /** The starter is about us, the options, the warranty, the terms: the warranty goes second. */
  const warranty = owner.getByRole("group", { name: "Section 3" });
  await expect(warranty.getByLabel("What it is")).toHaveValue("warranty");
  await warranty.getByLabel("Position").fill("2");
  await owner.getByRole("group", { name: "Section 2" }).getByLabel("Position").fill("3");
  await ready(owner);
  await owner.getByRole("button", { name: "Save the layout" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();

  // A photograph on the cover.
  await owner.reload();
  await owner.getByLabel("A JPEG or PNG, up to 8 MB").setInputFiles({ name: "install.jpg", mimeType: "image/jpeg", buffer: JPEG });
  await ready(owner);
  await owner.getByRole("button", { name: "Upload the photograph" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "The cover has its photograph." })).toBeVisible();

  // An estimate, written the ordinary way.
  const customerId = await newCustomer(owner, {
    name, address: { street: "8 Layout Ln", city: "Austin", state: "TX", zip: "78704" },
  });
  await owner.goto(`/customers/${customerId}`);
  await owner.getByRole("link", { name: "New estimate" }).click();
  await owner.getByLabel("Title").fill(`New furnace ${run}`);
  await owner.getByLabel("Option 1 name").fill("Furnace");
  await owner.getByLabel("Description, option 1 line 1").fill("96% furnace, installed");
  await owner.getByLabel("Unit price, option 1 line 1").fill("4200.00");
  await owner.getByRole("button", { name: "Save estimate" }).click();
  await expect(owner).toHaveURL(/\/estimates\/[0-9a-f-]{36}$/);
  const estimateUrl = owner.url();

  // The plain layout until one is applied, then the company's.
  const panel = owner.getByRole("region", { name: "Proposal layout" });
  await expect(panel).toContainText("The plain layout");
  await panel.getByLabel("Layout").selectOption({ label: layout });
  await ready(owner);
  await panel.getByRole("button", { name: "Use this layout" }).click();
  await expect(panel.getByRole("status").filter({ hasText: `Laid out as ${layout}.` })).toBeVisible();

  // The proposal follows it: the cover with its photograph first, then the sections in the company's order.
  await owner.goto(`${estimateUrl}/proposal`);
  const proposal = owner.getByRole("article", { name: "Proposal" });
  const cover = proposal.getByRole("region", { name: "Cover" });
  await expect(cover.getByRole("heading", { name: `Your new system ${run}` })).toBeVisible();
  await expect(cover.locator("img")).toHaveAttribute("src", /\/estimates\/[0-9a-f-]{36}\/proposal\/photos\/cover$/);
  const text = await proposal.innerText();
  const order = ["Who we are", `Family owned since 1998 ${run}.`, "Our warranty", "Your options", "Furnace"]
    .map((words) => text.indexOf(words));
  expect(order.every((at) => at >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);

  // The photograph is served, and the PDF follows the same layout.
  const photo = await owner.request.get(`${estimateUrl}/proposal/photos/cover`);
  expect(photo.status()).toBe(200);
  expect(photo.headers()["content-type"]).toBe("image/jpeg");
  const pdf = await owner.request.get(`${estimateUrl}/pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
});
