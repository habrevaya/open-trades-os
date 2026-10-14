import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient, schema } from "@opentradesos/db";
import { and, asc, eq } from "drizzle-orm";
import { test, expect, run } from "./fixtures";
import { E2E_TWILIO_ENV } from "./twilio-env";

/**
 * HOLD AND PASSING A CALLER ON, FROM THE PHONE SCREEN
 *
 * The owner has a caller they picked up in the browser. On `/phone` they put
 * the caller on hold, and the carrier is asked to move the caller's leg to
 * the hold music; then they pass the caller to a ring group, the carrier is
 * asked to move them there, and the call is no longer theirs. The caller's
 * call says who passed them on.
 *
 * The audio is the carrier's browser library and is not on a screen here:
 * the caller already picked up is a call row, as the carrier's webhooks leave
 * it, and Twilio's REST API is a local fake the connection points at.
 */

const PORT = Number(process.env["E2E_PORT"] ?? 3100);
const BASE = `http://localhost:${PORT}`;
const AUTH = E2E_TWILIO_ENV.E2E_TWILIO_TOKEN;
const NUMBER = "+15125550149";
const CALLER = `+1737${String(Date.now() + 5).slice(-7)}`;

interface Fake { baseUrl: string; moved: { sid: string; body: URLSearchParams }[]; close(): Promise<void> }

