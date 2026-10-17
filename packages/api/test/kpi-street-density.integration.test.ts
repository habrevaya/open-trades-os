import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { geo, reporting, type Actor } from "@opentradesos/core";
import * as kpis from "../src/services/kpis";
import * as properties from "../src/services/properties";
import * as geocoding from "../src/services/geocoding";
import type { GeocodeRequest, GeocodingProvider } from "../src/maps/provider";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, holdWholePassLock, WHOLE_PASS_WAIT_MS } from "./helpers";

/**
 * HOMES PER SERVED STREET, AND THE STREET IT WAITED ON
 *
 * The trash bin trade's "active subscriptions divided by the number of
 * distinct streets on the route. Excludes commercial stops." It waited on a
 * street kept apart from the street line, because "12 Oak Street" and "14 Oak
 * St" are one street and two strings. A property now keeps its street: the
 * geocoder's own street component, or typed by a person, never read out of
 * the line. A home with no street recorded is out of both halves and counted
 * beside the figure.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("kpi-street:org");
const USER = fixtureId("kpi-street:user");
const WINDOW = { from: "2026-06-01", to: "2026-06-30" };
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (role: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db(),
});
const owner = () => as("owner");

let planId = "";

/** A customer, residential unless said. */
async function customer(name: string, type: "residential" | "commercial" = "residential"): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name) values (${ORG}, ${type}::customer_type, ${name}) returning id`;
  return row!.id;
}

/**
 * An address, with its street recorded as a source said it: typed, or by
 * the geocoder, for the address as it is (or, with `forAnother`, for an
 * address it used to be).
 */
async function home(line1: string, street: string | null, opts: { city?: string; source?: string; forAnother?: boolean } = {}): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, ${line1}, ${opts.city ?? "Austin"}, 'TX', '78704') returning id`;
  if (street !== null) {
    await raw`
      update public.property
         set street = ${street}, street_source = ${opts.source ?? "typed"},
             street_for_address = ${opts.forAnother ? raw.unsafe("'99 somewhere else|'") : raw.unsafe("address_key")}
       where id = ${row!.id}`;
  }
  return row!.id;
}

