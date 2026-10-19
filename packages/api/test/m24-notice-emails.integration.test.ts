import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as notices from "../src/services/staff-notices";
import * as people from "../src/services/people";
import type { ServiceContext } from "../src/services/context";
import { companyToday, fixtureId, resetOrg, seedOrg, testDb } from "./helpers";

/**
 * A LICENCE RUNNING OUT: ITS OWN NOTICE PERIOD, THE EMAIL, AND SEVERAL KEEPERS (M24)
 *
 * Driven through the services and the worker, against a real database. What
 * is pinned is what a person would notice: a card with a longer renewal than
 * its kind warns earlier and says so on the renewals list; the holder, the
 * manager and each person who keeps the list get one email per notice, and
 * not a second on the next look; somebody who switched email off gets the
 * bell and nothing else; a company with no email connected is told why in
 * words rather than sent nothing silently; and naming keepers refuses
 * somebody who could not open the list.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("m24-notice-mail:org");
const OWNER = fixtureId("m24-notice-mail:owner");
const OFFICE = fixtureId("m24-notice-mail:office");
const CHIEF = fixtureId("m24-notice-mail:chief");
const BOOKS = fixtureId("m24-notice-mail:books");
const RAY = fixtureId("m24-notice-mail:ray");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: string[], extra: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: roles as Actor["roles"], ...extra }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);
const office = () => as(OFFICE, ["office_manager"]);
const chief = () => as(CHIEF, ["dispatcher"], { grants: ["compliance:read", "user:read"] });
const ray = () => as(RAY, ["technician"], { technicianId: rayTech });

let rayTech = "";
let rayMembership = "";

async function person(userId: string, role: string, email: string, name: string) {
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [m] = await raw<{ id: string }[]>`insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, ${role}) returning id`;
  return m!.id;
}

const rowsFor = (userId: string) => raw<{ id: string; title: string; body: string | null; source_key: string; href: string }[]>`
  select id, title, body, source_key, href from public.staff_notice
   where organization_id = ${ORG} and user_id = ${userId} order by created_at`;

/** Every email the company's outbox holds, by who it is to. */
const mailTo = (address: string) => raw<{ subject: string; body: string | null; status: string; channel: string }[]>`
  select subject, body, status, channel from public.message
   where organization_id = ${ORG} and channel = 'email' and to_address = ${address} order by created_at`;

const deliveries = () => raw<{ address: string; status: string; error: string | null; channel: string }[]>`
  select d.address, d.status, d.error, d.channel from public.staff_notice_delivery d
   where d.organization_id = ${ORG} and d.channel = 'email' order by d.created_at, d.address`;

async function aType(name: string, leadDays: number, expires = true) {
  const [type] = await raw<{ id: string }[]>`insert into public.certification_type (organization_id, code, name, renewal_lead_days, expires)
    values (${ORG}, ${`t-${crypto.randomUUID().slice(0, 8)}`}, ${name}, ${leadDays}, ${expires}) returning id`;
  return type!.id;
}

async function held(typeId: string, inDays: number, ownLead: number | null = null) {
  const [row] = await raw<{ id: string }[]>`insert into public.person_certification
    (organization_id, technician_id, certification_type_id, expires_on, renewal_lead_days, status)
    values (${ORG}, ${rayTech}, ${typeId}, ${companyToday(inDays)}, ${ownLead}, 'active') returning id`;
  return row!.id;
}

const connectEmail = () => raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
  values (${ORG}, 'email', 'smtp', 'connected', '{"fromAddress":"office@m24mail.test","fromName":"M24 Mail Co"}'::jsonb)`;

const WAS_URL = process.env["PUBLIC_URL"];

beforeAll(async () => {
  if (!url) return;
  // The links in an email are built from the company's public address.
  process.env["PUBLIC_URL"] = "https://ops.m24mail.test";
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "M24 Mail Co", slug: "m24-notice-mail" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`update public."user" set name = 'Olive Owner', email = 'olive@m24mail.test' where id = ${OWNER}`;
  await person(OFFICE, "office_manager", "office@m24mail.test", "Oscar Office");
  await person(CHIEF, "dispatcher", "chief@m24mail.test", "Dina Chief");
  await person(BOOKS, "accountant", "books@m24mail.test", "Beth Books");
  rayMembership = await person(RAY, "technician", "ray@m24mail.test", "Ray Nunez");
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${rayMembership}, 'Ray Nunez') returning id`;
  rayTech = t!.id;
  // Ray answers to Oscar, who may read people; Dina can read the renewals list and the people on it.
  await raw`update public.membership set reports_to_user_id = ${OFFICE} where id = ${rayMembership}`;
  await raw`update public.membership set grants = '["compliance:read","user:read"]'::jsonb where organization_id = ${ORG} and user_id = ${CHIEF}`;
});

