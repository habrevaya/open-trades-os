import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import * as core from "@opentradesos/core";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as webhooks from "../src/services/webhooks";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { runPass } from "../src/services/workflow-worker";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * OUTBOUND WEBHOOKS, WHICH NOTHING COULD REGISTER OR DELIVER
 *
 * `webhook_endpoint` has existed since the first migrations, carrying a URL,
 * a secret, an event list, an active flag, a failure count and a last
 * delivery time. No code in this product read or wrote any of it. The
 * automation schema names it as one of the two consumers `domain_event` was
 * built for, and it was the one that never arrived: every event this product
 * produces was readable only by being this codebase.
 *
 * The two properties these tests exist to hold are the ones that fail
 * silently otherwise. A subscription to an event nothing emits is a receiver
 * somebody built, tested and deployed that will never be called, and no
 * screen anywhere can tell that apart from a quiet week. And a delivery
 * whose timestamp is not inside the signed payload can be replayed forever
 * by anybody who captured it once, with the receiver seeing nothing wrong.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("wh:org");
const USER = fixtureId("wh:user");
const RECEIVER = "https://hooks.example.test/otos";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

/** Events are written straight in, because the point here is the reading. */
let sequence = 0;
async function emitted(name: string, payload: Record<string, string> = {}) {
  sequence += 1;
  const [row] = await raw<{ id: string }[]>`
    insert into public.domain_event
      (organization_id, sequence, name, entity_type, entity_id, payload)
    values (${ORG}, ${sequence}, ${name}, 'job', null, ${raw.json(payload)})
    returning id`;
  return { id: row!.id, sequence };
}

const OK: webhooks.DeliveryResponse = { status: 200, ok: true };
const DOWN: webhooks.DeliveryResponse = { status: 503, ok: false };

function transport(answer: (request: webhooks.DeliveryRequest) => webhooks.DeliveryResponse = () => OK) {
  const calls: webhooks.DeliveryRequest[] = [];
  const send: webhooks.Transport = async (request) => {
    calls.push(request);
    return answer(request);
  };
  return { calls, send };
}

const T0 = Date.UTC(2026, 0, 14, 9, 0, 0);
const at = (offsetMs: number) => () => new Date(T0 + offsetMs);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Webhook Co", slug: "webhook-co" });
});

