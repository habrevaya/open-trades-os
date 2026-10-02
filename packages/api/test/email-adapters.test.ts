import { describe, it, expect, afterEach, vi } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { createResendProvider, svixSignature, verifySvix } from "../src/email/resend";
import { createSmtpProvider, transportFor, type SmtpTransport } from "../src/email/smtp";
import {
  createEmailProvider, EmailProviderNotConfiguredError, registeredEmailProviders,
  type OutboundEmail, type WebhookRequest,
} from "../src/email/provider";
import "../src/email/index";

/**
 * THE TWO ADAPTERS, WITHOUT A NETWORK
 *
 * Nothing here opens a socket. `fetch` is stubbed and the SMTP transport is
 * injected, because a test that reaches a real provider fails when somebody
 * runs the suite offline and sends mail to a stranger the first time a
 * fixture is fat fingered.
 *
 * The signature tests are the important half of this file. A verification
 * that always returns true and one that always returns false both look like
 * working code, and only one of them is a hole anyone on the internet can
 * walk through.
 */

const SECRET_BYTES = randomBytes(24);
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const BODY = JSON.stringify({
  type: "email.delivered",
  data: { email_id: "re_abc", to: ["owner@customer.test"] },
});

function signed(body = BODY, at: number = Math.floor(Date.now() / 1000)): WebhookRequest {
  const id = "msg_2abc";
  const timestamp = String(at);
  return {
    url: "https://example.com/api/webhooks/email/tok",
    headers: {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${svixSignature(SECRET, id, timestamp, body)}`,
    },
    body,
  };
}

describe("the Svix signature Resend uses", () => {
  it("accepts a genuine request", () => {
    expect(verifySvix(SECRET, signed(), 300)).toBe(true);
  });

  it("refuses a body that changed by one byte", () => {
    /**
     * The whole point. The signature covers the exact bytes, so a body
     * rewritten anywhere between the provider and here stops verifying.
     */
    const request = signed();
    expect(verifySvix(SECRET, { ...request, body: `${request.body} ` }, 300)).toBe(false);
  });

  it("refuses a body re-serialized from its own parsed form", () => {
    /**
     * The mistake this product's dispatcher would make if a webhook went
     * through it: parse the JSON, keep the object, rebuild the string. Key
     * order and whitespace change and every signature breaks, and the usual
     * fix for a check that never passes is to stop checking.
     */
    const request = signed();
    const rebuilt = JSON.stringify(JSON.parse(request.body), ["data", "type", "email_id", "to"]);
    expect(rebuilt).not.toBe(request.body);
    expect(verifySvix(SECRET, { ...request, body: rebuilt }, 300)).toBe(false);
  });

  it("refuses a signature keyed by the printable secret instead of its bytes", () => {
    /**
     * The single most common way to get this wrong. `whsec_...` is base64
     * after the prefix, and the key is the DECODED bytes. Using the string
     * produces a check that never passes.
     */
    const id = "msg_2abc";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const wrong = createHmac("sha256", SECRET)
      .update(`${id}.${timestamp}.${BODY}`, "utf8").digest("base64");
    expect(verifySvix(SECRET, {
      url: "", body: BODY,
      headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${wrong}` },
    }, 300)).toBe(false);
  });

  it("refuses a correctly signed request that is too old to be live", () => {
    /**
     * Without a tolerance a captured request replays forever, and replaying a
     * hard bounce is how an attacker gets an address suppressed.
     */
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(verifySvix(SECRET, signed(BODY, old), 300)).toBe(false);
  });

  it("refuses a timestamp in the future", () => {
    /**
     * Both directions. Only bounding the past lets somebody with the clock
     * mint a request that stays valid for as long as they like.
     */
    const ahead = Math.floor(Date.now() / 1000) + 3600;
    expect(verifySvix(SECRET, signed(BODY, ahead), 300)).toBe(false);
  });

  it("accepts the second signature during a secret rotation", () => {
    /**
     * The header carries a space separated list because two secrets are live
     * while one is being rotated. Matching only the first drops every webhook
     * for the duration of the rotation.
     */
    const request = signed();
    const mine = request.headers["svix-signature"]!;
    expect(verifySvix(SECRET, {
      ...request,
      headers: { ...request.headers, "svix-signature": `v1,AAAA ${mine}` },
    }, 300)).toBe(true);
  });

  it("refuses a request with no signature headers at all", () => {
    expect(verifySvix(SECRET, { url: "", headers: {}, body: BODY }, 300)).toBe(false);
  });
});

