import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as layout from "../src/services/portal-layout";
import * as portal from "../src/services/portal";
import * as portalAccount from "../src/services/portal-account";
import { inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * A READING IN A NARROW BAND IS DRAWN FROM THE DATA WHEN THE TRADE SAYS SO
 *
 * The readings block's `narrow` setting names the readings whose chart starts
 * at the data; every other reading, and any block that does not say, stays
 * from zero. Rearranging the page in the layout editor keeps the setting.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("portal-readings-scale:org");
const USER = fixtureId("portal-readings-scale:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Pressure Plumbing", slug: "reading-scale-air" });
  const [l] = await raw<{ id: string }[]>`insert into public.portal_layout (organization_id, name, is_default)
    values (${ORG}, 'Plumbing', true) returning id`;
  await raw`insert into public.portal_block (organization_id, layout_id, kind, title, sort_order, config)
    values (${ORG}, ${l!.id}, 'readings_trend', 'Water over time', 0,
            ${raw.json({ keys: ["static_pressure", "water_hardness"], narrow: ["static_pressure"] } as never)})`;
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

async function aCustomerWithReadings(name: string) {
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, ${name}) returning id`;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '3 Gauge Way', 'Austin', 'TX', '78701') returning id`;
  const [job] = await raw<{ id: string }[]>`insert into public.job
    (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${Math.floor(Math.random() * 1e8)}, ${c!.id}, ${p!.id}, 'completed', 'Pressure check') returning id`;
  const [visit] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, window_start, window_end)
    values (${ORG}, ${job!.id}, 'completed', now() - interval '1 day', now() - interval '20 hours') returning id`;
  const [report] = await raw<{ id: string }[]>`insert into public.service_report
    (organization_id, visit_id, job_id, customer_id, property_id, summary, submitted_at, published_at)
    values (${ORG}, ${visit!.id}, ${job!.id}, ${c!.id}, ${p!.id}, 'Checked', now(), now()) returning id`;
  for (const [day, pressure, hardness] of [[30, "58", "9"], [20, "62", "9"], [10, "60", "10"]] as const) {
    await raw`insert into public.service_report_field
      (organization_id, report_id, property_id, key, label, kind, unit, value_numeric, customer_visible, recorded_at)
      values (${ORG}, ${report!.id}, ${p!.id}, 'static_pressure', 'Static pressure', 'numeric', 'psi', ${pressure}, true, now() - ${day + " days"}::interval),
             (${ORG}, ${report!.id}, ${p!.id}, 'water_hardness', 'Water hardness', 'numeric', 'gpg', ${hardness}, true, now() - ${day + " days"}::interval)`;
  }
  const link = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
    organizationId: ORG, customerId: c!.id, scope: "customer", expiresInDays: 30,
  }));
  return link.token;
}

run("a reading drawn from the data", () => {
  it("is marked for the readings the block names, and only those", async () => {
    const token = await aCustomerWithReadings("Pru Pressure");
    const { extras } = await portalAccount.viewAccount(db(), { token });
    const byKey = new Map(extras.readings.map((r) => [r.key, r]));
    expect(byKey.get("static_pressure")).toMatchObject({ fromData: true, unit: "psi" });
    expect(byKey.get("static_pressure")!.points).toHaveLength(3);
    expect(byKey.get("water_hardness")).toMatchObject({ fromData: false });
  });

  it("keeps the setting when the office rearranges the page", async () => {
    const seen = await layout.get(owner());
    const rows = seen.blocks.map((b) => ({ kind: b.kind, title: b.customTitle ?? null, visible: b.visible }));
    await layout.set(owner(), { blocks: [...rows].reverse() });
    const token = await aCustomerWithReadings("Rae Rearranged");
    const { extras } = await portalAccount.viewAccount(db(), { token });
    expect(extras.readings.find((r) => r.key === "static_pressure")).toMatchObject({ fromData: true });
    expect(extras.readings.find((r) => r.key === "water_hardness")).toMatchObject({ fromData: false });
  });
});