afterAll(async () => {
  if (WAS_URL === undefined) delete process.env["PUBLIC_URL"]; else process.env["PUBLIC_URL"] = WAS_URL;
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw`delete from public."user" where id in (${OFFICE}, ${CHIEF}, ${BOOKS}, ${RAY})`;
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.staff_notice_delivery where organization_id = ${ORG}`;
  await raw`delete from public.staff_notice where organization_id = ${ORG}`;
  await raw`delete from public.staff_notice_setting where organization_id = ${ORG}`;
  await raw`delete from public.person_certification where organization_id = ${ORG}`;
  await raw`delete from public.certification_renewals_keeper where organization_id = ${ORG}`;
  await raw`delete from public.audit_log where organization_id = ${ORG} and action in ('certification.renewal_days_set', 'organization.renewals_keeper_set')`;
  await raw`delete from public.message where organization_id = ${ORG}`;
  await raw`delete from public.integration_connection where organization_id = ${ORG} and capability = 'email'`;
});

run("one holding with a notice period of its own", () => {
  it("is warned from its own number, and says so on the renewals list", async () => {
    const type = await aType("Gas card", 30);
    const id = await held(type, 80);

    // The kind's thirty days has not started, so nothing is told and the list does not show it.
    await notices.raiseDueFor(db(), ORG);
    expect(await rowsFor(RAY)).toHaveLength(0);
    expect((await people.expiringSoon(owner())).filter((r) => r.id === id)).toHaveLength(0);

    const set = await people.setCertificationRenewalDays(owner(), { id, renewalLeadDays: 90 });
    expect(set).toEqual({ id, renewalLeadDays: 90, typeRenewalLeadDays: 30 });
    const [due] = (await people.expiringSoon(owner())).filter((r) => r.id === id);
    expect(due).toMatchObject({ renewalLeadDays: 90, ownRenewalLeadDays: 90, daysRemaining: 80 });

    await notices.raiseDueFor(db(), ORG);
    expect((await rowsFor(RAY)).map((r) => r.title)).toEqual(["Your Gas card runs out soon"]);
    // The manager hears too, once.
    expect((await rowsFor(OFFICE)).map((r) => r.title)).toEqual(["Ray Nunez's Gas card runs out soon"]);

    const [audited] = await raw<{ before: { renewalLeadDays: number | null }; after: { renewalLeadDays: number | null } }[]>`
      select before, after from public.audit_log
       where organization_id = ${ORG} and action = 'certification.renewal_days_set' and entity_id = ${id}`;
    expect(audited!.before.renewalLeadDays).toBeNull();
    expect(audited!.after.renewalLeadDays).toBe(90);
  });

  it("follows the kind's number until it is given one, and goes back to it when the number is cleared", async () => {
    const type = await aType("Forklift card", 30);
    const id = await held(type, 40);
    const held1 = async () => (await people.listCertifications(owner(), {})).find((c) => c.id === id)!;

    expect(await held1()).toMatchObject({ renewalLeadDays: 30, ownRenewalLeadDays: null });
    // The company changes the kind's number: every card that never chose its own moves with it.
    await people.updateCertificationType(owner(), { id: type, renewalLeadDays: 60 });
    expect(await held1()).toMatchObject({ renewalLeadDays: 60, ownRenewalLeadDays: null });
    expect((await people.expiringSoon(owner())).map((r) => r.id)).toContain(id);

    await people.setCertificationRenewalDays(owner(), { id, renewalLeadDays: 10 });
    expect(await held1()).toMatchObject({ renewalLeadDays: 10, ownRenewalLeadDays: 10 });
    expect((await people.expiringSoon(owner())).map((r) => r.id)).not.toContain(id);

    await people.setCertificationRenewalDays(owner(), { id, renewalLeadDays: null });
    expect(await held1()).toMatchObject({ renewalLeadDays: 60, ownRenewalLeadDays: null });
  });

  it("can be given at recording, and is refused when it is not whole days, for a card that does not expire, or without the permission", async () => {
    const type = await aType("Crane ticket", 30);
    const [tech] = await raw<{ id: string }[]>`select id from public.technician where organization_id = ${ORG} limit 1`;
    const recorded = await people.recordCertification(owner(), {
      technicianId: tech!.id, certificationTypeId: type, expiresOn: companyToday(200), renewalLeadDays: 120,
    });
    expect(recorded.renewalLeadDays).toBe(120);

    await expect(people.setCertificationRenewalDays(owner(), { id: recorded.id, renewalLeadDays: -1 })).rejects.toThrow("whole number of days");
    await expect(people.setCertificationRenewalDays(owner(), { id: recorded.id, renewalLeadDays: 2.5 })).rejects.toThrow("whole number of days");
    await expect(people.setCertificationRenewalDays(office(), { id: recorded.id, renewalLeadDays: 5 }))
      .rejects.toMatchObject({ name: "PermissionError" });

    const forever = await aType("Lifetime card", 30, false);
    const lifetime = await people.recordCertification(owner(), { technicianId: tech!.id, certificationTypeId: forever });
    await expect(people.setCertificationRenewalDays(owner(), { id: lifetime.id, renewalLeadDays: 30 }))
      .rejects.toThrow("does not expire");
    await expect(people.recordCertification(owner(), {
      technicianId: tech!.id, certificationTypeId: forever, reference: "2", renewalLeadDays: 30,
    })).rejects.toThrow("does not expire");
  });

  it("brings the company to the worker's list from its own number, not only inside a month", async () => {
    const type = await aType("Boiler licence", 30);
    await held(type, 80);
    const visits = async () => (await raw<{ organization_id: string }[]>`select organization_id from app.staff_notice_organizations(1000)`)
      .map((r) => r.organization_id);
    expect(await visits()).not.toContain(ORG);
    await raw`update public.person_certification set renewal_lead_days = 90 where organization_id = ${ORG}`;
    expect(await visits()).toContain(ORG);
  });
});

run("the email that goes with a notice", () => {
  it("goes to the holder, their manager and each keeper, once, in the company's outbox", async () => {
    await connectEmail();
    await notices.setRenewalsKeepers(owner(), { userIds: [OWNER, CHIEF] });
    const type = await aType("Backflow tester", 60);
    await held(type, 20);

    const result = await notices.noticesFor(db(), ORG, { push: false });
    expect(result.raised).toBe(4);
    expect(result.emailed).toBe(4);

    const ray1 = await mailTo("ray@m24mail.test");
    expect(ray1).toHaveLength(1);
    expect(ray1[0]).toMatchObject({ subject: "Your Backflow tester runs out soon", status: "queued" });
    expect(ray1[0]!.body).toContain(`Your Backflow tester runs out in 20 days, on ${companyToday(20)}.`);
    expect(ray1[0]!.body).toContain("Open it: https://ops.m24mail.test/me");
    expect(ray1[0]!.body).toContain("Sent by M24 Mail Co.");

    expect((await mailTo("office@m24mail.test")).map((m) => m.subject)).toEqual(["Ray Nunez's Backflow tester runs out soon"]);
    expect((await mailTo("olive@m24mail.test")).map((m) => m.subject)).toEqual(["Ray Nunez's Backflow tester runs out soon"]);
    expect((await mailTo("chief@m24mail.test")).map((m) => m.subject)).toEqual(["Ray Nunez's Backflow tester runs out soon"]);
    expect((await mailTo("olive@m24mail.test"))[0]!.body).toContain("You are told because you keep the renewals list.");
    expect((await deliveries()).every((d) => d.status === "sent")).toBe(true);

    // Looking again, an hour later or ten minutes later, tells and emails nobody twice.
    const again = await notices.noticesFor(db(), ORG, { push: false });
    expect(again.raised).toBe(0);
    expect(again.emailed).toBe(0);
    expect(await mailTo("ray@m24mail.test")).toHaveLength(1);
  });

  it("says the day itself in a second email, once per holding per notice", async () => {
    await connectEmail();
    const type = await aType("Elevator permit", 30);
    const id = await held(type, 10);
    await notices.noticesFor(db(), ORG, { push: false });
    expect((await mailTo("ray@m24mail.test")).map((m) => m.subject)).toEqual(["Your Elevator permit runs out soon"]);

    await raw`update public.person_certification set expires_on = ${companyToday()} where id = ${id}`;
    await notices.noticesFor(db(), ORG, { push: false });
    await notices.noticesFor(db(), ORG, { push: false });
    expect((await mailTo("ray@m24mail.test")).map((m) => m.subject)).toEqual([
      "Your Elevator permit runs out soon", "Your Elevator permit runs out today",
    ]);
  });

  it("goes to nobody who switched email off, who still has the bell", async () => {
    await connectEmail();
    await notices.setSwitches(ray(), {
      kinds: [{ kind: "qualification_expiry", inApp: true, push: true, text: false, email: false }],
    });
    const type = await aType("Rigging card", 30);
    await held(type, 10);
    await notices.noticesFor(db(), ORG, { push: false });
    expect(await rowsFor(RAY)).toHaveLength(1);
    expect(await mailTo("ray@m24mail.test")).toHaveLength(0);
    // The manager did not switch it off.
    expect(await mailTo("office@m24mail.test")).toHaveLength(1);
  });

  it("says why, in words, when the company has no email connected, and keeps the bell", async () => {
    const type = await aType("Scaffold card", 30);
    await held(type, 10);
    const result = await notices.noticesFor(db(), ORG, { push: false });
    expect(result.emailed).toBe(0);
    expect(result.skipped).toBe(2);
    expect(await rowsFor(RAY)).toHaveLength(1);
    const rows = await deliveries();
    expect(rows.map((d) => d.status)).toEqual(["skipped", "skipped"]);
    expect(rows[0]!.error).toContain("No email provider is connected");
    // Connecting email later does not send what was news and is not now.
    await connectEmail();
    expect((await notices.noticesFor(db(), ORG, { push: false })).emailed).toBe(0);
  });

  it("is not sent to an address that is on the do not email list, and says so", async () => {
    await connectEmail();
    await raw`insert into public.suppression (organization_id, address, channel, reason)
      values (${ORG}, 'ray@m24mail.test', 'email', 'complaint')`;
    try {
      const type = await aType("Trench card", 30);
      await held(type, 10);
      await notices.noticesFor(db(), ORG, { push: false });
      expect(await mailTo("ray@m24mail.test")).toHaveLength(0);
      expect(await mailTo("office@m24mail.test")).toHaveLength(1);
      const mine = (await deliveries()).find((d) => d.address === "ray@m24mail.test");
      expect(mine).toMatchObject({ status: "skipped" });
      expect(mine!.error).toContain("do-not-email list");
    } finally {
      await raw`delete from public.suppression where organization_id = ${ORG}`;
    }
  });

  it("is emailed only for the kinds that are emailed, in the switches a person sees", async () => {
    const view = await notices.settings(ray());
    expect(view.kinds.find((k) => k.kind === "qualification_expiry")).toMatchObject({ email: true });
    expect(view.kinds.filter((k) => k.kind !== "qualification_expiry").every((k) => k.email === null)).toBe(true);

    await expect(notices.setSwitches(ray(), {
      kinds: [{ kind: "task_assigned", inApp: true, push: true, text: false, email: true }],
    })).rejects.toThrow("does not come by email");

    await notices.setSwitches(ray(), {
      kinds: [{ kind: "qualification_expiry", inApp: true, push: true, text: false, email: false }],
    });
    expect((await notices.settings(ray())).kinds.find((k) => k.kind === "qualification_expiry")).toMatchObject({ email: false });
    // Saving the other three alone leaves the email choice where it was.
    await notices.setSwitches(ray(), {
      kinds: [{ kind: "qualification_expiry", inApp: true, push: false, text: false }],
    });
    expect((await notices.settings(ray())).kinds.find((k) => k.kind === "qualification_expiry"))
      .toMatchObject({ email: false, push: false });
  });
});

run("more than one person who keeps the renewals list", () => {
  it("names several, each of whom can read the list, and refuses one who cannot", async () => {
    expect((await notices.renewalsKeepers(owner())).keepers).toEqual([]);

    await expect(notices.setRenewalsKeepers(owner(), { userIds: [OWNER, OFFICE] }))
      .rejects.toThrow("Oscar Office cannot see the renewals list");
    await expect(notices.setRenewalsKeepers(office(), { userIds: [OWNER] })).rejects.toMatchObject({ name: "PermissionError" });
    expect((await notices.renewalsKeepers(owner())).keepers).toEqual([]);

    const named = await notices.setRenewalsKeepers(owner(), { userIds: [CHIEF, OWNER, OWNER] });
    expect(named.keepers).toEqual([
      { userId: CHIEF, name: "Dina Chief", active: true },
      { userId: OWNER, name: "Olive Owner", active: true },
    ]);
    // Somebody who reads the list may see who keeps it; they cannot change it.
    expect((await notices.renewalsKeepers(chief())).keepers).toHaveLength(2);
    await expect(notices.setRenewalsKeepers(chief(), { userIds: [] })).rejects.toMatchObject({ name: "PermissionError" });

    const choices = (await notices.renewalsKeeperChoices(owner())).map((c) => c.userId);
    expect(choices).toContain(CHIEF);
    expect(choices).not.toContain(OFFICE);

    // The same people again is the first answer and writes no second audit entry.
    await notices.setRenewalsKeepers(owner(), { userIds: [OWNER, CHIEF] });
    const [audited] = await raw<{ n: number }[]>`select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action = 'organization.renewals_keeper_set'`;
    expect(audited!.n).toBe(1);

    const tooMany = Array.from({ length: 21 }, () => crypto.randomUUID());
    await expect(notices.setRenewalsKeepers(owner(), { userIds: tooMany })).rejects.toThrow("up to 20 people");
  });

  it("tells each of them once, and nobody twice when they are also the manager", async () => {
    await notices.setRenewalsKeepers(owner(), { userIds: [OWNER, CHIEF] });
    const type = await aType("Gas fitter", 60);
    await held(type, 30);
    await notices.raiseDueFor(db(), ORG);
    for (const keeper of [OWNER, CHIEF]) {
      const told = await rowsFor(keeper);
      expect(told).toHaveLength(1);
      expect(told[0]!.title).toBe("Ray Nunez's Gas fitter runs out soon");
      expect(told[0]!.body).toContain("You are told because you keep the renewals list.");
    }
    await notices.raiseDueFor(db(), ORG);
    expect(await rowsFor(OWNER)).toHaveLength(1);
    expect(await rowsFor(CHIEF)).toHaveLength(1);

    // Dina becomes Ray's manager as well as a keeper: one notice, as the manager, not two.
    await raw`delete from public.staff_notice where organization_id = ${ORG}`;
    await raw`update public.membership set reports_to_user_id = ${CHIEF} where id = ${rayMembership}`;
    try {
      await notices.raiseDueFor(db(), ORG);
      expect(await rowsFor(CHIEF)).toHaveLength(1);
      expect((await rowsFor(CHIEF))[0]!.body).not.toContain("keep the renewals list");
      expect(await rowsFor(OWNER)).toHaveLength(1);
    } finally {
      await raw`update public.membership set reports_to_user_id = ${OFFICE} where id = ${rayMembership}`;
    }
  });

  it("tells nothing to one who was named and then lost the right to read the list, and shows it", async () => {
    await notices.setRenewalsKeepers(owner(), { userIds: [OWNER, CHIEF] });
    await raw`update public.membership set grants = '[]'::jsonb where organization_id = ${ORG} and user_id = ${CHIEF}`;
    try {
      const keepers = (await notices.renewalsKeepers(owner())).keepers;
      expect(keepers.find((k) => k.userId === CHIEF)).toMatchObject({ active: false });
      expect(keepers.find((k) => k.userId === OWNER)).toMatchObject({ active: true });
      const type = await aType("Chiller card", 60);
      await held(type, 30);
      await notices.raiseDueFor(db(), ORG);
      expect(await rowsFor(CHIEF)).toHaveLength(0);
      expect(await rowsFor(OWNER)).toHaveLength(1);
    } finally {
      await raw`update public.membership set grants = '["compliance:read","user:read"]'::jsonb where organization_id = ${ORG} and user_id = ${CHIEF}`;
    }
  });

  it("keeps the one person route working for older clients: the first by name, and naming one replaces the rest", async () => {
    await notices.setRenewalsKeepers(owner(), { userIds: [CHIEF, OWNER] });
    expect(await notices.renewalsKeeper(owner())).toEqual({ userId: CHIEF, name: "Dina Chief", active: true });

    const one = await notices.setRenewalsKeeper(owner(), { userId: OWNER });
    expect(one).toEqual({ userId: OWNER, name: "Olive Owner", active: true });
    expect((await notices.renewalsKeepers(owner())).keepers.map((k) => k.userId)).toEqual([OWNER]);

    expect(await notices.setRenewalsKeeper(owner(), { userId: null })).toEqual({ userId: null, name: null, active: false });
    expect((await notices.renewalsKeepers(owner())).keepers).toEqual([]);
  });
});
