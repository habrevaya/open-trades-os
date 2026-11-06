import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient, schema } from "@opentradesos/db";
import { and, eq } from "drizzle-orm";
import { test, expect, run } from "./fixtures";
import { E2E_TWILIO_ENV } from "./twilio-env";

/**
 * A PHONE MENU WITH HOURS OF ITS OWN, AND A CALLBACK NUMBER TYPED IN
 *
 * The owner opens a Sales menu's hours from Settings, Phone, gives it a week
 * of its own and a day off of its own, and the page says it goes by its own
 * hours; then it goes back to the number's, and its own week is kept.
 *
 * A caller waiting in a line asks to be called back, presses 2, types a
 * different number, hears it read back and confirms it. The call screen says
 * which number they typed. Twilio is the one thing not on a screen: its REST
 * API is a local fake, and this spec plays the carrier, signing its webhooks
 * with the token the server was started with.
 */

const PORT = Number(process.env["E2E_PORT"] ?? 3100);
const BASE = `http://localhost:${PORT}`;
const AUTH = E2E_TWILIO_ENV.E2E_TWILIO_TOKEN;
const LINE_NUMBER = `+1512557${String(Date.now()).slice(-4)}`;
const CALLER = `+1737${String(Date.now() + 5).slice(-7)}`;

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

