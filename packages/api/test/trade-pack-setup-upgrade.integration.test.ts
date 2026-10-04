import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { packById, type TradePack } from "@opentradesos/trade-packs";
import { applyTradePack, previewUpgradeTo, upgradeTo } from "../src/services/trade-pack";
import { updatePolicy } from "../src/services/retention";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A NEWER PACK OVER THE REST OF WHAT THE OLD ONE SET UP
 *
 * A pack seeds a service report template, inspection programmes, retention
 * rules and a portal layout beside its price book, and version two can fix
 * any of them. The promise is the price book's: what nobody here touched
 * takes the new version, and what the company changed, removed or made
 * itself is left exactly as it is. Two more ways to be the company's are
 * checked here because they are the dangerous ones: a piece the company
 * took out is not put back, and a retention rule it allowed to purge is
 * never shortened, because that would be records deleted sooner than
 * anybody agreed to.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("pack-setup:org");
const OWNER = fixtureId("pack-setup:owner");
const GONE_ORG = fixtureId("pack-setup:gone-org");
const GONE_OWNER = fixtureId("pack-setup:gone-owner");
const OLD_ORG = fixtureId("pack-setup:old-org");
const OLD_OWNER = fixtureId("pack-setup:old-owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (org = ORG, user = OWNER): ServiceContext => ({
  actor: { userId: user, organizationId: org, roles: ["owner"] as Actor["roles"] }, db: db(),
});

const v1 = packById("hvac")!;
const PROGRAM = v1.inspectionPrograms[0]!.name;

/** Version two: a reading's range fixed, a portal section added, a programme added, two rules changed, one rule new. */
const v2: TradePack = {
  ...v1,
  version: v1.version + 1,
  readings: v1.readings.map((r, i) => (i === 0 ? { ...r, min: -10, max: 140 } : r)),
  inspectionPrograms: [
    ...v1.inspectionPrograms.map((p) => ({ ...p, frequencyMonths: 12 })),
    {
      code: "duct", name: "Duct leakage test", reportAudience: "customer", frequencyMonths: 24,
      checkpoints: [{ key: "leakage", label: "Total leakage (CFM25)", requiresReading: true, unit: "CFM" }],
    },
  ],
  retention: [
    ...v1.retention.map((rule) => ({ ...rule, retainMonths: rule.retainMonths - 6 })),
    { entityType: "invoice", clockStart: "calendar_year_end", retainMonths: 84, basis: "Tax records" },
  ],
  portalBlocks: [...v1.portalBlocks, { kind: "referral", title: "Tell a neighbour", config: {} }],
} as TradePack;

const ruleOf = async (org: string, entityType: string, entityKind: string | null) => (await raw<{
  id: string; retain_months: number; purge_allowed: boolean; trade_pack_id: string | null;
}[]>`select id, retain_months, purge_allowed, trade_pack_id from public.retention_policy
  where organization_id = ${org} and entity_type = ${entityType}
    and entity_kind is not distinct from ${entityKind}`);

/**
 * A revision of the programme, as `reviseProgram` writes one: the standard
 * changed, a new version, saved now. By hand rather than through the
 * service, because the service checks every checkpoint again on a revision
 * and the HVAC pack's own cooling checkpoint asks for a reading with no
 * range, which it refuses; that is the pack's to fix, and not what this
 * file is about.
 */
async function revisedByHand(org: string) {
  await raw`update public.inspection_program
    set standard = 'Our own standard', version = version + 1, updated_at = now() + interval '1 second'
    where organization_id = ${org} and name = ${PROGRAM}`;
}

