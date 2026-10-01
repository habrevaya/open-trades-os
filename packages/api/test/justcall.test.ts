import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createJustCallProvider, justCallSignature, MAX_SKEW_MS,
} from "../src/comms/justcall";
import { createProvider, registeredProviders } from "../src/comms/index";
import type { WebhookRequest } from "../src/comms/provider";

/**
 * JUSTCALL, AND WHETHER THE MESSAGING SEAM WAS DRAWN IN THE RIGHT PLACE
 *
 * The product had one carrier for its whole life, which means the interface
 * in `comms/provider.ts` had never been asked to hold two. A seam with one
 * implementation is a shape somebody guessed at.
 *
 * So the question underneath this file is not "does JustCall work". It is
 * whether a second carrier needed anything outside its own adapter, and the
 * answer is in `comms/index.ts`: one import line. Nothing in the send path,
 * the outbox, the consent rules or the inbox knows which carrier is
 * configured, and the test at the bottom pins that by reaching this adapter
 * through the registry rather than by calling the factory.
 *
 * THE PROPERTY MOST OF THIS FILE IS ABOUT is that a signature which does not
 * cover the body is a weaker promise than one that does, and the code says
 * so rather than treating the two as interchangeable. JustCall signs the
 * secret, the URL, the event type and a timestamp. Not the message. Every
 * test below that looks paranoid is there because of that one fact.
 */

const KEY = "ea39089c40790e9dc7a080ec95e849b8fa0fa5fb";
const SECRET = "ea39089c40790e9dc7a080ec95e849b8fa0fa5fb";
const CREDENTIAL = `api-key-half:${SECRET}`;
const HOOK = "https://app.example.com/api/webhooks/justcall";

const provider = (settings: Record<string, unknown> = {}) =>
  createJustCallProvider({ webhookUrl: HOOK, ...settings }, CREDENTIAL);

/** A timestamp in their format, offset from now by a number of minutes. */
function stamp(minutesAgo = 0): string {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  return at.toISOString().slice(0, 19).replace("T", " ");
}

function signed(body: Record<string, unknown>, at = stamp()): WebhookRequest {
  const raw = JSON.stringify(body);
  return {
    url: HOOK,
    headers: {
      "x-justcall-signature": justCallSignature(SECRET, HOOK, String(body["type"]), at),
      "x-justcall-signature-version": "v1",
      "x-justcall-request-timestamp": at,
    },
    body: raw,
  };
}

const INBOUND = {
  request_id: "01HQAMVFRC4HZ0144TDSXXXX",
  webhook_url: HOOK,
  url_id: "65d5a5ed180da91d76edXXXX",
  type: "sms.received",
  data: {
    id: 123455001,
    contact_number: "+15125550160",
    justcall_number: "+15125550100",
    direction: "Incoming",
    delivery_status: "received",
    sms_info: { body: "On my way", is_mms: "no", mms: [] },
  },
};

