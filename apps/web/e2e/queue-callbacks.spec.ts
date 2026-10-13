import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient, schema } from "@opentradesos/db";
import { and, eq } from "drizzle-orm";
import { test, expect, run } from "./fixtures";
import { E2E_TWILIO_ENV } from "./twilio-env";

/**
 * A WAITING LINE THAT CALLS BACK, FROM THE SETTINGS SCREEN TO THE CALL SCREEN
 *
 * The owner makes a waiting line on Settings, Phone menus with "press 1 to be
 * called back" on, and puts it behind a menu on a number. A caller joins the
 * line, hears the offer with the music, presses 1, and is told they will be
 * called back on their own number. The owner's phone is rung for the
 * callback, the owner picks up and is put through to the caller from the
 * company's number, and the caller's call says so on the call screen.
 *
 * Twilio is the one thing not on a screen: its REST API is a local fake the
 * connection's address points at, and this spec plays the carrier, signing
 * its webhooks with the token the server was started with.
 */

const PORT = Number(process.env["E2E_PORT"] ?? 3100);
const BASE = `http://localhost:${PORT}`;
const AUTH = E2E_TWILIO_ENV.E2E_TWILIO_TOKEN;
const NUMBER = "+15125550148";
const CALLER = `+1737${String(Date.now() + 3).slice(-7)}`;

interface Fake { baseUrl: string; placed: URLSearchParams[]; close(): Promise<void> }

