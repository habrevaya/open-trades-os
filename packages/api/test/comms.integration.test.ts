import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import { flush, recordDelivery, recoverStuck, claimOne } from "../src/services/comms-outbox";
import { receive, store, resolveWebhook } from "../src/services/comms-inbound";
import { createTwilioProvider, twilioSignature } from "../src/comms/twilio";
import type {
  MessagingProvider, OutboundMessage, SendResult, WebhookRequest,
} from "../src/comms/provider";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE CARRIER BOUNDARY
 *
 * Everything here is about the two failures that reach a customer: a text
 * sent twice, and a text sent to somebody who said stop. Both happen in the
 * gap between our database and a carrier's, which is why the fake provider
 * below can be told to crash exactly where a real one would.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cm:org");
const USER = fixtureId("cm:user");
const NUMBER = fixtureId("cm:number");
const OUR_NUMBER = "+15125559997";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let customerId = "";
let conversationId = "";

/** A provider that never reaches a network and can be told how to fail. */
function fakeProvider(behaviour: {
  result?: SendResult;
  onSend?: (message: OutboundMessage) => void;
} = {}): MessagingProvider & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return {
    name: "fake",
    sent,
    async send(message) {
      sent.push(message);
      behaviour.onSend?.(message);
      return behaviour.result ?? { ok: true, providerMessageId: `SM${sent.length}` };
    },
    verify: () => true,
    parseInbound: () => null,
    parseDelivery: () => null,
  };
}

async function queue(body: string): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.message
      (organization_id, conversation_id, direction, channel, purpose,
       from_address, to_address, body, status)
    values (${ORG}, ${conversationId}, 'outbound', 'sms', 'transactional',
            ${OUR_NUMBER}, '+15125550160', ${body}, 'queued')
    returning id`;
  return row!.id;
}

const messageRow = (id: string) => raw<{
  status: string; provider_message_id: string | null; error_code: string | null;
}[]>`select status, provider_message_id, error_code from public.message where id = ${id}`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Comms Co", slug: "comms-co" });

  await raw`insert into public.phone_number (id, organization_id, e164, purpose, sms_registered)
            values (${NUMBER}, ${ORG}, ${OUR_NUMBER}, 'main', true)`;

  const customer = await customers.create(owner(), {
    type: "residential", name: "Cora Comms", phone: "+15125550160",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;

  const [conversation] = await raw<{ id: string }[]>`
    insert into public.conversation
      (organization_id, channel, external_address, phone_number_id, customer_id, status)
    values (${ORG}, 'sms', '+15125550160', ${NUMBER}, ${customerId}, 'open')
    returning id`;
  conversationId = conversation!.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.message where organization_id = ${ORG}`;
  await raw`delete from public.suppression where organization_id = ${ORG}`;
  await raw`delete from public.conversation where organization_id = ${ORG} and id <> ${conversationId}`;
});

