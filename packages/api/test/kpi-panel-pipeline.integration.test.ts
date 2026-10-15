import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { reporting, type Actor } from "@opentradesos/core";
import { packById } from "@opentradesos/trade-packs";
import * as kpis from "../src/services/kpis";
import * as equipment from "../src/services/equipment";
import * as fieldOps from "../src/services/field";
import { PANEL_CATEGORIES, PANEL_RATINGS } from "../src/services/kpi-catalogue";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * PANEL UPGRADE PIPELINE, AND THE TYPED DETAILS IT WAITED ON
 *
 * The electrical pack's "total value of declined panel and service upgrade
 * recommendations on panels recorded as full, flagged as a known concern, or
 * rated below 100 amps, counting only properties still on the customer list".
 * The pack declares a service panel's rating, open spaces and known concern
 * with their kinds; the register now holds a unit's details to that
 * declaration, so the figure reads values rather than guessing at words.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("kpi-panel:org");
const USER = fixtureId("kpi-panel:user");
const WINDOW = { from: "2026-06-01", to: "2026-06-30" };

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const tech = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["technician"] as Actor["roles"] }, db: db(),
});

let customerId = "";
let onList = "";
let leftList = "";

/** A unit written as the register holds it, with whatever details it was given. */
async function unit(tag: string, attributes: Record<string, unknown>, opts: { property?: string; category?: string; active?: boolean } = {}): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.equipment (organization_id, property_id, tag, category, attributes, active)
    values (${ORG}, ${opts.property ?? onList}, ${tag}, ${opts.category ?? "service-panel"}, ${raw.json(attributes as postgres.JSONValue)},
            ${opts.active ?? true})
    returning id`;
  return row!.id;
}

async function recommendation(equipmentId: string, amount: string | null, declinedOn: string | null, property = onList): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.deficiency (organization_id, property_id, customer_id, equipment_id, description, quoted_amount, declined_on)
    values (${ORG}, ${property}, ${customerId}, ${equipmentId}, 'Upgrade the panel', ${amount}, ${declinedOn}) returning id`;
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
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Panel Co", slug: "kpi-panel-co" });
  await raw`update public.organization set primary_trade = 'electrical' where id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Homeowner', 0) returning id`;
  customerId = customer!.id;
  const [a] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '1 Volt', 'Austin', 'TX', '78704') returning id`;
  const [b] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '2 Volt', 'Austin', 'TX', '78704') returning id`;
  onList = a!.id;
  leftList = b!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customerId}, ${onList})`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id, ended_on)
            values (${ORG}, ${customerId}, ${leftList}, '2026-05-01')`;
});

/**
 * The month, by hand.
 *
 *   U1  full (no open spaces), declined at 1,200                      in
 *   U2  "Service panel" by name, a known problem, declined at 2,290    in
 *   U3  rated 60 amps, declined at 2,890                              in
 *   U4  200 amps, six open, no concern, declined at 1,500             out: nothing wrong with it
 *   U5  "100A" typed before the register checked, declined at 999    not known, counted beside
 *   U6  full, declined in July                                        another month
 *   U7  a known problem at an address the customer left               not on the customer list
 *   U8  full, taken off the register                                  not live
 *   U9  a furnace flagged as a known problem                          not a panel
 *   U1  again: one still open, one declined with no price             not declined, not valued
 *
 *   2,890 + 2,290 + 1,200 = 6,380 over three recommendations; one more not known.
 */
async function month(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  const u1 = await unit("U1", { service_amps: "200", spaces_open: 0 });
  ids.U1 = await recommendation(u1, "1200", "2026-06-05");
  await recommendation(u1, "800", null);
  await recommendation(u1, null, "2026-06-06");
  ids.U2 = await recommendation(await unit("U2", { known_concern: true }, { category: "Service panel" }), "2290", "2026-06-10");
  ids.U3 = await recommendation(await unit("U3", { service_amps: "60" }), "2890", "2026-06-11");
  ids.U4 = await recommendation(await unit("U4", { service_amps: "200", spaces_open: 6, known_concern: false }), "1500", "2026-06-12");
  ids.U5 = await recommendation(await unit("U5", { service_amps: "100A" }), "999", "2026-06-13");
  ids.U6 = await recommendation(await unit("U6", { spaces_open: 0 }), "700", "2026-07-02");
  ids.U7 = await recommendation(await unit("U7", { known_concern: true }, { property: leftList }), "1800", "2026-06-14", leftList);
  ids.U8 = await recommendation(await unit("U8", { spaces_open: 0 }, { active: false }), "1100", "2026-06-15");
  ids.U9 = await recommendation(await unit("U9", { known_concern: true }, { category: "furnace" }), "4000", "2026-06-16");
  return ids;
}

const figure = async () => (await kpis.scorecard(owner(), WINDOW)).computed.find((k) => k.key === "panel_pipeline")!;