/** A subscription for a customer at an address, from a day, cancelled on another when given. */
async function plan(customerId: string, propertyId: string | null, startedOn: string, cancelledOn: string | null = null): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.agreement (organization_id, plan_id, customer_id, property_id, status, started_on, ends_on, price,
                                  billing_frequency, cancelled_on)
    values (${ORG}, ${planId}, ${customerId}, ${propertyId}, ${cancelledOn ? "cancelled" : "active"}::agreement_status,
            ${startedOn}, '2027-05-31', '24.0000', 'monthly', ${cancelledOn})
    returning id`;
  return row!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (raw) await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Street Co", slug: "kpi-street-co" });
  await raw`update public.organization set timezone = ${ZONE}, primary_trade = 'trash-bin-cleaning' where id = ${ORG}`;
  const [p] = await raw<{ id: string }[]>`
    insert into public.agreement_plan (organization_id, name, code, price, billing_frequency)
    values (${ORG}, 'Monthly bin', 'bin-mo', '24.0000', 'monthly') returning id`;
  planId = p!.id;
});

/**
 * The month, by hand. Active is running on June 30.
 *
 *   S1  12 Oak Street, typed "Oak Street"                          Oak Street, Austin
 *   S2  14 Oak St, the geocoder said "Oak Street"                   Oak Street, Austin
 *   S3  3 Elm Rd, typed "Elm  Road" (two spaces)                    Elm Road, Austin
 *   S4  20 Elm Road, the geocoder said "elm road"                   Elm Road, Austin
 *   S5  5 Main Street, Austin                                       Main Street, Austin
 *   S6  7 Main Street, Round Rock                                   Main Street, Round Rock
 *   S7  a commercial account on Mill Lane                           left out, commercial
 *   S8  9 Pine Ct, no street recorded                               left out, not known
 *   S9  11 Cedar Ave, a street recorded for an address it used to be  left out, not known
 *   S10 a plan with no address of its own                           left out, not known
 *   S11 Oak Street, cancelled on June 15                            not active on June 30
 *   S12 Oak Street, starting July 5                                 not active on June 30
 *
 *   Six subscriptions on four streets: 6 / 4 = 1.5 homes per street.
 */
async function month(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  const ann = await customer("Ann");
  ids.S1 = await plan(ann, await home("12 Oak Street", "Oak Street"), "2026-01-10");
  ids.S2 = await plan(await customer("Bea"), await home("14 Oak St", "Oak Street", { source: "test-geocoder" }), "2026-02-01");
  ids.S3 = await plan(await customer("Cal"), await home("3 Elm Rd", "Elm  Road"), "2026-03-01");
  ids.S4 = await plan(await customer("Dee"), await home("20 Elm Road", "elm road", { source: "test-geocoder" }), "2026-06-12");
  ids.S5 = await plan(await customer("Eve"), await home("5 Main Street", "Main Street"), "2026-04-01");
  ids.S6 = await plan(await customer("Fay"), await home("7 Main Street", "Main Street", { city: "Round Rock" }), "2026-04-01");
  ids.S7 = await plan(await customer("Mill Offices", "commercial"), await home("1 Mill Lane", "Mill Lane"), "2026-01-01");
  ids.S8 = await plan(await customer("Gus"), await home("9 Pine Ct", null), "2026-05-01");
  ids.S9 = await plan(await customer("Hal"), await home("11 Cedar Ave", "Cedar Avenue", { forAnother: true }), "2026-05-01");
  ids.S10 = await plan(await customer("Ivy"), null, "2026-05-01");
  ids.S11 = await plan(await customer("Jo"), await home("16 Oak Street", "Oak Street"), "2026-01-01", "2026-06-15");
  ids.S12 = await plan(await customer("Kit"), await home("18 Oak Street", "Oak Street"), "2026-07-05");
  return ids;
}

const figure = async () => (await kpis.scorecard(owner(), WINDOW)).computed.find((k) => k.key === "street_density")!;

run("homes per served street", () => {
  it("is active residential subscriptions over the distinct streets they are on, worked by hand", async () => {
    const ids = await month();
    const kpi = await figure();
    expect([kpi.numerator, kpi.denominator, kpi.value]).toEqual(["6", "4", "1.50"]);
    expect(kpi.besides).toEqual([
      expect.objectContaining({ key: "excluded", count: "1" }),
      expect.objectContaining({ key: "unknown", count: "3" }),
    ]);

    const name = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id;
    const counted = await kpis.drill(owner(), { key: "street_density", half: "numerator", ...WINDOW });
    expect(counted.records.map((r) => name(r.id)).sort()).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
    expect(counted.records.find((r) => name(r.id) === "S2")!.label).toBe("Monthly bin for Bea, Oak Street");

    const streets = await kpis.drill(owner(), { key: "street_density", half: "denominator", ...WINDOW });
    expect(streets.records.map((r) => r.label).sort()).toEqual([
      "Elm Road, Austin TX: 2 homes",
      "Main Street, Austin TX: 1 home",
      "Main Street, Round Rock TX: 1 home",
      "Oak Street, Austin TX: 2 homes",
    ]);
    expect(streets.records.every((r) => r.kind === "street" && /^\/properties\/[0-9a-f-]{36}$/.test(r.href))).toBe(true);
    expect(streets.total).toBe("4");

    const commercial = await kpis.drill(owner(), { key: "street_density", half: "excluded", ...WINDOW });
    expect(commercial.records.map((r) => name(r.id))).toEqual(["S7"]);
    /** A home not known opens on its address, where the street is typed. */
    const unknown = await kpis.drill(owner(), { key: "street_density", half: "unknown", ...WINDOW });
    expect(unknown.records.map((r) => name(r.id)).sort()).toEqual(["S10", "S8", "S9"]);
    expect(unknown.records.find((r) => name(r.id) === "S8")!.href).toMatch(/^\/properties\//);
    expect(unknown.records.find((r) => name(r.id) === "S10")!.href).toBe(`/agreements/${ids.S10}`);
  });

  it("puts the same plans through core's rule and gets the same answer", async () => {
    await month();
    const rows = await raw<{
      started_on: string; cancelled_on: string | null; type: string; has_address: boolean;
      address_key: string | null; street: string | null; street_source: string | null; street_for_address: string | null;
      city: string | null; state: string | null;
    }[]>`
      select a.started_on::text, a.cancelled_on::text, c.type::text, a.property_id is not null as has_address,
             p.address_key, p.street, p.street_source, p.street_for_address, p.city, p.state
      from public.agreement a
      join public.customer c on c.id = a.customer_id
      left join public.property p on p.id = a.property_id
      where a.organization_id = ${ORG}`;
    const active = rows.filter((r) => r.started_on <= WINDOW.to && (r.cancelled_on === null || r.cancelled_on > WINDOW.to));
    const verdict = reporting.streetDensityOf(active.map((r) => ({
      street: r.address_key === null ? null : geo.streetOf({
        addressKey: r.address_key, street: r.street, streetSource: r.street_source,
        streetForAddress: r.street_for_address, streetAttemptedAddress: null,
      }),
      city: r.city ?? "", state: r.state ?? "", commercial: r.type === "commercial", hasAddress: r.has_address,
    })));
    const kpi = await figure();
    expect([Number(kpi.numerator), Number(kpi.denominator)]).toEqual([verdict.subscriptions, verdict.streets]);
    expect(kpi.besides!.map((b) => Number(b.count))).toEqual([verdict.commercial, verdict.unknown]);
  });

  it("reads nothing to measure, not nought, for a company with no street recorded", async () => {
    await plan(await customer("Lone"), await home("1 Nowhere Rd", null), "2026-01-01");
    const kpi = await figure();
    expect([kpi.numerator, kpi.denominator, kpi.value]).toEqual(["0", "0", null]);
  });
});

run("the street a home is on", () => {
  it("is typed by somebody who may change the address, wins for that address, and is on the audit log", async () => {
    const id = await home("4 Birch Way", null);
    const typed = await properties.setStreet(owner(), { id, street: "  Birch   Way " });
    expect(typed).toEqual({ id, street: "Birch Way", streetSource: "typed" });
    expect(await properties.get(owner(), { id })).toMatchObject({ street: "Birch Way", streetSource: "typed" });
    const audited = await raw`select 1 from public.audit_log where organization_id = ${ORG} and entity_id = ${id} and action = 'property.street_set'`;
    expect(audited.length).toBe(1);

    /** The town's streets are offered, so the same street is picked rather than spelled again. */
    await home("6 Birch Way", "Birch Way");
    expect(await properties.streetsIn(owner(), { city: "austin", state: "tx" })).toEqual(["Birch Way"]);

    /** Taken off, it is not known and the geocoder will be asked again. */
    const cleared = await properties.setStreet(owner(), { id, street: null });
    expect(cleared).toEqual({ id, street: null, streetSource: null });
    const [row] = await raw<{ street_attempted_address: string | null }[]>`select street_attempted_address from public.property where id = ${id}`;
    expect(row!.street_attempted_address).toBeNull();

    await expect(properties.setStreet(as("technician"), { id, street: "Birch Way" })).rejects.toThrow(/property:write/);
  });

  it("is not the address's once the address changes", async () => {
    const id = await home("8 Aspen Ct", null);
    await properties.setStreet(owner(), { id, street: "Aspen Court" });
    await raw`update public.property set address_line1 = '10 Larch Ln' where id = ${id}`;
    expect(await properties.get(owner(), { id })).toMatchObject({ street: null, streetSource: null });
  });
});

/**
 * THE GEOCODER'S STREET. The worker's pass reads every company with a
 * geocoder, so this holds the whole pass lock while it runs one, and runs it
 * for this company only.
 */
run("the street from the geocoder", () => {
  it("is written from the geocoder's own parts, asked once per address, and never over a typed street", async () => {
    const release = await holdWholePassLock(url!);
    try {
      await raw`insert into public.integration_connection (organization_id, capability, provider, status)
                values (${ORG}, 'maps', 'test-geocoder', 'connected')`;
      const asked: string[] = [];
      const provider: GeocodingProvider = {
        name: "test-geocoder",
        async geocode(request: GeocodeRequest) {
          asked.push(request.address.addressLine1 ?? "");
          if (request.address.addressLine1 === "30 Willow Bend") return { kind: "found", lat: 30.25, lng: -97.75, precision: "postal_code", label: null };
          return { kind: "found", lat: 30.26, lng: -97.74, precision: "rooftop", label: "somewhere", street: "Willow Street" };
        },
      };
      const pass = () => geocoding.geocodePending(db(), { deps: { providerFor: () => provider }, limit: 50, only: [ORG] });

      /** A new address: the coordinate and the street in one answer. */
      const fresh = await home("31 Willow St", null);
      /** Located before streets were kept: asked once more, for its street alone, and its pin is not moved. */
      const [old] = await raw<{ id: string }[]>`
        insert into public.property (organization_id, address_line1, city, state, postal_code,
                                     latitude, longitude, location_precision, location_source)
        values (${ORG}, '33 Willow St', 'Austin', 'TX', '78704', '30.300000', '-97.700000', 'rooftop', 'test-geocoder')
        returning id`;
      await raw`update public.property set located_address = address_key where id = ${old!.id}`;
      /** Typed by a person for this address: never asked, never overwritten. */
      const typed = await home("35 Willow St", "Willow Street Northbound");
      /** The geocoder's parts name no street: not known, and not asked again. */
      const vague = await home("30 Willow Bend", null);
      /** A pin the office placed by hand is never sent to the geocoder, for its street or anything else. */
      const placed = await home("37 Willow St", null);
      await raw`update public.property set latitude = '30.310000', longitude = '-97.710000', location_precision = 'placed',
                       location_source = 'manual', located_address = address_key where id = ${placed}`;

      await pass();
      const [a, b, c, d] = await Promise.all([fresh, old!.id, typed, vague].map((id) => properties.get(owner(), { id })));
      expect(a).toMatchObject({ street: "Willow Street", streetSource: "test-geocoder", latitude: "30.260000" });
      expect(b).toMatchObject({ street: "Willow Street", streetSource: "test-geocoder", latitude: "30.300000" });
      expect(c).toMatchObject({ street: "Willow Street Northbound", streetSource: "typed" });
      expect(d).toMatchObject({ street: null });
      expect(await properties.get(owner(), { id: placed })).toMatchObject({ street: null, latitude: "30.310000" });
      expect(asked.sort()).toEqual(["30 Willow Bend", "31 Willow St", "33 Willow St", "35 Willow St"]);

      asked.length = 0;
      await pass();
      expect(asked).toEqual([]);
    } finally {
      await raw`delete from public.integration_connection where organization_id = ${ORG} and capability = 'maps'`;
      await release();
    }
  }, WHOLE_PASS_WAIT_MS);
});