run("handing a message to a carrier", () => {
  it("sends what is queued and records the carrier's id", async () => {
    const id = await queue("Your tech is on the way.");
    const provider = fakeProvider();

    const outcomes = await flush(db(), ORG, { provider });

    expect(outcomes).toEqual([{ messageId: id, status: "sent" }]);
    expect(provider.sent[0]!.body).toBe("Your tech is on the way.");
    const [row] = await messageRow(id);
    // `sent`, not `delivered`. The carrier accepted it and nothing more is
    // known yet.
    expect(row!.status).toBe("sent");
    expect(row!.provider_message_id).toBe("SM1");
  });

  it("does not send the same message twice", async () => {
    await queue("Once.");
    const provider = fakeProvider();

    await flush(db(), ORG, { provider });
    await flush(db(), ORG, { provider });

    // The failure an operator actually hears about.
    expect(provider.sent).toHaveLength(1);
  });

  it("does not send twice when the process dies between claim and send", async () => {
    /**
     * The real crash: the row is claimed, the carrier is called, and the
     * process dies before the status is written. A loop that reads `queued`
     * and marks `sent` afterwards sends it again on restart. Claiming first
     * is what makes the restart a no-op.
     */
    const id = await queue("Crash me.");
    const first = fakeProvider({ onSend: () => { throw new Error("process died"); } });
    await expect(flush(db(), ORG, { provider: first })).rejects.toThrow("process died");

    const second = fakeProvider();
    await flush(db(), ORG, { provider: second });
    expect(second.sent).toHaveLength(0);

    const [row] = await messageRow(id);
    // Visibly stuck rather than quietly sent again.
    expect(row!.status).toBe("sending");
  });

  it("lets exactly one worker claim a message", async () => {
    /**
     * Two workers reaching the same queued row. The claim is a conditional
     * update, so Postgres serializes them and only one sees a returned row;
     * without the condition both would proceed and the customer would get the
     * text twice.
     *
     * Asserted directly rather than by racing two flushes, because a race
     * that usually goes the right way is a test that usually passes.
     */
    const id = await queue("Contended.");
    expect(await claimOne(db(), ORG, id)).toBe(true);
    expect(await claimOne(db(), ORG, id)).toBe(false);
  });

  it("requeues a retryable failure and gives up on a permanent one", async () => {
    const retryable = await queue("Rate limited.");
    await flush(db(), ORG, {
      provider: fakeProvider({ result: { ok: false, code: "20429", message: "slow down", retryable: true } }),
    });
    expect((await messageRow(retryable))[0]!.status).toBe("queued");

    await raw`delete from public.message where id = ${retryable}`;

    const permanent = await queue("Wrong number.");
    await flush(db(), ORG, {
      provider: fakeProvider({ result: { ok: false, code: "21211", message: "invalid", retryable: false } }),
    });
    const [row] = await messageRow(permanent);
    // Retrying a disconnected number forever is how a queue stops being one.
    expect(row!.status).toBe("failed");
    expect(row!.error_code).toBe("21211");
  });

  it("recovers a claim that was abandoned", async () => {
    const id = await queue("Abandoned.");
    await flush(db(), ORG, { provider: fakeProvider({ onSend: () => { throw new Error("died"); } }) })
      .catch(() => undefined);

    expect(await recoverStuck(db(), ORG, 0)).toBe(1);
    expect((await messageRow(id))[0]!.status).toBe("queued");
  });

  it("leaves a fresh claim alone", async () => {
    // Recovering eagerly sends a second text while the first is in flight,
    // which is the exact failure the claim exists to prevent.
    await queue("In flight.");
    await flush(db(), ORG, { provider: fakeProvider({ onSend: () => { throw new Error("died"); } }) })
      .catch(() => undefined);

    expect(await recoverStuck(db(), ORG, 10 * 60 * 1000)).toBe(0);
  });
});

run("delivery receipts", () => {
  it("moves a sent message to delivered", async () => {
    const id = await queue("Track me.");
    await flush(db(), ORG, { provider: fakeProvider() });

    expect(await recordDelivery(db(), ORG, {
      providerMessageId: "SM1", reference: id, status: "delivered",
    })).toBe(true);
    expect((await messageRow(id))[0]!.status).toBe("delivered");
  });

  it("does not move a message backwards when receipts arrive out of order", async () => {
    // Otherwise a support screen shows "sending" for a text that arrived an
    // hour ago.
    const id = await queue("Out of order.");
    await flush(db(), ORG, { provider: fakeProvider() });
    await recordDelivery(db(), ORG, { providerMessageId: "SM1", reference: id, status: "delivered" });

    expect(await recordDelivery(db(), ORG, {
      providerMessageId: "SM1", reference: id, status: "sent",
    })).toBe(false);
    expect((await messageRow(id))[0]!.status).toBe("delivered");
  });
});

