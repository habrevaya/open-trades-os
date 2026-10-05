import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as fieldOps from "../src/services/field";
import * as dispatch from "../src/services/dispatch";
import * as dispatchMap from "../src/services/dispatch-map";
import * as liveLocation from "../src/services/location";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * LIVE LOCATION, AGAINST A REAL DATABASE
 *
 * The promises the module doc makes about where a technician is, each held
 * here against the server rather than the phone, because the server is the
 * one that has to keep them when the phone is wrong:
 *
 *   Nothing is kept until the company turns sharing on, nothing for a person
 *   it is off for, and nothing off the clock, whatever the phone sends.
 *   Positions are deleted after the retention, and at once when sharing is
 *   turned off.
 *   Only somebody who dispatches sees where people are.
 *   The customer's link shows the van only on the way to their visit, after
 *   the text, and nothing once the technician has arrived.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("live:org");
const USER = fixtureId("live:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const tech = () => as(["technician"]);
const owner = () => as(["owner"]);
const dispatcher = () => as(["dispatcher"]);

let technicianId = "";
let customerId = "";
let propertyId = "";
let device = "";
let sequence = 0;
let trackingToken = "";
/** One fix's time, sent twice, so the second arrival is recognised as the same fix. */
const onTheClockAt = new Date(Date.now() - 30 * 60_000);

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const uuid = () => crypto.randomUUID();
const fix = (when: Date, lat = 30.27, lng = -97.74) => ({ latitude: lat, longitude: lng, accuracyMeters: 8, recordedAt: when.toISOString() });

async function send(input: {
  operations?: { kind: string; subjectId?: string; occurredAt: Date }[];
  positions?: ReturnType<typeof fix>[];
}) {
  return fieldOps.sync(tech(), {
    deviceId: device,
    operations: (input.operations ?? []).map((op) => ({
      clientId: uuid(),
      sequence: ++sequence,
      kind: op.kind as never,
      ...(op.subjectId ? { subjectId: op.subjectId } : {}),
      occurredAt: op.occurredAt.toISOString(),
      payload: {},
    })),
    positions: input.positions ?? [],
  });
}

/**
 * A new phone for a scenario that records things in the past. The server
 * clamps an operation claimed before the device's last sync to that sync,
 * as it should for a real phone sending in order, so a test that writes the
 * morning's punch after the afternoon's sync needs a phone that has not
 * synced yet.
 */
async function freshDevice() {
  device = (await fieldOps.register(tech(), { installationId: `install-${uuid()}` })).deviceId;
  sequence = 0;
}

const kept = () => raw<{ reason: string; visit_id: string | null; recorded_at: Date }[]>`
  select reason::text as reason, visit_id, recorded_at from public.technician_position
  where organization_id = ${ORG} order by recorded_at`;

async function visitToday(): Promise<string> {
  const [n] = await raw<{ next: number }[]>`
    select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${n!.next}, ${customerId}, ${propertyId}, 'scheduled', 'No cooling') returning id`;
  const [visit] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, status, window_start, window_end)
    values (${ORG}, ${job!.id}, 'dispatched', ${minutesAgo(60)}, ${new Date(Date.now() + 3 * 3_600_000)})
    returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id, is_lead)
            values (${ORG}, ${visit!.id}, ${technicianId}, true)`;
  return visit!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Live Air", slug: "live-air" });
  const [membership] = await raw`select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
  const [t] = await raw`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, 'Ray Nunez') returning id`;
  technicianId = t!.id;

  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
            values (${ORG}, '+15125559960', 'main', true)`;
  const [c] = await raw`insert into public.customer (organization_id, name, phone)
    values (${ORG}, 'Nina Patel', '+15125550160') returning id`;
  customerId = c!.id;
  await raw`insert into public.communication_consent
    (organization_id, address, channel, purpose, state, method, captured_at)
    values (${ORG}, '+15125550160', 'sms', 'transactional', 'granted', 'verbal', now())`;
  const [p] = await raw`insert into public.property
    (organization_id, address_line1, city, state, postal_code, latitude, longitude, location_precision, location_source)
    values (${ORG}, '88 Ridge Rd', 'Austin', 'TX', '78704', '30.250000', '-97.760000', 'rooftop', 'test') returning id`;
  propertyId = p!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
    values (${ORG}, ${customerId}, ${propertyId})`;

  device = (await fieldOps.register(tech(), { installationId: `install-${uuid()}` })).deviceId;
});
afterAll(async () => { if (raw) await raw.end(); });

