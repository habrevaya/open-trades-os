import { createHmac, randomBytes } from "node:crypto";
import { createClient, schema } from "@opentradesos/db";
import { and, eq } from "drizzle-orm";
import { test, expect, run } from "./fixtures";
import { E2E_TWILIO_ENV } from "./twilio-env";

/**
 * A PHONE MENU THAT TAKES SPOKEN ANSWERS
 *
 * The owner builds a menu on Settings, Phone menus with "Callers can say an
 * option" on and a few words beside Billing. A caller to the number it
 * answers is asked to press or say; words it cannot match hear the menu
 * again, saying so; "I want to pay my bill" goes where Billing goes; and the
 * call screen says what they said.
 *
 * The carrier is the one thing not on a screen: its webhooks are signed with
 * the token the server was started with, as Twilio signs them.
 */

const PORT = Number(process.env["E2E_PORT"] ?? 3100);
const BASE = `http://localhost:${PORT}`;
const AUTH = E2E_TWILIO_ENV.E2E_TWILIO_TOKEN;
const NUMBER = `+1512556${String(Date.now()).slice(-4)}`;

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

const gatherAction = (twiml: string): string => {
  const action = /<Gather action="([^"]+)"/.exec(twiml)![1]!.replace(/&amp;/g, "&");
  return action.slice(action.indexOf("?"));
};

test("a caller says what they want to a phone menu, and the call says what they said", async ({ owner }) => {
  const db = createClient();
  const token = randomBytes(32).toString("base64url");
  const [org] = await db.select({ id: schema.organization.id }).from(schema.organization)
    .where(eq(schema.organization.slug, "ridgeline")).limit(1);
  let numberId = "";
  try {
    const twilio = { accountSid: "ACe2e", webhookToken: token };
    await db.insert(schema.integrationConnection).values({
      organizationId: org!.id, capability: "messaging", provider: "twilio", status: "connected",
      credentialRef: "E2E_TWILIO_TOKEN", settings: twilio,
    }).onConflictDoUpdate({
      target: [schema.integrationConnection.organizationId, schema.integrationConnection.capability, schema.integrationConnection.provider],
      set: { status: "connected", credentialRef: "E2E_TWILIO_TOKEN", settings: twilio },
    });

    await owner.goto("/settings/phone");
    const build = owner.locator("div").filter({ has: owner.getByRole("heading", { name: "Build a menu" }) }).last();
    await build.getByLabel("Name").fill(`Spoken ${run}`);
    await build.getByLabel("What callers hear first").fill("Thanks for calling Ridgeline.");
    await build.getByLabel("Option 1 key").selectOption("1");
    await build.getByLabel("Option 1 is for").fill("Service");
    await build.locator('select[name="optionTo"]').nth(0).selectOption({ label: "Voicemail" });
    await build.getByLabel("Option 2 key").selectOption("2");
    await build.getByLabel("Option 2 is for").fill("Billing");
    await build.locator('select[name="optionTo"]').nth(1).selectOption({ label: "Voicemail" });
    await build.getByLabel("Option 2 words").fill("pay my bill, invoice");
    await build.getByLabel("Callers can say an option instead of pressing a key").check();
    await build.getByRole("button", { name: "Build menu" }).click();
    await expect(owner.getByText(
      `"Thanks for calling Ridgeline. For Service, press 1 or say Service. For Billing, press 2 or say Billing."`,
    )).toBeVisible();

    // The words are kept with the option, ready to change.
    const saved = owner.getByRole("listitem").filter({ has: owner.getByRole("heading", { name: `Spoken ${run}` }) });
    await saved.getByText("Change it").click();
    await expect(saved.getByLabel("Option 2 words")).toHaveValue("pay my bill, invoice");
    await expect(saved.getByLabel("Callers can say an option instead of pressing a key")).toBeChecked();

    // A number answered by the menu.
    const [menu] = await db.select({ id: schema.phoneMenu.id }).from(schema.phoneMenu)
      .where(and(eq(schema.phoneMenu.organizationId, org!.id), eq(schema.phoneMenu.name, `Spoken ${run}`))).limit(1);
    const [number] = await db.insert(schema.phoneNumber).values({
      organizationId: org!.id, e164: NUMBER, label: "Spoken menu line", purpose: "main",
      providerNumberId: `PNspoken${run}`, menuId: menu!.id,
    }).returning({ id: schema.phoneNumber.id });
    numberId = number!.id;

    // The caller is asked to press or say, and the carrier listens for the words.
    const sid = `CA${randomBytes(8).toString("hex")}`;
    const answered = await carrier(token, null, { CallSid: sid, From: "+15125550166", To: NUMBER });
    expect(answered).toContain('input="dtmf speech"');
    expect(answered).toContain("pay my bill, invoice");

    // Words it cannot match: the menu again, saying so.
    const missed = await carrier(token, "menu", { CallSid: sid, SpeechResult: "What is the weather like?", Confidence: "0.9" }, gatherAction(answered));
    expect(missed).toContain("Sorry, I did not understand that. Here are the options again.");

    // Words it can: where Billing goes.
    const matched = await carrier(token, "menu", { CallSid: sid, SpeechResult: "I want to pay my bill.", Confidence: "0.9" }, gatherAction(missed));
    expect(matched).toContain("<Record ");

    const [call] = await db.select({ id: schema.call.id }).from(schema.call)
      .where(eq(schema.call.providerCallId, `twilio:${sid}`)).limit(1);
    await owner.goto(`/marketing/calls/${call!.id}`);
    await expect(owner.getByText(`said "I want to pay my bill." for Billing in the Spoken ${run} menu`)).toBeVisible();
    await expect(owner.getByText('Said "What is the weather like?", which is not one of the options.', { exact: false })).toBeVisible();
  } finally {
    if (numberId) await db.update(schema.phoneNumber).set({ releasedAt: new Date(), menuId: null }).where(eq(schema.phoneNumber.id, numberId));
    await db.update(schema.integrationConnection).set({ status: "disconnected" })
      .where(and(eq(schema.integrationConnection.organizationId, org!.id), eq(schema.integrationConnection.capability, "messaging")));
    await db.$close();
  }
});
