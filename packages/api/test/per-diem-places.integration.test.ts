import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as expenses from "../src/services/expenses";
import * as payExtras from "../src/services/pay-extras";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import { routes } from "../src/contracts";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * A DAY AWAY THAT IS WORTH SOMETHING ELSE IN SOME PLACES
 *
 * The company keeps a list of places with a day rate each, from a date. A day away recorded
 * against a job is worked out at the rate in force on that day at its place: the one chosen, or
 * the one whose city is the job's address's city, and never a guess. A trip that crosses places is
 * separate entries. Nothing is posted to the ledger.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("pdplaces:org");
const OWNER = fixtureId("pdplaces:owner");
const RAY = fixtureId("pdplaces:ray");
const OFFICE = fixtureId("pdplaces:office");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const office = (): ServiceContext => ({
  actor: { userId: OFFICE, organizationId: ORG, roles: ["office_manager"] as Actor["roles"] }, db: db(),
});

let rayTech = "";
/** A job in Austin, one in Dallas and one in Tulsa, Oklahoma. */
const job: Record<"austin" | "dallas" | "tulsa", string> = { austin: "", dallas: "", tulsa: "" };

async function jobAt(name: string, city: string, state: string): Promise<string> {
  const created = await customers.create(owner(), {
    type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    property: { address: { line1: "12 Oak St", city, state, postalCode: "78701", country: "US" } },
  });
  const [prop] = await raw`select p.id from public.property p where p.organization_id = ${ORG} and p.city = ${city} and p.state = ${state}`;
  const made = await jobs.create(owner(), {
    customerId: created.id as string, propertyId: (prop as { id: string }).id, summary: `Work in ${city}`, tags: [], customFields: {},
  });
  return made.id as string;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Places Co", slug: "per-diem-places-co" });
  for (const [id, name, role] of [[RAY, "Ray Nunez", "technician"], [OFFICE, "Olive Office", "office_manager"]] as const) {
    const email = `${name.split(" ")[0]!.toLowerCase()}@pdplaces.test`;
    await raw`delete from public."user" where id = ${id} or email = ${email}`;
    await raw`insert into public."user" (id, email, name) values (${id}, ${email}, ${name})`;
    const [m] = await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${id}, ${role}::member_role) returning id`;
    if (role === "technician") {
      const [t] = await raw`insert into public.technician (organization_id, membership_id, display_name)
        values (${ORG}, ${m!.id}, ${name}) returning id`;
      rayTech = t!.id as string;
    }
  }
  job.austin = await jobAt("Delacroix", "Austin", "TX");
  job.dallas = await jobAt("Okafor", "Dallas", "TX");
  job.tulsa = await jobAt("Whitfield", "Tulsa", "OK");
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.per_diem where organization_id = ${ORG}`;
  await raw`update public.organization set settings = settings - 'payExtras' where id = ${ORG}`;
});

const record = (input: Partial<Parameters<typeof expenses.recordPerDiem>[1]> & { from: string; to: string }) =>
  expenses.recordPerDiem(office(), { technicianId: rayTech, jobId: job.austin, ...input });

const place = async (name: string, perDay: string, extra: { city?: string; state?: string; from?: string } = {}) => {
  const view = await payExtras.addPerDiemPlace(owner(), { name, from: extra.from ?? "2026-01-01", perDay, ...(extra.city ? { city: extra.city } : {}), ...(extra.state ? { state: extra.state } : {}) });
  return view.perDiemPlaces.find((p) => p.name === name)!;
};

