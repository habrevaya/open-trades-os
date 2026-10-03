import type { Page } from "@playwright/test";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * M12 IN A BROWSER: A CHANGE ORDER THE CUSTOMER SIGNS, AND AN APPLICATION FOR
 * PAYMENT THAT BECOMES AN INVOICE.
 *
 * The two flows on a project where money changes hands. A change order is
 * logged and priced in the office, the link goes to the customer, who signs
 * it on their own device with nobody signed in, and only then does the
 * contract on the office's screen move. An application is filled in line by
 * line, worked through to a payment due with retainage held, and raised as
 * an invoice for exactly that.
 */

/** A project for a fresh customer, through the office's own form, and its phases. */
async function startProject(owner: Page, input: {
  name: string; customer: string; contract: string; phases: { name: string; value: string }[];
}): Promise<string> {
  const customerId = await newCustomer(owner, {
    name: input.customer, address: { street: "14 Hillcrest Dr", city: "Austin", state: "TX", zip: "78701" },
  });
  await owner.goto("/projects");
  await owner.getByRole("link", { name: "Start a project" }).click();
  await owner.getByLabel("Customer").selectOption(customerId);
  await owner.getByRole("button", { name: "Next" }).click();
  await owner.getByLabel("Name").fill(input.name);
  await owner.getByLabel("Contract value").fill(input.contract);
  await owner.getByRole("button", { name: "Start project" }).click();
  await expect(owner).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  const projectId = owner.url().split("/").pop()!;

  for (const phase of input.phases) {
    await owner.getByPlaceholder("Rough-in", { exact: true }).fill(phase.name);
    await owner.getByPlaceholder("Billing value").fill(phase.value);
    await owner.getByRole("button", { name: "Add phase" }).click();
    await expect(owner.getByText(phase.name).first()).toBeVisible();
  }
  return projectId;
}

test("Change order: priced in the office, signed by the customer on their link, and only then on the contract", async ({ owner, stranger }) => {
  const projectId = await startProject(owner, {
    name: `Hillcrest fit out ${run}`, customer: `Pat Owner ${run}`, contract: "40000.00",
    phases: [{ name: "Rough in", value: "25000.00" }, { name: "Finishes", value: "15000.00" }],
  });

  await owner.getByRole("navigation", { name: "Project" }).getByRole("link", { name: "Change orders" }).click();
  await owner.getByLabel("What is the change").fill("Two more circuits in the kitchen");
  await owner.getByLabel("Asked for by").fill("Pat");
  await owner.getByLabel("Phase it lands on").selectOption({ label: "Rough in" });
  await owner.getByRole("button", { name: "Log change" }).click();
  await expect(owner).toHaveURL(/\/change-orders\/[0-9a-f-]{36}$/);
  await expect(owner.getByRole("heading", { level: 1 })).toContainText("Change order 1: Two more circuits in the kitchen");

  const typed = owner.getByRole("group", { name: "Typed by hand" });
  await typed.getByLabel("What it is").fill("Dedicated 20A circuit");
  await typed.getByLabel("Quantity").fill("2");
  await typed.getByLabel("Price", { exact: true }).fill("450.00");
  await typed.getByRole("button", { name: "Add line" }).click();
  await expect(owner.getByRole("cell", { name: "Dedicated 20A circuit" })).toBeVisible();
  await expect(owner.getByText("Priced, not sent")).toBeVisible();

  await owner.getByLabel("Just give me the link").check();
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  const link = owner.getByRole("link", { name: /\/co\// });
  await expect(link).toBeVisible();
  const path = new URL((await link.getAttribute("href"))!).pathname;

  /** The contract has not moved: a change order with the customer is a question, not an answer. */
  await owner.goto(`/projects/${projectId}`);
  await expect(owner.getByText("$40,000.00").first()).toBeVisible();

  await stranger.goto(path);
  await expect(stranger.getByRole("heading", { level: 1 })).toContainText("Change order 1: Two more circuits in the kitchen");
  await expect(stranger.getByText("This adds $900.00 to your contract of $40,000.00, making it $40,900.00.")).toBeVisible();
  await stranger.getByLabel("Your name").fill(`Pat Owner ${run}`);
  await stranger.getByRole("button", { name: "Approve and sign" }).click();
  await expect(stranger.getByText("Approved", { exact: true })).toBeVisible();
  await expect(stranger.getByText(`Signed by Pat Owner ${run}. Your contract is now $40,900.00.`)).toBeVisible();

  await owner.goto(`/projects/${projectId}/change-orders`);
  const row = owner.getByRole("row").filter({ hasText: "Two more circuits in the kitchen" });
  await expect(row).toContainText("Agreed");
  await expect(row).toContainText("$40,900.00");
  await owner.goto(`/projects/${projectId}`);
  await expect(owner.getByText("$40,900.00").first()).toBeVisible();
});

test("Application for payment: filled in line by line, retainage held, and raised as an invoice for what is due", async ({ owner }) => {
  const projectId = await startProject(owner, {
    name: `Riverside build ${run}`, customer: `Riverside Plaza ${run}`, contract: "20000.00",
    phases: [{ name: "Framing", value: "12000.00" }, { name: "Finishes", value: "8000.00" }],
  });

  await owner.getByRole("navigation", { name: "Project" }).getByRole("link", { name: "Applications for payment" }).click();
  await owner.getByLabel("Retainage on work, %").fill("10");
  await owner.getByLabel("Retainage on stored materials, %").fill("10");
  await owner.getByRole("button", { name: "Start application" }).click();
  await expect(owner).toHaveURL(new RegExp(`/projects/${projectId}/applications/[0-9a-f-]{36}$`));
  await expect(owner.getByRole("heading", { level: 1 })).toContainText("application 1");

  await owner.getByLabel("Framing, work this period").fill("6000");
  await owner.getByLabel("Finishes, stored now").fill("1000");
  await owner.getByRole("button", { name: "Save" }).click();

  /** 6,000 of work and 1,000 stored, 10% held on each: 7,000 less 700 is 6,300 due. */
  const summary = owner.getByRole("region", { name: "Summary" });
  await expect(summary).toContainText("$7,000.00");
  await expect(summary).toContainText("$700.00");
  await expect(summary).toContainText(/Payment due now\s*\$6,300\.00/);

  await owner.getByRole("button", { name: "Raise the invoice" }).click();
  await expect(owner.getByText("Invoiced", { exact: true })).toBeVisible();
  await owner.getByRole("link", { name: "Its invoice" }).click();
  await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  await expect(owner.getByText("$6,300.00").first()).toBeVisible();
  await expect(owner.getByText("Framing").first()).toBeVisible();

  await owner.goto(`/projects/${projectId}/applications`);
  await expect(owner.getByRole("link", { name: /Application 1/ })).toContainText("$6,300.00");
});