const RECEIPT = {
  request_id: "01HQAMVFRC4HZ0144TDSXXXY",
  webhook_url: HOOK,
  url_id: "65d5a5ed180da91d76edXXXX",
  type: "sms.status_updated",
  data: {
    id: 123455002,
    contact_number: "+15125550160",
    justcall_number: "+15125550100",
    direction: "Outgoing",
    delivery_status: "delivered",
    sms_info: { body: "Your technician is on the way", is_mms: "no", mms: [] },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ------------------------------------------------------- the signature */

describe("the signature, against the vendor's own published answer", () => {
  it("reproduces the worked example in their documentation", () => {
    /**
     * Verbatim from developer.justcall.io, secret, URL, type, timestamp and
     * expected digest. Tested against THEIR answer rather than against this
     * file's reading of their prose, because a signature check written from
     * a description and never compared to a real one is a check that agrees
     * with itself.
     */
    expect(
      justCallSignature(
        "ea39089c40790e9dc7a080ec95e849b8fa0fa5fb",
        "https://webhook.site/3bcea770-370a-4b09-8b66-426f687e08a4",
        "call.completed",
        "2024-03-21 17:08:22",
      ),
    ).toBe("56761bae5b27a784a3ddd2af828bc5def7176bc0a8650199b04c737bd39bbecf");
  });

  it("accepts a correctly signed delivery", () => {
    expect(provider().verify(signed(INBOUND))).toBe(true);
  });

  it("refuses one signed with a different secret", () => {
    const at = stamp();
    const request = signed(INBOUND, at);
    request.headers["x-justcall-signature"] =
      justCallSignature("not-the-secret", HOOK, INBOUND.type, at);
    expect(provider().verify(request)).toBe(false);
  });

  it("refuses one with no signature at all", () => {
    const request = signed(INBOUND);
    delete request.headers["x-justcall-signature"];
    expect(provider().verify(request)).toBe(false);
  });

  it("refuses one with no timestamp, which is the only freshness there is", () => {
    const request = signed(INBOUND);
    delete request.headers["x-justcall-request-timestamp"];
    expect(provider().verify(request)).toBe(false);
  });

  it("signs the URL WE were configured with, not the one the body claims", () => {
    /**
     * THE DEFECT THIS TEST EXISTS FOR, and the one a reasonable
     * implementation walks straight into, because their own sample code
     * reads `body.webhook_url`.
     *
     * The URL is in the signed string and the body is the one thing an
     * attacker controls completely. Taking it from the body means checking
     * their claim against their own signature: anybody holding the secret
     * for ANY JustCall account could sign a body naming their own URL and
     * this would accept it as a delivery to ours.
     */
    const forged = { ...INBOUND, webhook_url: "https://evil.example.com/hook" };
    const at = stamp();
    const request: WebhookRequest = {
      url: HOOK,
      headers: {
        "x-justcall-signature":
          justCallSignature(SECRET, "https://evil.example.com/hook", forged.type, at),
        "x-justcall-request-timestamp": at,
      },
      body: JSON.stringify(forged),
    };
    expect(provider().verify(request)).toBe(false);
  });

  it("refuses a delivery older than the replay window", () => {
    const at = stamp(MAX_SKEW_MS / 60_000 + 1);
    expect(provider().verify(signed(INBOUND, at))).toBe(false);
  });

  it("accepts one inside it", () => {
    expect(provider().verify(signed(INBOUND, stamp(1)))).toBe(true);
  });

  it("reads their timestamp as UTC, not as the server's local time", () => {
    /**
     * "2024-03-21 17:08:22" has no zone, and V8 parses a space separated
     * date as LOCAL time. On a box set to anything but UTC that puts every
     * genuine delivery hours out of the window, so the skew check would
     * refuse the real ones and only the real ones: a failure that passes
     * every test written in UTC and breaks on one machine in Austin.
     */
    /**
     * THE TIME ZONE HAS TO BE MOVED OR THIS TEST CANNOT FAIL.
     *
     * The first version of this set a fake clock and asserted the delivery
     * was accepted, and stayed green with the parse deliberately switched to
     * local time: vitest runs with TZ unset, which resolves to UTC, where
     * local and UTC are the same number. A test that cannot fail is worse
     * than no test, because it reads as coverage of the exact bug it misses.
     *
     * Node honours a TZ change at runtime, so the zone is moved for the
     * length of this one assertion and put back.
     */
    const original = process.env.TZ;
    process.env.TZ = "America/Chicago";
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-03-21T17:08:30Z"));
      const at = "2024-03-21 17:08:22";
      expect(provider().verify(signed(INBOUND, at))).toBe(true);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("refuses a timestamp that is not a time", () => {
    expect(provider().verify(signed(INBOUND, "the day before yesterday"))).toBe(false);
  });

  it("keys the HMAC with the secret half of the credential, not the whole thing", () => {
    /**
     * The credential arrives as one `key:secret` string because a deployment
     * secret store holds one value per name. Only the half after the colon
     * signs, so a verify built on the whole string would reject every
     * genuine delivery.
     */
    const at = stamp();
    const request = signed(INBOUND, at);
    request.headers["x-justcall-signature"] =
      justCallSignature(CREDENTIAL, HOOK, INBOUND.type, at);
    expect(provider().verify(request)).toBe(false);
    expect(provider().verify(signed(INBOUND, at))).toBe(true);
  });
});

/* --------------------------------------------------------- what arrived */

describe("reading what arrived", () => {
  it("parses an inbound message, body and all", () => {
    expect(provider().parseInbound(signed(INBOUND))).toEqual({
      from: "+15125550160",
      to: "+15125550100",
      body: "On my way",
      media: [],
      providerMessageId: "123455001",
    });
  });

  it("finds the media on an inbound MMS", () => {
    const mms = {
      ...INBOUND,
      data: {
        ...INBOUND.data,
        sms_info: {
          body: "Here is the panel",
          is_mms: "yes",
          mms: [{ media_url: "https://cdn.example.com/a.png", content_type: "image/png" }],
        },
      },
    };
    expect(provider().parseInbound(signed(mms))?.media)
      .toEqual([{ url: "https://cdn.example.com/a.png", contentType: "image/png" }]);
  });

  it("does not read an outgoing message as an inbound one", () => {
    /**
     * `sms.sent_received` fires in both directions with the same shape, so
     * the event name cannot decide this. A product that read its own sends
     * back in would thread every reminder into the inbox as if the customer
     * had written it, and an automation watching for a reply would fire on
     * its own message.
     */
    const outgoing = { ...INBOUND, type: "sms.sent_received", data: { ...INBOUND.data, direction: "Outgoing" } };
    expect(provider().parseInbound(signed(outgoing))).toBeNull();
  });

  it("does not read a delivery receipt as an inbound message", () => {
    expect(provider().parseInbound(signed(RECEIPT))).toBeNull();
  });

  it("refuses an inbound with no sender, which nothing could be threaded onto", () => {
    const anonymous = { ...INBOUND, data: { ...INBOUND.data, contact_number: "" } };
    expect(provider().parseInbound(signed(anonymous))).toBeNull();
  });

  it("refuses an inbound with no id of their own", () => {
    /**
     * Their id is the unique key the inbound path writes. With none, every
     * such message collapses onto one empty value and the second one is
     * treated as a repeat of the first: a customer's reply disappearing with
     * a success recorded.
     */
    const { id: _id, ...rest } = INBOUND.data;
    expect(provider().parseInbound(signed({ ...INBOUND, data: rest }))).toBeNull();
  });

  it("returns nothing for a body that is not JSON", () => {
    const request: WebhookRequest = { url: HOOK, headers: {}, body: "<html>no</html>" };
    expect(provider().parseInbound(request)).toBeNull();
    expect(provider().parseDelivery(request)).toBeNull();
    expect(provider().verify(request)).toBe(false);
  });
});

/* ------------------------------------------------------- delivery state */

describe("delivery receipts", () => {
  it("reads a delivered receipt", () => {
    expect(provider().parseDelivery(signed(RECEIPT))).toEqual({
      providerMessageId: "123455002",
      reference: undefined,
      status: "delivered",
      errorCode: undefined,
      errorMessage: undefined,
    });
  });

  it("does not read an inbound message as a receipt for something we sent", () => {
    /**
     * TWO GATES, AND THIS NAMES WHICH ONE IS DOING THE WORK.
     *
     * The first version asserted only the line above and stayed green with
     * the direction check deleted, because the sample inbound carries
     * `delivery_status: "received"`, which is not in the status map either.
     * A test that passes through two gates cannot say which of them is
     * holding, and deleting the wrong one would have gone unnoticed.
     *
     * So the second case is an INCOMING message carrying a status that DOES
     * map. Only the direction check can refuse that one, and it has to:
     * their `sms.sent_received` event fires in both directions with the same
     * shape, and writing a receipt against a message the customer sent would
     * overwrite the real delivery state of the outbound one on that thread.
     */
    expect(provider().parseDelivery(signed(INBOUND))).toBeNull();

    const incomingButDelivered = {
      ...INBOUND,
      type: "sms.sent_received",
      data: { ...INBOUND.data, direction: "Incoming", delivery_status: "delivered" },
    };
    expect(provider().parseDelivery(signed(incomingButDelivered))).toBeNull();
  });

  it("ignores a status with no outcome in it yet", () => {
    /**
     * Their own examples show an empty string on a message just sent.
     * Recording that would move a message backwards from delivered when
     * callbacks arrive out of order, which is the same reason the Twilio
     * adapter drops `queued`.
     */
    const pending = { ...RECEIPT, data: { ...RECEIPT.data, delivery_status: "" } };
    expect(provider().parseDelivery(signed(pending))).toBeNull();
  });

  it("keeps undelivered and failed apart", () => {
    for (const status of ["undelivered", "failed"] as const) {
      const body = { ...RECEIPT, data: { ...RECEIPT.data, delivery_status: status } };
      expect(provider().parseDelivery(signed(body))?.status).toBe(status);
    }
  });
});

/* ------------------------------------------------------------- sending */

describe("sending", () => {
  const message = {
    to: "+15125550160", from: "+15125550100",
    body: "Your technician is on the way", reference: "our-ref-1",
  };

  function stubFetch(status: number, body: unknown, capture?: (init: RequestInit) => void) {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      capture?.(init);
      return new Response(JSON.stringify(body), {
        status, headers: { "Content-Type": "application/json" },
      });
    }));
  }

  it("sends as JSON with their colon separated Authorization header", async () => {
    let seen: RequestInit | undefined;
    stubFetch(200, { data: { id: 987 } }, (init) => { seen = init; });

    const result = await provider().send(message);
    expect(result).toEqual({ ok: true, providerMessageId: "987" });

    const headers = seen?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(CREDENTIAL);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(seen?.body))).toEqual({
      justcall_number: "+15125550100",
      contact_number: "+15125550160",
      body: "Your technician is on the way",
    });
  });

  it("does not ask them to suppress duplicates", () => {
    /**
     * `restrict_once` drops the same body to the same number inside 24
     * hours, silently, with a success returned. The outbox already makes
     * that decision with our idempotency key and our rules, and two of them
     * means a legitimate second reminder vanishing at the carrier while
     * this product records it as sent.
     */
    let seen: RequestInit | undefined;
    stubFetch(200, { data: { id: 1 } }, (init) => { seen = init; });
    return provider().send(message).then(() => {
      expect(Object.keys(JSON.parse(String(seen?.body)))).not.toContain("restrict_once");
    });
  });

  it("joins media into the one comma separated field they take", async () => {
    let seen: RequestInit | undefined;
    stubFetch(200, { data: { id: 2 } }, (init) => { seen = init; });
    await provider().send({ ...message, media: ["https://a.example/1.png", "https://a.example/2.png"] });
    expect(JSON.parse(String(seen?.body))["media_url"])
      .toBe("https://a.example/1.png,https://a.example/2.png");
  });

  it("calls a rate limit retryable and a refusal not", async () => {
    stubFetch(429, { message: "slow down" });
    expect(await provider().send(message)).toMatchObject({ ok: false, retryable: true });

    stubFetch(400, { message: "that number is not yours" });
    expect(await provider().send(message)).toMatchObject({ ok: false, retryable: false });

    stubFetch(503, { message: "down" });
    expect(await provider().send(message)).toMatchObject({ ok: false, retryable: true });
  });

  it("treats a network failure as retryable, because nothing was sent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    expect(await provider().send(message)).toMatchObject({
      ok: false, code: "network", retryable: true,
    });
  });

  it("refuses a 200 that carries no id, rather than storing an empty one", async () => {
    /**
     * Their id is what every delivery receipt is matched on. Reporting
     * success with "" means the next receipt matches this row too, and a
     * message somebody is chasing shows the wrong state.
     */
    stubFetch(200, { data: {} });
    expect(await provider().send(message)).toMatchObject({
      ok: false, code: "no_id", retryable: false,
    });
  });
});

