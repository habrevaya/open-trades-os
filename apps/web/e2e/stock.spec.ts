import { test, expect, run, newCustomer } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * SERIALS, AND AN ORDER THAT HAS TO BE APPROVED BEFORE IT IS EMAILED
 *
 * Two journeys through the forms, because each one turns on a value the
 * screen has to carry to the service intact: a serial number typed into a box
 * that has to arrive on the movement and then on the customer's equipment, and
 * an approval step that has to stop an email the screen would otherwise send.
 */

/** A part in the price book, through its own form, so a rerun never collides with the last. */
async function newPart(owner: Page, code: string, name: string) {
  await owner.goto("/pricebook/items/new");
  await owner.getByLabel("Kind").selectOption("material");
  await owner.getByLabel("Code").fill(code);
  await owner.getByLabel("Name").fill(name);
  await owner.getByLabel("Price").fill("1500.00");
  await owner.getByRole("button", { name: "Add to the price book" }).click();
  await expect(owner).toHaveURL(/\/pricebook\/items\/[0-9a-f-]{36}$/);
}

test("Serials: a compressor is received by serial number, used on a job as the customer's condenser, and traced back", async ({ owner }) => {
  const code = `CMP${run.slice(-6).toUpperCase()}`;
  const part = `Scroll compressor ${run}`;
  const serial = `SN-${run}-1`;
  await newPart(owner, code, part);

  // Tracked by serial from now on.
  await owner.goto("/inventory/serials");
  const tracking = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Save" }) });
  await tracking.getByLabel("Part").selectOption({ label: `${part} (${code})` });
  await tracking.getByLabel("Track it").selectOption("serial");
  await tracking.getByRole("button", { name: "Save" }).click();
  await expect(tracking.getByRole("status")).toContainText("Saved.");
  await expect(owner.getByRole("listitem").filter({ hasText: part })).toContainText("by serial number");

  // Received without its number is refused in words; with it, it arrives.
  await owner.goto("/inventory");
  const receive = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Receive", exact: true }) });
  await receive.getByLabel("Part").selectOption({ label: `${part} (${code}), by serial` });
  await receive.getByLabel("Into").selectOption({ label: "Shop (warehouse)" });
  await receive.getByLabel("Quantity").fill("1");
  await receive.getByLabel("What it all cost").fill("900.00");
  await receive.getByRole("button", { name: "Receive", exact: true }).click();
  await expect(receive.getByRole("alert")).toContainText("tracked by serial number, so say which ones");
  await receive.getByLabel("Serial or lot numbers").fill(serial);
  await receive.getByRole("button", { name: "Receive", exact: true }).click();
  await expect(receive.getByRole("status")).toContainText(`Received 1: ${serial}.`);
  await expect(owner.getByRole("row").filter({ hasText: part }).filter({ hasText: "Shop" }).first()).toBeVisible();

  // A job at the customer's house.
  const customer = `Odette Marsh ${run}`;
  const street = `${run.slice(-4)} Pecan Way`;
  await newCustomer(owner, { name: customer, phone: "512-555-0163", address: { street, city: "Austin", state: "TX", zip: "78745" } });
  await owner.getByRole("link", { name: `${street}, Austin` }).click();
  await owner.getByRole("link", { name: "Book a job here" }).click();
  await owner.getByLabel("Summary").fill(`Compressor change ${run}`);
  await owner.getByLabel("Day", { exact: true }).fill(new Date(Date.now() + 864e5).toISOString().slice(0, 10));
  await owner.getByLabel("Arrives from").fill("09:00");
  await owner.getByRole("button", { name: "Book job" }).click();
  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const jobNumber = (await owner.getByRole("heading", { level: 1 }).locator("span").first().textContent())!.trim();

  // Used on it, and recorded as the customer's condenser with its serial.
  await owner.goto("/inventory");
  const use = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Use on the job" }) });
  await use.getByLabel("Part").selectOption({ label: `${part} (${code}), by serial` });
  await use.getByLabel("Taken from").selectOption({ label: "Shop (warehouse)" });
  await use.getByLabel("Job number").fill(jobNumber);
  await use.getByLabel("Serial or lot numbers").fill(serial);
  await use.getByLabel("Record as customer equipment, of the kind").fill("Condenser");
  await use.getByLabel("Make").fill("Copeland");
  await use.getByRole("button", { name: "Use on the job" }).click();
  await expect(use.getByRole("status")).toContainText(`Used 1 on job ${jobNumber}, recorded as the customer's condenser.`);

  // Found by half its number, and traced from the shelf to the customer's house.
  await owner.goto(`/inventory/serials?number=${encodeURIComponent(`${run}-1`)}`);
  const row = owner.getByRole("row").filter({ hasText: serial });
  await expect(row).toContainText("Used on a job");
  await expect(row).toContainText(`job ${jobNumber}`);
  await row.getByRole("link", { name: "Trace" }).click();
  await expect(owner.getByRole("heading", { level: 1 })).toContainText(serial);
  const went = owner.getByRole("region", { name: "Where it went" });
  await expect(went).toContainText(`Condenser at ${street}, Austin for ${customer}`);
  await expect(went).toContainText(`Serial on the record: ${serial}`);
  const history = owner.getByRole("table", { name: "History" });
  await expect(history.getByRole("row").filter({ hasText: "Received" })).toContainText("Shop");
  await expect(history.getByRole("row").filter({ hasText: "Issued to a job" })).toContainText(`Job ${jobNumber}`);
});