run("the company keeps places with a day rate each", () => {
  it("adds a place with its first rate, tidied, and shows it with what a day is worth today", async () => {
    const view = await payExtras.addPerDiemPlace(owner(), { name: " Round  Rock ", state: "tx", city: "Round Rock", from: "2026-01-01", perDay: "80" });
    expect(view.perDiemPlaces).toEqual([{
      id: expect.any(String), name: "Round Rock", state: "TX", city: "Round Rock",
      rates: [{ from: "2026-01-01", perDay: "80.00" }], rateToday: "80.00", retired: false,
    }]);
    expect((await payExtras.get(office())).perDiemPlaces).toHaveLength(1);
  });

  it("is refused in words when it cannot be right, and two in use cannot share a name", async () => {
    await expect(payExtras.addPerDiemPlace(owner(), { name: "", from: "2026-01-01", perDay: "80" })).rejects.toThrow(/Give the place a name/);
    await expect(payExtras.addPerDiemPlace(owner(), { name: "Austin", state: "Texas", from: "2026-01-01", perDay: "80" })).rejects.toThrow(/two letters/);
    await expect(payExtras.addPerDiemPlace(owner(), { name: "Austin", from: "2026-01-01", perDay: "8000" })).rejects.toThrow(/slip of the keys/);
    await place("Austin", "75", { city: "Austin" });
    await expect(payExtras.addPerDiemPlace(owner(), { name: "austin", from: "2026-01-01", perDay: "99" })).rejects.toThrow(/already a place called austin/);
    expect((await payExtras.get(owner())).perDiemPlaces).toHaveLength(1);
  });

  it("is the same place sent again, and audited once", async () => {
    const audits = async () => (await raw`select count(*)::int as n from public.audit_log where action = 'per_diem_place.added' and entity_id = ${ORG}`)[0]!.n as number;
    const before = await audits();
    await place("Austin", "75", { city: "Austin" });
    const again = await payExtras.addPerDiemPlace(owner(), { name: "Austin", city: "Austin", from: "2026-01-01", perDay: "75.00" });
    expect(again.perDiemPlaces).toHaveLength(1);
    expect(await audits()).toBe(before + 1);
  });

  it("takes a rate from a day, refuses a second for the same day, and takes one off", async () => {
    const austin = await place("Austin", "75", { city: "Austin" });
    const more = await payExtras.addPerDiemPlaceRate(owner(), { id: austin.id, from: "2026-07-01", perDay: "85" });
    expect(more.perDiemPlaces[0]!.rates).toEqual([{ from: "2026-01-01", perDay: "75.00" }, { from: "2026-07-01", perDay: "85.00" }]);
    await expect(payExtras.addPerDiemPlaceRate(owner(), { id: austin.id, from: "2026-07-01", perDay: "90" })).rejects.toThrow(/already has a rate from 2026-07-01/);
    // The same line again is the first one back.
    expect((await payExtras.addPerDiemPlaceRate(owner(), { id: austin.id, from: "2026-07-01", perDay: "85.00" })).perDiemPlaces[0]!.rates).toHaveLength(2);
    const removed = await payExtras.removePerDiemPlaceRate(owner(), { id: austin.id, from: "2026-07-01" });
    expect(removed.perDiemPlaces[0]!.rates).toHaveLength(1);
    expect((await payExtras.removePerDiemPlaceRate(owner(), { id: austin.id, from: "2026-07-01" })).perDiemPlaces[0]!.rates).toHaveLength(1);
    await expect(payExtras.addPerDiemPlaceRate(owner(), { id: fixtureId("pdplaces:nobody"), from: "2026-07-01", perDay: "85" })).rejects.toThrow(/not on the list/);
  });

  it("retires a place, which cannot then be given a rate, and lets a new one take the name", async () => {
    const austin = await place("Austin", "75", { city: "Austin" });
    const retired = await payExtras.retirePerDiemPlace(owner(), { id: austin.id });
    expect(retired.perDiemPlaces[0]).toMatchObject({ retired: true });
    await expect(payExtras.addPerDiemPlaceRate(owner(), { id: austin.id, from: "2026-07-01", perDay: "85" })).rejects.toThrow(/no longer used/);
    expect((await payExtras.retirePerDiemPlace(owner(), { id: austin.id })).perDiemPlaces).toHaveLength(1);
    await place("Austin", "78", { city: "Austin" });
    expect((await payExtras.get(owner())).perDiemPlaces.map((p) => [p.name, p.retired])).toEqual([["Austin", false], ["Austin", true]]);
  });

  it("is payroll:configure's to change: the office that records days may not", async () => {
    const austin = await place("Austin", "75", { city: "Austin" });
    await expect(payExtras.addPerDiemPlace(office(), { name: "Dallas", from: "2026-01-01", perDay: "80" })).rejects.toBeInstanceOf(PermissionError);
    await expect(payExtras.addPerDiemPlaceRate(office(), { id: austin.id, from: "2026-07-01", perDay: "85" })).rejects.toBeInstanceOf(PermissionError);
    await expect(payExtras.removePerDiemPlaceRate(office(), { id: austin.id, from: "2026-01-01" })).rejects.toBeInstanceOf(PermissionError);
    await expect(payExtras.retirePerDiemPlace(office(), { id: austin.id })).rejects.toBeInstanceOf(PermissionError);
  });

  it("leaves the standard rate, the tip rule and the mileage rates as they were", async () => {
    await payExtras.set(owner(), { perDiemRate: "60", tipSplit: "hours" });
    await payExtras.addMileageRate(owner(), { from: "2026-01-01", perMile: "0.70" });
    await place("Austin", "75", { city: "Austin" });
    const set = await payExtras.set(owner(), { perDiemRate: "65" });
    expect(set).toMatchObject({ perDiemRate: "65.00", tipSplit: "hours" });
    expect(set.mileageRates).toHaveLength(1);
    expect(set.perDiemPlaces).toHaveLength(1);
  });
});