run("what the server keeps", () => {
  it("keeps nothing while the company has not turned sharing on, and says why", async () => {
    await freshDevice();
    const result = await send({
      operations: [{ kind: "timeclock.punch_in", occurredAt: minutesAgo(50) }],
      positions: [fix(minutesAgo(40))],
    });
    expect(result.positions).toEqual({ stored: 0, dropped: { company_off: 1 } });
    expect(await kept()).toEqual([]);
  });

  it("tells the phone the company's setting and the person's with the day", async () => {
    const day = await dispatch.snapshot(tech(), { deviceId: device, from: new Date().toISOString().slice(0, 10), days: 1 });
    expect(day.locationSharing).toEqual({ companyEnabled: false, personEnabled: true, intervalSeconds: 60, retentionDays: 3 });
  });

  it("keeps a fix taken on the clock once sharing is on, and drops the one after clocking out", async () => {
    await liveLocation.setSharing(owner(), { enabled: true });
    await freshDevice();
    /** The punch out goes first in the batch, so both fixes are judged against a closed punch. */
    const result = await send({
      operations: [{ kind: "timeclock.punch_out", occurredAt: minutesAgo(20) }],
      positions: [fix(onTheClockAt), fix(minutesAgo(10))],
    });
    expect(result.positions).toEqual({ stored: 1, dropped: { off_the_clock: 1 } });
    const rows = await kept();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe("on_the_clock");
  });

  it("keeps nothing off the clock whatever the phone sends, and nothing twice", async () => {
    const before = (await kept()).length;
    const result = await send({ positions: [fix(minutesAgo(5)), fix(onTheClockAt)] });
    expect(result.positions.dropped["off_the_clock"]).toBe(1);
    expect(result.positions.dropped["already_had"]).toBe(1);
    expect((await kept()).length).toBe(before);
  });

  it("refuses a fix from the future and one that is nowhere", async () => {
    const result = await send({
      positions: [fix(new Date(Date.now() + 30 * 60_000)), { ...fix(minutesAgo(1)), latitude: 0, longitude: 0 }],
    });
    expect(result.positions.dropped).toEqual({ in_the_future: 1, not_a_place: 1 });
  });

  it("ties a fix taken on the way to a visit to that visit, off the clock or not", async () => {
    const visit = await visitToday();
    await freshDevice();
    const result = await send({
      operations: [{ kind: "visit.en_route", subjectId: visit, occurredAt: minutesAgo(4) }],
      positions: [fix(minutesAgo(3), 30.26, -97.75)],
    });
    expect(result.positions.stored).toBe(1);
    const rows = await kept();
    expect(rows[rows.length - 1]).toMatchObject({ reason: "on_the_way", visit_id: visit });
  });

  it("keeps no two positions of one person closer together than half the company's interval", async () => {
    const before = (await kept()).length;
    const at = minutesAgo(2);
    const result = await send({
      positions: [fix(at, 30.255, -97.755), fix(new Date(at.getTime() + 5_000), 30.2551, -97.7551)],
    });
    expect(result.positions).toEqual({ stored: 1, dropped: { too_soon: 1 } });
    expect((await kept()).length).toBe(before + 1);
  });
});

