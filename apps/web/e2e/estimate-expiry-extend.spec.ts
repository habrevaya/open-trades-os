import { sql } from "drizzle-orm";
import { createClient } from "@opentradesos/db";
import { test, expect, run, newCustomer, companyToday } from "./fixtures";

/**
 * AN EXPIRED ESTIMATE GIVEN LONGER
 *
 * An estimate goes out after its date, so it is expired. The customer rings
 * and asks the office to hold the price. The office moves the date later on
 * the estimate's page with a reason; the estimate is open again, back on the
 * unsold list, with the same price, and the customer's link opens it.
 */

const plus = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

test("the office gives a customer longer to answer an expired estimate, and nothing priced changes", async ({ owner, stranger }) => {
  const name = `Hollis Longer ${run}`;
  const customerId = await newCustomer(owner, {
    name, address: { street: "9 Patience Path", city: "Austin", state: "TX", zip: "78701" },
  });
  const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}`);
  const propertyId = ((await places.json()) as { data: { id: string }[] }).data[0]!.id;
  const title = `Hold the price ${run}`;
  const made = await owner.request.post("/api/v1/estimates", {
    data: {
      customerId, propertyId, title, expiresOn: plus(companyToday(), -3),
      options: [{ name: "Replace", isRecommended: true, lines: [{ name: "Heater", quantity: "1", unitPrice: "1450.00", discountAmount: "0", taxable: false }] }],
    },
  });
  expect(made.ok()).toBe(true);
  const id = ((await made.json()) as { id: string }).id;
  const sent = await owner.request.post(`/api/v1/estimates/${id}/send`, { data: { channel: "link" } });
  expect(sent.ok()).toBe(true);
  const link = ((await sent.json()) as { approvalUrl: string }).approvalUrl;

  await owner.goto(`/estimates/${id}`);
  await expect(owner.getByText("Expired", { exact: true })).toBeVisible();
  const later = plus(companyToday(), 14);
  await owner.getByText("Give them longer to answer").click();
  await owner.getByLabel("New good until date").fill(later);
  await owner.getByLabel("Why").fill("Waiting on their insurer.");
  await owner.getByRole("button", { name: "Move the date" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "The link they were sent works until then." })).toBeVisible();
  await owner.reload();
  await expect(owner.getByText("Sent", { exact: true }).first()).toBeVisible();
  await expect(owner.getByText("Expired", { exact: true })).toHaveCount(0);
  await expect(owner.getByText("$1,450.00").first()).toBeVisible();

  // Back on the unsold list.
  const unsold = await owner.request.get("/api/v1/unsold-estimates");
  expect(JSON.stringify(await unsold.json())).toContain(id);

  // The customer's link opens it, with the price they were sent.
  await stranger.goto(link);
  await expect(stranger.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(stranger.getByText("1450.00").or(stranger.getByText("1,450.00")).first()).toBeVisible();
});

test("giving a customer longer starts the follow up again from today, unless the office ticks the box to leave it alone", async ({ owner }) => {
  const customerId = await newCustomer(owner, {
    name: `Ines Again ${run}`, address: { street: "3 Again Alley", city: "Austin", state: "TX", zip: "78701" },
  });
  const places = await owner.request.get(`/api/v1/properties?customerId=${customerId}`);
  const propertyId = ((await places.json()) as { data: { id: string }[] }).data[0]!.id;

  /** Sent, with a date that is still a few days off. */
  const sentEstimate = async (title: string) => {
    const made = await owner.request.post("/api/v1/estimates", {
      data: {
        customerId, propertyId, title, expiresOn: plus(companyToday(), 3),
        options: [{ name: "Replace", isRecommended: true, lines: [{ name: "Heater", quantity: "1", unitPrice: "900.00", discountAmount: "0", taxable: false }] }],
      },
    });
    expect(made.ok()).toBe(true);
    const id = ((await made.json()) as { id: string }).id;
    expect((await owner.request.post(`/api/v1/estimates/${id}/send`, { data: { channel: "link" } })).ok()).toBe(true);
    return id;
  };
  const startedAgain = async (id: string) => {
    const db = createClient();
    try {
      const [row] = await db.execute<{ follow_up_from: string | null }>(
        sql`select follow_up_from::text from public.estimate where id = ${id}::uuid`);
      return row!.follow_up_from !== null;
    } finally {
      await db.$close();
    }
  };
  const giveLonger = async (id: string, days: number, leaveAlone: boolean) => {
    await owner.goto(`/estimates/${id}`);
    await owner.getByText("Give them longer to answer").click();
    await owner.getByLabel("New good until date").fill(plus(companyToday(), days));
    await owner.getByLabel("Why").fill("Waiting on their insurer.");
    if (leaveAlone) await owner.getByLabel("Leave the follow up alone.").check();
    await owner.getByRole("button", { name: "Move the date" }).click();
  };

  const usual = await sentEstimate(`Start again ${run}`);
  await giveLonger(usual, 14, false);
  await expect(owner.getByRole("status").filter({ hasText: "The follow up counts its days from today." })).toBeVisible();
  expect(await startedAgain(usual)).toBe(true);

  const quiet = await sentEstimate(`Leave alone ${run}`);
  await giveLonger(quiet, 14, true);
  await expect(owner.getByRole("status").filter({ hasText: "The follow up was left alone." })).toBeVisible();
  expect(await startedAgain(quiet)).toBe(false);
});