run("a day away is worked out at its place", () => {
  it("takes the place whose city is the job's city, at the rate in force on each day, and keeps it", async () => {
    const austin = await place("Austin", "75", { city: "Austin", state: "TX" });
    await payExtras.addPerDiemPlaceRate(owner(), { id: austin.id, from: "2026-01-08", perDay: "85" });
    const done = await record({ from: "2026-01-06", to: "2026-01-09" });
    expect(done).toEqual({
      recorded: ["2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"], alreadyHad: [], rate: null, place: "Austin",
      amounts: [
        { day: "2026-01-06", amount: "75.00" }, { day: "2026-01-07", amount: "75.00" },
        { day: "2026-01-08", amount: "85.00" }, { day: "2026-01-09", amount: "85.00" },
      ],
    });

    // Rates change afterwards: days recorded keep what they were.
    await payExtras.addPerDiemPlaceRate(owner(), { id: austin.id, from: "2026-01-02", perDay: "99" });
    await payExtras.retirePerDiemPlace(owner(), { id: austin.id });
    const days = await expenses.listPerDiem(office(), { technicianId: rayTech });
    expect(days.map((d) => [d.day, d.amount, d.placeName]).sort()).toEqual([
      ["2026-01-06", "75.0000", "Austin"], ["2026-01-07", "75.0000", "Austin"],
      ["2026-01-08", "85.0000", "Austin"], ["2026-01-09", "85.0000", "Austin"],
    ]);
    const [row] = await raw`select place_id, place_name from public.per_diem where organization_id = ${ORG} limit 1`;
    expect(row).toEqual({ place_id: austin.id, place_name: "Austin" });
    const [audit] = await raw`select after from public.audit_log where action = 'per_diem.recorded' and entity_id = ${rayTech} order by created_at desc limit 1`;
    expect(audit!.after).toMatchObject({ place: { id: austin.id, name: "Austin" } });
  });

  it("gives the one rate as the rate when it did not change inside the span", async () => {
    await place("Austin", "75", { city: "Austin" });
    const done = await record({ from: "2026-01-06", to: "2026-01-07" });
    expect(done).toMatchObject({ rate: "75.00", place: "Austin" });
  });

  it("works out the place from the job's city only, and never guesses from a near miss", async () => {
    await place("Austin", "75", { city: "Austin", state: "TX" });
    await place("Out of state", "110");
    await place("Texas", "90", { state: "TX" });
    // Dallas is Texas, and "Texas" is a place, but a place with no city is chosen by a person.
    await expect(record({ jobId: job.dallas, from: "2026-01-06", to: "2026-01-06" }))
      .rejects.toThrow(/No place on the list is Dallas, TX, where job \d+ is\. Choose where they were\./);
    await expect(record({ jobId: job.tulsa, from: "2026-01-06", to: "2026-01-06" })).rejects.toThrow(/No place on the list is Tulsa, OK/);
    expect(await expenses.listPerDiem(office(), {})).toEqual([]);
    // The same city in another state is not the place.
    await place("Tulsa, Minnesota", "70", { city: "Tulsa", state: "MN" });
    await expect(record({ jobId: job.tulsa, from: "2026-01-06", to: "2026-01-06" })).rejects.toThrow(/No place on the list is Tulsa, OK/);
  });

  it("asks which when two places name the city, and takes the one chosen", async () => {
    await place("Austin", "75", { city: "Austin" });
    const downtown = await place("Austin downtown", "95", { city: "Austin", state: "TX" });
    await expect(record({ from: "2026-01-06", to: "2026-01-06" })).rejects.toThrow(/More than one place matches Austin, TX.*Austin, Austin downtown\. Choose which one\./);
    const done = await record({ from: "2026-01-06", to: "2026-01-06", placeId: downtown.id });
    expect(done).toMatchObject({ rate: "95.00", place: "Austin downtown" });
  });

  it("takes a place chosen for a job somewhere else, and the standard rate when that is chosen on purpose", async () => {
    await payExtras.set(owner(), { perDiemRate: "60" });
    const away = await place("Out of state", "110");
    expect(await record({ jobId: job.tulsa, from: "2026-01-06", to: "2026-01-06", placeId: away.id })).toMatchObject({ rate: "110.00", place: "Out of state" });
    // The standard rate is never used because a city did not match.
    await expect(record({ jobId: job.dallas, from: "2026-01-07", to: "2026-01-07" })).rejects.toThrow(/choose the standard rate/);
    const standard = await record({ jobId: job.dallas, from: "2026-01-07", to: "2026-01-07", placeId: null });
    expect(standard).toEqual({ recorded: ["2026-01-07"], alreadyHad: [], rate: "60.00" });
    const days = await expenses.listPerDiem(office(), {});
    expect(days.map((d) => [d.day, d.amount, d.placeName]).sort()).toEqual([
      ["2026-01-06", "110.0000", "Out of state"], ["2026-01-07", "60.0000", null],
    ]);
  });

  it("does not offer the standard rate in the question when there is none", async () => {
    await place("Austin", "75", { city: "Austin" });
    await expect(record({ jobId: job.dallas, from: "2026-01-06", to: "2026-01-06" })).rejects.toThrow(/Choose where they were\.$/);
    await expect(record({ jobId: job.dallas, from: "2026-01-06", to: "2026-01-06", placeId: null })).rejects.toThrow(/No standard rate is set/);
  });

  it("refuses a day the place has no rate for, by name, and records nothing", async () => {
    const austin = await place("Austin", "75", { city: "Austin", from: "2026-01-08" });
    await expect(record({ from: "2026-01-06", to: "2026-01-09" }))
      .rejects.toThrow("Austin has no rate for 2026-01-06: its first rate starts 2026-01-08. Add one that starts earlier, or leave that day out.");
    expect(await expenses.listPerDiem(office(), {})).toEqual([]);
    await payExtras.removePerDiemPlaceRate(owner(), { id: austin.id, from: "2026-01-08" });
    await expect(record({ from: "2026-01-06", to: "2026-01-06" })).rejects.toThrow(/Austin has no rate yet/);
  });

  it("refuses a place that is not on the list or is no longer used", async () => {
    const austin = await place("Austin", "75", { city: "Austin" });
    await expect(record({ from: "2026-01-06", to: "2026-01-06", placeId: fixtureId("pdplaces:nobody") })).rejects.toThrow(/not on the list/);
    await payExtras.retirePerDiemPlace(owner(), { id: austin.id });
    await expect(record({ from: "2026-01-06", to: "2026-01-06", placeId: austin.id })).rejects.toThrow(/Austin is no longer used/);
  });

  it("records a trip that crosses places as separate entries, and one entry cannot overwrite another's day", async () => {
    await place("Austin", "75", { city: "Austin" });
    const dallas = await place("Dallas", "95", { city: "Dallas" });
    await record({ from: "2026-01-06", to: "2026-01-07" });
    const second = await record({ jobId: job.dallas, from: "2026-01-07", to: "2026-01-08", placeId: dallas.id });
    expect(second).toMatchObject({ recorded: ["2026-01-08"], alreadyHad: ["2026-01-07"], place: "Dallas" });
    const days = await expenses.listPerDiem(office(), { technicianId: rayTech });
    expect(days.map((d) => [d.day, d.amount, d.placeName]).sort()).toEqual([
      ["2026-01-06", "75.0000", "Austin"], ["2026-01-07", "75.0000", "Austin"], ["2026-01-08", "95.0000", "Dallas"],
    ]);
  });

  it("leaves a company with no places exactly as it was", async () => {
    await payExtras.set(owner(), { perDiemRate: "75" });
    expect(await record({ jobId: job.dallas, from: "2026-01-06", to: "2026-01-06" })).toEqual({ recorded: ["2026-01-06"], alreadyHad: [], rate: "75.00" });
    const [day] = await expenses.listPerDiem(office(), {});
    expect(day).toMatchObject({ placeName: null, amount: "75.0000" });
    await payExtras.set(owner(), { perDiemRate: null });
    await expect(record({ from: "2026-01-07", to: "2026-01-07" })).rejects.toThrow(/No per diem rate is set/);
  });

  it("lists the places in use for whoever records the days, and not the retired ones", async () => {
    await place("Austin", "75", { city: "Austin" });
    const gone = await place("Gone", "75");
    await payExtras.retirePerDiemPlace(owner(), { id: gone.id });
    expect((await expenses.list(office())).perDiemPlaces).toEqual([{ id: expect.any(String), name: "Austin", state: null, city: "Austin" }]);
  });

  it("is not posted to the ledger", async () => {
    const before = (await raw`select count(*)::int as n from public.ledger_entry where organization_id = ${ORG}`)[0]!.n as number;
    await place("Austin", "75", { city: "Austin" });
    await record({ from: "2026-01-06", to: "2026-01-07" });
    expect((await raw`select count(*)::int as n from public.ledger_entry where organization_id = ${ORG}`)[0]!.n).toBe(before);
  });
});

run("the routes", () => {
  it("declare the permissions the services demand", () => {
    expect(routes.addPerDiemPlace.permissions).toEqual(["payroll:configure"]);
    expect(routes.addPerDiemPlaceRate.permissions).toEqual(["payroll:configure"]);
    expect(routes.removePerDiemPlaceRate.permissions).toEqual(["payroll:configure"]);
    expect(routes.retirePerDiemPlace.permissions).toEqual(["payroll:configure"]);
    expect(routes.recordPerDiem.permissions).toEqual(["expense:approve"]);
  });
});