run("what arrives", () => {
  const inbound = (body: string, from = "+15125550160") => ({
    from, to: OUR_NUMBER, body, media: [], providerMessageId: `IN${Math.random()}`,
  });

  it("threads a reply onto the customer's existing conversation", async () => {
    const result = await store(db(), ORG, inbound("Sounds good"));
    expect(result.kind).toBe("message");
    if (result.kind !== "message") return;
    expect(result.conversationId).toBe(conversationId);
  });

  it("keeps a message from a number that matches no customer", async () => {
    // An unrecognized number texting in is a lead. Dropping it because it
    // does not match a customer row is how leads are lost.
    const result = await store(db(), ORG, inbound("Do you do water heaters?", "+15125550999"));
    expect(result.kind).toBe("message");
  });

  it("suppresses immediately on STOP, in the same transaction as the message", async () => {
    const result = await store(db(), ORG, inbound("STOP"));
    expect(result.kind === "message" && result.intent).toBe("stop");

    const rows = await raw`select id from public.suppression
      where organization_id = ${ORG} and address = '+15125550160' and lifted_at is null`;
    expect(rows).toHaveLength(1);
  });

  it("lifts the suppression on START", async () => {
    await store(db(), ORG, inbound("stop"));
    await store(db(), ORG, inbound("START"));

    const rows = await raw`select id from public.suppression
      where organization_id = ${ORG} and address = '+15125550160' and lifted_at is null`;
    expect(rows).toHaveLength(0);
  });

  it("refuses a message arriving on a number we do not own", async () => {
    const result = await store(db(), ORG, {
      ...inbound("Hello"), to: "+15125550000",
    });
    expect(result).toMatchObject({ kind: "rejected", reason: "unknown_number" });
  });
});

run("proving the webhook came from the carrier", () => {
  const TOKEN = "test-auth-token";
  const URL_ = "https://app.example.com/api/webhooks/twilio";
  const provider = () => createTwilioProvider({ accountSid: "AC123" }, TOKEN);

  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

  const signed = (fields: Record<string, string>): WebhookRequest => ({
    url: URL_,
    headers: { "x-twilio-signature": twilioSignature(TOKEN, URL_, fields) },
    body: form(fields),
  });

  it("accepts a correctly signed inbound message", async () => {
    const request = signed({
      From: "+15125550160", To: OUR_NUMBER, Body: "Signed", MessageSid: "SM_signed", NumMedia: "0",
    });
    const result = await receive(db(), provider(), request, ORG);
    expect(result.kind).toBe("message");
  });

  it("rejects an unsigned request", async () => {
    const fields = { From: "+15125550160", To: OUR_NUMBER, Body: "Forged", MessageSid: "SM_forged" };
    const result = await receive(db(), provider(), { url: URL_, headers: {}, body: form(fields) }, ORG);
    expect(result).toMatchObject({ kind: "rejected", reason: "bad_signature" });
  });

  it("rejects a forged STOP", async () => {
    /**
     * The attack that matters. Anyone who can post to the endpoint could
     * otherwise opt a competitor's customers out of every message, and the
     * suppression list is deliberately hard to undo.
     */
    const fields = { From: "+15125550160", To: OUR_NUMBER, Body: "STOP", MessageSid: "SM_evil" };
    const result = await receive(db(), provider(), {
      url: URL_,
      headers: { "x-twilio-signature": "not-the-right-signature" },
      body: form(fields),
    }, ORG);

    expect(result).toMatchObject({ kind: "rejected", reason: "bad_signature" });
    expect(await raw`select id from public.suppression where organization_id = ${ORG}`).toHaveLength(0);
  });

  it("rejects a body that was tampered with after signing", async () => {
    const original = { From: "+15125550160", To: OUR_NUMBER, Body: "Yes please", MessageSid: "SM_t" };
    const request = signed(original);
    const tampered: WebhookRequest = {
      ...request,
      body: form({ ...original, Body: "STOP" }),
    };
    expect(await receive(db(), provider(), tampered, ORG))
      .toMatchObject({ kind: "rejected", reason: "bad_signature" });
  });

  it("rejects a signature computed for a different URL", async () => {
    // Behind a load balancer the request often arrives as http on an internal
    // hostname. Reconstructing the URL from headers an attacker can set would
    // let them choose what gets signed.
    const fields = { From: "+15125550160", To: OUR_NUMBER, Body: "Elsewhere", MessageSid: "SM_u" };
    const result = await receive(db(), provider(), {
      url: URL_,
      headers: { "x-twilio-signature": twilioSignature(TOKEN, "https://evil.example.com/hook", fields) },
      body: form(fields),
    }, ORG);
    expect(result).toMatchObject({ kind: "rejected", reason: "bad_signature" });
  });

  it("computes the signature the way Twilio documents it", () => {
    // Sorted keys appended to the full URL, HMAC-SHA1, base64. Pinned against
    // an independent computation rather than against itself, because a
    // signature check that agrees with its own bug is not a check.
    const params = { Zebra: "last", Apple: "first", MessageSid: "SM1" };
    // Written out rather than derived, so a bug in the sorting cannot be
    // reproduced by the expectation. Keys sort Apple, MessageSid, Zebra.
    const expected = createHmac("sha1", TOKEN)
      .update(`${URL_}ApplefirstMessageSidSM1Zebralast`)
      .digest("base64");
    expect(twilioSignature(TOKEN, URL_, params)).toBe(expected);
  });

  it("records a delivery receipt that is correctly signed", async () => {
    const id = await queue("Receipt.");
    await flush(db(), ORG, { provider: fakeProvider() });

    const fields = { MessageSid: "SM1", MessageStatus: "delivered", IdempotencyToken: id };
    const result = await receive(db(), provider(), signed(fields), ORG);
    expect(result).toMatchObject({ kind: "delivery", recorded: true });
    expect((await messageRow(id))[0]!.status).toBe("delivered");
  });

  it("ignores a status the carrier is still working on", async () => {
    // `queued` and `accepted` arriving as receipts would move a delivered
    // message backwards.
    const fields = { MessageSid: "SM1", MessageStatus: "accepted" };
    const result = await receive(db(), provider(), signed(fields), ORG);
    expect(result).toMatchObject({ kind: "rejected", reason: "unparseable" });
  });
});

