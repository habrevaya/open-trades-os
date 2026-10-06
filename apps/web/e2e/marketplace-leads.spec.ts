import { test, expect, run } from "./fixtures";
import { E2E_MARKETING_ENV } from "./marketing-env";
import { fakeMarketing, pointAt } from "./marketing-fakes";

/**
 * A THUMBTACK LEAD ARRIVING, BEING ANSWERED, AND BEING CREDITED
 *
 * Through the screens an owner would use: a tracking campaign for what the
 * company spends on Thumbtack; Thumbtack connected on Marketing, Lead offers,
 * Lead sources with its business id and the names of its secrets; Thumbtack
 * posting a lead to the address shown there (the one step Thumbtack takes);
 * the lead in the inbox with what Thumbtack charged; the customer's message
 * in the lead's conversation and a reply sent back through Thumbtack; and the
 * lead accepted into a job credited to the campaign, whose cost is on the
 * spend list. Thumbtack's API is the one thing faked (e2e/marketing-fakes.ts).
 */
test("a Thumbtack lead arrives, is answered through Thumbtack, and the job is credited to the campaign", async ({ owner }) => {
  const fake = await fakeMarketing();
  try {
    const campaign = `Thumbtack pro ${run}`;
    const lead = `tt-${run}`;
    const name = `Wren Calloway ${run}`;

    await owner.goto("/marketing/tracking");
    await owner.getByLabel("Name").fill(campaign);
    await owner.getByLabel("Channel").selectOption({ label: "A lead marketplace" });
    await owner.getByRole("button", { name: "Start campaign" }).click();
    await expect(owner.getByRole("heading", { level: 1, name: campaign })).toBeVisible();

    await owner.goto("/marketing/leads/connectors");
    const form = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Connect it" }) });
    await form.getByLabel("Marketplace").selectOption("thumbtack");
    await form.locator("#marketplace-channel").selectOption({ label: `A lead marketplace: ${campaign}` });
    await form.getByLabel("Business id (Thumbtack and Yelp)").fill("biz-e2e");
    await form.getByLabel(/^Access token, as the name of the secret/).fill("E2E_THUMBTACK_TOKEN");
    await form.getByLabel(/^Name to keep the password it posts with under/).fill("E2E_THUMBTACK_PASSWORD");
    await form.getByRole("button", { name: "Connect it" }).click();
    await expect(form.getByRole("status")).toContainText("Give Thumbtack the address ending /api/webhooks/leads/");
    await pointAt("thumbtack", fake.base);

    await owner.reload();
    const card = owner.getByRole("listitem", { name: "Thumbtack" });
    await expect(card.getByText("Connected", { exact: true })).toBeVisible();
    const path = (await card.locator("code").innerText()).trim();
    expect(path).toMatch(/^\/api\/webhooks\/leads\/[A-Za-z0-9_-]+$/);

    // Thumbtack posts the lead, with the password kept in the secret store under the name given.
    const auth = { authorization: `Basic ${Buffer.from(`thumbtack:${E2E_MARKETING_ENV.E2E_THUMBTACK_PASSWORD}`).toString("base64")}` };
    const refused = await owner.request.post(path, { headers: { authorization: "Basic eDp5" }, data: {} });
    expect(refused.status()).toBe(401);
    const posted = await owner.request.post(path, {
      headers: auth,
      data: {
        leadID: lead, createTimestamp: String(Math.floor(Date.now() / 1000)), price: "18.50",
        business: { businessID: "biz-e2e" },
        customer: { customerID: "c-e2e", name, phone: "+15125550142" },
        request: { category: "Furnace repair", description: "No heat since Sunday.",
          location: { address1: "12 Pecan St", city: "Austin", state: "TX", zipCode: "78704" } },
      },
    });
    expect(posted.status()).toBe(201);
    await owner.request.post(path, {
      headers: auth,
      data: { leadID: lead, businessID: "biz-e2e", message: { messageID: `m-${run}`, createTimestamp: String(Math.floor(Date.now() / 1000)), text: "Is Tuesday possible?" } },
    });

    // In the inbox, with what it cost and the conversation.
    await owner.goto("/marketing/leads");
    await owner.getByRole("link", { name }).first().click();
    await expect(owner.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(owner.getByText(`credited to ${campaign}`)).toBeVisible();
    await expect(owner.getByText("$18.50")).toBeVisible();
    const thread = owner.getByRole("list", { name: "Messages on this lead" });
    await expect(thread).toContainText("Is Tuesday possible?");

    await owner.getByLabel("Reply").fill("Tuesday at 10 works.");
    await owner.getByRole("button", { name: "Send through Thumbtack" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Sent." })).toBeVisible();
    expect(fake.replies).toEqual([{ lead, text: "Tuesday at 10 works.", authorization: `Bearer ${E2E_MARKETING_ENV.E2E_THUMBTACK_TOKEN}` }]);
    await owner.reload();
    await expect(owner.getByRole("list", { name: "Messages on this lead" })).toContainText("Tuesday at 10 works.");

    // Accepted, the job is credited to the campaign Thumbtack's leads are bought under.
    await owner.getByRole("button", { name: "Accept" }).click();
    await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
    await expect(owner.getByRole("region", { name: "Where this job came from" })).toContainText(campaign);

    // And what Thumbtack charged is on the spend list, against the campaign.
    await owner.goto("/marketing/spend");
    const charged = owner.getByRole("table", { name: "Spend" }).getByRole("row").filter({ hasText: campaign });
    await expect(charged).toContainText("What a marketplace charged for a lead");
    await expect(charged).toContainText("$18.50");
  } finally {
    await fake.close();
  }
});
