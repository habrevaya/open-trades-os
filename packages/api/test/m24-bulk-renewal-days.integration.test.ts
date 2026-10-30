import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, time, type Actor } from "@opentradesos/core";
import * as people from "../src/services/people";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { routes } from "../src/contracts";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * M24. DAYS AHEAD FOR A SET OF HOLDINGS AT ONCE
 *
 * The same change as setting one card's number, for several cards in one call: all or nothing, one
 * audit row for each card that moved, a card already on the number left alone.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("m24-bulk:org");
const USER = fixtureId("m24-bulk:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (role: Actor["roles"][number]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db(),
});
const owner = () => as("owner");
const dispatcher = () => as("dispatcher");

const today = (): string => time.dateIn(new Date(), "America/Chicago");
const daysFromToday = (days: number): string =>
  new Date(Date.parse(`${today()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

async function technician(key: string, name: string): Promise<string> {
  const userId = fixtureId(`m24-bulk:tech:${key}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`m24-bulk-${key}@test.local`}) on conflict (id) do nothing`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, ${name}) returning id`;
  return t!.id;
}

let dana = "";
let sam = "";
let licence = "";
let ticket = "";
let lifetime = "";
let danaLicence = "";
let samLicence = "";
let danaTicket = "";
let danaLifetime = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Bulk Days Co", slug: "bulk-days-co" });
  dana = await technician("dana", "Dana Reyes");
  sam = await technician("sam", "Sam Okafor");
  licence = (await people.defineCertificationType(owner(), { code: "lic", name: "Electrical licence", renewalLeadDays: 60 })).id;
  ticket = (await people.defineCertificationType(owner(), { code: "hoist", name: "Hoist ticket", renewalLeadDays: 30 })).id;
  lifetime = (await people.defineCertificationType(owner(), { code: "first_aid_once", name: "Safety induction", expires: false })).id;
  danaLicence = (await people.recordCertification(owner(), { technicianId: dana, certificationTypeId: licence, expiresOn: daysFromToday(200) })).id;
  samLicence = (await people.recordCertification(owner(), { technicianId: sam, certificationTypeId: licence, expiresOn: daysFromToday(200) })).id;
  danaTicket = (await people.recordCertification(owner(), { technicianId: dana, certificationTypeId: ticket, expiresOn: daysFromToday(200) })).id;
  danaLifetime = (await people.recordCertification(owner(), { technicianId: dana, certificationTypeId: lifetime })).id;
});

const audits = (id: string) => raw`select before, after from public.audit_log
  where organization_id = ${ORG} and action = 'certification.renewal_days_set' and entity_id = ${id} order by created_at`;

