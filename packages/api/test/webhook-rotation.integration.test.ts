import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as webhooks from "../src/services/webhooks";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A NEW SIGNING SECRET WITHOUT A BROKEN RECEIVER
 *
 * The person rotating and the person who updates the receiver are rarely the
 * same person acting in the same minute. So for an overlap both secrets sign
 * every delivery, and a receiver holding either keeps accepting; after it,
 * only the new one does. With no overlap the old one stops at once, which is
 * what a leaked secret needs.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("rotate:org");
const USER = fixtureId("rotate:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});

let sequence = 0;
async function emitted() {
  sequence += 1;
  await raw`insert into public.domain_event (organization_id, sequence, name, entity_type, entity_id, payload)
    values (${ORG}, ${sequence}, 'job.completed', 'job', null, ${raw.json({})})`;
}

function capture() {
  const calls: webhooks.DeliveryRequest[] = [];
  const send: webhooks.Transport = async (request) => {
    calls.push(request);
    return { status: 200, ok: true };
  };
  return { calls, send };
}

const verifies = (secret: string, sent: webhooks.DeliveryRequest, now: number) => webhooks.verifyDelivery({
  secret, body: sent.body, timestamp: sent.headers["x-otos-timestamp"]!,
  signature: sent.headers["x-otos-signature"]!, now,
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Rotate Co", slug: "rotate-co" });
});

afterAll(async () => {
  if (!raw) return;
  await raw`delete from public.webhook_endpoint where organization_id = ${ORG}`;
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.event_cursor where organization_id = ${ORG}`;
  await raw`delete from public.webhook_endpoint where organization_id = ${ORG}`;
  await raw`delete from public.domain_event where organization_id = ${ORG}`;
  sequence = 0;
});

run("rotating a signing secret", () => {
  it("signs with both secrets during the overlap, so a receiver holding either accepts", async () => {
    const endpoint = await webhooks.register(owner(), { url: "https://hooks.example.test/a", events: ["job.completed"] });
    const rotated = await webhooks.rotateSecret(owner(), { id: endpoint.id, overlapHours: 24 });
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(endpoint.secret);
    expect(rotated.previousSecretExpiresAt).not.toBeNull();

    await emitted();
    const http = capture();
    const now = Date.now();
    await webhooks.deliver(db(), ORG, { send: http.send, now: () => new Date(now) });
    const sent = http.calls[0]!;
    expect(sent.headers["x-otos-signature"]!.split(",")).toHaveLength(2);
    expect(verifies(rotated.secret, sent, now)).toBe(true);
    expect(verifies(endpoint.secret, sent, now)).toBe(true);
    expect(verifies("whsec_somebody_else", sent, now)).toBe(false);
  });

  it("stops signing with the old one when the overlap ends", async () => {
    const endpoint = await webhooks.register(owner(), { url: "https://hooks.example.test/b", events: ["job.completed"] });
    const rotated = await webhooks.rotateSecret(owner(), { id: endpoint.id, overlapHours: 1 });
    await emitted();
    const http = capture();
    const later = Date.now() + 2 * 3_600_000;
    await webhooks.deliver(db(), ORG, { send: http.send, now: () => new Date(later) });
    const sent = http.calls[0]!;
    expect(sent.headers["x-otos-signature"]!.split(",")).toHaveLength(1);
    expect(verifies(rotated.secret, sent, later)).toBe(true);
    expect(verifies(endpoint.secret, sent, later)).toBe(false);
  });

  it("with no overlap, the old secret stops at once", async () => {
    const endpoint = await webhooks.register(owner(), { url: "https://hooks.example.test/c", events: ["job.completed"] });
    const rotated = await webhooks.rotateSecret(owner(), { id: endpoint.id, overlapHours: 0 });
    expect(rotated.previousSecretExpiresAt).toBeNull();
    await emitted();
    const http = capture();
    const now = Date.now();
    await webhooks.deliver(db(), ORG, { send: http.send, now: () => new Date(now) });
    expect(verifies(endpoint.secret, http.calls[0]!, now)).toBe(false);
  });

  it("never signs with more than two: a second rotation retires the oldest", async () => {
    const endpoint = await webhooks.register(owner(), { url: "https://hooks.example.test/d", events: ["job.completed"] });
    const first = await webhooks.rotateSecret(owner(), { id: endpoint.id });
    const second = await webhooks.rotateSecret(owner(), { id: endpoint.id });
    await emitted();
    const http = capture();
    const now = Date.now();
    await webhooks.deliver(db(), ORG, { send: http.send, now: () => new Date(now) });
    const sent = http.calls[0]!;
    expect(verifies(second.secret, sent, now)).toBe(true);
    expect(verifies(first.secret, sent, now)).toBe(true);
    expect(verifies(endpoint.secret, sent, now)).toBe(false);
  });

  it("hands the same secret back on a retry, and refuses the retry after another rotation", async () => {
    const endpoint = await webhooks.register(owner(), { url: "https://hooks.example.test/e", events: ["job.completed"] });
    const once = await webhooks.rotateSecret(owner("rotate-key-1"), { id: endpoint.id });
    const twice = await webhooks.rotateSecret(owner("rotate-key-1"), { id: endpoint.id });
    expect(twice.secret).toBe(once.secret);
    await webhooks.rotateSecret(owner("rotate-key-2"), { id: endpoint.id });
    await expect(webhooks.rotateSecret(owner("rotate-key-1"), { id: endpoint.id })).rejects.toBeInstanceOf(ConflictError);
  });

  it("never puts a secret in a list, a read or the audit log", async () => {
    const endpoint = await webhooks.register(owner(), { url: "https://hooks.example.test/f", events: ["job.completed"] });
    const rotated = await webhooks.rotateSecret(owner(), { id: endpoint.id });
    const listed = JSON.stringify(await webhooks.list(owner()));
    expect(listed).not.toContain(rotated.secret);
    expect(listed).not.toContain(endpoint.secret);
    const rows = await raw<{ before: unknown; after: unknown }[]>`
      select before, after from public.audit_log where entity_id = ${endpoint.id} and action = 'webhook.secret_rotated'`;
    expect(JSON.stringify(rows)).not.toContain("whsec_");
  });

  it("refuses an overlap longer than a week", async () => {
    const endpoint = await webhooks.register(owner(), { url: "https://hooks.example.test/g", events: ["job.completed"] });
    await expect(webhooks.rotateSecret(owner(), { id: endpoint.id, overlapHours: 169 })).rejects.toBeInstanceOf(ConflictError);
  });
});
