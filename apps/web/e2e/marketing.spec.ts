import { createHmac } from "node:crypto";
import { createClient, schema } from "@opentradesos/db";
import { eq } from "drizzle-orm";
import { test, expect, run } from "./fixtures";

/**
 * A CALL ON A CAMPAIGN'S NUMBER, THROUGH TO A PAID JOB, ON THE FUNNEL
 *
 * The story the marketing module exists to tell, through the screens an office
 * would use: a tracking campaign under Google Ads with what it cost, a tracking
 * number credited to it, a call arriving on that number from CallRail, the call
 * turned into a customer and a job from the call log, the job invoiced and
 * paid, and then the funnel by campaign, by number and by channel saying one
 * call, one lead, one booked job, the revenue, the cost per lead, the cost per
 * booked job and the return, with each of those opening into the rows behind it.
 *
 * CallRail is the one thing not on a screen: its webhook is signed with the
 * key the suite started the server with (e2e/callrail-env.ts) and posted to
 * the address the connection hands out, exactly as CallRail would post it.
 */

const money = (amount: string) =>
  `$${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Points the company's CallRail connection at the two secret names the server was started with. */
async function pointCallRailAtSuiteSecrets(connectionId: string): Promise<void> {
  const db = createClient();
  try {
    const [row] = await db.select({ settings: schema.integrationConnection.settings })
      .from(schema.integrationConnection).where(eq(schema.integrationConnection.id, connectionId)).limit(1);
    if (!row) throw new Error(`No connection ${connectionId}`);
    await db.update(schema.integrationConnection)
      .set({
        credentialRef: "E2E_CALLRAIL_KEY",
        settings: { ...row.settings, webhookSecretRef: "E2E_CALLRAIL_SIGNING" },
      })
      .where(eq(schema.integrationConnection.id, connectionId));
  } finally {
    await db.$close();
  }
}

test("a call on a tracking campaign's number becomes a paid job, and the funnel shows it by number, campaign and channel", async ({ owner }) => {
  const digits = String(Date.now()).slice(-7);
  const campaign = `Spring AC tune up ${run}`;
  const tracking = `+1737${digits}`;
  const caller = `+1512${String(Number(digits) + 1).padStart(7, "0").slice(-7)}`;
  const range = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  // A tracking campaign under Google Ads, with its link tag and its budget.
  await owner.goto("/marketing/tracking");
  await owner.getByLabel("Name").fill(campaign);
  await owner.getByLabel("Channel").selectOption({ label: "Google Ads" });
  await owner.getByLabel("Budget (a plan, never added to the cost)").fill("1500");
  await owner.getByLabel("Link tag (utm_campaign)").fill(`spring_${run}`);
  await owner.getByRole("button", { name: "Start campaign" }).click();
  await expect(owner).toHaveURL(/\/marketing\/tracking\/[0-9a-f-]{36}$/);
  await expect(owner.getByRole("heading", { level: 1, name: campaign })).toBeVisible();

  // What it cost today, typed against the campaign.
  await owner.goto("/marketing/spend");
  await owner.getByLabel("Spent on").selectOption({ label: `Google Ads: ${campaign}` });
  /**
   * The day the form offers, which is the company's today. Typing the UTC date
   * here instead recorded tomorrow's spend every evening in the Americas, and
   * the list, which ends on the company's today, then had nothing to show.
   */
  await expect(owner.getByLabel("Day")).not.toHaveValue("");
  await owner.getByLabel("Amount").fill("300.00");
  await owner.getByRole("button", { name: "Record spend" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Recorded" })).toBeVisible();
  await expect(owner.getByRole("table", { name: "Spend" })).toContainText(campaign);

  // A tracking number, its calls credited to the campaign.
  await owner.goto("/settings");
  await owner.getByRole("button", { name: "Add a number" }).click();
  const addForm = owner.locator("form").filter({ has: owner.locator("#n-e164") });
  await addForm.getByLabel("Number", { exact: true }).fill(tracking);
  await addForm.getByLabel("Label").fill(`Spring flyer ${run}`);
  await addForm.getByLabel("What it is for").selectOption("tracking");
  await addForm.getByLabel("Calls to it are credited to").selectOption({ label: `Google Ads: ${campaign}` });
  await addForm.getByRole("button", { name: "Add", exact: true }).click();
  const numberRow = owner.getByRole("listitem").filter({ hasText: `Spring flyer ${run}` });
  await expect(numberRow).toContainText(`credited to Google Ads: ${campaign}`);
  await expect(numberRow).toContainText("0 calls in 90 days");

  // CallRail, connected, and a call on the number, signed and posted as CallRail would.
  const connected = await owner.request.post("/api/v1/call-tracking/connect", { data: { accountId: "ACC0E2E" } });
  expect(connected.ok()).toBe(true);
  const connection = await connected.json() as { id: string; webhookPath: string };
  await pointCallRailAtSuiteSecrets(connection.id);
  const at = new Date();
  const body = JSON.stringify({
    resource_id: `CAL-e2e-${run}`,
    tracking_phone_number: tracking,
    customer_phone_number: caller,
    customer_name: "Caller",
    start_time: at.toISOString(),
    direction: "inbound",
    answered: true,
    duration: 214,
    voicemail: false,
    first_call: true,
    timestamp: at.toISOString(),
  });
  const delivered = await owner.request.post(connection.webhookPath, {
    headers: {
      "content-type": "application/json",
      signature: createHmac("sha1", "e2e-fake-callrail-signing-value-not-a-secret").update(body).digest("base64"),
    },
    data: body,
  });
  expect(delivered.status()).toBe(201);

  // On the call log, with its campaign, and turned into a customer and a job from there.
  await owner.goto(`/marketing/calls?from=${range(-2)}&to=${range(2)}`);
  const callRow = owner.getByRole("table", { name: "Calls" }).getByRole("row").filter({ hasText: campaign });
  await expect(callRow).toContainText("Google Ads");
  await expect(callRow).toContainText("First time");
  await callRow.getByRole("link", { name: "Create customer and job" }).click();
  await expect(owner.getByRole("heading", { level: 2, name: "Create customer and job from this call" })).toBeVisible();
  await owner.getByLabel("Name").fill(`Rosa Delgado ${run}`);
  await owner.getByLabel("Street").fill("41 Larkspur Ln");
  await owner.getByLabel("City").fill("Austin");
  await owner.getByLabel("State").fill("TX");
  await owner.getByLabel("ZIP").fill("78745");
  await owner.getByLabel("Summary").fill(`AC tune up ${run}`);
  await owner.getByRole("button", { name: "Create customer and job" }).click();

  await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  const origin = owner.getByRole("region", { name: "Where this job came from" });
  await expect(origin).toContainText(`Google Ads, ${campaign}`);
  await expect(origin).toContainText("worked out from what they did");
  await expect(origin).toContainText("a call to a tracking number");

  // Invoiced from the job, and paid in full.
  await owner.getByRole("link", { name: "Invoice this job" }).click();
  await owner.getByLabel("Line 1 description").fill("AC tune up");
  await owner.getByLabel("Line 1 quantity").fill("1");
  await owner.getByLabel("Line 1 unit price").fill("500.00");
  await owner.getByRole("button", { name: "Create invoice" }).click();
  await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  await owner.getByRole("link", { name: "Record a payment" }).click();
  await owner.getByLabel("How it was paid").selectOption("check");
  await owner.getByLabel("Cheque number").fill("2201");
  await owner.getByRole("button", { name: "Record payment" }).click();
  await expect(owner.getByRole("heading", { level: 1 }).locator("..").getByText("Paid", { exact: true })).toBeVisible();

  // The funnel, by campaign: the call, the lead, the job, the revenue and the return.
  await owner.goto(`/marketing?by=campaign&from=${range(-2)}&to=${range(2)}`);
  const funnel = owner.getByRole("table", { name: "The funnel" });
  const row = funnel.getByRole("row").filter({ hasText: campaign });
  await expect(row.getByRole("link", { name: `${campaign} spend` })).toHaveText(money("300"));
  await expect(row.getByRole("link", { name: `${campaign} calls` })).toHaveText("1");
  await expect(row.getByRole("link", { name: `${campaign} first time` })).toHaveText("1");
  await expect(row.getByRole("link", { name: `${campaign} leads` })).toHaveText("1");
  await expect(row.getByRole("link", { name: `${campaign} booked` })).toHaveText("1");
  await expect(row.getByRole("link", { name: `${campaign} revenue` })).toHaveText(money("500"));
  // Cost per lead and per booked job are both the $300 over one, and the return is 200 over 300.
  await expect(row).toContainText(money("300"));
  await expect(row).toContainText("66.67%");

  // Every number opens into the rows behind it.
  await row.getByRole("link", { name: `${campaign} calls` }).click();
  await expect(owner.getByRole("heading", { level: 1 })).toContainText(`Calls: ${campaign}`);
  await expect(owner.getByRole("table", { name: "Calls" }).getByRole("row")).toHaveCount(2);
  await expect(owner.getByRole("table", { name: "Calls" })).toContainText("Booked");
  await owner.goBack();
  await funnel.getByRole("row").filter({ hasText: campaign }).getByRole("link", { name: `${campaign} booked` }).click();
  await expect(owner.getByRole("table", { name: "Jobs" })).toContainText(`AC tune up ${run}`);
  await owner.goBack();
  await funnel.getByRole("row").filter({ hasText: campaign }).getByRole("link", { name: `${campaign} spend` }).click();
  await expect(owner.getByRole("table", { name: "Spend" })).toContainText(money("300"));

  // By number, the same story on the number's own row.
  await owner.goto(`/marketing?by=number&from=${range(-2)}&to=${range(2)}`);
  const byNumber = owner.getByRole("table", { name: "The funnel" }).getByRole("row").filter({ hasText: tracking });
  await expect(byNumber.getByRole("link", { name: `${tracking} calls` })).toHaveText("1");
  await expect(byNumber.getByRole("link", { name: `${tracking} booked` })).toHaveText("1");
  await expect(byNumber.getByRole("link", { name: `${tracking} revenue` })).toHaveText(money("500"));
  await expect(byNumber).toContainText("66.67%");

  // And by channel, where Google Ads carries at least this campaign's call and job.
  await owner.goto(`/marketing?by=channel&from=${range(-2)}&to=${range(2)}`);
  const google = owner.getByRole("table", { name: "The funnel" }).getByRole("row").filter({ hasText: "Google Ads" }).first();
  await expect(google.getByRole("link", { name: "Google Ads calls" })).not.toHaveText("0");
  await google.getByRole("link", { name: "Google Ads booked" }).click();
  await expect(owner.getByRole("table", { name: "Jobs" })).toContainText(`AC tune up ${run}`);

  // The number's settings row now counts the call.
  await owner.goto("/settings");
  await expect(owner.getByRole("listitem").filter({ hasText: `Spring flyer ${run}` })).toContainText("1 call in 90 days");
});