run("routing a webhook to the right tenant", () => {
  const TOKEN = "wh_" + "a".repeat(40);
  const TOKEN_REF = "TEST_TWILIO_TOKEN";

  beforeAll(async () => {
    if (!url) return;
    process.env[TOKEN_REF] = "test-auth-token";
    await raw`delete from public.integration_connection
              where organization_id = ${ORG} and capability = 'messaging'`;
    await raw`insert into public.integration_connection
                (organization_id, capability, provider, status, credential_ref, settings)
              values (${ORG}, 'messaging', 'twilio', 'connected', ${TOKEN_REF},
                      ${raw.json({ accountSid: "AC123", webhookToken: TOKEN })})`;
    await import("../src/comms/twilio");
  });

  const read = async (ref: string) => process.env[ref] ?? "";

  it("finds the connection from the secret in the URL", async () => {
    const found = await resolveWebhook(db(), TOKEN, read);
    expect(found?.organizationId).toBe(ORG);
    expect(found?.provider.name).toBe("twilio");
  });

  it("finds nothing for a token that does not match", async () => {
    expect(await resolveWebhook(db(), "wh_" + "b".repeat(40), read)).toBeNull();
  });

  it("refuses a token short enough to guess", async () => {
    // A deployment that configures a weak token gets no webhooks rather than
    // an open endpoint.
    await raw`update public.integration_connection
              set settings = ${raw.json({ accountSid: "AC123", webhookToken: "short" })}
              where organization_id = ${ORG} and capability = 'messaging'`;
    expect(await resolveWebhook(db(), "short", read)).toBeNull();
    await raw`update public.integration_connection
              set settings = ${raw.json({ accountSid: "AC123", webhookToken: TOKEN })}
              where organization_id = ${ORG} and capability = 'messaging'`;
  });

  it("finds nothing for a connection that is not connected", async () => {
    await raw`update public.integration_connection set status = 'needs_reauth'
              where organization_id = ${ORG} and capability = 'messaging'`;
    expect(await resolveWebhook(db(), TOKEN, read)).toBeNull();
    await raw`update public.integration_connection set status = 'connected'
              where organization_id = ${ORG} and capability = 'messaging'`;
  });
});
