import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient, schema } from "@opentradesos/db";
import { and, eq } from "drizzle-orm";
import { test, expect, run } from "./fixtures";
import { E2E_TWILIO_ENV } from "./twilio-env";

/**
 * TRACKING NUMBERS, THE WEBSITE AND LEAD FORMS, THROUGH THE SCREENS
 *
 * A number bought from the company's own Twilio account on the settings
 * screen, a call to it that nobody answers and the voicemail it leaves played
 * back on the call screen; a pool number swapped onto the website test page;
 * a lead form built in the office and filled in on its hosted page; and a
 * customer's referral code. Twilio is the one thing not on a screen: its API
 * is a local fake reached through the adapter's own `baseUrl` setting, and
 * its webhooks are signed with the token the server was started with, posted
 * to the address the number was bought with.
 */

const PORT = Number(process.env["E2E_PORT"] ?? 3100);
const BASE = `http://localhost:${PORT}`;
const AUTH = E2E_TWILIO_ENV.E2E_TWILIO_TOKEN;
const ACCOUNT = "ACe2e";

interface FakeTwilio { baseUrl: string; bought: string[]; deleted: string[]; close(): Promise<void> }

/** Twilio's number, purchase, release and recording endpoints, on localhost. */
async function fakeTwilio(available: string[]): Promise<FakeTwilio> {
  const bought: string[] = [];
  const deleted: string[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      const path = request.url ?? "";
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.method === "GET" && path.includes("/AvailablePhoneNumbers/US/Local.json")) {
        const free = available.filter((n) => !bought.includes(n));
        return json(200, { available_phone_numbers: free.map((n) => ({ phone_number: n, friendly_name: n, locality: "Austin", region: "TX" })) });
      }
      if (request.method === "POST" && path.endsWith("/IncomingPhoneNumbers.json")) {
        const e164 = new URLSearchParams(body).get("PhoneNumber") ?? "";
        bought.push(e164);
        return json(201, { sid: `PN${bought.length}${run}`, phone_number: e164 });
      }
      if (request.method === "GET" && path.endsWith(".mp3")) {
        response.writeHead(200, { "content-type": "audio/mpeg" });
        response.end(Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 7, 7, 7]));
        return;
      }
      if (request.method === "DELETE") {
        deleted.push(path);
        response.writeHead(204);
        response.end();
        return;
      }
      json(404, { message: `The fake has no ${request.method} ${path}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`, bought, deleted,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The company's Twilio connection, pointed at the fake and the suite's token, and its webhook token. */
async function connectTwilio(baseUrl: string): Promise<string> {
  const db = createClient();
  try {
    const [org] = await db.select({ id: schema.organization.id }).from(schema.organization)
      .where(eq(schema.organization.slug, "ridgeline")).limit(1);
    const token = randomBytes(32).toString("base64url");
    await db.insert(schema.integrationConnection).values({
      organizationId: org!.id, capability: "messaging", provider: "twilio", status: "connected",
      credentialRef: "E2E_TWILIO_TOKEN", settings: { accountSid: ACCOUNT, webhookToken: token, baseUrl },
    }).onConflictDoUpdate({
      target: [schema.integrationConnection.organizationId, schema.integrationConnection.capability, schema.integrationConnection.provider],
      set: { status: "connected", credentialRef: "E2E_TWILIO_TOKEN", settings: { accountSid: ACCOUNT, webhookToken: token, baseUrl } },
    });
    return token;
  } finally {
    await db.$close();
  }
}

/**
 * Off again afterwards, so the specs after this one see the company as the
 * seed left it: no carrier, and nothing trying to reach a fake that has gone.
 */
async function disconnectTwilio(): Promise<void> {
  const db = createClient();
  try {
    await db.update(schema.integrationConnection).set({ status: "disconnected" })
      .where(and(eq(schema.integrationConnection.provider, "twilio"), eq(schema.integrationConnection.capability, "messaging")));
  } finally {
    await db.$close();
  }
}

/** A request exactly as Twilio makes it: form encoded, signed over the public URL. */
async function carrier(token: string, step: string | null, form: Record<string, string>): Promise<Response> {
  const url = `${BASE}/api/webhooks/voice/${token}${step ? `/${step}` : ""}`;
  const data = Object.keys(form).sort().reduce((acc, key) => acc + key + form[key], url);
  const signature = createHmac("sha1", AUTH).update(Buffer.from(data, "utf8")).digest("base64");
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    body: new URLSearchParams(form).toString(),
  });
}

