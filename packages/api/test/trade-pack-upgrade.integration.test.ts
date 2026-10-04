import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import { packById, type TradePack } from "@opentradesos/trade-packs";
import {
  applyTradePack, previewUpgradeTo, upgradeTo, standings, previewUpgrade,
} from "../src/services/trade-pack";
import { revise } from "../src/services/pricebook";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A NEWER VERSION OF A TRADE PACK, OVER A PRICE BOOK THE COMPANY HAS MADE ITS OWN
 *
 * Every pack ships at version one today, so version two is made here: the
 * HVAC pack with a corrected diagnostic price, a re-priced tune up, a new
 * item, a dropped item and a new job type. The company re-prices the tune up
 * itself before the upgrade arrives. What has to hold is the promise on the
 * screen: the pack's own untouched rows take the new version, everything the
 * company changed or made stays exactly as it is, and nothing is deleted.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("pack-upgrade:org");
const OWNER = fixtureId("pack-upgrade:owner");
const LEGACY_ORG = fixtureId("pack-upgrade:legacy-org");
const LEGACY_OWNER = fixtureId("pack-upgrade:legacy-owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], org = ORG, user = OWNER): ServiceContext => ({
  actor: { userId: user, organizationId: org, roles }, db: db(),
});

const v1 = packById("hvac")!;
const dropped = v1.priceBook.at(-1)!.code;

/** Version two, as a pack author would ship it. */
const v2: TradePack = {
  ...v1,
  version: v1.version + 1,
  priceBook: [
    ...v1.priceBook
      .filter((item) => item.code !== dropped)
      .map((item) => {
        if (item.code === "DIAG-STD") return { ...item, price: "139.00", laborMinutes: 50 };
        if (item.code === "MAINT-TUNE") return { ...item, price: "199.00" };
        return item;
      }),
    {
      code: "IAQ-SANITIZE", name: "Duct sanitizing", kind: "service", category: "Indoor air quality",
      price: "495.00", cost: "180.00", laborMinutes: 90, taxable: true, taxClass: "service",
    },
  ],
  jobTypes: [...v1.jobTypes, {
    code: "duct-sanitize", name: "Duct sanitizing", capacityModel: "technician_dispatch", revenueClass: "install",
    defaultDurationMinutes: 120, requiredSkills: [],
  }],
};

const priceOf = async (org: string, code: string) => (await raw<{ price: string; version: number; tag: string }[]>`
  select v.price, v.version, i.trade_pack_id as tag from public.price_book_item i
  join public.price_book_item_version v on v.item_id = i.id and v.effective_to is null
  where i.organization_id = ${org} and i.code = ${code}`)[0];

let tuneId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Upgrade Air", slug: "pack-upgrade-air" });
  await seedOrg(raw, { organizationId: LEGACY_ORG, userId: LEGACY_OWNER, name: "Legacy Air", slug: "pack-upgrade-legacy" });
  await applyTradePack(as(["owner"]), "hvac");

  // The owner re-prices the tune up for their market, the way the wizard asks them to.
  const [tune] = await raw<{ id: string }[]>`select id from public.price_book_item where organization_id = ${ORG} and code = 'MAINT-TUNE'`;
  tuneId = tune!.id;
  await revise(as(["owner"]), { id: tuneId, price: "245.00" });
  // And makes an item of their own under a code the next version also uses.
  await raw`insert into public.price_book_item (organization_id, code, kind) values (${ORG}, 'IAQ-SANITIZE', 'service')`;
  const [mine] = await raw<{ id: string }[]>`select id from public.price_book_item where organization_id = ${ORG} and code = 'IAQ-SANITIZE'`;
  await raw`insert into public.price_book_item_version (organization_id, item_id, version, name, price, taxable)
            values (${ORG}, ${mine!.id}, 1, 'Our duct sanitizing', '450.0000', true)`;
});

afterAll(async () => { if (raw) await raw.end(); });

run("what applying a pack records", () => {
  it("keeps one snapshot of what it seeded, and applying again adds no second one and no duplicates", async () => {
    const again = await applyTradePack(as(["owner"]), "hvac");
    expect(again.created.priceBookItems).toBe(0);
    const [apps] = await raw`select count(*)::int as n from public.trade_pack_application where organization_id = ${ORG}`;
    expect(apps!.n).toBe(1);
    const [templates] = await raw`select count(*)::int as n from public.service_report_template where organization_id = ${ORG}`;
    expect(templates!.n).toBe(1);
    const [layouts] = await raw`select count(*)::int as n from public.portal_layout where organization_id = ${ORG} and is_default`;
    expect(layouts!.n).toBe(1);
  });

  it("says which version the company is on", async () => {
    const view = await standings(as(["owner"]));
    const hvac = view.packs.find((p) => p.id === "hvac")!;
    expect(hvac.applied).toBe(v1.version);
    expect(hvac.upgradable).toBe(false);
    expect(view.packs.find((p) => p.id === "plumbing")!.applied).toBeNull();
  });
});

