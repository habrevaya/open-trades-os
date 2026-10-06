import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient, schema } from "@opentradesos/db";
import { and, eq } from "drizzle-orm";
import { test, expect, run } from "./fixtures";
import { E2E_TWILIO_ENV } from "./twilio-env";

/**
 * A PHONE MENU BUILT ON THE SETTINGS SCREEN, AND A TRANSCRIPT ON THE CALL SCREEN
 *
 * The owner says which phone they answer on, builds "press 1 for service,
 * 2 for billing" on Settings, Phone menus, has the company's main number
 * (already on its Twilio account) answered here by that menu, and a call to
 * it hears the menu and is put through to the owner on 2. Then a voicemail is
 * written out by speech to text from the call screen, the card number the
 * caller read out is gone, and the call log finds it by what was said.
 *
 * Twilio and the Whisper server are the two things not on a screen: each is
 * a local fake, reached through the connection's own address setting, and
 * the carrier's webhooks are signed with the token the server was started
 * with, as Twilio signs them.
 */

const PORT = Number(process.env["E2E_PORT"] ?? 3100);
const BASE = `http://localhost:${PORT}`;
const AUTH = E2E_TWILIO_ENV.E2E_TWILIO_TOKEN;
const MAIN = "+15125550143";
const OWNER_PHONE = `+1737${String(Date.now()).slice(-7)}`;

interface Fake { baseUrl: string; posts: string[]; close(): Promise<void> }

/** Twilio's number lookup and its call settings, and a Whisper server, on localhost. */
async function fakes(): Promise<Fake> {
  const posts: string[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("latin1"); });
    request.on("end", () => {
      const path = request.url ?? "";
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.method === "GET" && path.includes("/IncomingPhoneNumbers.json")) {
        return json(200, { incoming_phone_numbers: [{ sid: `PNmain${run}`, phone_number: MAIN, voice_url: "https://old.example/voice" }] });
      }
      if (request.method === "POST" && path.includes("/IncomingPhoneNumbers/")) {
        posts.push(body);
        return json(200, { sid: `PNmain${run}` });
      }
      if (request.method === "POST" && path.endsWith("/audio/transcriptions")) {
        return json(200, {
          language: "en",
          segments: [
            { start: 0, end: 3.5, text: " Hi, my water heater is leaking all over the garage.", avg_logprob: -0.12, no_speech_prob: 0.01 },
            { start: 3.5, end: 8, text: " Put the deposit on card 4111 1111 1111 1111.", avg_logprob: -0.2, no_speech_prob: 0.01 },
          ],
        });
      }
      json(404, { message: `The fake has no ${request.method} ${path}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`, posts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
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

/** Twilio and speech to text, pointed at the fakes. Returns the voice webhook token. */
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
    const whisper = { endpoint: `${baseUrl}/v1` };
    await db.insert(schema.integrationConnection).values({
      organizationId: org, capability: "transcription", provider: "whisper", status: "connected", settings: whisper,
    }).onConflictDoUpdate({
      target: [schema.integrationConnection.organizationId, schema.integrationConnection.capability, schema.integrationConnection.provider],
      set: { status: "connected", settings: whisper },
    });
    return token;
  } finally {
    await db.$close();
  }
}

/** Off again, so later specs see the company as the seed left it. */
async function disconnect(): Promise<void> {
  const db = createClient();
  try {
    await db.update(schema.integrationConnection).set({ status: "disconnected" })
      .where(and(eq(schema.integrationConnection.provider, "twilio"), eq(schema.integrationConnection.capability, "messaging")));
    await db.update(schema.integrationConnection).set({ status: "disconnected" })
      .where(eq(schema.integrationConnection.capability, "transcription"));
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

/** A call that left a voicemail, kept here, as the voice webhook leaves one. */
async function voicemailCall(): Promise<string> {
  const org = await organizationId();
  const db = createClient();
  try {
    const bytes = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0]), randomBytes(16)]);
    const key = `${org}/vm/${run}/${randomBytes(8).toString("hex")}.mp3`;
    await db.insert(schema.storedFile).values({
      organizationId: org, storageKey: key, contentType: "audio/mpeg",
      sha256: randomBytes(32).toString("hex"), sizeBytes: bytes.length, bytes,
    });
    const [call] = await db.insert(schema.call).values({
      organizationId: org, direction: "inbound", fromE164: "+15125550188", toE164: MAIN, receivedOnE164: MAIN,
      status: "voicemail", startedAt: new Date(), voicemailStorageKey: key,
    }).returning({ id: schema.call.id });
    return call!.id;
  } finally {
    await db.$close();
  }
}