const templateOf = async (org: string) => (await raw<{
  id: string; version: number; trade_pack_id: string; fields: { key: string; min?: number; max?: number }[];
}[]>`select id, version, trade_pack_id, fields from public.service_report_template where organization_id = ${org}`);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Setup Air", slug: "pack-setup-air" });
  await seedOrg(raw, { organizationId: GONE_ORG, userId: GONE_OWNER, name: "Gone Air", slug: "pack-setup-gone" });
  await seedOrg(raw, { organizationId: OLD_ORG, userId: OLD_OWNER, name: "Old Air", slug: "pack-setup-old" });
  await applyTradePack(as(), "hvac");

  // The owner revises the programme and keeps one rule longer than the pack said.
  await revisedByHand(ORG);
  const [first, second] = v1.retention;
  await updatePolicy(as(), { id: (await ruleOf(ORG, first!.entityType, first!.entityKind ?? null))[0]!.id, retainMonths: 120 });
  // And switches purging on for the other, at the pack's own period.
  await updatePolicy(as(), { id: (await ruleOf(ORG, second!.entityType, second!.entityKind ?? null))[0]!.id, purgeAllowed: true });
  // And keeps its own rule for invoices, made by hand before any pack had one.
  await raw`insert into public.retention_policy (organization_id, name, entity_type, clock_start, retain_months)
            values (${ORG}, 'Our invoices', 'invoice', 'calendar_year_end', 120)`;
});

afterAll(async () => { if (raw) await raw.end(); });

run("previewing version two of the rest of the pack", () => {
  it("updates what nobody touched, adds what is new, and keeps everything that is the company's, saying why", async () => {
    const { setup } = await previewUpgradeTo(as(), v2);
    expect(setup.update.map((u) => [u.kind, u.changed])).toEqual([
      ["service_report", ["fields"]],
      ["portal_layout", ["blocks"]],
    ]);
    expect(setup.add).toEqual([{ kind: "inspection_program", key: "Duct leakage test", name: "Duct leakage test" }]);
    const kept = Object.fromEntries(setup.kept.map((k) => [`${k.kind}:${k.key}`, k]));
    expect(kept[`inspection_program:${PROGRAM}`]).toMatchObject({ reason: "edited", changed: ["frequencyMonths", "standard"] });
    const [first, second] = v1.retention;
    expect(kept[`retention_rule:${first!.entityType}:${first!.entityKind ?? ""}`]).toMatchObject({ reason: "edited", changed: ["retainMonths"] });
    expect(kept[`retention_rule:${second!.entityType}:${second!.entityKind ?? ""}`]).toMatchObject({ reason: "purging" });
    expect(kept["retention_rule:invoice:"]).toMatchObject({ reason: "yours" });
    expect(setup.dropped).toEqual([]);
  });
});

