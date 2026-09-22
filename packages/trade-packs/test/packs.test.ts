import { describe, it, expect } from "vitest";
import { packs } from "../src/index";
import { TradePack } from "../src/schema";

/**
 * Packs are contributed by people who run shops rather than by engineers, so
 * these check the honest mistakes rather than the typos.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

describe("the registry", () => {
  /**
   * A pack file that nobody registered is a pack that silently does not
   * exist, and the author has no way to notice. Cheaper to assert than to
   * discover.
   */
  it("registers every pack file in the folder", () => {
    const files = readdirSync(join(__dirname, "..", "packs"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/, ""));
    const registered = new Set(packs.map((p) => p.id));
    for (const file of files) {
      expect(registered.has(file), `packs/${file}.ts exists but is not registered in src/index.ts`).toBe(true);
    }
  });

  it("gives every pack a unique id", () => {
    const ids = packs.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("every pack", () => {
  it("is structurally valid", () => {
    for (const pack of packs) expect(TradePack.safeParse(pack).success, pack.id).toBe(true);
  });

  it("has unique price book codes", () => {
    for (const pack of packs) {
      const codes = pack.priceBook.map((i) => i.code);
      expect(new Set(codes).size, `${pack.id} has duplicate price book codes`).toBe(codes.length);
    }
  });

  it("has unique job type codes", () => {
    for (const pack of packs) {
      const codes = pack.jobTypes.map((j) => j.code);
      expect(new Set(codes).size, `${pack.id} has duplicate job type codes`).toBe(codes.length);
    }
  });

  it("only references job types that exist", () => {
    for (const pack of packs) {
      const known = new Set(pack.jobTypes.map((j) => j.code));
      for (const list of pack.checklists) {
        for (const code of list.jobTypeCodes) {
          expect(known.has(code), `${pack.id}: checklist ${list.code} references unknown job type ${code}`).toBe(true);
        }
      }
    }
  });

  it("only nests equipment categories that exist", () => {
    for (const pack of packs) {
      const known = new Set(pack.equipmentCategories.map((c) => c.code));
      for (const cat of pack.equipmentCategories) {
        if (!cat.parentCode) continue;
        expect(known.has(cat.parentCode), `${pack.id}: ${cat.code} has unknown parent ${cat.parentCode}`).toBe(true);
      }
    }
  });

  /**
   * A pack that ships an item priced below its cost teaches a new company to
   * lose money on every one of them, which is worse than shipping no pricing.
   *
   * Zero is the deliberate exception, and the pest control pack is what
   * surfaced it: a warranty re-service is free to the customer and still costs
   * the company money. That is not a pricing error, it is the whole reason
   * coverage source exists. Those items carry real cost so agreement and
   * warranty profitability reporting works, and they must never be caught by
   * this check.
   *
   * What the check still catches is the actual mistake: an item priced above
   * zero but under its cost, which is margin quietly leaking on every sale.
   */
  it("never prices an item above zero but below its cost", () => {
    for (const pack of packs) {
      for (const item of pack.priceBook) {
        if (!item.cost) continue;
        const price = Number(item.price);
        if (price === 0) continue;
        expect(
          price >= Number(item.cost),
          `${pack.id}: ${item.code} is priced at ${item.price} against a cost of ${item.cost}`,
        ).toBe(true);
      }
    }
  });

  /**
   * The flip side: a zero priced item with a real cost is only sane if it is
   * covered by something. Flag any that carry no cost either, since those are
   * usually an unfinished row rather than a deliberate freebie.
   */
  it("gives a zero priced item either a cost or a reason to be free", () => {
    for (const pack of packs) {
      for (const item of pack.priceBook) {
        if (Number(item.price) !== 0) continue;
        const explained = item.cost != null || item.description != null || item.kind === "discount" || item.kind === "fee";
        expect(explained, `${pack.id}: ${item.code} is free with no cost and no explanation`).toBe(true);
      }
    }
  });

  it("trends only readings that can be trended", () => {
    for (const pack of packs) {
      for (const r of pack.readings) {
        if (!r.trend) continue;
        expect(
          ["numeric", "measurement", "chemical"].includes(r.kind),
          `${pack.id}: reading ${r.key} is trended but is a ${r.kind}`,
        ).toBe(true);
      }
    }
  });

  it("keeps a reading's range the right way round", () => {
    for (const pack of packs) {
      for (const r of pack.readings) {
        if (r.min == null || r.max == null) continue;
        expect(r.min < r.max, `${pack.id}: reading ${r.key} has min ${r.min} above max ${r.max}`).toBe(true);
      }
    }
  });

  it("defines every KPI precisely enough to implement", () => {
    for (const pack of packs) {
      expect(pack.kpis.length, `${pack.id} defines no KPIs`).toBeGreaterThan(0);
      for (const k of pack.kpis) {
        expect(k.definition.length, `${pack.id}: KPI ${k.key} has a thin definition`).toBeGreaterThan(30);
      }
    }
  });

  it("is honest about what it does not cover yet", () => {
    for (const pack of packs) {
      expect(pack.status, `${pack.id} should say what it does not cover yet`).toBeTruthy();
    }
  });

  it("uses a capacity model its job types agree with", () => {
    for (const pack of packs) {
      const models = new Set(pack.jobTypes.map((j) => j.capacityModel));
      expect(models.has(pack.capacityModel), `${pack.id} claims ${pack.capacityModel} but no job type uses it`).toBe(true);
    }
  });
});