run("panel upgrade pipeline", () => {
  it("totals declined recommendations on full, problem and under 100 amp panels still on the customer list", async () => {
    const ids = await month();
    const kpi = await figure();
    expect([kpi.value, kpi.numerator, kpi.denominator]).toEqual(["6380.0000", "6380.0000", "3"]);
    expect(kpi.besides).toEqual([expect.objectContaining({ key: "unknown", count: "1" })]);

    const name = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id;
    const value = await kpis.drill(owner(), { key: "panel_pipeline", half: "numerator", ...WINDOW });
    expect(value.records.map((r) => name(r.id)).sort()).toEqual(["U1", "U2", "U3"]);
    expect(value.records.every((r) => r.href.startsWith("/equipment/"))).toBe(true);
    const unknown = await kpis.drill(owner(), { key: "panel_pipeline", half: "unknown", ...WINDOW });
    expect(unknown.records.map((r) => name(r.id))).toEqual(["U5"]);
  });

  it("puts the same panels through core's rule and gets the same answer", async () => {
    await month();
    const rows = await raw<{ id: string; attributes: Record<string, unknown> }[]>`
      select d.id, e.attributes from public.deficiency d join public.equipment e on e.id = d.equipment_id
      where d.organization_id = ${ORG} and d.declined_on between '2026-06-01' and '2026-06-30' and d.quoted_amount is not null
        and e.active and lower(e.category) = any(${PANEL_CATEGORIES}) and e.property_id = ${onList}`;
    const pick = (verdict: string) => rows.filter((r) => reporting.panelQualifies(r.attributes, PANEL_RATINGS) === verdict).map((r) => r.id).sort();
    const drilled = async (half: "numerator" | "unknown") =>
      (await kpis.drill(owner(), { key: "panel_pipeline", half, ...WINDOW })).records.map((r) => r.id).sort();
    expect(await drilled("numerator")).toEqual(pick("in"));
    expect(await drilled("unknown")).toEqual(pick("unknown"));
  });

  it("reads the panel the electrical pack declares, so a pack that stopped declaring it would fail here", () => {
    const panel = packById("electrical")!.equipmentCategories.find((c) => c.code === "service-panel")!;
    expect(PANEL_CATEGORIES).toEqual(["service-panel", "service panel"]);
    expect(PANEL_RATINGS.filter((r) => Number(r) < 100)).toEqual(["60"]);
    expect(panel.attributes.map((a) => [a.key, a.kind])).toEqual(expect.arrayContaining([
      ["service_amps", "select"], ["spaces_open", "numeric"], ["known_concern", "boolean"],
    ]));
  });
});

run("a panel's details held to what the pack declares", () => {
  it("stores them as their kinds from the office, by key or label, and refuses one that is not, naming it", async () => {
    const made = await equipment.register(owner(), {
      propertyId: onList, category: "service-panel",
      attributes: { "Service rating, amps": "100", spaces_open: "0", known_concern: "Yes", "Breaker brand": "Zinsco" },
    });
    expect(made.attributes).toEqual({ service_amps: "100", spaces_open: 0, known_concern: true, "Breaker brand": "Zinsco" });

    const refused = await equipment.register(owner(), {
      propertyId: onList, category: "service-panel", attributes: { service_amps: "100A", spaces_open: "four" },
    }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConflictError);
    expect((refused as Error).message).toBe(
      'Service rating, amps is one of 60, 100, 125, 150, 200, 320, 400. "100A" is not one of them. Open spaces is a number. "four" is not one.',
    );

    await expect(equipment.update(owner(), { id: made.id, attributes: { known_concern: "perhaps" } }))
      .rejects.toThrow(/is yes or no/);
    /** A furnace's details are the furnace's: the electrical pack declares nothing for it. */
    const furnace = await equipment.register(owner(), { propertyId: onList, category: "furnace", attributes: { spaces_open: "lots" } });
    expect(furnace.attributes).toEqual({ spaces_open: "lots" });
  });

  it("lets an old unit be edited without retyping words it held before the register checked them", async () => {
    const old = await unit("Old", { service_amps: "100A" });
    const edited = await equipment.update(owner(), { id: old, serialNumber: "SN-1" });
    expect(edited.attributes).toEqual({ service_amps: "100A" });
  });

  it("keeps the phone's words rather than refusing them, and types what it can", async () => {
    const [membership] = await raw<{ id: string }[]>`select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
    await raw`insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${membership!.id}, 'Ray')`;
    const { deviceId } = await fieldOps.register(tech(), { installationId: `install-${crypto.randomUUID()}` });
    const result = await fieldOps.sync(tech(), {
      deviceId,
      operations: [{
        clientId: crypto.randomUUID(), sequence: 1, kind: "equipment.record", occurredAt: new Date().toISOString(),
        payload: { propertyId: onList, category: "service-panel", attributes: { service_amps: "60", spaces_open: "none", known_concern: "no" } },
      }],
    });
    expect(result.results[0]!.status).toBe("applied");
    const [row] = await raw<{ attributes: Record<string, unknown> }[]>`
      select attributes from public.equipment where organization_id = ${ORG} and created_at > now() - interval '1 minute'
      order by created_at desc limit 1`;
    expect(row!.attributes).toEqual({ service_amps: "60", spaces_open: "none", known_concern: false });
  });
});