test("a Sales menu given hours and a day off of its own, then put back on the number's", async ({ owner }) => {
  const org = await organizationId();
  const db = createClient();
  const name = `Sales ${run}`;
  const [menu] = await db.insert(schema.phoneMenu).values({
    organizationId: org, name, greeting: "Sales.",
    options: [{ key: "1", label: "Quotes", to: { kind: "voicemail", box: "main" } }],
    noInputTo: { kind: "voicemail", box: "main" }, afterHoursTo: { kind: "voicemail", box: "main" },
  }).returning({ id: schema.phoneMenu.id });
  try {
    await owner.goto("/settings/phone");
    const item = owner.getByRole("listitem").filter({ has: owner.getByRole("heading", { name }) });
    await expect(item.getByText("Goes by the hours of the number each call came in on.")).toBeVisible();
    await item.getByRole("link", { name: "Its hours" }).click();
    await expect(owner.getByRole("heading", { level: 1, name: `Hours for the ${name} menu` })).toBeVisible();
    await expect(owner.locator("section").first()).toContainText("The hours of the number each call came in on");

    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
      await owner.getByLabel(`${day} closed`).uncheck();
      await owner.getByLabel(`${day} opens`).fill("09:00");
      await owner.getByLabel(`${day} closes`).fill("12:00");
    }
    for (const day of ["Saturday", "Sunday"]) await owner.getByLabel(`${day} closed`).check();
    await owner.getByRole("button", { name: "Save its own hours" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await owner.reload();
    await expect(owner.locator("section").first()).toContainText("Its own hours");
    await expect(owner.locator("section").first()).toContainText("Mon 09:00 to 12:00");

    await owner.getByLabel("Name", { exact: true }).fill(`Sales training ${run}`);
    await owner.getByLabel("Date", { exact: true }).fill("2031-03-04");
    await owner.getByRole("button", { name: "Add day off" }).click();
    const day = owner.getByRole("row").filter({ hasText: `Sales training ${run}` });
    await expect(day).toContainText("Closed");

    await owner.getByLabel("Its hours come from").selectOption({ label: "The number each call came in on" });
    await owner.getByRole("button", { name: "Save whose hours it goes by" }).click();
    await expect(owner.locator("section").first()).toContainText("The hours of the number each call came in on");
    await expect(owner.getByText("Kept for when it keeps its own hours again.", { exact: false })).toBeVisible();

    await day.getByRole("button", { name: "Remove" }).click();
    await expect(owner.getByRole("row").filter({ hasText: `Sales training ${run}` })).toHaveCount(0);

    await owner.goto("/settings/phone");
    await expect(owner.getByRole("listitem").filter({ has: owner.getByRole("heading", { name }) })
      .getByText("Goes by the hours of the number each call came in on.")).toBeVisible();
  } finally {
    await db.delete(schema.phoneMenu).where(eq(schema.phoneMenu.id, menu!.id));
    await db.$close();
  }
});

/** Twilio's REST API for placing calls, on localhost. */
async function fake(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const placing = request.method === "POST" && request.url?.endsWith("/Calls.json");
      response.writeHead(placing ? 201 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(placing ? { sid: `CAleg${randomBytes(3).toString("hex")}` } : { message: "The fake has nothing here" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

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
const gatherQuery = (twiml: string) => queryOf(attribute(twiml, "Gather", "action"));

test("a caller waiting to be called back types a different number, and the call screen says so", async ({ owner }) => {
  const twilio = await fake();
  const org = await organizationId();
  const token = randomBytes(32).toString("base64url");
  const db = createClient();
  let numberId = "";
  let queueId = "";
  let groupId = "";
  let menuId = "";
  try {
    const settings = { accountSid: "ACe2e", webhookToken: token, baseUrl: twilio.baseUrl };
    await db.insert(schema.integrationConnection).values({
      organizationId: org, capability: "messaging", provider: "twilio", status: "connected",
      credentialRef: "E2E_TWILIO_TOKEN", settings,
    }).onConflictDoUpdate({
      target: [schema.integrationConnection.organizationId, schema.integrationConnection.capability, schema.integrationConnection.provider],
      set: { status: "connected", credentialRef: "E2E_TWILIO_TOKEN", settings },
    });
    const [group] = await db.insert(schema.ringGroup).values({
      organizationId: org, name: `Typed team ${run}`, strategy: "all_at_once", ringSeconds: 20,
      members: [{ e164: "+15125550199", label: "Office mobile" }], noAnswerTo: { kind: "voicemail", box: "main" },
    }).returning({ id: schema.ringGroup.id });
    groupId = group!.id;
    const [queue] = await db.insert(schema.callQueue).values({
      organizationId: org, name: `Typed line ${run}`, ringGroupId: groupId, maxWaitSeconds: 600,
      overflowTo: { kind: "voicemail", box: "main" }, offerCallback: true,
    }).returning({ id: schema.callQueue.id });
    queueId = queue!.id;
    const [menu] = await db.insert(schema.phoneMenu).values({
      organizationId: org, name: `Typed menu ${run}`, greeting: "Thanks for calling Ridgeline.",
      options: [{ key: "1", label: "Service", to: { kind: "queue", id: queueId } }],
      noInputTo: { kind: "voicemail", box: "main" },
    }).returning({ id: schema.phoneMenu.id });
    menuId = menu!.id;
    const [number] = await db.insert(schema.phoneNumber).values({
      organizationId: org, e164: LINE_NUMBER, label: "Typed callback line", purpose: "main",
      providerNumberId: `PNtyped${run}`, menuId,
    }).returning({ id: schema.phoneNumber.id });
    numberId = number!.id;

    const sid = `CA${randomBytes(8).toString("hex")}`;
    const answered = await carrier(token, null, { CallSid: sid, From: CALLER, To: LINE_NUMBER });
    const joined = await carrier(token, "menu", { CallSid: sid, Digits: "1" }, gatherQuery(answered));
    const turn = await carrier(token, "queue-wait", { CallSid: sid, QueuePosition: "1", QueueTime: "0" },
      queryOf(attribute(joined, "Enqueue", "waitUrl")));
    await carrier(token, "queue-callback", { CallSid: sid, Digits: "1", QueueTime: "9" }, gatherQuery(turn));
    const left = await carrier(token, "queue-done", { CallSid: sid, QueueResult: "leave", QueueTime: "9" },
      queryOf(attribute(joined, "Enqueue", "action")));
    expect(left).toContain("To be called back on a different number, press 2.");

    const asked = await carrier(token, "callback-number", { CallSid: sid, Digits: "2" }, gatherQuery(left));
    expect(asked).toContain("Type the number to call you back on, with its area code, then press pound.");
    const typed = await carrier(token, "callback-typed", { CallSid: sid, Digits: "5125550177" }, gatherQuery(asked));
    expect(typed).toContain("You typed 5 1 2, 5 5 5, 0 1 7 7.");
    const confirmed = await carrier(token, "callback-confirm", { CallSid: sid, Digits: "1" }, gatherQuery(typed));
    expect(confirmed).toContain("We will call you back on 5 1 2, 5 5 5, 0 1 7 7 when it is your turn");

    const [call] = await db.select({ id: schema.call.id }).from(schema.call)
      .where(eq(schema.call.providerCallId, `twilio:${sid}`)).limit(1);
    await owner.goto(`/marketing/calls/${call!.id}`);
    await expect(owner.getByText(`Typed another number to be called back on: +15125550177, instead of ${CALLER}.`, { exact: false }))
      .toBeVisible();
  } finally {
    await db.update(schema.queueCallback).set({ status: "done", endedAt: new Date() })
      .where(and(eq(schema.queueCallback.organizationId, org), eq(schema.queueCallback.status, "waiting")));
    if (numberId) await db.update(schema.phoneNumber).set({ releasedAt: new Date(), menuId: null }).where(eq(schema.phoneNumber.id, numberId));
    if (menuId) await db.delete(schema.phoneMenu).where(eq(schema.phoneMenu.id, menuId));
    if (queueId) await db.update(schema.queueCallback).set({ queueId: null }).where(eq(schema.queueCallback.queueId, queueId));
    if (queueId) await db.delete(schema.callQueue).where(eq(schema.callQueue.id, queueId));
    if (groupId) await db.delete(schema.ringGroup).where(eq(schema.ringGroup.id, groupId));
    await db.update(schema.integrationConnection).set({ status: "disconnected" })
      .where(and(eq(schema.integrationConnection.organizationId, org), eq(schema.integrationConnection.capability, "messaging")));
    await db.$close();
    await twilio.close();
  }
});