test("Purchasing: an order over the approval step waits, is approved, and its email is recorded on it", async ({ owner }) => {
  const code = `FLT${run.slice(-6).toUpperCase()}`;
  const vendor = `Watsco ${run}`;
  await newPart(owner, code, `Pleated filter case ${run}`);

  // A step: anything at or over $40,000 waits for the owner.
  await owner.goto("/purchasing/approvals");
  await owner.getByLabel("Orders at or over").fill("40000");
  await owner.getByLabel("Approved by").selectOption({ label: "Owner" });
  await owner.getByRole("button", { name: "Add step" }).click();
  const step = owner.getByRole("table", { name: "Approval steps" }).getByRole("row").filter({ hasText: "$40,000.00" });
  await expect(step).toContainText("Owner");

  try {
    // A vendor with an address to email orders to.
    await owner.goto("/purchasing");
    await owner.getByLabel("Name", { exact: true }).fill(vendor);
    await owner.getByLabel("Orders email").fill(`orders+${run}@watsco.test`);
    await owner.getByRole("button", { name: "Add vendor" }).click();
    await expect(owner.getByRole("row").filter({ hasText: vendor })).toContainText(`orders+${run}@watsco.test`);

    // Thirty cases at $1,500 is $45,000: over the step.
    const byPart = owner.locator("form").filter({ has: owner.getByLabel("Part, line 1") });
    await byPart.getByLabel("Vendor").selectOption({ label: vendor });
    await byPart.getByLabel("Deliver to").selectOption({ label: "Shop" });
    await byPart.getByLabel("Part, line 1").fill(code);
    await byPart.getByLabel("Quantity, line 1").fill("30");
    await byPart.getByLabel("Price, line 1").fill("1500");
    await byPart.getByRole("button", { name: "Create a draft order" }).click();
    await expect(byPart.getByRole("status")).toContainText("Saved.");
    await owner.reload();
    await owner.getByRole("row").filter({ hasText: vendor }).getByRole("link").first().click();
    await expect(owner.getByRole("heading", { level: 1 })).toContainText(vendor);

    // Not emailed while the step waits: emailing a draft is sending it.
    const approval = owner.getByRole("region", { name: "Approval" });
    await expect(approval).toContainText("Waiting for an owner to approve it, step 1 of 1");
    const email = owner.getByRole("region", { name: "Send to the vendor" });
    await email.getByRole("button", { name: "Email to vendor" }).click();
    await expect(email.getByRole("alert")).toContainText("Waiting for an owner to approve it");

    // Approved by the owner, then emailed.
    await approval.getByLabel("Your decision").selectOption("approved");
    await approval.getByRole("button", { name: "Decide" }).click();
    await expect(owner.getByRole("region", { name: "Approval" })).toContainText("Approved at every step (Owner)");

    /**
     * The seeded company has connected no mail provider, so the send is refused
     * in words and kept on the order, and the order is NOT marked sent: a vendor
     * who never got it owes us nothing.
     */
    const send = owner.getByRole("region", { name: "Send to the vendor" });
    await send.getByLabel("Message").fill("Deliver to the back gate, please.");
    await send.getByRole("button", { name: "Email to vendor" }).click();
    await expect(send.getByRole("status")).toContainText(`Not sent to orders+${run}@watsco.test`);
    await owner.reload();
    await expect(owner.getByText(`to orders+${run}@watsco.test`)).toBeVisible();
    await expect(owner.getByText("Not sent", { exact: true })).toBeVisible();
    await expect(owner.locator("dl").getByText("Status", { exact: true }).locator("..")).toContainText("draft");
  } finally {
    // The step comes off again, so no other order in the seeded company waits on it.
    await owner.goto("/purchasing/approvals");
    await owner.getByRole("table", { name: "Approval steps" }).getByRole("row").filter({ hasText: "$40,000.00" })
      .getByRole("button", { name: "Remove" }).click();
    await expect(owner.getByText("No steps")).toBeVisible();
  }
});