/** Twilio's REST API for placing calls, on localhost. */
async function fake(): Promise<Fake> {
  const placed: URLSearchParams[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      response.writeHead(request.method === "POST" && request.url?.endsWith("/Calls.json") ? 201 : 404, { "content-type": "application/json" });
      if (request.method === "POST" && request.url?.endsWith("/Calls.json")) {
        placed.push(new URLSearchParams(body));
        response.end(JSON.stringify({ sid: `CAleg${placed.length}` }));
        return;
      }
      response.end(JSON.stringify({ message: `The fake has no ${request.method} ${request.url}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, placed, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function organizationId(): Promise<string> {
  const db = createClient();
  try {
    const [org] = await db.select({ id: schema.organization.id }).from(schema.organization)
      .where(eq(schema.organization.slug, "ridgeline")).limit(1);
    return org!.id;
  } finally {
    await db.$close();
  }
}

/** Twilio pointed at the fake, and a number answered here. Returns the voice webhook token. */
async function connect(baseUrl: string): Promise<string> {
  const org = await organizationId();
  const token = randomBytes(32).toString("base64url");
  const db = createClient();
  try {
    const twilio = { accountSid: "ACe2e", webhookToken: token, baseUrl };
    await db.insert(schema.integrationConnection).values({
      organizationId: org, capability: "messaging", provider: "twilio", status: "connected",
      credentialRef: "E2E_TWILIO_TOKEN", settings: twilio,
    }).onConflictDoUpdate({
      target: [schema.integrationConnection.organizationId, schema.integrationConnection.capability, schema.integrationConnection.provider],
      set: { status: "connected", credentialRef: "E2E_TWILIO_TOKEN", settings: twilio },
    });
    const [held] = await db.select({ id: schema.phoneNumber.id }).from(schema.phoneNumber)
      .where(and(eq(schema.phoneNumber.organizationId, org), eq(schema.phoneNumber.e164, NUMBER))).limit(1);
    if (!held) {
      await db.insert(schema.phoneNumber).values({
        organizationId: org, e164: NUMBER, label: "Callback line", purpose: "main", providerNumberId: `PNcallback${run}`,
      });
    }
    return token;
  } finally {
    await db.$close();
  }
}

/** Everything off again, so later specs see the company as the seed left it. */
async function disconnect(): Promise<void> {
  const org = await organizationId();
  const db = createClient();
  try {
    await db.update(schema.phoneNumber).set({ menuId: null })
      .where(and(eq(schema.phoneNumber.organizationId, org), eq(schema.phoneNumber.e164, NUMBER)));
    await db.update(schema.integrationConnection).set({ status: "disconnected" })
      .where(and(eq(schema.integrationConnection.organizationId, org), eq(schema.integrationConnection.capability, "messaging")));
  } finally {
    await db.$close();
  }
}

/** A request exactly as Twilio makes it: form encoded, signed over the public URL with its query. */
async function carrier(token: string, step: string | null, form: Record<string, string>, query = ""): Promise<string> {
  const url = `${BASE}/api/webhooks/voice/${token}${step ? `/${step}` : ""}${query}`;
  const data = Object.keys(form).sort().reduce((acc, key) => acc + key + form[key], url);
  const signature = createHmac("sha1", AUTH).update(Buffer.from(data, "utf8")).digest("base64");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    body: new URLSearchParams(form).toString(),
  });
  expect(response.status).toBe(200);
  return response.text();
}

const attribute = (twiml: string, verb: string, name: string): string => {
  const match = new RegExp(`<${verb}[^>]* ${name}="([^"]+)"`).exec(twiml);
  if (!match) throw new Error(`No ${verb} ${name} in ${twiml}`);
  return match[1]!.replace(/&amp;/g, "&");
};
const queryOf = (address: string) => address.slice(address.indexOf("?"));

test("a waiting line offers to call a caller back, and the owner's phone rings first and then the caller's", async ({ owner }) => {
  const twilio = await fake();
  const token = await connect(twilio.baseUrl);
  const ownerPhone = `+1737${String(Date.now() + 11).slice(-7)}`;
  try {
    await owner.goto("/settings/phone");

    // The owner answers on their phone, in a group of one.
    const me = owner.locator("li").filter({ has: owner.getByRole("textbox", { name: /'s number$/ }) }).first();
    await me.getByRole("textbox").fill(ownerPhone);
    await me.getByRole("button", { name: "Save" }).click();
    await expect(me.getByRole("status")).toHaveText("Saved.");
    const ownerName = (await me.locator("span").first().textContent())!.trim();
    const group = owner.locator("div").filter({ has: owner.getByRole("heading", { name: "Make a ring group" }) }).last();
    await group.getByLabel("Name", { exact: true }).fill(`Callback team ${run}`);
    await group.getByLabel("Member 1", { exact: true }).selectOption({ label: ownerName });
    await group.getByRole("button", { name: "Make group" }).click();
    await expect(owner.getByRole("heading", { name: `Callback team ${run}` })).toBeVisible();

    // The line, with callers able to ask to be called back.
    const line = owner.locator("div").filter({ has: owner.getByRole("heading", { name: "Make a waiting line" }) }).last();
    await line.getByLabel("Name", { exact: true }).fill(`Callbacks ${run}`);
    await line.getByLabel("Answered by the ring group").selectOption({ label: `Callback team ${run}` });
    await line.getByLabel("Let callers press 1 to be called back instead of waiting, keeping their place").check();
    await line.getByRole("button", { name: "Make line" }).click();
    const made = owner.locator("li").filter({ has: owner.getByRole("heading", { name: `Callbacks ${run}` }) });
    await expect(made.getByText("Callers can press 1 to be called back instead of waiting.")).toBeVisible();
    await expect(made.getByText("Callers hear how long callers have lately waited.")).toBeVisible();

    // A menu whose first option is the line, on the number.
    const build = owner.locator("div").filter({ has: owner.getByRole("heading", { name: "Build a menu" }) }).last();
    await build.getByLabel("Name").fill(`Callback menu ${run}`);
    await build.getByLabel("What callers hear first").fill("Thanks for calling Ridgeline.");
    await build.getByLabel("Option 1 key").selectOption("1");
    await build.getByLabel("Option 1 is for").fill("Service");
    await build.locator('select[name="optionTo"]').nth(0).selectOption({ label: `Callbacks ${run}` });
    await build.getByRole("button", { name: "Build menu" }).click();
    await expect(owner.getByRole("heading", { name: `Callback menu ${run}` })).toBeVisible();
    const number = owner.locator("li").filter({ hasText: /555.?0148/ }).first();
    await number.getByLabel("Answered by").selectOption({ label: `The Callback menu ${run} menu` });
    await number.getByRole("button", { name: "Save" }).click();
    await expect(number.getByText(`Callback menu ${run} menu`, { exact: true })).toBeVisible();

    // A caller joins the line and hears the offer with the music.
    const sid = `CA${randomBytes(8).toString("hex")}`;
    const answered = await carrier(token, null, { CallSid: sid, From: CALLER, To: NUMBER });
    const pressed = await carrier(token, "menu", { CallSid: sid, Digits: "1" }, queryOf(attribute(answered, "Gather", "action")));
    const wait = attribute(pressed, "Enqueue", "waitUrl");
    const done = attribute(pressed, "Enqueue", "action");
    const turn = await carrier(token, "queue-wait", { CallSid: sid, QueuePosition: "1", QueueTime: "0" }, queryOf(wait));
    expect(turn).toContain("To be called back instead of waiting, keeping your place in line, press 1.");
    expect(turn).toContain("<Play>");

    // They press 1, are taken out of the line, and told what happens next.
    const left = await carrier(token, "queue-callback", { CallSid: sid, Digits: "1", QueueTime: "12" }, queryOf(attribute(turn, "Gather", "action")));
    expect(left).toContain("<Leave/>");
    twilio.placed.length = 0;
    const told = await carrier(token, "queue-done", { CallSid: sid, QueueResult: "leave", QueueTime: "12" }, queryOf(done));
    expect(told).toContain("Thanks. We will call you back on");
    await carrier(token, "status", { CallSid: sid, CallStatus: "completed", CallDuration: "30" });

    // The owner's phone is rung first, from the company's number.
    await expect.poll(() => twilio.placed.map((p) => p.get("To"))).toContain(ownerPhone);
    const leg = twilio.placed.find((p) => p.get("To") === ownerPhone)!;
    expect(leg.get("From")).toBe(NUMBER);

    // The owner picks up and is put through to the caller.
    const picked = await carrier(token, "queue-answer", { CallSid: `CAowner${run}`, To: ownerPhone }, queryOf(leg.get("Url")!));
    expect(picked).toContain("asked to be called back. Calling them now.");
    expect(picked).toContain(`<Number>${CALLER}</Number>`);
    expect(attribute(picked, "Dial", "callerId")).toBe(NUMBER);
    await carrier(token, "callback-dialed", { CallSid: `CAowner${run}`, DialCallStatus: "completed", DialCallDuration: "64" },
      queryOf(attribute(picked, "Dial", "action")));

    // The caller's call says what happened, on the call screen.
    await owner.goto("/marketing/calls");
    await owner.getByRole("row").filter({ hasText: CALLER.slice(-4) }).first().getByRole("link").first().click();
    await expect(owner.getByText(/Asked to be called back on .* instead of waiting/)).toBeVisible();
    await expect(owner.getByText(new RegExp(`Called back by ${ownerName}, and they picked up\\.`))).toBeVisible();
  } finally {
    await disconnect();
    await twilio.close();
  }
});