run("who sees where people are", () => {
  it("shows the dispatcher each technician's latest position with how long ago", async () => {
    const live = await liveLocation.latest(dispatcher());
    expect(live.enabled).toBe(true);
    const ray = live.positions.find((p) => p.technicianId === technicianId)!;
    expect(ray).toMatchObject({ displayName: "Ray Nunez", reason: "on_the_way", freshness: "live" });
    expect(ray.lastSeen).toMatch(/minutes? ago|just now/);
  });

  it("draws the path they took today, oldest first, ending where they are now", async () => {
    const live = await liveLocation.latest(dispatcher());
    const ray = live.positions.find((p) => p.technicianId === technicianId)!;
    const today = (await kept()).filter((r) => r.recorded_at >= new Date(Date.now() - 40 * 60_000));
    expect(ray.trail.length).toBeGreaterThanOrEqual(2);
    expect(ray.trail.length).toBeLessThanOrEqual(today.length);
    expect(ray.trail.map((p) => p.at)).toEqual([...ray.trail.map((p) => p.at)].sort());
    expect(ray.trail.at(-1)).toMatchObject({ lat: ray.lat, lng: ray.lng, at: ray.recordedAt });
  });

  it("does not show a technician where their colleagues are", async () => {
    await expect(liveLocation.latest(tech())).rejects.toMatchObject({ name: "PermissionError" });
  });

  it("puts them on the dispatcher's map and nobody else's", async () => {
    const date = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
    const map = await dispatchMap.map(dispatcher(), { date });
    expect(map.live?.positions.map((p) => p.technicianId)).toContain(technicianId);
    const csr = await dispatchMap.map(as(["csr"]), { date });
    expect(csr.live).toBeNull();
  });
});

run("the customer's tracking link", () => {
  it("shows the van only after the text, only for their visit, and nothing once they arrive", async () => {
    const visit = await visitToday();
    await freshDevice();
    /** The drive before the text: on the way, and still not the customer's to see. */
    await send({
      operations: [{ kind: "visit.en_route", subjectId: visit, occurredAt: minutesAgo(2) }],
      positions: [fix(minutesAgo(1), 30.29, -97.73)],
    });

    const told = await dispatch.onMyWay(tech(), { id: visit, channel: "sms", etaMinutes: 20, includeTracking: true });
    expect(told.sent).toBe(true);
    const token = told.trackingUrl!.split("/j/")[1]!;
    trackingToken = token;

    const message = await raw<{ body: string }[]>`
      select body from public.message where organization_id = ${ORG} order by created_at desc limit 1`;
    expect(message[0]!.body).toContain("your technician, Ray,");

    const beforeAnyFix = await liveLocation.liveTracking(db(), { token });
    expect(beforeAnyFix).toMatchObject({ status: "on_the_way", tracking: false, position: null, etaBasis: "technician" });
    expect(beforeAnyFix.etaMinutes).toBeGreaterThan(18);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await send({ positions: [fix(new Date(), 30.255, -97.758)] });
    const live = await liveTracking(token);
    expect(live.tracking).toBe(true);
    expect(live.position).toMatchObject({ lat: 30.255, lng: -97.758 });
    expect(live.destination).toEqual({ lat: 30.25, lng: -97.76 });
    expect(live.technician).toEqual({ firstName: "Ray", photoUrl: null });
    /** A straight line here, because no routing service is connected, and said so. */
    expect(live.etaBasis).toBe("estimate");
    expect(live.etaMinutes).toBeGreaterThanOrEqual(1);

    await send({ operations: [{ kind: "visit.arrive", subjectId: visit, occurredAt: new Date() }] });
    const arrived = await liveTracking(token);
    expect(arrived).toMatchObject({ status: "arrived", tracking: false, position: null, destination: null, etaMinutes: null });
    expect(arrived.explanation).toMatch(/no longer shown/);
  });

  it("shows the technician's photo through the link once the office sets one, and not after it is taken down", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    await expect(dispatchMap.setTechnicianPhoto(as(["technician"]), { id: technicianId, bytes: png }))
      .rejects.toMatchObject({ name: "PermissionError" });
    const set = await dispatchMap.setTechnicianPhoto(owner(), { id: technicianId, bytes: png });
    expect(set.hasPhoto).toBe(true);
    const live = await liveTracking(trackingToken);
    expect(live.technician?.photoUrl).toMatch(new RegExp(`/j/${trackingToken}/technician-photo$`));
    const photo = await liveLocation.trackingPhoto(db(), trackingToken);
    expect(photo?.contentType).toBe("image/png");

    await dispatchMap.setTechnicianPhoto(owner(), { id: technicianId, bytes: null });
    expect(await liveLocation.trackingPhoto(db(), trackingToken)).toBeNull();
    expect((await liveTracking(trackingToken)).technician?.photoUrl).toBeNull();
  });

  it("refuses a photo that is not a picture", async () => {
    await expect(dispatchMap.setTechnicianPhoto(owner(), { id: technicianId, bytes: Buffer.from("%PDF-1.4 not a photo").toString("base64") }))
      .rejects.toThrow();
  });

  it("answers for a job with no visit yet rather than failing the page", async () => {
    const [job] = await raw<{ id: string }[]>`
      insert into public.job (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, 99001, ${customerId}, ${propertyId}, 'lead', 'Just a question') returning id`;
    const token = "t".repeat(40) + "lead";
    await raw`insert into public.portal_grant (organization_id, customer_id, scope, subject_id, token_hash, expires_at)
      values (${ORG}, ${customerId}, 'job', ${job!.id}, encode(sha256(${token}::bytea), 'hex'), now() + interval '1 day')`;
    expect(await liveTracking(token)).toMatchObject({ status: "not_on_the_way", tracking: false, position: null });
  });

  it("refuses a token that is not a job's", async () => {
    await expect(liveLocation.liveTracking(db(), { token: "x".repeat(43) })).rejects.toThrow();
  });
});

