import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A FILE THE OFFICE MARKS FOR THE CUSTOMER SHOWS IN THEIR DOCUMENTS, AND NO OTHER
 *
 * The office books a job, adds two PDFs to it and shows one of them to the
 * customer. The customer opens their account link: the documents block lists
 * the one that was shown, with the invoice as a PDF, and opens the file; the
 * other is nowhere and its address is a 404. Stopping showing it takes it away.
 */
test("a file the office shows the customer is in their documents, and one it does not is not", async ({ owner, stranger, baseURL }) => {
  const name = `Pia Papers ${run}`;
  let restore: boolean | null = null;

  try {
    // The documents block is on the page.
    await owner.goto("/settings/portal/layout");
    const show = owner.getByLabel("Show Your documents");
    restore = await show.isChecked();
    if (!restore) {
      await show.check();
      await owner.getByRole("button", { name: "Save layout" }).click();
      await expect(owner.getByRole("status").filter({ hasText: "Customers see it this way" })).toBeVisible();
    }

    const customerId = await newCustomer(owner, {
      name, address: { street: "7 Folio Lane", city: "Austin", state: "TX", zip: "78745" },
    });
    await owner.getByRole("link", { name: "7 Folio Lane, Austin" }).click();
    await owner.getByRole("link", { name: "Book a job here" }).click();
    await owner.getByLabel("Summary").fill(`Panel inspection ${run}`);
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);
    await owner.getByLabel("Day", { exact: true }).fill(tomorrow);
    await owner.getByLabel("Arrives from").fill("10:00");
    await owner.getByLabel("Ray Ortiz").check();
    await owner.getByRole("button", { name: "Book job" }).click();
    await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
    const jobUrl = owner.url();

    // Two files; both private.
    const files = owner.getByRole("region", { name: "Files" });
    for (const file of ["permit.pdf", "internal-costs.pdf"]) {
      await files.getByLabel("A PDF or a photo").setInputFiles({
        name: file, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n% ${file}\n%%EOF\n`),
      });
      await files.getByRole("button", { name: "Add the file" }).click();
      await expect(files.getByRole("listitem").filter({ hasText: file })).toContainText("private");
    }
    const permit = files.getByRole("listitem").filter({ hasText: "permit.pdf" });
    await permit.getByRole("button", { name: "Show the customer" }).click();
    await expect(permit).toContainText("shown to the customer");
    await expect(files.getByRole("listitem").filter({ hasText: "internal-costs.pdf" })).toContainText("private");

    // An invoice, so the documents block has a PDF of it too.
    await owner.getByRole("link", { name: "Invoice this job" }).click();
    await owner.getByLabel("Line 1 description").fill("Inspection");
    await owner.getByLabel("Line 1 unit price").fill("95.00");
    await owner.getByRole("button", { name: "Create invoice" }).click();
    await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
    const invoiceNumber = (await owner.getByRole("heading", { level: 1 }).textContent())!.replace(/\D/g, "");

    await owner.goto(`/customers/${customerId}`);
    await owner.getByRole("button", { name: "Get their account link" }).click();
    const accountLink = owner.getByRole("link", { name: /\/c\// });
    await expect(accountLink).toBeVisible();
    const forAccount = (await accountLink.getAttribute("href"))!;

    await stranger.goto(forAccount);
    const documents = stranger.getByRole("region", { name: "Your documents" });
    await expect(documents.getByRole("link", { name: "permit.pdf" })).toBeVisible();
    await expect(documents.getByText("internal-costs.pdf")).toHaveCount(0);
    await expect(documents.getByRole("link", { name: new RegExp(`Invoice #${invoiceNumber}.*\\(PDF\\)`) })).toBeVisible();
    expect(await stranger.content()).not.toContain("internal-costs.pdf");

    const opened = await stranger.request.get(new URL((await documents.getByRole("link", { name: "permit.pdf" }).getAttribute("href"))!, baseURL!).toString());
    expect(opened.status()).toBe(200);
    expect(opened.headers()["content-type"]).toContain("application/pdf");
    expect(await opened.text()).toContain("permit.pdf");

    // The invoice PDF opens too.
    const pdfHref = await documents.getByRole("link", { name: new RegExp(`Invoice #${invoiceNumber}`) }).getAttribute("href");
    const pdf = await stranger.request.get(new URL(pdfHref!, baseURL!).toString());
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toContain("application/pdf");

    // Stopping showing it takes it away, and its address stops working.
    const fileHref = new URL((await documents.getByRole("link", { name: "permit.pdf" }).getAttribute("href"))!, baseURL!).toString();
    await owner.goto(jobUrl);
    await owner.getByRole("region", { name: "Files" }).getByRole("listitem").filter({ hasText: "permit.pdf" })
      .getByRole("button", { name: "Stop showing the customer" }).click();
    await expect(owner.getByRole("region", { name: "Files" }).getByRole("listitem").filter({ hasText: "permit.pdf" })).toContainText("private");
    expect((await stranger.request.get(fileHref)).status()).toBe(404);
    await stranger.reload();
    await expect(stranger.getByText("permit.pdf")).toHaveCount(0);
  } finally {
    if (restore === false) {
      await owner.goto("/settings/portal/layout");
      await owner.getByLabel("Show Your documents").uncheck();
      await owner.getByRole("button", { name: "Save layout" }).click();
      await expect(owner.getByRole("status").filter({ hasText: "Customers see it this way" })).toBeVisible();
    }
  }
});
