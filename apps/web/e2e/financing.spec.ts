import { test, expect, run, newCustomer } from "./fixtures";
import { fakeWisetackApi, pointWisetackAt, statusChanged } from "./wisetack";

/**
 * FINANCING AN INVOICE, FROM THE OFFER TO THE MONEY
 *
 * The owner connects Wisetack the way a company would, with the plans on its
 * agreement; the invoice then shows "as low as" with "subject to approval" in
 * the same sentence; the office opens an application and gets the lender's
 * link; Wisetack (a local fake) funds the loan and says so with a signed
 * webhook; and the invoice is paid, with the funded loan and the lender's fee
 * on it. Everything between the edges is the product, running for real.
 */
test("the office offers financing on an invoice and sees it funded", async ({ owner }) => {
  const wisetack = await fakeWisetackApi();
  const name = `Dana Whitfield ${run}`;

  try {
    await owner.goto("/settings/integrations");
    let card = owner.getByRole("listitem").filter({ hasText: "Wisetack" }).first();
    if (await card.getByRole("button", { name: "Disconnect" }).count()) {
      await card.getByRole("button", { name: "Disconnect" }).click();
      await expect(card.getByRole("button", { name: "Connect Wisetack" })).toBeVisible();
    }
    await card.getByRole("button", { name: "Connect Wisetack" }).click();
    await card.getByLabel("API token, as the name of the secret holding it").fill("E2E_WISETACK_TOKEN");
    await card.getByLabel("Merchant id").fill("merchant-e2e");
    await card.getByLabel(/Webhook signing secret/).fill("E2E_WISETACK_SIGNING");
    await card.getByLabel(/Plans on your Wisetack agreement/).fill("12@0, 60@17.9");
    await card.getByLabel("Smallest amount Wisetack finances for you").fill("500");
    await card.getByLabel("Largest amount Wisetack finances for you").fill("25000");
    await card.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(card.getByRole("status")).toHaveText("Saved.");
    await owner.reload();
    card = owner.getByRole("listitem").filter({ hasText: "Wisetack" }).first();
    const webhookPath = (await card.locator("code").filter({ hasText: "/api/webhooks/financing/" }).textContent())!.trim();
    await pointWisetackAt(webhookPath.split("/").pop()!, wisetack.baseUrl);

    // A customer, a job and an invoice of $2,400.
    await newCustomer(owner, {
      name, phone: `(737) 555-${String(Date.now()).slice(-4)}`,
      address: { street: "88 Sycamore Bend", city: "Austin", state: "TX", zip: "78746" },
    });
    await owner.getByRole("link", { name: "88 Sycamore Bend, Austin" }).click();
    await owner.getByRole("link", { name: "Book a job here" }).click();
    await owner.getByLabel("Summary").fill(`Condenser replacement ${run}`);
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);
    await owner.getByLabel("Day", { exact: true }).fill(tomorrow);
    await owner.getByLabel("Arrives from").fill("09:00");
    await owner.getByLabel("Ray Ortiz").check();
    await owner.getByRole("button", { name: "Book job" }).click();
    await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
    await owner.getByRole("link", { name: "Invoice this job" }).click();
    await owner.getByLabel("Line 1 description").fill("Condenser, installed");
    await owner.getByLabel("Line 1 unit price").fill("2400.00");
    await owner.getByRole("button", { name: "Create invoice" }).click();
    await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);

    // The offer: the lowest payment on the agreement's plans, never without its caveat.
    const panel = owner.getByRole("region", { name: "Financing" });
    await expect(panel).toContainText("As low as $60.82 a month over 60 months at 17.9% APR");
    await expect(panel).toContainText("Subject to approval");

    // The office takes the link to hand over.
    await panel.getByLabel("How").selectOption("link");
    await panel.getByRole("button", { name: "Send the application link" }).click();
    await expect(panel.getByRole("status").filter({ hasText: "Give the customer this link to apply." })).toBeVisible();
    await expect(panel.getByRole("link", { name: /wisetack\.test\/apply\// })).toBeVisible();
    expect(wisetack.transactions).toHaveLength(1);
    const transaction = wisetack.transactions[0]!;
    expect(transaction.amount).toBe("2400.00");
    expect(transaction.authorization).toBe("Bearer e2e-fake-wisetack-api-token-not-a-secret");
    await owner.reload();
    await expect(panel.getByRole("table", { name: "Financing applications" })).toContainText("Link sent");

    // Wisetack funds it, less its fee, and says so.
    transaction.state = {
      transactionId: transaction.transactionId, status: "SETTLED",
      approvedLoanAmount: "2400.00", settledLoanAmount: "2400.00", processingFee: "96.00",
      loanTerms: { termLength: 60, apr: "17.9", monthlyPayment: "60.81" },
    };
    const signed = statusChanged(transaction.transactionId, "SETTLED");
    const delivered = await owner.request.post(webhookPath, {
      data: signed.body, headers: { "content-type": "application/json", "x-wisetack-signature": signed.signature },
    });
    expect(delivered.status()).toBe(200);
    expect((await delivered.json()) as Record<string, unknown>).toMatchObject({ handled: true, status: "funded" });

    // A forged copy is refused.
    const forged = await owner.request.post(webhookPath, {
      data: signed.body, headers: { "content-type": "application/json", "x-wisetack-signature": "0".repeat(64) },
    });
    expect(forged.status()).toBe(401);

    await owner.reload();
    await expect(owner.getByText("Paid", { exact: true }).first()).toBeVisible();
    const applications = panel.getByRole("table", { name: "Financing applications" });
    await expect(applications).toContainText("Funded");
    await expect(applications).toContainText("60 months at 17.9% APR");
    await expect(applications).toContainText("$96.00");

    // And it is on the financing report.
    await owner.goto("/invoices/financing");
    await expect(owner.getByRole("region", { name: "Financing report" })).toContainText("$2,400.00");
    await expect(owner.getByRole("table", { name: "Financing applications" })).toContainText(name);
  } finally {
    await wisetack.close();
  }
});