/* ---------------------------------------------------------- the seam */

describe("the seam the whole adapter is a test of", () => {
  it("is reachable by name, without anything importing this file", () => {
    /**
     * The registry, not the factory. Every other test here calls
     * `createJustCallProvider` directly, which would still pass if the
     * registration line were deleted and no deployment could ever select
     * this carrier.
     */
    expect(registeredProviders()).toContain("justcall");
    expect(registeredProviders()).toContain("twilio");
    expect(createProvider("justcall", { webhookUrl: HOOK }, CREDENTIAL).name).toBe("justcall");
  });

  it("required nothing outside its own file", async () => {
    /**
     * The claim this module is making: a second carrier is an adapter, not a
     * change to the product. Asserted as a property rather than left as a
     * sentence in a commit message, by reading the two files that would have
     * had to change if the seam had been drawn wrong.
     */
    const { readFile } = await import("node:fs/promises");
    const sendPath = await readFile(
      new URL("../src/services/comms-outbox.ts", import.meta.url), "utf8",
    );
    const inbound = await readFile(
      new URL("../src/services/comms-inbound.ts", import.meta.url), "utf8",
    );

    /**
     * A QUOTED CARRIER NAME, NOT A MENTIONED ONE.
     *
     * The first version of this refused any occurrence of either name and
     * went red on a comment in `comms-outbox.ts` explaining a bug with
     * Twilio as the worked example. That is a prose mention, and refusing it
     * would be a test that stops this codebase explaining itself.
     *
     * The property is a DEPENDENCY: an import of an adapter, or a carrier
     * name in a string literal, which is the only form a branch on one can
     * take. Either of those is the send path knowing which carrier is
     * configured, which is the thing this seam exists to prevent.
     */
    for (const source of [sendPath, inbound]) {
      expect(source).not.toMatch(/["'`](twilio|justcall)["'`]/i);
      expect(source).not.toMatch(/from\s+["'][^"']*comms\/(twilio|justcall)["']/i);
    }
  });
});