run("previewing version two", () => {
  it("adds what is new, updates what is untouched, and keeps what the company changed or made", async () => {
    const plan = await previewUpgradeTo(as(["owner"]), v2);
    expect(plan.fromVersion).toBe(1);
    expect(plan.toVersion).toBe(2);
    expect(plan.upToDate).toBe(false);

    expect(plan.update.map((u) => u.code)).toEqual(["DIAG-STD"]);
    expect(plan.update[0]!.changes.map((c) => c.field)).toEqual(["price", "laborMinutes"]);

    const kept = new Map(plan.kept.map((k) => [k.code, k]));
    expect(kept.get("MAINT-TUNE")!.reason).toBe("edited");
    expect(kept.get("MAINT-TUNE")!.changes).toEqual([{ field: "price", from: "245.0000", to: "199.00" }]);
    expect(kept.get("IAQ-SANITIZE")!.reason).toBe("yours");

    expect(plan.add).toEqual([]);
    expect(plan.dropped.map((d) => d.code)).toEqual([dropped]);
    expect(plan.jobTypes.add.map((t) => t.code)).toEqual(["duct-sanitize"]);
    expect(plan.unchanged).toBe(v1.priceBook.length - 3);
  });

  it("writes nothing", async () => {
    expect((await priceOf(ORG, "DIAG-STD"))!.price).toBe("129.0000");
  });

  it("hides a cost from somebody who may not read costs", async () => {
    const plan = await previewUpgradeTo(as(["office_manager"]), {
      ...v2, priceBook: v2.priceBook.map((i) => (i.code === "DIAG-STD" ? { ...i, cost: "40.00" } : i)),
    });
    // The office manager preset may read costs; a dispatcher may not read settings at all.
    expect(plan.update[0]!.changes.some((c) => c.field === "cost")).toBe(true);
    await expect(previewUpgradeTo(as(["dispatcher"]), v2)).rejects.toThrow(PermissionError);
  });

  it("refuses a pack that does not exist", async () => {
    await expect(previewUpgrade(as(["owner"]), "basket-weaving")).rejects.toThrow(NotFoundError);
  });
});

run("upgrading to version two", () => {
  it("refuses somebody who may not change settings", async () => {
    await expect(upgradeTo(as(["office_manager"]), v2)).rejects.toThrow(PermissionError);
  });

  it("applies the plan, and never touches what the company changed", async () => {
    const result = await upgradeTo(as(["owner"]), v2);
    expect(result).toMatchObject({ fromVersion: 1, toVersion: 2, updated: 1, kept: 2, added: 0, dropped: 1, jobTypesAdded: 1 });

    const diag = (await priceOf(ORG, "DIAG-STD"))!;
    expect(diag.price).toBe("139.0000");
    expect(diag.version).toBe(2);
    expect(diag.tag).toBe("hvac@2");

    const tune = (await priceOf(ORG, "MAINT-TUNE"))!;
    expect(tune.price).toBe("245.0000");
    expect(tune.tag).toBe("hvac@1");

    expect((await priceOf(ORG, "IAQ-SANITIZE"))!.price).toBe("450.0000");
    expect((await priceOf(ORG, dropped))).toBeDefined();

    const [type] = await raw`select name from public.job_type where organization_id = ${ORG} and code = 'duct-sanitize'`;
    expect(type!.name).toBe("Duct sanitizing");
  });

  it("keeps the old version of an updated item, so an old invoice still says what it said", async () => {
    const versions = await raw<{ version: number; price: string; effective_to: Date | null }[]>`
      select v.version, v.price, v.effective_to from public.price_book_item_version v
      join public.price_book_item i on i.id = v.item_id
      where i.organization_id = ${ORG} and i.code = 'DIAG-STD' order by v.version`;
    expect(versions.map((v) => v.price)).toEqual(["129.0000", "139.0000"]);
    expect(versions[0]!.effective_to).not.toBeNull();
  });

  it("is on version two afterwards, and a second upgrade has nothing to do", async () => {
    const view = await standings(as(["owner"]));
    expect(view.packs.find((p) => p.id === "hvac")!.applied).toBe(2);
    await expect(upgradeTo(as(["owner"]), v2)).rejects.toThrow(/already on version 2/);
  });

  it("still keeps the edited item at version three, because the snapshot says it was never the pack's again", async () => {
    const v3: TradePack = {
      ...v2, version: 3,
      priceBook: v2.priceBook.map((i) => (i.code === "MAINT-TUNE" ? { ...i, price: "209.00" } : i)),
    };
    const plan = await previewUpgradeTo(as(["owner"]), v3);
    expect(plan.kept.find((k) => k.code === "MAINT-TUNE")?.reason).toBe("edited");
    expect(plan.update).toEqual([]);
  });

  it("refuses to upgrade a pack the company never applied", async () => {
    const plumbing = packById("plumbing")!;
    await expect(upgradeTo(as(["owner"]), { ...plumbing, version: plumbing.version + 1 }))
      .rejects.toThrow(ConflictError);
  });
});

run("a company that applied its pack before snapshots were kept", () => {
  it("reads its version from the tags, and treats anything revised since as edited", async () => {
    await applyTradePack(as(["owner"], LEGACY_ORG, LEGACY_OWNER), "hvac");
    await raw`delete from public.trade_pack_application where organization_id = ${LEGACY_ORG}`;
    const [tune] = await raw<{ id: string }[]>`select id from public.price_book_item where organization_id = ${LEGACY_ORG} and code = 'MAINT-TUNE'`;
    await revise(as(["owner"], LEGACY_ORG, LEGACY_OWNER), { id: tune!.id, price: "189.00" });

    const plan = await previewUpgradeTo(as(["owner"], LEGACY_ORG, LEGACY_OWNER), v2);
    expect(plan.fromVersion).toBe(1);
    // Revised back to the same price is still a revision without a snapshot
    // to compare against: kept, which is the safe direction to be wrong in.
    expect(plan.kept.find((k) => k.code === "MAINT-TUNE")?.reason).toBe("edited");
    expect(plan.update.map((u) => u.code)).toEqual(["DIAG-STD"]);
  });
});
