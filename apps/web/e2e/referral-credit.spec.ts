import type { Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { referrals } from "@opentradesos/api/services";
import { test, expect, run, newCustomer } from "./fixtures";

/**
 * A REFERRAL REWARD'S CREDIT, ON THE REFERRER'S INVOICE
 *
 * A customer sends a neighbour who pays for a first job, and the company's
 * reward is a credit on the sender's account. The next bill to the sender offers
 * it, and one press takes it off. With the company's setting turned on, the
 * worker does it by itself on the sender's next bill (run here as the worker
 * runs it). The setting is a tick on the referrals page, off until ticked.
 */
async function api<T>(page: Page, method: "get" | "post" | "put", path: string, data?: unknown): Promise<T> {
  const response = await page.request[method](`/api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

const addressOf = (n: string) => ({ street: `${n} Reward Way`, city: "Austin", state: "TX", zip: "78704" });

/** A customer the referrer sent, whose first job is paid in full. */
async function neighbourWhoPaid(owner: Page, referrerId: string, name: string, n: string): Promise<string> {
  const referred = await newCustomer(owner, { name, address: addressOf(n) });
  const { data } = await api<{ data: { id: string }[] }>(owner, "get", `/v1/properties?customerId=${referred}`);
  await api(owner, "put", `/v1/customers/${referred}/referrer`, { referrerId });
  const job = await api<{ id: string }>(owner, "post", "/v1/jobs", { customerId: referred, propertyId: data[0]!.id, summary: `Tune up ${name}` });
  const invoice = await api<{ id: string }>(owner, "post", "/v1/invoices", {
    customerId: referred, jobId: job.id,
    lines: [{ name: "Tune up", quantity: "1", unitPrice: "150.00", discountAmount: "0", taxable: false }],
  });
  await api(owner, "post", "/v1/payments", {
    customerId: referred, method: "check", amount: "150.00",
    allocations: [{ invoiceId: invoice.id, amount: "150.00" }],
  });
  return invoice.id;
}

/** The worker's pass over the company that owns this invoice, run as the worker runs it. */
async function inCompanyOf<T>(invoiceId: string, pass: (db: ReturnType<typeof createClient>, organizationId: string) => Promise<T>): Promise<T> {
  const db = createClient();
  try {
    const [row] = await db.select({ organizationId: schema.invoice.organizationId })
      .from(schema.invoice).where(eq(schema.invoice.id, invoiceId)).limit(1);
    if (!row) throw new Error(`No invoice ${invoiceId}`);
    return await pass(db, row.organizationId);
  } finally {
    await db.$close();
  }
}
const grantRewards = (invoiceId: string) => inCompanyOf(invoiceId, (db, org) => referrals.grantDue(db, org));
const applyRewards = (invoiceId: string) => inCompanyOf(invoiceId, (db, org) => referrals.applyDue(db, org));

test("a referral reward's credit comes off the referrer's invoice when the office presses, and by itself when the company says so", async ({ owner }) => {
  test.setTimeout(180_000);
  const referrerName = `Rosa Credit ${run}`;
  const referrerId = await newCustomer(owner, { name: referrerName, address: addressOf(`${run.slice(-3)}1`) });

  /** A company that sets a reward and says nothing more is on the default, which is off. */
  await api(owner, "put", "/v1/marketing/referral-settings", { reward: "credit_note", amount: "25" });
  await owner.goto("/marketing/referrals");
  await expect(owner.getByLabel("Take a credit off their next invoice by itself")).not.toBeChecked();

  const firstPaid = await neighbourWhoPaid(owner, referrerId, `Ned Credit ${run}`, `${run.slice(-3)}2`);
  expect((await grantRewards(firstPaid)).granted).toBeGreaterThanOrEqual(1);

  /** The sender's next bill offers the credit, and one press takes it off. */
  const bill = await api<{ id: string }>(owner, "post", "/v1/invoices", {
    customerId: referrerId,
    lines: [{ name: "Gutter clean", quantity: "1", unitPrice: "90.00", discountAmount: "0", taxable: false }],
  });
  await owner.goto(`/invoices/${bill.id}`);
  const offer = owner.getByRole("region", { name: "Referral reward credit" });
  await expect(offer).toContainText(`For sending Ned Credit ${run}`);
  await offer.getByRole("button", { name: "Take $25.00 off this invoice" }).click();
  /** Used, so the page no longer offers it. */
  await expect(owner.getByRole("region", { name: "Referral reward credit" })).toHaveCount(0);
  expect((await api<{ balance: string }>(owner, "get", `/v1/invoices/${bill.id}`)).balance).toBe("65.0000");

  /** Ticked, saved, and still ticked after a reload. */
  await owner.goto("/marketing/referrals");
  await owner.getByLabel("Take a credit off their next invoice by itself").check();
  await owner.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await owner.reload();
  await expect(owner.getByLabel("Take a credit off their next invoice by itself")).toBeChecked();

  /** The next reward and the next bill: the worker puts the one on the other. */
  const secondPaid = await neighbourWhoPaid(owner, referrerId, `Pia Credit ${run}`, `${run.slice(-3)}3`);
  expect((await grantRewards(secondPaid)).granted).toBeGreaterThanOrEqual(1);
  const next = await api<{ id: string }>(owner, "post", "/v1/invoices", {
    customerId: referrerId,
    lines: [{ name: "Furnace filter", quantity: "1", unitPrice: "60.00", discountAmount: "0", taxable: false }],
  });
  expect((await applyRewards(next.id)).applied).toBeGreaterThanOrEqual(1);
  expect((await api<{ balance: string }>(owner, "get", `/v1/invoices/${next.id}`)).balance).toBe("35.0000");
  await owner.goto("/marketing/referrals");
  await expect(owner.getByRole("row").filter({ hasText: `Pia Credit ${run}` })).toContainText("Used by itself");
});