test("a phone menu built on the settings screen answers the company's number and puts a caller through", async ({ owner }) => {
  const fake = await fakes();
  const token = await connect(fake.baseUrl);
  try {
    await owner.goto("/settings/phone");
    await expect(owner.getByRole("heading", { level: 1, name: "Phone menus" })).toBeVisible();

    // The number the owner answers the company's calls on.
    const me = owner.locator("li").filter({ has: owner.getByRole("textbox", { name: /'s number$/ }) }).first();
    await me.getByRole("textbox").fill(OWNER_PHONE);
    await me.getByRole("button", { name: "Save" }).click();
    await expect(me.getByRole("status")).toHaveText("Saved.");
    const ownerName = (await me.locator("span").first().textContent())!.trim();

    // The menu: 1 for service to voicemail, 2 for billing to the owner.
    const build = owner.locator("div").filter({ has: owner.getByRole("heading", { name: "Build a menu" }) }).last();
    await build.getByLabel("Name").fill(`Main ${run}`);
    await build.getByLabel("What callers hear first").fill("Thanks for calling Ridgeline.");
    await build.getByLabel("Option 1 key").selectOption("1");
    await build.getByLabel("Option 1 is for").fill("Service");
    await build.locator('select[name="optionTo"]').nth(0).selectOption({ label: "Voicemail" });
    await build.getByLabel("Option 2 key").selectOption("2");
    await build.getByLabel("Option 2 is for").fill("Billing");
    await build.locator('select[name="optionTo"]').nth(1).selectOption({ label: ownerName });
    await build.getByRole("button", { name: "Build menu" }).click();
    await expect(owner.getByText(`"Thanks for calling Ridgeline. For Service, press 1. For Billing, press 2."`)).toBeVisible();

    // The main number, already on the Twilio account, answered here by the menu.
    const number = owner.locator("li").filter({ hasText: /555.?0143/ }).first();
    await number.getByRole("button", { name: "Answer calls here" }).click();
    await expect(number.getByText("Answered here", { exact: true })).toBeVisible();
    expect(new URLSearchParams(fake.posts.at(-1)!).get("VoiceUrl")).toBe(`${BASE}/api/webhooks/voice/${token}`);
    await number.getByLabel("Answered by").selectOption({ label: `The Main ${run} menu` });
    await number.getByRole("button", { name: "Save" }).click();
    await expect(number.getByText(`Main ${run} menu`, { exact: true })).toBeVisible();

    // A call: it hears the menu, presses 2, and rings the owner.
    const sid = `CA${randomBytes(8).toString("hex")}`;
    const answered = await carrier(token, null, { CallSid: sid, From: "+15125550177", To: MAIN });
    expect(answered).toContain("For Billing, press 2.");
    const action = /<Gather action="([^"]+)"/.exec(answered)![1]!.replace(/&amp;/g, "&");
    const pressed = await carrier(token, "menu", { CallSid: sid, Digits: "2" }, action.slice(action.indexOf("?")));
    expect(pressed).toContain(`>${OWNER_PHONE}</Number>`);

    // Handed back: its calls go where they went before.
    await number.getByLabel("Answered by").selectOption({ label: "Ringing, as set on the Settings page" });
    await number.getByRole("button", { name: "Save" }).click();
    await number.getByRole("button", { name: "Stop answering here" }).click();
    await expect(number.getByText("Not answered here", { exact: true })).toBeVisible();
    expect(new URLSearchParams(fake.posts.at(-1)!).get("VoiceUrl")).toBe("https://old.example/voice");
  } finally {
    await disconnect();
    await fake.close();
  }
});

test("a voicemail written out from the call screen, with the card number gone, found on the call log by what was said", async ({ owner }) => {
  const fake = await fakes();
  await connect(fake.baseUrl);
  try {
    const id = await voicemailCall();
    await owner.goto(`/marketing/calls/${id}`);
    await expect(owner.getByText("Not written out.")).toBeVisible();
    await owner.getByRole("button", { name: "Write it out now" }).click();
    await expect(owner.getByRole("heading", { name: "Transcript of the voicemail" })).toBeVisible();
    await expect(owner.getByText("Hi, my water heater is leaking all over the garage.")).toBeVisible();
    await expect(owner.getByText("Removed before it was stored: 1 card number.")).toBeVisible();
    await expect(owner.getByText(/4111/)).toHaveCount(0);

    await owner.goto("/marketing/calls");
    await owner.getByLabel("What was said, or a number").fill("leaking garage");
    await owner.getByRole("button", { name: "Show" }).click();
    await expect(owner.getByText(/my water heater is leaking/)).toBeVisible();
    await owner.getByLabel("What was said, or a number").fill("furnace");
    await owner.getByRole("button", { name: "Show" }).click();
    await expect(owner.getByText("No calls match")).toBeVisible();
  } finally {
    await disconnect();
    await fake.close();
  }
});
