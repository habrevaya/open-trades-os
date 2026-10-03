import { test, expect, run } from "./fixtures";
import { fakeGoogle, forgetGoogleAds, pointGoogleAdsAt } from "./ads";

/**
 * CONNECTING GOOGLE ADS, AND SEEING WHAT IT COST AND WHAT IT RETURNED
 *
 * Through the screens an owner would use: a tracking campaign under Google
 * Ads; Google Ads connected on Settings, Integrations with the names of its
 * secrets; "Sign in with Google", which goes to Google's consent screen and
 * comes back connected; a customer who came from that campaign, booked,
 * invoiced and paid; "Pull now" on Marketing, Ad platforms, which pulls the
 * day's spend and files it under the campaign by its name; and Return on
 * spend, where the campaign's spend is the pulled figure and its revenue per
 * dollar is the paid job over it, every figure opening into its rows.
 *
 * Google is the one thing faked, at its edges (e2e/ads.ts): the consent screen
 * sends the browser straight back the way Google does after Allow, and the
 * token endpoint and the Ads API answer as Google documents. Three settings
 * with no screen point the connection at the fake.
 */

const money = (amount: string) =>
  `$${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

test("an owner connects Google Ads, signs in, and sees the pulled spend and its return", async ({ owner }) => {
  const google = await fakeGoogle();
  try {
    await forgetGoogleAds();
    const campaign = `Furnace push ${run}`;
    const today = new Date().toISOString().slice(0, 10);
    google.spend.push({ name: campaign, micros: "200000000" });

    // A tracking campaign under Google Ads, whose name the Ads account's campaign shares.
    await owner.goto("/marketing/tracking");
    await owner.getByLabel("Name").fill(campaign);
    await owner.getByLabel("Channel").selectOption({ label: "Google Ads" });
    await owner.getByRole("button", { name: "Start campaign" }).click();
    await expect(owner.getByRole("heading", { level: 1, name: campaign })).toBeVisible();

    // Google Ads, saved with the names of its secrets, and waiting for somebody to sign in.
    await owner.goto("/settings/integrations");
    const card = owner.getByRole("listitem").filter({ has: owner.getByText("Google Ads", { exact: true }) });
    await card.getByRole("button", { name: "Connect Google Ads" }).click();
    await card.getByLabel("Customer id").fill("123-456-7890");
    await card.getByLabel("Developer token, as the name of the secret holding it").fill("E2E_GOOGLE_ADS_DEVELOPER_TOKEN");
    await card.getByLabel(/^OAuth client, as the name of the secret/).fill("E2E_GOOGLE_OAUTH_CLIENT");
    await card.getByLabel("Conversion action id for booked jobs").fill("555");
    await card.getByRole("button", { name: "Save settings" }).click();
    await expect(card.getByText("Waiting for somebody to sign in")).toBeVisible();
    await pointGoogleAdsAt(google.base);

    // Signed in on Google's consent screen, and back.
    await owner.reload();
    await owner.getByRole("listitem").filter({ has: owner.getByText("Google Ads", { exact: true }) })
      .getByRole("button", { name: "Sign in with Google" }).click();
    await expect(owner).toHaveURL(/\/settings\/integrations\?signedIn=google_ads$/);
    await expect(owner.getByRole("status").filter({ hasText: "Google Ads is connected" })).toBeVisible();
    await expect(owner.getByRole("listitem").filter({ has: owner.getByText("Google Ads", { exact: true }) })
      .getByText("Connected", { exact: true })).toBeVisible();

    // A customer who came from the campaign, booked, invoiced and paid.
    await owner.goto("/customers/new");
    await owner.getByLabel("Name").fill(`Wren Calloway ${run}`);
    await owner.getByLabel("Phone").fill("512-555-0142");
    await owner.getByLabel("Street").fill("12 Pecan St");
    await owner.getByLabel("City").fill("Austin");
    await owner.getByLabel("State").fill("TX");
    await owner.getByLabel("ZIP").fill("78704");
    await owner.getByLabel("Where they came from").selectOption({ label: `Google Ads: ${campaign}` });
    await owner.getByRole("button", { name: "Save customer" }).click();
    await expect(owner.getByRole("heading", { level: 1, name: `Wren Calloway ${run}` })).toBeVisible();
    await owner.getByRole("link", { name: "12 Pecan St, Austin" }).click();
    await owner.getByRole("link", { name: "Book a job here" }).click();
    await owner.getByLabel("Summary").fill(`Furnace will not light ${run}`);
    await owner.getByRole("button", { name: "Book job" }).click();
    await expect(owner).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
    await owner.getByRole("link", { name: "Invoice this job" }).click();
    await owner.getByLabel("Line 1 description").fill("Igniter");
    await owner.getByLabel("Line 1 quantity").fill("1");
    await owner.getByLabel("Line 1 unit price").fill("500.00");
    await owner.getByRole("button", { name: "Create invoice" }).click();
    await expect(owner).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
    await owner.getByRole("link", { name: "Record a payment" }).click();
    await owner.getByLabel("How it was paid").selectOption("check");
    await owner.getByLabel("Cheque number").fill("3301");
    await owner.getByRole("button", { name: "Record payment" }).click();
    await expect(owner.getByRole("heading", { level: 1 }).locator("..").getByText("Paid", { exact: true })).toBeVisible();

    // Pulled now, filed under the campaign by its name.
    await owner.goto("/marketing/platforms");
    const platform = owner.getByRole("listitem", { name: "Google Ads" });
    await expect(platform.getByText("Connected", { exact: true })).toBeVisible();
    await platform.getByRole("button", { name: "Pull now" }).click();
    await expect(platform.getByRole("status")).toContainText("1 spend day");
    expect(google.searches).toBeGreaterThan(0);
    await owner.reload();
    const mapped = owner.getByRole("table", { name: "Platform campaigns" }).getByRole("row").filter({ hasText: campaign });
    await expect(mapped).toContainText("Matched by name");

    // The return: the pulled spend against the paid job, every figure opening into its rows.
    await owner.goto(`/marketing/roi?by=campaign&from=${today}&to=${today}`);
    await expect(owner.getByRole("region", { name: "Where the spend came from" })).toContainText("pulled from the platforms themselves");
    const row = owner.getByRole("table", { name: "Return on spend" }).getByRole("row").filter({ hasText: campaign });
    await expect(row.getByRole("link", { name: `${campaign} spend` })).toHaveText(money("200"));
    await expect(row.getByRole("link", { name: `${campaign} revenue` })).toHaveText(money("500"));
    await expect(row.getByRole("link", { name: `${campaign} booked` })).toHaveText("1");
    await expect(row).toContainText("2.50");
    await row.getByRole("link", { name: `${campaign} spend` }).click();
    await expect(owner.getByRole("table", { name: "Spend" })).toContainText("Pulled from Google Ads.");

    // By ad platform, Google Ads carries at least that spend.
    await owner.goto(`/marketing/roi?by=platform&from=${today}&to=${today}`);
    await expect(owner.getByRole("table", { name: "Return on spend" }).getByRole("row").filter({ hasText: "Google Ads" }).first())
      .toBeVisible();

    // And what Google was told: nothing, because nothing about this job could be matched, and the reason says so.
    await owner.goto("/marketing/platforms/sends");
    const send = owner.getByRole("table", { name: "Conversion sends" }).getByRole("row").filter({ hasText: `Wren Calloway ${run}` });
    await expect(send).toContainText("withheld");
    await expect(send).toContainText("nothing the platform could match");
  } finally {
    await google.close();
  }
});