afterAll(async () => {
  if (!raw) return;
  /**
   * Endpoints left failing or with a replay waiting are work the worker goes
   * looking for in every company, so a worker test running after this file
   * would try to reach the receivers named here. They are fixtures, not
   * history, and they go.
   */
  await raw`delete from public.webhook_endpoint where organization_id = ${ORG}`;
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.event_cursor where organization_id = ${ORG}`;
  await raw`delete from public.webhook_endpoint where organization_id = ${ORG}`;
  await raw`delete from public.domain_event where organization_id = ${ORG}`;
  await raw`delete from public.audit_log where organization_id = ${ORG}`;
  sequence = 0;
});

run("subscribing to an event", () => {
  it("registers an endpoint for an event the product actually emits", async () => {
    const endpoint = await webhooks.register(owner(), {
      url: RECEIVER, events: ["invoice.paid", "job.completed"],
    });
    expect(endpoint.events).toEqual(["invoice.paid", "job.completed"]);
    expect(endpoint.active).toBe(true);
  });

  it("refuses a name nothing in the catalogue knows", async () => {
    /**
     * The whole finding. A receiver subscribed to `invoice.payed` is built,
     * tested by hand, deployed and never called, and nothing on either side
     * of the integration can tell that apart from a quiet week.
     */
    await expect(webhooks.register(owner(), { url: RECEIVER, events: ["invoice.payed"] }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses an event the catalogue declares and nothing emits yet", async () => {
    /**
     * `invoice.sent` is in the catalogue with `emitted: false`, owed by M13.
     * It is a perfectly plausible thing to subscribe to and it would never
     * arrive, which is exactly the trap the workflow builder refuses.
     */
    await expect(webhooks.register(owner(), { url: RECEIVER, events: ["invoice.sent"] }))
      .rejects.toThrow(/not emitted yet/);
  });

  it("refuses a dwell event, which is emitted and is not a subscription", async () => {
    await expect(webhooks.register(owner(), { url: RECEIVER, events: ["job.dwelling"] }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("allows a name this company's own log already holds", async () => {
    /**
     * Written by an older build or a migration. It is a real thing in this
     * company's history and an integration on it works, so refusing it would
     * break something that is delivering today.
     */
    await emitted("legacy.thing");
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["legacy.thing"] });
    expect(endpoint.events).toEqual(["legacy.thing"]);
  });

  it("refuses an endpoint subscribed to nothing", async () => {
    await expect(webhooks.register(owner(), { url: RECEIVER, events: [] }))
      .rejects.toThrow(/never be called/);
  });

  it("refuses plaintext http", async () => {
    await expect(webhooks.register(owner(), {
      url: "http://hooks.example.test/otos", events: ["job.completed"],
    })).rejects.toThrow(/https/);
  });

  it("refuses a loopback address, which is the exception somebody always wants", async () => {
    await expect(webhooks.register(owner(), {
      url: "http://127.0.0.1:9000/hook", events: ["job.completed"],
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("offers the same list it validates against, plus this company's own history", async () => {
    /**
     * A settings screen that builds its own list is how the workflow builder
     * came to offer fourteen triggers of which one was ever emitted.
     */
    await emitted("legacy.thing");
    const offered = await webhooks.catalogue(owner());
    const names = offered.map((e) => e.name);

    expect(names).toContain("job.completed");
    expect(names).toContain("legacy.thing");
    /** Nothing emits it, so it is not offered, whatever the catalogue says. */
    expect(names).not.toContain("invoice.sent");
    /** Emitted, and not a subscription: offering it produces a dead endpoint. */
    expect(names).not.toContain("job.dwelling");

    expect(offered.find((e) => e.name === "job.completed")!.summary)
      .toBe("A job was finished");
    /** A name from this company's log has no sentence, and the bare name beats hiding it. */
    expect(offered.find((e) => e.name === "legacy.thing")!.summary).toBeNull();
  });

  it("refuses to register for a role that cannot touch integrations", async () => {
    await expect(webhooks.register(as(["accountant"]), {
      url: RECEIVER, events: ["job.completed"],
    })).rejects.toBeInstanceOf(PermissionError);
  });

  it("refuses to empty the event list through an update", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await expect(webhooks.update(owner(), { id: endpoint.id, events: [] }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses to point an existing endpoint at a dead event", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await expect(webhooks.update(owner(), { id: endpoint.id, events: ["payment.failed"] }))
      .rejects.toBeInstanceOf(ConflictError);
  });
});

run("the signing secret", () => {
  it("is returned once, on registration", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    expect(endpoint.secret).toMatch(/^whsec_/);
  });

  it("is never on a row that is read back", async () => {
    await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });

    const [listed] = await webhooks.list(owner());
    expect(listed).toBeDefined();
    /**
     * Asserted on the whole object rather than on one key, because the way
     * this leaks is somebody spreading the database row into the response
     * and the secret arriving under whatever the column is called.
     */
    expect(JSON.stringify(listed)).not.toContain("whsec_");
    expect(Object.keys(listed!)).not.toContain("secret");
    expect(Object.keys(listed!)).not.toContain("secretRef");
  });

  it("is not returned by an update either", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    const after = await webhooks.update(owner(), {
      id: endpoint.id, events: ["job.completed", "invoice.paid"],
    });
    expect(JSON.stringify(after)).not.toContain("whsec_");
  });

  it("is different for every endpoint", async () => {
    const a = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    const b = await webhooks.register(owner(), { url: `${RECEIVER}/two`, events: ["job.completed"] });
    expect(a.secret).not.toBe(b.secret);
  });
});

run("delivering", () => {
  it("signs the body so the receiver can verify it", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed", { jobId: "j-1" });

    const http = transport();
    const pass = await webhooks.deliver(db(), ORG, { send: http.send, now: at(0) });

    expect(pass.attempts).toHaveLength(1);
    expect(pass.attempts[0]).toMatchObject({ ok: true, eventName: "job.completed" });

    const sent = http.calls[0]!;
    expect(webhooks.verifyDelivery({
      secret: endpoint.secret,
      body: sent.body,
      timestamp: sent.headers["x-otos-timestamp"]!,
      signature: sent.headers["x-otos-signature"]!,
      now: T0,
    })).toBe(true);

    const body = JSON.parse(sent.body) as Record<string, unknown>;
    expect(body).toMatchObject({ name: "job.completed", organizationId: ORG });
    expect(body["payload"]).toMatchObject({ jobId: "j-1" });
  });

  it("does not verify once a single byte of the body changes", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed", { jobId: "j-1" });

    const http = transport();
    await webhooks.deliver(db(), ORG, { send: http.send, now: at(0) });
    const sent = http.calls[0]!;

    expect(webhooks.verifyDelivery({
      secret: endpoint.secret,
      body: sent.body.replace("j-1", "j-2"),
      timestamp: sent.headers["x-otos-timestamp"]!,
      signature: sent.headers["x-otos-signature"]!,
      now: T0,
    })).toBe(false);
  });

  it("makes a replay detectable, because the timestamp is inside the signature", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed");

    const http = transport();
    await webhooks.deliver(db(), ORG, { send: http.send, now: at(0) });
    const sent = http.calls[0]!;

    /**
     * Captured and sent again an hour later. The signature still matches the
     * body, which is why a signature over the body alone is valid forever;
     * what gives it away is that the timestamp it was computed with is now
     * far outside the window.
     */
    expect(webhooks.verifyDelivery({
      secret: endpoint.secret,
      body: sent.body,
      timestamp: sent.headers["x-otos-timestamp"]!,
      signature: sent.headers["x-otos-signature"]!,
      now: T0 + 60 * 60 * 1000,
    })).toBe(false);

    /**
     * And a replayer who restamps it to now cannot resign it, so the
     * signature no longer matches the payload it is supposed to cover.
     */
    expect(webhooks.verifyDelivery({
      secret: endpoint.secret,
      body: sent.body,
      timestamp: String(T0 + 60 * 60 * 1000),
      signature: sent.headers["x-otos-signature"]!,
      now: T0 + 60 * 60 * 1000,
    })).toBe(false);
  });

  it("sends only the events the endpoint subscribed to", async () => {
    await webhooks.register(owner(), { url: RECEIVER, events: ["invoice.paid"] });
    await emitted("job.completed");
    await emitted("invoice.paid");
    await emitted("job.created");

    const http = transport();
    const pass = await webhooks.deliver(db(), ORG, { send: http.send, now: at(0) });

    expect(pass.attempts.map((a) => a.eventName)).toEqual(["invoice.paid"]);
  });

  it("starts from now, not from the beginning of the company's history", async () => {
    /**
     * An endpoint registered today being handed a year of events is not a
     * backfill, it is an outage: tens of thousands of deliveries at a
     * receiver that has been live for four seconds.
     */
    await emitted("job.completed");
    await emitted("job.completed");
    await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });

    const http = transport();
    const pass = await webhooks.deliver(db(), ORG, { send: http.send, now: at(0) });
    expect(pass.attempts).toHaveLength(0);
  });

  it("does not deliver the same event twice", async () => {
    await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed");

    const http = transport();
    await webhooks.deliver(db(), ORG, { send: http.send, now: at(0) });
    const second = await webhooks.deliver(db(), ORG, { send: http.send, now: at(1000) });

    expect(http.calls).toHaveLength(1);
    expect(second.attempts).toHaveLength(0);
  });

  it("delivers in order and holds the position at a failure", async () => {
    /**
     * Skipping the failed event and carrying on would deliver a completion
     * for a job the receiver never heard of being created. So the endpoint
     * stops where it broke, and the next pass starts from the same event.
     */
    await webhooks.register(owner(), { url: RECEIVER, events: ["job.created", "job.completed"] });
    await emitted("job.created", { jobId: "j-1" });
    await emitted("job.completed", { jobId: "j-1" });

    const failing = transport(() => DOWN);
    const first = await webhooks.deliver(db(), ORG, { send: failing.send, now: at(0) });
    expect(first.attempts).toHaveLength(1);
    expect(first.attempts[0]).toMatchObject({ ok: false, eventName: "job.created" });

    const recovered = transport();
    const second = await webhooks.deliver(db(), ORG, {
      send: recovered.send, now: at(webhooks.backoffMs(1)),
    });
    expect(second.attempts.map((a) => a.eventName)).toEqual(["job.created", "job.completed"]);
  });

  it("skips an endpoint that is switched off", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await webhooks.update(owner(), { id: endpoint.id, active: false });
    await emitted("job.completed");

    const http = transport();
    await webhooks.deliver(db(), ORG, { send: http.send, now: at(0) });
    expect(http.calls).toHaveLength(0);
  });

  it("stops delivering to a removed endpoint and takes it off the list", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await webhooks.remove(owner(), { id: endpoint.id });
    await emitted("job.completed");

    const http = transport();
    await webhooks.deliver(db(), ORG, { send: http.send, now: at(0) });
    expect(http.calls).toHaveLength(0);
    expect(await webhooks.list(owner())).toHaveLength(0);
    await expect(webhooks.position(owner(), { id: endpoint.id }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("reports how far behind an endpoint is", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed");
    await emitted("invoice.paid");
    await emitted("job.completed");

    const behind = await webhooks.position(owner(), { id: endpoint.id });
    expect(behind.pending).toBe(2);

    const http = transport();
    await webhooks.deliver(db(), ORG, { send: http.send, now: at(0) });
    expect((await webhooks.position(owner(), { id: endpoint.id })).pending).toBe(0);
  });

  it("refuses to read an endpoint for a role that cannot see integrations", async () => {
    await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await expect(webhooks.list(as(["accountant"]))).rejects.toBeInstanceOf(PermissionError);
    await expect(webhooks.position(as(["accountant"]), { id: fixtureId("wh:nobody") }))
      .rejects.toBeInstanceOf(PermissionError);
    await expect(webhooks.catalogue(as(["accountant"]))).rejects.toBeInstanceOf(PermissionError);
  });
});

run("failing endpoints", () => {
  /** One pass that fails, at a clock far enough on to be past any backoff. */
  const failOnce = async (offsetMs: number) => {
    const http = transport(() => DOWN);
    return webhooks.deliver(db(), ORG, { send: http.send, now: at(offsetMs) });
  };

  it("writes the failure count and the delivery time, which nothing ever has", async () => {
    await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed");

    const before = (await webhooks.list(owner()))[0]!;
    expect(before.failureCount).toBe(0);
    expect(before.lastDeliveryAt).toBeNull();

    await failOnce(0);

    const after = (await webhooks.list(owner()))[0]!;
    expect(after.failureCount).toBe(1);
    expect(after.lastDeliveryAt).toBe(new Date(T0).toISOString());
  });

  it("stamps the delivery time on a success too", async () => {
    await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed");

    const http = transport();
    await webhooks.deliver(db(), ORG, { send: http.send, now: at(5000) });

    const after = (await webhooks.list(owner()))[0]!;
    expect(after.lastDeliveryAt).toBe(new Date(T0 + 5000).toISOString());
  });

  it("waits out a backoff instead of hammering a receiver that is down", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed");
    await failOnce(0);

    const immediately = transport(() => DOWN);
    const pass = await webhooks.deliver(db(), ORG, { send: immediately.send, now: at(1000) });
    expect(immediately.calls).toHaveLength(0);
    expect(pass.backingOff).toContain(endpoint.id);

    const later = transport(() => DOWN);
    await webhooks.deliver(db(), ORG, { send: later.send, now: at(webhooks.backoffMs(1)) });
    expect(later.calls).toHaveLength(1);
  });

  it("clears the count on a delivery that works", async () => {
    await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed");
    await failOnce(0);
    expect((await webhooks.list(owner()))[0]!.failureCount).toBe(1);

    const http = transport();
    await webhooks.deliver(db(), ORG, { send: http.send, now: at(webhooks.backoffMs(1)) });

    /**
     * Reset rather than decremented. What the number measures is consecutive
     * failures: an endpoint that fails every other delivery forever is a
     * different problem from one that has stopped answering, and a counter
     * that only climbed would eventually switch the first off as though it
     * were the second.
     */
    expect((await webhooks.list(owner()))[0]!.failureCount).toBe(0);
  });

  it("counts a transport that throws, not only one that answers badly", async () => {
    await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed");

    const thrower: webhooks.Transport = async () => { throw new Error("ECONNREFUSED"); };
    const pass = await webhooks.deliver(db(), ORG, { send: thrower, now: at(0) });

    expect(pass.attempts[0]).toMatchObject({ ok: false, status: null, error: "ECONNREFUSED" });
    expect((await webhooks.list(owner()))[0]!.failureCount).toBe(1);
  });

  it("switches an endpoint off rather than retrying it forever", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed");

    /**
     * Each pass is two hours after the last, which is past the capped
     * backoff, so every one of them actually attempts a delivery.
     */
    let last: webhooks.DeliveryPass | null = null;
    for (let i = 0; i < 12; i += 1) last = await failOnce(i * 2 * 60 * 60 * 1000);

    expect(last!.attempts[0]).toMatchObject({ ok: false, disabled: true });

    const after = (await webhooks.list(owner()))[0]!;
    expect(after.active).toBe(false);
    expect(after.failureCount).toBe(12);

    /** And it stays off: a disabled endpoint is not attempted again. */
    const http = transport();
    await webhooks.deliver(db(), ORG, { send: http.send, now: at(48 * 60 * 60 * 1000) });
    expect(http.calls).toHaveLength(0);

    /**
     * With a reason. An operator opening a disabled endpoint and seeing a
     * count and no error has nothing to act on: "connection refused" and
     * "HTTP 410" are two completely different mornings.
     */
    const [entry] = await raw<{ after: { reason: string } }[]>`
      select after from public.audit_log
      where organization_id = ${ORG} and action = 'webhook.disabled'
        and entity_id = ${endpoint.id}`;
    expect(entry!.after.reason).toBe("HTTP 503");
  });

  it("comes back when the operator fixes the URL", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed");
    for (let i = 0; i < 12; i += 1) await failOnce(i * 2 * 60 * 60 * 1000);
    expect((await webhooks.list(owner()))[0]!.active).toBe(false);

    /**
     * Without the counter clearing here the endpoint is stuck: switched off,
     * count at the limit, and the very next failure trips the limit again on
     * the first attempt. The only recovery would be delete and re-register,
     * which loses the position and either replays or skips whatever happened
     * in between.
     */
    const fixed = await webhooks.update(owner(), {
      id: endpoint.id, url: `${RECEIVER}/v2`, active: true,
    });
    expect(fixed.failureCount).toBe(0);
    expect(fixed.active).toBe(true);

    const http = transport();
    const pass = await webhooks.deliver(db(), ORG, {
      send: http.send, now: at(48 * 60 * 60 * 1000),
    });
    expect(pass.attempts).toHaveLength(1);
    expect(http.calls[0]!.url).toBe(`${RECEIVER}/v2`);
  });

  it("does not let one broken endpoint hold up another", async () => {
    await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    const b = await webhooks.register(owner(), {
      url: `${RECEIVER}/two`, events: ["job.completed"],
    });
    await emitted("job.completed");

    const http = transport((request) => (request.url === RECEIVER ? DOWN : OK));
    const pass = await webhooks.deliver(db(), ORG, { send: http.send, now: at(0) });

    expect(pass.attempts).toHaveLength(2);
    expect(pass.attempts.find((a) => a.endpointId === b.id)).toMatchObject({ ok: true });
  });
});

/* ------------------------------------------------- the history, and replay */

/**
 * An endpoint used to report THAT it was failing and never WHY: a failure
 * count, the time of the last attempt, and nothing a person debugging a
 * receiver could read. And nothing could send an event again, so a receiver
 * that lost a day to a bad deploy had lost it for good.
 */
const keyed = (key: string): ServiceContext => ({ ...owner(), idempotencyKey: key });

run("delivery history", () => {
  it("keeps every attempt with what the receiver said and how long it took", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    const event = await emitted("job.completed");

    await webhooks.deliver(db(), ORG, {
      send: transport(() => ({ status: 503, ok: false, body: "upstream is down" })).send, now: at(0),
    });
    await webhooks.deliver(db(), ORG, {
      send: transport(() => ({ status: 200, ok: true, body: "{\"received\":true}" })).send,
      now: at(webhooks.backoffMs(1)),
    });

    const history = await webhooks.history(owner(), { id: endpoint.id });
    expect(history.data.map((d) => [d.attempt, d.status, d.responseStatus, d.responseExcerpt])).toEqual([
      [2, "delivered", 200, "{\"received\":true}"],
      [1, "refused", 503, "upstream is down"],
    ]);
    expect(history.data[1]).toMatchObject({
      eventId: event.id, eventSequence: event.sequence, eventName: "job.completed",
      requestedAt: new Date(T0).toISOString(), error: "HTTP 503", replayId: null,
    });
    expect(history.data.every((d) => d.durationMs >= 0)).toBe(true);
  });

  it("calls an attempt that got no answer unreachable, with the reason", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed");
    await webhooks.deliver(db(), ORG, {
      send: async () => { throw new Error("connect ECONNREFUSED"); }, now: at(0),
    });

    const [only] = (await webhooks.history(owner(), { id: endpoint.id })).data;
    expect(only).toMatchObject({ status: "unreachable", responseStatus: null, error: "connect ECONNREFUSED" });
  });

  it("filters by what happened", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed");
    await webhooks.deliver(db(), ORG, { send: transport(() => DOWN).send, now: at(0) });
    await webhooks.deliver(db(), ORG, { send: transport().send, now: at(webhooks.backoffMs(1)) });

    const refused = await webhooks.history(owner(), { id: endpoint.id, status: "refused" });
    expect(refused.data.map((d) => d.attempt)).toEqual([1]);
    const delivered = await webhooks.history(owner(), { id: endpoint.id, status: "delivered" });
    expect(delivered.data.map((d) => d.attempt)).toEqual([2]);
    expect((await webhooks.history(owner(), { id: endpoint.id, status: "unreachable" })).data).toEqual([]);
  });

  it("keeps the start of a long answer and says how much it left out", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed");
    await webhooks.deliver(db(), ORG, {
      send: transport(() => ({ status: 500, ok: false, body: "<html>".padEnd(9000, "x") })).send, now: at(0),
    });

    const [only] = (await webhooks.history(owner(), { id: endpoint.id })).data;
    expect(only!.responseExcerpt!.startsWith("<html>")).toBe(true);
    expect(only!.responseExcerpt).toMatch(/\[7000 more characters not kept\]$/);
  });

  it("pages newest first without skipping an attempt made in the same instant", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed");
    await emitted("job.completed");
    await emitted("job.completed");
    /** One pass, one clock reading: three attempts with the same time. */
    await webhooks.deliver(db(), ORG, { send: transport().send, now: at(0) });

    const first = await webhooks.history(owner(), { id: endpoint.id, limit: 2 });
    expect(first.hasMore).toBe(true);
    const second = await webhooks.history(owner(), { id: endpoint.id, limit: 2, cursor: first.nextCursor! });
    expect(second.hasMore).toBe(false);
    const seen = [...first.data, ...second.data].map((d) => d.eventSequence).sort();
    expect(seen).toEqual([1, 2, 3]);
  });

  it("answers for one event across every endpoint it went to", async () => {
    const a = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    const b = await webhooks.register(owner(), { url: "https://other.example.test/in", events: ["job.completed"] });
    const event = await emitted("job.completed");
    await webhooks.deliver(db(), ORG, {
      send: transport((r) => (r.url === RECEIVER ? OK : DOWN)).send, now: at(0),
    });

    const answer = await webhooks.eventHistory(owner(), { eventId: event.id });
    expect(answer.event).toMatchObject({ id: event.id, name: "job.completed", sequence: event.sequence });
    expect(answer.deliveries.map((d) => [d.endpointId, d.status]).sort()).toEqual([
      [a.id, "delivered"], [b.id, "refused"],
    ].sort());
    expect(answer.deliveries.find((d) => d.endpointId === b.id)!.endpointUrl).toBe("https://other.example.test/in");
  });

  it("cannot grow without bound: old attempts and attempts past the limit are let go", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    const old = await emitted("job.completed");
    await raw`
      insert into public.webhook_delivery
        (organization_id, endpoint_id, event_id, event_sequence, event_name, attempt,
         requested_at, duration_ms, response_status, ok)
      select ${ORG}, ${endpoint.id}, ${old.id}, ${old.sequence}, 'job.completed', n,
             ${new Date(T0 - 60_000).toISOString()}::timestamptz - (n || ' seconds')::interval, 5, 200, true
      from generate_series(1, ${core.webhooks.KEEP_PER_ENDPOINT + 10}) as n`;
    await raw`
      insert into public.webhook_delivery
        (organization_id, endpoint_id, event_id, event_sequence, event_name, attempt,
         requested_at, duration_ms, response_status, ok)
      values (${ORG}, ${endpoint.id}, ${old.id}, ${old.sequence}, 'job.completed', 99999,
              ${new Date(T0 - 40 * 86_400_000).toISOString()}::timestamptz, 5, 200, true)`;

    await emitted("job.completed");
    await webhooks.deliver(db(), ORG, { send: transport().send, now: at(0) });

    const [kept] = await raw<{ n: number; oldest: Date }[]>`
      select count(*)::int as n, min(requested_at) as oldest
      from public.webhook_delivery where endpoint_id = ${endpoint.id}`;
    expect(kept!.n).toBe(core.webhooks.KEEP_PER_ENDPOINT);
    expect(kept!.oldest.getTime()).toBeGreaterThan(T0 - 30 * 86_400_000);
    /** The newest attempt, the one this pass made, is never the one let go. */
    const newest = (await webhooks.history(owner(), { id: endpoint.id, limit: 1 })).data[0]!;
    expect(newest.requestedAt).toBe(new Date(T0).toISOString());
  });

  it("is not readable by a role that cannot see integrations", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await expect(webhooks.history(as(["accountant"]), { id: endpoint.id }))
      .rejects.toBeInstanceOf(PermissionError);
    await expect(webhooks.requestReplay(as(["accountant"]), { id: endpoint.id, fromSequence: 1 }))
      .rejects.toBeInstanceOf(PermissionError);
  });
});

run("replaying", () => {
  it("sends a delivery again, re-signed now, with the header a receiver deduplicates on", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed", { jobId: "j-1" });
    const http = transport();
    await webhooks.deliver(db(), ORG, { send: http.send, now: at(0) });
    const [original] = (await webhooks.history(owner(), { id: endpoint.id })).data;

    const replay = await webhooks.requestReplay(owner(), { id: endpoint.id, deliveryId: original!.id });
    expect(replay).toMatchObject({ status: "pending", eventId: original!.eventId });
    const later = T0 + 6 * 60 * 60 * 1000;
    await webhooks.deliver(db(), ORG, { send: http.send, now: () => new Date(later) });

    expect(http.calls).toHaveLength(2);
    const [first, again] = http.calls as [webhooks.DeliveryRequest, webhooks.DeliveryRequest];
    expect(again.body).toBe(first.body);
    expect(again.headers[webhooks.DELIVERY_HEADER]).toBe(first.headers[webhooks.DELIVERY_HEADER]);
    expect(again.headers[webhooks.REPLAY_HEADER]).toBe(replay.id);
    expect(first.headers[webhooks.REPLAY_HEADER]).toBeUndefined();
    /** Valid NOW, which the original signature six hours on is not. */
    expect(webhooks.verifyDelivery({
      secret: endpoint.secret, body: again.body, now: later,
      timestamp: again.headers[webhooks.TIMESTAMP_HEADER]!, signature: again.headers[webhooks.SIGNATURE_HEADER]!,
    })).toBe(true);

    const history = (await webhooks.history(owner(), { id: endpoint.id })).data;
    expect(history[0]).toMatchObject({ attempt: 2, replayId: replay.id, status: "delivered" });
    expect((await webhooks.replays(owner(), { id: endpoint.id }))[0]).toMatchObject({ status: "done" });
  });

  it("replays a range from a point, only what the endpoint subscribes to, and stops where it was asked to", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    const one = await emitted("job.completed", { n: "1" });
    await emitted("job.created", { n: "2" });
    await emitted("job.completed", { n: "3" });
    const http = transport();
    await webhooks.deliver(db(), ORG, { send: http.send, now: at(0) });
    expect(http.calls).toHaveLength(2);

    await webhooks.requestReplay(owner(), { id: endpoint.id, fromSequence: one.sequence });
    /** After the request: live, once, and not part of the replay. */
    await emitted("job.completed", { n: "4" });
    await webhooks.deliver(db(), ORG, { send: http.send, now: at(60_000) });

    const sent = http.calls.slice(2).map((c) => [
      (JSON.parse(c.body) as { payload: { n: string } }).payload.n,
      c.headers[webhooks.REPLAY_HEADER] ? "replay" : "live",
    ]);
    expect(sent).toEqual([["4", "live"], ["1", "replay"], ["3", "replay"]]);

    /** The live position is where the live stream left it. */
    const position = await webhooks.position(owner(), { id: endpoint.id });
    expect(position).toMatchObject({ deliveredThrough: 4, pending: 0 });
  });

  it("stops where the receiver refuses and carries on from there", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed", { n: "1" });
    await emitted("job.completed", { n: "2" });
    await webhooks.deliver(db(), ORG, { send: transport().send, now: at(0) });

    const replay = await webhooks.requestReplay(owner(), { id: endpoint.id, fromSequence: 1 });
    let calls = 0;
    const flaky = transport(() => (++calls === 2 ? DOWN : OK));
    await webhooks.deliver(db(), ORG, { send: flaky.send, now: at(60_000) });
    expect((await webhooks.replays(owner(), { id: endpoint.id }))[0]).toMatchObject({
      id: replay.id, status: "pending", position: 1, failureCount: 1, lastError: "HTTP 503",
    });

    const rest = transport();
    await webhooks.deliver(db(), ORG, { send: rest.send, now: at(60_000 + webhooks.backoffMs(1)) });
    expect(rest.calls.map((c) => (JSON.parse(c.body) as { payload: { n: string } }).payload.n)).toEqual(["2"]);
    expect((await webhooks.replays(owner(), { id: endpoint.id }))[0]).toMatchObject({ status: "done", position: 2 });
  });

  it("gives up on a replay without switching the live stream off", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed");
    await webhooks.deliver(db(), ORG, { send: transport().send, now: at(0) });
    await webhooks.requestReplay(owner(), { id: endpoint.id, fromSequence: 1 });

    for (let pass = 1; pass <= 12; pass += 1) {
      await webhooks.deliver(db(), ORG, { send: transport(() => DOWN).send, now: at(pass * 2 * 60 * 60 * 1000) });
    }
    expect((await webhooks.replays(owner(), { id: endpoint.id }))[0]).toMatchObject({ status: "failed", failureCount: 12 });
    expect((await webhooks.list(owner()))[0]).toMatchObject({ active: true, failureCount: 0 });
  });

  it("does not queue a second copy of a replay that is still waiting, or of a retried request", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed");
    const first = await webhooks.requestReplay(keyed("replay-1"), { id: endpoint.id, fromSequence: 1 });
    const retried = await webhooks.requestReplay(keyed("replay-1"), { id: endpoint.id, fromSequence: 1 });
    const pressedTwice = await webhooks.requestReplay(keyed("replay-2"), { id: endpoint.id, fromSequence: 1 });
    expect(retried.id).toBe(first.id);
    expect(pressedTwice.id).toBe(first.id);
    expect(await webhooks.replays(owner(), { id: endpoint.id })).toHaveLength(1);
  });

  it("is sent by the worker even when the company has done nothing since", async () => {
    /**
     * Delivery runs after a company's events are drained, so a replay asked
     * for on a quiet afternoon used to wait for the next job to be booked.
     */
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    await emitted("job.completed");
    const http = transport();
    await webhooks.deliver(db(), ORG, { send: http.send, now: at(0) });
    /** The log drained, so this company has had no events as far as the next pass knows. */
    await runPass({ db: db(), schedules: false, geocoding: false, webhooks: { send: http.send }, push: false });
    expect(http.calls).toHaveLength(1);

    const replay = await webhooks.requestReplay(owner(), { id: endpoint.id, fromSequence: 1 });
    await runPass({ db: db(), schedules: false, geocoding: false, webhooks: { send: http.send }, push: false });
    expect(http.calls).toHaveLength(2);
    expect(http.calls[1]!.headers[webhooks.REPLAY_HEADER]).toBe(replay.id);
  });

  it("refuses what it could not send", async () => {
    const endpoint = await webhooks.register(owner(), { url: RECEIVER, events: ["job.completed"] });
    const other = await emitted("job.created");
    await emitted("job.completed");

    await expect(webhooks.requestReplay(owner(), { id: endpoint.id, eventId: other.id }))
      .rejects.toThrow(/does not subscribe to job\.created/);
    await expect(webhooks.requestReplay(owner(), { id: endpoint.id, fromSequence: 9 }))
      .rejects.toThrow(/log ends at event 2/);
    await expect(webhooks.requestReplay(owner(), { id: endpoint.id }))
      .rejects.toThrow(/Say what to send again/);
    await expect(webhooks.requestReplay(owner(), { id: endpoint.id, fromSequence: 1, eventId: other.id }))
      .rejects.toThrow(/Say what to send again/);

    await webhooks.update(owner(), { id: endpoint.id, active: false });
    await expect(webhooks.requestReplay(owner(), { id: endpoint.id, fromSequence: 1 }))
      .rejects.toBeInstanceOf(ConflictError);
  });
});