run("setting the days ahead on a set of holdings", () => {
  it("changes every ticked holding, with an audit row each carrying the earlier number", async () => {
    await people.setCertificationRenewalDays(owner(), { id: samLicence, renewalLeadDays: 20 });
    const answer = await people.setCertificationRenewalDaysMany(owner(), { ids: [danaLicence, samLicence, danaTicket], renewalLeadDays: 250 });
    expect(answer.changed).toBe(3);
    expect(answer.holdings.map((h) => [h.id, h.renewalLeadDays, h.typeRenewalLeadDays, h.changed])).toEqual([
      [danaLicence, 250, 60, true], [samLicence, 250, 60, true], [danaTicket, 250, 30, true],
    ]);
    const held = await people.listCertifications(owner());
    for (const id of [danaLicence, samLicence, danaTicket]) {
      expect(held.find((h) => h.id === id)).toMatchObject({ renewalLeadDays: 250, ownRenewalLeadDays: 250 });
    }
    expect(await audits(danaLicence)).toEqual([{ before: { renewalLeadDays: null }, after: { renewalLeadDays: 250, withOthers: 3 } }]);
    /** Sam's was changed twice, and both are in the log with the number it had. */
    const sams = await audits(samLicence);
    expect(sams.map((a) => (a.before as { renewalLeadDays: number | null }).renewalLeadDays)).toEqual([null, 20]);
  });

  it("hands a set back to their kinds' numbers with null, and leaves one already there alone", async () => {
    await people.setCertificationRenewalDays(owner(), { id: danaLicence, renewalLeadDays: 90 });
    const answer = await people.setCertificationRenewalDaysMany(owner(), { ids: [danaLicence, samLicence], renewalLeadDays: null });
    expect(answer.holdings.map((h) => h.changed)).toEqual([true, false]);
    expect(answer.changed).toBe(1);
    const held = await people.listCertifications(owner());
    expect(held.find((h) => h.id === danaLicence)).toMatchObject({ renewalLeadDays: 60, ownRenewalLeadDays: null });
    expect(await audits(samLicence)).toEqual([]);
  });

  it("is the same twice: the second call changes nothing and writes nothing", async () => {
    await people.setCertificationRenewalDaysMany(owner(), { ids: [danaLicence, samLicence], renewalLeadDays: 45 });
    const again = await people.setCertificationRenewalDaysMany(owner(), { ids: [danaLicence, samLicence, danaLicence], renewalLeadDays: 45 });
    expect(again.changed).toBe(0);
    expect(again.holdings).toHaveLength(2);
    expect(await audits(danaLicence)).toHaveLength(1);
  });

  it("is all or nothing: a card whose kind does not expire refuses the set and names it", async () => {
    const refusal = people.setCertificationRenewalDaysMany(owner(), { ids: [danaLicence, danaLifetime], renewalLeadDays: 45 });
    await expect(refusal).rejects.toBeInstanceOf(ConflictError);
    await expect(refusal).rejects.toThrow(/Nothing was changed\. Dana Reyes's Safety induction does not expire/);
    expect((await people.listCertifications(owner())).find((h) => h.id === danaLicence)!.ownRenewalLeadDays).toBeNull();
    expect(await audits(danaLicence)).toEqual([]);
    /** Handing back to the kind's number is no warning at all, so it is allowed for any card. */
    expect((await people.setCertificationRenewalDaysMany(owner(), { ids: [danaLifetime], renewalLeadDays: null })).changed).toBe(0);
  });

  it("refuses a card that is not here, an empty set, a bad number and too many at once", async () => {
    await expect(people.setCertificationRenewalDaysMany(owner(), { ids: [danaLicence, crypto.randomUUID()], renewalLeadDays: 45 }))
      .rejects.toBeInstanceOf(NotFoundError);
    expect((await people.listCertifications(owner())).find((h) => h.id === danaLicence)!.ownRenewalLeadDays).toBeNull();
    await expect(people.setCertificationRenewalDaysMany(owner(), { ids: [], renewalLeadDays: 45 })).rejects.toThrow(/Tick at least one/);
    await expect(people.setCertificationRenewalDaysMany(owner(), { ids: [danaLicence], renewalLeadDays: -3 })).rejects.toThrow(/whole number of days/);
    await expect(people.setCertificationRenewalDaysMany(owner(), { ids: [danaLicence], renewalLeadDays: Number.NaN })).rejects.toThrow(/whole number of days/);
    const many = Array.from({ length: people.MAX_BULK_HOLDINGS + 1 }, () => crypto.randomUUID());
    await expect(people.setCertificationRenewalDaysMany(owner(), { ids: many, renewalLeadDays: 45 })).rejects.toThrow(/at most/);
  });

  it("is compliance:write's, and another company's cards are not found", async () => {
    await expect(people.setCertificationRenewalDaysMany(dispatcher(), { ids: [danaLicence], renewalLeadDays: 45 })).rejects.toBeInstanceOf(PermissionError);
    const other = fixtureId("m24-bulk:other-org");
    await resetOrg(raw, other);
    await seedOrg(raw, { organizationId: other, userId: fixtureId("m24-bulk:other-user"), name: "Other Co", slug: "bulk-days-other" });
    const strangers: ServiceContext = {
      actor: { userId: fixtureId("m24-bulk:other-user"), organizationId: other, roles: ["owner"] as Actor["roles"] }, db: db(),
    };
    await expect(people.setCertificationRenewalDaysMany(strangers, { ids: [danaLicence], renewalLeadDays: 45 })).rejects.toBeInstanceOf(NotFoundError);
    expect(routes.setCertificationRenewalDaysMany.permissions).toEqual(["compliance:write"]);
    expect(routes.setCertificationRenewalDaysMany.input.safeParse({ ids: [], renewalLeadDays: 3 }).success).toBe(false);
    expect(routes.setCertificationRenewalDaysMany.input.safeParse({ ids: [danaLicence], renewalLeadDays: null }).success).toBe(true);
  });
});