describe("the Resend adapter", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function stubFetch(status: number, payload: unknown) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(payload), {
        status, headers: { "content-type": "application/json" },
      });
    });
    return calls;
  }

  const message: OutboundEmail = {
    to: "owner@customer.test",
    from: "hello@example-trades.com",
    subject: "Your invoice",
    text: "Attached.",
    reference: "11111111-1111-4111-8111-111111111111",
  };

  it("carries our reference as a tag and as the idempotency key", async () => {
    /**
     * The tag is how a delivery callback names our own message. The
     * idempotency key is how a retry that crossed in flight does not send the
     * mail twice. They are different problems and both are cheap.
     */
    const calls = stubFetch(200, { id: "re_1" });
    const result = await createResendProvider({}, "re_key").send(message);
    expect(result).toEqual({ ok: true, providerMessageId: "re_1" });

    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body["tags"]).toEqual([{ name: "reference", value: message.reference }]);
    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"])
      .toBe(message.reference);
  });

  it("treats a rate limit as retryable and a rejected address as permanent", async () => {
    stubFetch(429, { name: "rate_limit_exceeded", message: "slow down" });
    expect(await createResendProvider({}, "k").send(message))
      .toMatchObject({ ok: false, retryable: true });

    vi.unstubAllGlobals();
    stubFetch(422, { name: "validation_error", message: "not a valid address" });
    expect(await createResendProvider({}, "k").send(message))
      .toMatchObject({ ok: false, retryable: false });
  });

  it("refuses to call a 200 with no message id a success", async () => {
    /**
     * Storing a null provider id on a message marked sent means every later
     * callback for it matches nothing, and the message is unauditable from
     * the moment it leaves.
     */
    stubFetch(200, { ok: true });
    expect(await createResendProvider({}, "k").send(message)).toMatchObject({
      ok: false, code: "no_message_id", retryable: true,
    });
  });

  it("reports no delivery feedback when no signing secret is configured", async () => {
    /**
     * Honest rather than a `verify` that always returns false. The operator
     * sees a sentence telling them what to go and get instead of a delivery
     * column that is silently always empty.
     */
    const provider = createResendProvider({}, "k");
    expect(provider.delivery.kind).toBe("none");
    if (provider.delivery.kind !== "none") throw new Error("unreachable");
    expect(provider.delivery.because).toMatch(/signing secret/i);
  });

  it("never takes the signing secret from the settings, which are a database column", () => {
    const provider = createResendProvider({ webhookSecret: SECRET }, "k");
    expect(provider.delivery.kind).toBe("none");
  });

  it("parses a delivery, a hard bounce and a complaint, and ignores an open", () => {
    const provider = createResendProvider({}, "k", { webhookSecret: SECRET });
    if (provider.delivery.kind !== "webhook") throw new Error("unreachable");
    const parse = (payload: unknown) =>
      provider.delivery.kind === "webhook"
        ? provider.delivery.parse({ url: "", headers: {}, body: JSON.stringify(payload) })
        : null;

    expect(parse({
      type: "email.delivered",
      data: { email_id: "re_1", tags: [{ name: "reference", value: "ref-1" }] },
    })).toMatchObject({ type: "delivered", providerMessageId: "re_1", reference: "ref-1" });

    expect(parse({
      type: "email.bounced",
      data: { email_id: "re_2", bounce: { type: "Permanent", subType: "General" } },
    })).toMatchObject({ type: "bounced", permanent: true });

    /**
     * A transient bounce must NOT be reported as permanent. A soft bounce
     * wrongly called hard writes a suppression, and a suppression is a
     * customer this company can no longer email until somebody notices.
     */
    expect(parse({
      type: "email.bounced",
      data: { email_id: "re_3", bounce: { type: "Transient", subType: "MailboxFull" } },
    })).toMatchObject({ type: "bounced", permanent: false });

    expect(parse({ type: "email.complained", data: { email_id: "re_4" } }))
      .toMatchObject({ type: "complained" });

    /**
     * An open is a tracking pixel that Apple Mail Privacy Protection fetches
     * whether or not a human looked. Nothing in this product reads one, so
     * parsing it would be inventing a fact.
     */
    expect(parse({ type: "email.opened", data: { email_id: "re_5" } })).toBeNull();
  });

  it("ignores an event type it has never heard of rather than failing", () => {
    /**
     * A webhook that errors on an event the provider added last week is a
     * webhook the provider eventually disables for being unreliable, and the
     * deliveries we DO care about go with it.
     */
    const provider = createResendProvider({}, "k", { webhookSecret: SECRET });
    if (provider.delivery.kind !== "webhook") throw new Error("unreachable");
    expect(provider.delivery.parse({
      url: "", headers: {},
      body: JSON.stringify({ type: "email.something_new", data: { email_id: "re_9" } }),
    })).toBeNull();
  });

  it("does not fall over on a body that is not JSON", () => {
    const provider = createResendProvider({}, "k", { webhookSecret: SECRET });
    if (provider.delivery.kind !== "webhook") throw new Error("unreachable");
    expect(provider.delivery.parse({ url: "", headers: {}, body: "<html>nope" })).toBeNull();
  });
});