async function callId(sid: string): Promise<string> {
  const db = createClient();
  try {
    const [row] = await db.select({ id: schema.call.id }).from(schema.call)
      .where(eq(schema.call.providerCallId, `twilio:${sid}`)).limit(1);
    return row!.id;
  } finally {
    await db.$close();
  }
}

const digits = () => String(Date.now()).slice(-7);

test("a number bought from Twilio answers its calls, keeps the voicemail nobody picked up, and plays it on the call", async ({ owner }) => {
  const tracking = `+1737${digits()}`;
  const pool = `+1737${String(Number(digits()) + 7).padStart(7, "0").slice(-7)}`;
  const twilio = await fakeTwilio([tracking, pool]);
  const token = await connectTwilio(twilio.baseUrl);
  try {
    // Search, pick, and buy it credited to Google Ads, ringing the main line.
    await owner.goto("/settings");
    await owner.getByLabel("Area code").fill("737");
    await owner.getByRole("button", { name: "Find numbers" }).click();
    const buy = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Buy this number" }) });
    await expect(buy.getByRole("radio").first()).toBeVisible();
    await buy.getByRole("radio").first().check();
    await buy.getByLabel("Calls to it are credited to").selectOption({ label: "Google Ads, no campaign" });
    await buy.getByLabel("Label").fill(`Truck wrap ${run}`);
    await buy.getByLabel("Ring this number").fill("+15125550143");
    await buy.getByRole("button", { name: "Buy this number" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Its calls now ring here first" })).toBeVisible();
    const row = owner.getByRole("listitem").filter({ hasText: `Truck wrap ${run}` });
    await expect(row.getByRole("button", { name: "Hand it back to Twilio" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Save how it rings" })).toBeVisible();

    // A call to it that nobody answers.
    const sid = `CA${randomBytes(8).toString("hex")}`;
    const caller = `+1512${digits()}`;
    const rang = await carrier(token, null, { CallSid: sid, From: caller, To: twilio.bought[0]!, Direction: "inbound" });
    expect(rang.status).toBe(200);
    expect(rang.headers.get("content-type")).toContain("text/xml");
    expect(await rang.text()).toContain("<Dial");
    const unanswered = await carrier(token, "dialed", { CallSid: sid, DialCallStatus: "no-answer" });
    expect(await unanswered.text()).toContain("<Record");
    const forged = await fetch(`${BASE}/api/webhooks/voice/${token}/dialed`, {
      method: "POST", headers: { "x-twilio-signature": "forged" }, body: `CallSid=${sid}&DialCallStatus=completed`,
    });
    expect(forged.status).toBe(403);
    const left = await carrier(token, "voicemail", {
      CallSid: sid, RecordingSid: `RE${run}`, RecordingStatus: "completed",
      RecordingUrl: `${twilio.baseUrl}/2010-04-01/Accounts/${ACCOUNT}/Recordings/RE${run}`,
    });
    expect(left.status).toBe(200);
    expect(twilio.deleted.some((p) => p.includes(`/Recordings/RE${run}.json`))).toBe(true);

    // The call screen says where it went and plays what they said.
    const id = await callId(sid);
    await owner.goto(`/marketing/calls/${id}`);
    await expect(owner.getByText("Where it went")).toBeVisible();
    await expect(owner.getByRole("heading", { name: "Voicemail" })).toBeVisible();
    await expect(owner.locator(`audio[src="/marketing/calls/${id}/voicemail"]`)).toBeVisible();
    const audio = await owner.request.get(`/marketing/calls/${id}/voicemail`);
    expect(audio.status()).toBe(200);
    expect(audio.headers()["content-type"]).toBe("audio/mpeg");

    // A pool number for the website, and the snippet swapping it onto the test page.
    await owner.goto("/settings");
    await owner.getByLabel("Area code").fill("737");
    await owner.getByRole("button", { name: "Find numbers" }).click();
    const poolBuy = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Buy this number" }) });
    await poolBuy.getByLabel("What it is for").selectOption("pool");
    await poolBuy.getByLabel("Ring this number").fill("+15125550143");
    await poolBuy.getByRole("button", { name: "Buy this number" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Its calls now ring here first" })).toBeVisible();

    await owner.goto("/settings/website");
    await expect(owner.getByLabel("The snippet to paste")).toContainText("/t.js?c=ridgeline");
    await expect(owner.getByRole("listitem").filter({ hasText: "737" }).first()).toBeVisible();
    await owner.getByRole("link", { name: "Try it on a test page" }).click();
    const sample = owner.getByTestId("swap-sample");
    const shown = twilio.bought[1]!.slice(2);
    await expect(sample.locator('[data-number="plain"]')).toHaveText(`(${shown.slice(0, 3)}) ${shown.slice(3, 6)}-${shown.slice(6)}`);
    await expect(sample.locator('[data-number="dots"]')).toHaveText(`${shown.slice(0, 3)}.${shown.slice(3, 6)}.${shown.slice(6)}`);
    await expect(sample.locator('[data-number="link"]')).toHaveAttribute("href", `tel:${twilio.bought[1]}`);
    await expect(sample.locator('[data-link="book"]')).toHaveAttribute("href", /otv=[0-9a-f]{32}/);

    // The missed call text back, from the recommended list.
    await owner.goto("/automations");
    const card = owner.getByRole("region", { name: "Text back a missed call" });
    await card.getByRole("button", { name: "Turn on" }).click();
    await expect(card.getByText("On", { exact: true })).toBeVisible();
  } finally {
    await disconnectTwilio();
    await twilio.close();
  }
});

test("a lead form built in the office is filled in on its own page and lands in the office queue", async ({ owner, stranger }) => {
  const slug = `quote-${run}`;
  await owner.goto("/marketing/forms");
  await owner.getByLabel("Title").fill(`Free AC check ${run}`);
  await owner.getByLabel("Short name").fill(slug);
  await owner.getByRole("button", { name: "Start form" }).click();
  await expect(owner).toHaveURL(new RegExp(`/marketing/forms/${slug}$`));
  await owner.getByLabel("A text to them (blank for none)").fill("Thanks, we will ring you shortly.");
  await owner.getByLabel("What the page says").fill(`Thanks ${run}, we ring within the hour.`);
  /**
   * The timing check off for this form: a browser driven by a test fills it
   * in faster than any person, which is exactly what the check is for.
   */
  await owner.getByLabel("Too fast to be a person (seconds)").fill("0");
  await owner.getByRole("button", { name: "Save form" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  const hosted = await owner.getByRole("link", { name: /^\/f\// }).getAttribute("href");

  const name = `Fern Form ${run}`;
  const phone = `512555${digits().slice(-4)}`;
  await stranger.goto(`${hosted!}?utm_source=mailer&utm_medium=print`);
  await stranger.getByLabel("Your name").fill(name);
  await stranger.getByLabel("Mobile number").fill(phone);
  await stranger.getByLabel("You may text me about offers and seasonal maintenance.").check();
  await stranger.getByRole("button", { name: "Send" }).click();
  await expect(stranger.getByRole("status").filter({ hasText: `Thanks ${run}` })).toBeVisible();

  await owner.goto("/tasks");
  await expect(owner.getByText(`Ring back ${name}: Free AC check ${run}`)).toBeVisible();
});

test("a customer has a referral code and link, and referrals have a screen with what they earn", async ({ owner }) => {
  await owner.goto("/marketing/referrals");
  await owner.getByLabel("Reward").selectOption({ label: "A credit on their account" });
  await owner.getByLabel("Amount", { exact: true }).fill("25");
  await owner.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

  const listed = await owner.request.get("/api/v1/customers?limit=1");
  const customerId = (await listed.json() as { data: { id: string }[] }).data[0]!.id;
  await owner.goto(`/customers/${customerId}`);
  const referral = owner.locator("section").filter({ has: owner.getByRole("heading", { name: "Referrals" }) });
  await expect(referral).toContainText(/Code [A-Z2-9]{6}/);
  await expect(referral).toContainText("/book/ridgeline?ref=");
});