/** Twilio's REST API for moving a call in progress, on localhost. */
async function fake(): Promise<Fake> {
  const moved: Fake["moved"] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      const match = /\/Calls\/([^/]+)\.json$/.exec(request.url ?? "");
      response.writeHead(match && request.method === "POST" ? 200 : 404, { "content-type": "application/json" });
      if (match && request.method === "POST") {
        moved.push({ sid: match[1]!, body: new URLSearchParams(body) });
        response.end(JSON.stringify({ sid: match[1] }));
        return;
      }
      response.end(JSON.stringify({ message: `The fake has no ${request.method} ${request.url}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, moved, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

interface Setup { token: string; org: string; ownerId: string; callId: string; sid: string; group: string }

/** Twilio pointed at the fake, a number answered here, a ring group, and a caller the owner picked up in the browser. */
async function setUp(baseUrl: string): Promise<Setup> {
  const db = createClient();
  try {
    const [org] = await db.select({ id: schema.organization.id }).from(schema.organization)
      .where(eq(schema.organization.slug, "ridgeline")).limit(1);
    const [owner] = await db.select({ userId: schema.membership.userId }).from(schema.membership)
      .where(and(eq(schema.membership.organizationId, org!.id), eq(schema.membership.role, "owner")))
      .orderBy(asc(schema.membership.createdAt)).limit(1);
    const token = randomBytes(32).toString("base64url");
    const twilio = { accountSid: "ACe2e", webhookToken: token, baseUrl };
    await db.insert(schema.integrationConnection).values({
      organizationId: org!.id, capability: "messaging", provider: "twilio", status: "connected",
      credentialRef: "E2E_TWILIO_TOKEN", settings: twilio,
    }).onConflictDoUpdate({
      target: [schema.integrationConnection.organizationId, schema.integrationConnection.capability, schema.integrationConnection.provider],
      set: { status: "connected", credentialRef: "E2E_TWILIO_TOKEN", settings: twilio },
    });
    let [number] = await db.select({ id: schema.phoneNumber.id }).from(schema.phoneNumber)
      .where(and(eq(schema.phoneNumber.organizationId, org!.id), eq(schema.phoneNumber.e164, NUMBER))).limit(1);
    if (!number) {
      [number] = await db.insert(schema.phoneNumber).values({
        organizationId: org!.id, e164: NUMBER, label: "Transfer line", purpose: "main", providerNumberId: `PNtransfer${run}`,
      }).returning({ id: schema.phoneNumber.id });
    }
    const [group] = await db.insert(schema.ringGroup).values({
      organizationId: org!.id, name: `Front desk ${run}`, strategy: "all_at_once", ringSeconds: 20,
      members: [{ e164: "+15125550188", label: "Front desk phone" }], noAnswerTo: { kind: "voicemail", box: "main" },
    }).returning({ id: schema.ringGroup.id });
    const sid = `CAe2e${randomBytes(8).toString("hex")}`;
    const [call] = await db.insert(schema.call).values({
      organizationId: org!.id, direction: "inbound", phoneNumberId: number!.id, receivedOnE164: NUMBER,
      fromE164: CALLER, toE164: NUMBER, status: "in_progress", startedAt: new Date(), answeredAt: new Date(),
      answeredByUserId: owner!.userId, handledByUserId: owner!.userId, providerCallId: `twilio:${sid}`,
    }).returning({ id: schema.call.id });
    return { token, org: org!.id, ownerId: owner!.userId, callId: call!.id, sid, group: group!.id };
  } finally {
    await db.$close();
  }
}

/** Everything off again, so later specs see the company as the seed left it. */
async function tearDown(setup: Setup): Promise<void> {
  const db = createClient();
  try {
    await db.update(schema.call).set({ status: "completed", endedAt: new Date() }).where(eq(schema.call.id, setup.callId));
    await db.update(schema.integrationConnection).set({ status: "disconnected" })
      .where(and(eq(schema.integrationConnection.organizationId, setup.org), eq(schema.integrationConnection.capability, "messaging")));
  } finally {
    await db.$close();
  }
}

/** A request exactly as Twilio makes it: form encoded, signed over the public URL with its query. */
async function carrier(token: string, step: string, form: Record<string, string>, query: string): Promise<string> {
  const url = `${BASE}/api/webhooks/voice/${token}/${step}${query}`;
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

test("the person on a call puts the caller on hold and passes them to a ring group from the phone screen", async ({ owner }) => {
  const twilio = await fake();
  const setup = await setUp(twilio.baseUrl);
  try {
    await owner.goto("/phone");
    const call = owner.getByRole("region", { name: "Your call" });
    await expect(call.getByText(`On a call with ${CALLER}.`)).toBeVisible();

    // On hold: the caller's leg is moved to the hold music.
    await call.getByRole("button", { name: "Put on hold" }).click();
    await expect(call.getByText(`${CALLER} is on hold.`, { exact: false })).toBeVisible();
    expect(twilio.moved.map((m) => m.sid)).toEqual([setup.sid]);
    expect(twilio.moved[0]!.body.get("Url")).toBe(`${BASE}/api/webhooks/voice/${setup.token}/hold?c=${setup.callId}`);
    const held = await carrier(setup.token, "hold", { CallSid: setup.sid }, `?c=${setup.callId}`);
    expect(held).toContain(`>ots-hold-${setup.callId}</Enqueue>`);

    // Passed to the ring group, straight away: the call is no longer the owner's.
    await call.getByLabel("Pass them to").selectOption({ label: `The Front desk ${run} ring group` });
    await call.getByRole("button", { name: "Pass the caller on" }).click();
    await expect(owner.getByRole("region", { name: "Your call" })).toHaveCount(0);
    const passed = twilio.moved.at(-1)!;
    expect(passed.sid).toBe(setup.sid);
    const step = passed.body.get("Url")!;
    expect(step).toContain(`/api/webhooks/voice/${setup.token}/transfer?t=`);

    // The carrier asks where the caller goes, and is told to ring the group.
    const rung = await carrier(setup.token, "transfer", { CallSid: setup.sid }, step.slice(step.indexOf("?")));
    expect(rung).toContain("<Number>+15125550188</Number>");

    // The caller's call says who passed them on.
    await owner.goto(`/marketing/calls/${setup.callId}`);
    await expect(owner.getByText(new RegExp(`Passed on by .* to the Front desk ${run} ring group\\.`))).toBeVisible();
  } finally {
    await tearDown(setup);
    await twilio.close();
  }
});