describe("the generic SMTP adapter", () => {
  const message: OutboundEmail = {
    to: "owner@customer.test",
    from: "hello@example-trades.com",
    subject: "Your invoice",
    text: "Attached.",
    html: "<p>Attached.</p>",
    replyTo: "dispatch@example-trades.com",
    reference: "22222222-2222-4222-8222-222222222222",
  };

  function transport(behaviour: {
    info?: Record<string, unknown>;
    throws?: unknown;
  } = {}): SmtpTransport & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      async sendMail(options) {
        calls.push(options);
        if (behaviour.throws) throw behaviour.throws;
        return { messageId: "<abc@example-trades.com>", accepted: [message.to], rejected: [], ...behaviour.info };
      },
    };
  }

  it("says plainly that it cannot report delivery", () => {
    /**
     * The honest shape, forced by the type. SMTP ends at the receiving
     * server's 250 OK; a bounce arrives hours later as a separate email to a
     * mailbox this product does not read. An adapter that claimed a webhook
     * and never fired one would leave an operator waiting for a column that
     * is never going to fill.
     */
    const provider = createSmtpProvider({ host: "smtp.test", port: 587 }, "pw", transport());
    expect(provider.delivery.kind).toBe("none");
    if (provider.delivery.kind !== "none") throw new Error("unreachable");
    expect(provider.delivery.because).toMatch(/SMTP tells us only/);
  });

  it("passes both body parts and the reply address through", async () => {
    const fake = transport();
    const result = await createSmtpProvider({ host: "smtp.test", port: 587 }, "pw", fake)
      .send(message);
    expect(result).toEqual({ ok: true, providerMessageId: "<abc@example-trades.com>" });
    expect(fake.calls[0]).toMatchObject({
      to: message.to, subject: message.subject,
      text: "Attached.", html: "<p>Attached.</p>",
      replyTo: "dispatch@example-trades.com",
    });
  });

  it("treats a 4xx reply as retryable and a 5xx as permanent", async () => {
    /**
     * RFC 5321 says it outright: a 4yz reply is transient and the sender
     * SHOULD try again, a 5yz is permanent. Greylisting, which most well
     * configured receivers do, is a 451 on first contact from an unknown
     * sender. Treating it as permanent means a self hoster's first email to
     * every new domain fails.
     */
    const greylisted = await createSmtpProvider({ host: "h", port: 587 }, "pw",
      transport({ throws: { responseCode: 451, code: "EENVELOPE", message: "greylisted" } }))
      .send(message);
    expect(greylisted).toMatchObject({ ok: false, retryable: true });

    const rejected = await createSmtpProvider({ host: "h", port: 587 }, "pw",
      transport({ throws: { responseCode: 550, code: "EENVELOPE", message: "no such user" } }))
      .send(message);
    expect(rejected).toMatchObject({ ok: false, retryable: false });
  });

  it("treats a connection that never got a reply as retryable", async () => {
    const result = await createSmtpProvider({ host: "h", port: 587 }, "pw",
      transport({ throws: { code: "ECONNECTION", message: "connect ECONNREFUSED" } }))
      .send(message);
    expect(result).toMatchObject({ ok: false, code: "ECONNECTION", retryable: true });
  });

  it("does not call a resolved send a success when the recipient was rejected", async () => {
    /**
     * nodemailer resolves when at least one recipient was accepted. This
     * adapter always sends to exactly one, so a non-empty `rejected` means
     * the only recipient was refused, and reporting ok would mark the message
     * sent and stop anybody looking at it again.
     */
    const result = await createSmtpProvider({ host: "h", port: 587 }, "pw",
      transport({ info: { rejected: [message.to], response: "550 refused" } }))
      .send(message);
    expect(result).toMatchObject({ ok: false, code: "recipient_rejected", retryable: false });
  });

  it("does not call a send with no Message-ID a success", async () => {
    const result = await createSmtpProvider({ host: "h", port: 587 }, "pw",
      transport({ info: { messageId: undefined } }))
      .send(message);
    expect(result).toMatchObject({ ok: false, code: "no_message_id" });
  });

  it("refuses to send a password over an unencrypted connection", () => {
    /**
     * SMTP AUTH LOGIN is base64, which is not encryption and is routinely
     * mistaken for it. Without this an operator who picks "none" to get past
     * a certificate error puts their mailbox password on the wire on every
     * message, for as long as nobody looks.
     */
    expect(() => transportFor(
      { host: "smtp.test", port: 25, security: "none", username: "postmaster" }, "pw",
    )).toThrow(/in the clear/i);
  });

  it("allows an unauthenticated relay, which is a real setup", () => {
    /**
     * A relay on localhost with no credentials is legitimate and common in a
     * self hosted deployment. There is no password to leak, so there is
     * nothing to refuse.
     */
    expect(() => transportFor({ host: "127.0.0.1", port: 25, security: "none" }, ""))
      .not.toThrow();
  });

  it("makes STARTTLS mandatory rather than opportunistic", () => {
    /**
     * The part people get wrong. STARTTLS is an upgrade on a plain
     * connection, so it is `secure: false`, and WITHOUT `requireTLS` a server
     * that does not offer the upgrade is silently talked to in plaintext.
     * The operator picked an encrypted mode and would never find out.
     */
    const starttls = transportFor(
      { host: "smtp.test", port: 587, security: "starttls", username: "u" }, "pw",
    ) as unknown as { options?: Record<string, unknown> };
    expect(starttls.options?.["requireTLS"]).toBe(true);
    expect(starttls.options?.["secure"]).toBe(false);

    /** Implicit TLS is the other mode: encrypted from the first byte. */
    const implicit = transportFor(
      { host: "smtp.test", port: 465, security: "tls", username: "u" }, "pw",
    ) as unknown as { options?: Record<string, unknown> };
    expect(implicit.options?.["secure"]).toBe(true);
  });

  it("allows plaintext auth only when the operator says they meant it", () => {
    expect(() => transportFor(
      { host: "smtp.test", port: 25, security: "none", username: "u", allowPlaintextAuth: true },
      "pw",
    )).not.toThrow();
  });
});

describe("the registry", () => {
  it("has both adapters once the barrel is imported", () => {
    expect(registeredEmailProviders()).toEqual(expect.arrayContaining(["resend", "smtp"]));
  });

  it("refuses a provider nobody wrote an adapter for", () => {
    /**
     * Named rather than falling back to something. A deployment configured
     * for a provider this build does not have should stop, not quietly send
     * a customer's invoice through whatever happened to be registered first.
     */
    expect(() => createEmailProvider("mailchimp", {}, "k"))
      .toThrow(EmailProviderNotConfiguredError);
  });
});