run("upgrading the rest of the pack", () => {
  it("writes the plan, and never touches what the company changed, chose or made", async () => {
    const before = await raw<{ id: string; checkpoints: unknown[]; version: number }[]>`
      select id, checkpoints, version from public.inspection_program where organization_id = ${ORG} and name = ${PROGRAM}`;
    const result = await upgradeTo(as(), v2);
    expect(result.setup).toEqual({ added: 1, updated: 2, kept: 4, dropped: 0 });

    // The template takes the fixed range as a new version, so a report captured under the old one still says which.
    const [template] = await templateOf(ORG);
    expect(template!.version).toBe(2);
    expect(template!.trade_pack_id).toBe("hvac@2");
    expect(template!.fields[0]).toMatchObject({ min: -10, max: 140 });

    // The programme the owner revised is exactly as the owner left it.
    const after = await raw<{ checkpoints: unknown[]; version: number; frequency_months: number; trade_pack_id: string }[]>`
      select checkpoints, version, frequency_months, trade_pack_id from public.inspection_program
      where organization_id = ${ORG} and name = ${PROGRAM}`;
    expect(after[0]!.checkpoints).toEqual(before[0]!.checkpoints);
    expect(after[0]!.version).toBe(before[0]!.version);
    expect(after[0]!.trade_pack_id).toBe("hvac@1");
    const [added] = await raw`select trade_pack_id from public.inspection_program where organization_id = ${ORG} and name = 'Duct leakage test'`;
    expect(added!["trade_pack_id"]).toBe("hvac@2");

    // The longer period stands, the purging rule is not shortened, and the hand made invoice rule is the only one.
    const [first, second] = v1.retention;
    expect((await ruleOf(ORG, first!.entityType, first!.entityKind ?? null))[0]!.retain_months).toBe(120);
    expect((await ruleOf(ORG, second!.entityType, second!.entityKind ?? null))[0])
      .toMatchObject({ retain_months: second!.retainMonths, purge_allowed: true, trade_pack_id: "hvac@1" });
    const invoices = await ruleOf(ORG, "invoice", null);
    expect(invoices.map((r) => r.retain_months)).toEqual([120]);

    // The portal has the new section, and is still the default.
    const [layout] = await raw<{ id: string; is_default: boolean; trade_pack_id: string }[]>`
      select id, is_default, trade_pack_id from public.portal_layout where organization_id = ${ORG}`;
    expect(layout).toMatchObject({ is_default: true, trade_pack_id: "hvac@2" });
    const blocks = await raw<{ kind: string }[]>`select kind from public.portal_block where layout_id = ${layout!.id} order by sort_order`;
    expect(blocks.map((b) => b.kind)).toEqual(v2.portalBlocks.map((b) => b.kind));

    // What version two set up is recorded, for version three to compare against.
    const [application] = await raw<{ seeded_setup: Record<string, unknown> }[]>`
      select seeded_setup from public.trade_pack_application where organization_id = ${ORG} and version = 2`;
    expect(Object.keys(application!.seeded_setup)).toContain("inspection_program:Duct leakage test");
  });

  it("at version three, reads what version two updated as untouched and what the company owns as still its own", async () => {
    const v3: TradePack = {
      ...v2, version: 3,
      readings: v2.readings.map((r, i) => (i === 0 ? { ...r, max: 150 } : r)),
      inspectionPrograms: v2.inspectionPrograms.map((p) => ({ ...p, standard: "ACCA 4" })),
    };
    const { setup } = await previewUpgradeTo(as(), v3);
    expect(setup.update.map((u) => `${u.kind}:${u.key}`).sort())
      .toEqual(["inspection_program:Duct leakage test", "service_report:template"]);
    expect(setup.kept.find((k) => k.key === PROGRAM)?.reason).toBe("edited");
  });
});

run("a piece the company took out", () => {
  it("is not put back by an upgrade", async () => {
    await applyTradePack(as(GONE_ORG, GONE_OWNER), "hvac");
    await raw`delete from public.service_report_template where organization_id = ${GONE_ORG}`;
    const { setup } = await previewUpgradeTo(as(GONE_ORG, GONE_OWNER), v2);
    expect(setup.kept.find((k) => k.kind === "service_report")).toMatchObject({ reason: "removed", id: null });
    expect(setup.add.some((a) => a.kind === "service_report")).toBe(false);
    await upgradeTo(as(GONE_ORG, GONE_OWNER), v2);
    expect(await templateOf(GONE_ORG)).toEqual([]);
  });
});

run("a company that applied its pack before the rest of it was recorded", () => {
  it("decides by the rows' own versions and dates, keeping anything that has been touched", async () => {
    await applyTradePack(as(OLD_ORG, OLD_OWNER), "hvac");
    await raw`update public.trade_pack_application set seeded_setup = '{}'::jsonb where organization_id = ${OLD_ORG}`;
    await revisedByHand(OLD_ORG);

    const { setup } = await previewUpgradeTo(as(OLD_ORG, OLD_OWNER), v2);
    expect(setup.kept.find((k) => k.key === PROGRAM)?.reason).toBe("edited");
    expect(setup.update.map((u) => u.kind)).toContain("service_report");
    // Untouched rules take the new period; nothing here has purging on.
    expect(setup.update.filter((u) => u.kind === "retention_rule").length).toBe(v1.retention.length);
    // There is no record of a template having been there, so nothing can read as removed.
    expect(setup.kept.some((k) => k.reason === "removed")).toBe(false);
  });
});