const liveTracking = (token: string) => liveLocation.liveTracking(db(), { token });

run("forgetting where people were", () => {
  it("deletes positions past the retention and keeps the rest", async () => {
    await raw`insert into public.technician_position
      (organization_id, technician_id, device_id, recorded_at, latitude, longitude, reason)
      values (${ORG}, ${technicianId}, ${device}, now() - interval '5 days', 30.2, -97.7, 'on_the_clock')`;
    const before = (await kept()).length;
    const purged = await liveLocation.purgePositions(db());
    expect(purged.positions).toBeGreaterThanOrEqual(1);
    const after = await kept();
    expect(after.length).toBe(before - 1);
    expect(after.every((r) => r.recorded_at.getTime() > Date.now() - 3 * 864e5)).toBe(true);
  });

  it("deletes a person's positions when sharing is turned off for them, and keeps nothing new", async () => {
    await dispatchMap.updateTechnician(owner(), { id: technicianId, shareLocation: false });
    expect(await kept()).toEqual([]);
    const result = await send({ positions: [fix(new Date())] });
    expect(result.positions).toEqual({ stored: 0, dropped: { person_off: 1 } });
    await dispatchMap.updateTechnician(owner(), { id: technicianId, shareLocation: true });
  });

  it("deletes everything when the company turns sharing off", async () => {
    await send({ positions: [fix(new Date())] });
    expect((await kept()).length).toBeGreaterThan(0);
    await liveLocation.setSharing(owner(), { enabled: false });
    expect(await kept()).toEqual([]);
    const audit = await raw<{ action: string }[]>`
      select action from public.audit_log where organization_id = ${ORG} and action = 'location.sharing_set'`;
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses a retention outside a day to a month, and a dispatcher changing it", async () => {
    await expect(liveLocation.setSharing(owner(), { retentionDays: 90 })).rejects.toThrow(/between 1 and 30 days/);
    await expect(liveLocation.setSharing(dispatcher(), { enabled: true })).rejects.toMatchObject({ name: "PermissionError" });
  });
});
