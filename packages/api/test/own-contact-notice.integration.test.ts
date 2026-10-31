import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as me from "../src/services/me";
import * as notices from "../src/services/staff-notices";
import * as peopleRecords from "../src/services/people-records";
import { routes } from "../src/contracts";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { companyToday, fixtureId, resetOrg, seedOrg, testDb } from "./helpers";

/**
 * THE OFFICE IS TOLD WHEN A PERSON CHANGES THEIR OWN PHONE OR ADDRESS (M24, M34),
 * AND A PERSON KEEPS A SECOND MAILBOX FOR THEIR OWN LICENCE EMAILS
 *
 * A new kind of notice through the same engine: it goes to everybody who may
 * read people and reaches this one, never to the person, says what they did
 * and not the new number or address, and opens their page. The second mailbox
 * gets a copy of the person's OWN licence and skill emails and nobody else's.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("contactnotice:org");
const OWNER = fixtureId("contactnotice:owner");
const OLIVE = fixtureId("contactnotice:olive");
const HANA = fixtureId("contactnotice:hana");
const BEN = fixtureId("contactnotice:ben");
const RAY = fixtureId("contactnotice:ray");
const DANA = fixtureId("contactnotice:dana");
const PEOPLE = [OLIVE, HANA, BEN, RAY, DANA];

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, role: string, extra: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: [role] as Actor["roles"], ...extra }, db: db(),
});
const olive = () => as(OLIVE, "office_manager");
const ray = () => as(RAY, "technician", { technicianId: rayTech });
const dana = () => as(DANA, "technician");

let houston = "";
let austin = "";
let rayMember = "";
let rayTech = "";

async function person(userId: string, name: string, role: string, unit: string | null): Promise<string> {
  const email = `${name.split(" ")[0]!.toLowerCase()}@contact-notice.test`;
  await raw`delete from public."user" where id = ${userId} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [m] = await raw`insert into public.membership (organization_id, user_id, role, business_unit_id)
    values (${ORG}, ${userId}, ${role}::member_role, ${unit}) returning id`;
  return m!.id as string;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Contact Notice Co", slug: "contact-notice-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  const [h] = await raw`insert into public.business_unit (organization_id, name) values (${ORG}, 'Houston') returning id`;
  const [a] = await raw`insert into public.business_unit (organization_id, name) values (${ORG}, 'Austin') returning id`;
  houston = h!.id as string;
  austin = a!.id as string;
  await person(OLIVE, "Olive Office", "office_manager", null);
  await person(HANA, "Hana Branch", "branch_manager", houston);
  await person(BEN, "Ben Branch", "branch_manager", austin);
  rayMember = await person(RAY, "Ray Nunez", "technician", houston);
  await person(DANA, "Dana Pike", "technician", austin);
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${rayMember}, 'Ray Nunez') returning id`;
  rayTech = t!.id;
  await raw`update public.membership set reports_to_user_id = ${OLIVE} where id = ${rayMember}`;
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw`delete from public."user" where id in ${raw(PEOPLE)}`;
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.staff_notice_delivery where organization_id = ${ORG}`;
  await raw`delete from public.staff_notice where organization_id = ${ORG}`;
  await raw`delete from public.staff_notice_setting where organization_id = ${ORG}`;
  await raw`delete from public.person_contact where organization_id = ${ORG}`;
  await raw`delete from public.person_second_email where organization_id = ${ORG}`;
  await raw`delete from public.person_certification where organization_id = ${ORG}`;
});

const told = async (kind = "contact_changed") =>
  (await raw<{ user_id: string }[]>`select user_id from public.staff_notice
    where organization_id = ${ORG} and kind = ${kind} order by user_id`).map((r) => r.user_id).sort();
const noticeRows = () => raw<{ user_id: string; title: string; body: string | null; href: string; entity_type: string; entity_id: string }[]>`
  select user_id, title, body, href, entity_type, entity_id from public.staff_notice
   where organization_id = ${ORG} and kind = 'contact_changed' order by created_at`;

run("a person changes their own phone or address", () => {
  it("tells everybody who may read people and reaches this one, and nobody else", async () => {
    await me.setOwnContact(ray(), { phone: "(512) 555-0143" });
    // The owner and the office manager see everybody, Hana is in Ray's branch. Ben is in Austin, Dana is a technician, Ray is the one who changed it.
    expect(await told()).toEqual([OWNER, OLIVE, HANA].sort());
    const rows = await noticeRows();
    expect(rows[0]).toMatchObject({
      title: "Ray Nunez added a phone number", body: "Open their page to see what changed.",
      href: `/people/${rayMember}`, entity_type: "person", entity_id: rayMember,
    });
  });

  it("says what they did and never the new number or address", async () => {
    await me.setOwnContact(ray(), { phone: "(512) 555-0143", addressLine1: "12 Oak St", city: "Austin", state: "tx", postalCode: "78701" });
    await me.setOwnContact(ray(), { phone: "(512) 555-0199", addressLine1: "12 Oak St", city: "Round Rock", state: "tx", postalCode: "78664" });
    await me.setOwnContact(ray(), { phone: null, addressLine1: "12 Oak St", city: "Round Rock", state: "tx", postalCode: "78664" });
    const mine = (await noticeRows()).filter((r) => r.user_id === OLIVE);
    expect(mine.map((r) => r.title)).toEqual([
      "Ray Nunez added a phone number and home address",
      "Ray Nunez changed their phone number and home address",
      "Ray Nunez removed their phone number",
    ]);
    for (const row of mine) {
      expect(`${row.title} ${row.body}`).not.toMatch(/\d{3}|Oak|Round Rock/);
      expect(`${row.title} ${row.body}`).not.toMatch(/[\u2014\u2013]/);
    }
  });

  it("tells nobody when nothing was different, and nothing about a different branch's people", async () => {
    await me.setOwnContact(ray(), { phone: "(512) 555-0143" });
    const first = (await noticeRows()).length;
    await me.setOwnContact(ray(), { phone: "512-555-0143" });
    expect((await noticeRows()).length).toBe(first);

    await me.setOwnContact(dana(), { phone: "(512) 555-0100" });
    const danaNotices = (await noticeRows()).filter((r) => r.title.startsWith("Dana"));
    expect(danaNotices.map((r) => r.user_id).sort()).toEqual([OWNER, OLIVE, BEN].sort());
  });

  it("is a kind the office can switch off on its own page, and respects it", async () => {
    await notices.setSwitches(olive(), { kinds: [{ kind: "contact_changed", inApp: false, push: false, text: false }] });
    await me.setOwnContact(ray(), { phone: "(512) 555-0143" });
    const rows = await raw<{ user_id: string; in_app: boolean }[]>`select user_id, in_app from public.staff_notice
      where organization_id = ${ORG} and kind = 'contact_changed' order by user_id`;
    expect(rows.find((r) => r.user_id === OLIVE)?.in_app).toBe(false);
    expect(rows.find((r) => r.user_id === OWNER)?.in_app).toBe(true);
  });

  it("opens the person's page for the reader, and not for one whose scope no longer reaches them", async () => {
    await me.setOwnContact(ray(), { phone: "(512) 555-0143" });
    const inHouston = as(HANA, "branch_manager", { businessUnitId: houston });
    const hana = await notices.list(inHouston, {});
    expect(hana.notices.some((n) => n.kind === "contact_changed" && n.href === `/people/${rayMember}`)).toBe(true);
    // The same notice asked again as a manager of Austin: Ray is not inside that branch, so it is no longer shown.
    const inAustin = as(HANA, "branch_manager", { businessUnitId: austin });
    expect((await notices.list(inAustin, {})).notices.some((n) => n.kind === "contact_changed")).toBe(false);
  });
});

const connectEmail = () => raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
  values (${ORG}, 'email', 'smtp', 'connected', '{"fromAddress":"office@contact-notice.test","fromName":"Contact Notice Co"}'::jsonb)
  on conflict do nothing`;

const emailTo = () => raw<{ address: string; user_id: string }[]>`
  select d.address, n.user_id from public.staff_notice_delivery d
    join public.staff_notice n on n.id = d.notice_id
   where d.organization_id = ${ORG} and d.channel = 'email' order by d.address`;

async function expiringCard() {
  const [type] = await raw<{ id: string }[]>`insert into public.certification_type (organization_id, code, name, renewal_lead_days, expires)
    values (${ORG}, ${`t-${crypto.randomUUID().slice(0, 8)}`}, 'Electrical card', 30, true) returning id`;
  await raw`insert into public.person_certification (organization_id, technician_id, certification_type_id, expires_on, status)
    values (${ORG}, ${rayTech}, ${type!.id}, ${companyToday(10)}, 'active')`;
}

run("a second mailbox for a person's own licence emails", () => {
  it("is kept by the person, read back, shown to the office and audited", async () => {
    expect((await me.record(ray())).secondEmail).toBeNull();
    expect(await me.setOwnSecondEmail(ray(), { email: "  Ray.Home@Example.com " })).toEqual({ secondEmail: "ray.home@example.com" });
    expect((await me.record(ray())).secondEmail).toBe("ray.home@example.com");
    expect((await peopleRecords.person(olive(), { membershipId: rayMember })).secondEmail).toBe("ray.home@example.com");
    // The same again changes nothing and is not audited a second time.
    await me.setOwnSecondEmail(ray(), { email: "ray.home@example.com" });
    const [audited] = await raw`select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action = 'person.second_email_changed'`;
    expect(audited!.n).toBe(1);
    expect(await me.setOwnSecondEmail(ray(), { email: "" })).toEqual({ secondEmail: null });
    expect((await me.record(ray())).secondEmail).toBeNull();
  });

  it("is refused when it is not an address or is the one they sign in with, in words", async () => {
    await expect(me.setOwnSecondEmail(ray(), { email: "ray at home" })).rejects.toThrow(/is not an email address/);
    await expect(me.setOwnSecondEmail(ray(), { email: "RAY@contact-notice.test" })).rejects.toThrow(/already sign in with/);
    await expect(me.setOwnSecondEmail(ray(), { email: "x@y.test" }).then(() => me.setOwnSecondEmail(ray(), { email: "nope" })))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("gets the person's own licence email too, and nobody else's copy", async () => {
    await connectEmail();
    await me.setOwnSecondEmail(ray(), { email: "ray.home@example.com" });
    // Olive, Ray's manager, has a second mailbox of her own: it must not get the copy about Ray's licence.
    await me.setOwnSecondEmail(olive(), { email: "olive.home@example.com" });
    await expiringCard();
    await notices.raiseDueFor(db(), ORG);
    expect(await emailTo()).toEqual([
      { address: "olive@contact-notice.test", user_id: OLIVE },
      { address: "ray.home@example.com", user_id: RAY },
      { address: "ray@contact-notice.test", user_id: RAY },
    ]);
    // A second look tells nobody twice.
    await notices.raiseDueFor(db(), ORG);
    expect(await emailTo()).toHaveLength(3);
  });

  it("follows the person's own email switch: off means neither address", async () => {
    await connectEmail();
    await me.setOwnSecondEmail(ray(), { email: "ray.home@example.com" });
    await notices.setSwitches(ray(), { kinds: [{ kind: "qualification_expiry", inApp: true, push: true, text: false, email: false }] });
    await expiringCard();
    await notices.raiseDueFor(db(), ORG);
    expect((await emailTo()).filter((r) => r.user_id === RAY)).toEqual([]);
  });

  it("is the person's own to keep: one permission, and no person to name", async () => {
    expect(routes.setMySecondEmail.permissions).toEqual(["profile:own"]);
    expect(Object.keys(routes.setMySecondEmail.input.shape)).toEqual(["email"]);
    expect(Object.values(routes).filter((r) => r.path.includes("second-email") && r.permissions.includes("user:write"))).toEqual([]);
  });
});
