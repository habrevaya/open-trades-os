import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { PermissionError } from "@opentradesos/core";
import * as priceBook from "../src/services/pricebook";
import { NotFoundError, ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * The price book, against a real database.
 *
 * One rule carries the whole file: editing an item creates a new version and
 * never mutates the old one. Documents point at the version, so a price rise
 * must leave every invoice already sent saying what it said. The tests below
 * are mostly different ways of checking that the old row survived.
 */
const url = process.env.DATABASE_URL;

if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}

const run = url ? describe : describe.skip;

const ORG_A = fixtureId("pricebook:org-a");
const ORG_B = fixtureId("pricebook:org-b");
const USER_A = fixtureId("pricebook:user-a");
const USER_B = fixtureId("pricebook:user-b");

let raw: postgres.Sql;
const db = () => testDb(url!);

const ctxFor = (
  organizationId: string, userId: string, roles: Actor["roles"],
  extra: Partial<ServiceContext> = {},
): ServiceContext => ({
  actor: { userId, organizationId, roles },
  db: db(),
  ...extra,
});

const owner = () => ctxFor(ORG_A, USER_A, ["owner"]);
let n = 0;
const code = (prefix: string) => `${prefix}-${(n += 1)}`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG_A, userId: USER_A, name: "Book Co", slug: "book-pb" });
  await seedOrg(raw, { organizationId: ORG_B, userId: USER_B, name: "Other Book", slug: "other-pb" });
});

afterAll(async () => { if (raw) await raw.end(); });

run("permissions and redaction", () => {
  it("refuses a read to a role without pricebook:read", async () => {
    await expect(priceBook.list(ctxFor(ORG_A, USER_A, []), { limit: 10, includeInactive: false }))
      .rejects.toThrow(PermissionError);
  });

  it("refuses authoring to a technician", async () => {
    await expect(priceBook.create(ctxFor(ORG_A, USER_A, ["technician"]), {
      kind: "service", code: code("NOPE"), name: "Nope", price: "100.00", taxable: true,
    })).rejects.toThrow(PermissionError);
  });

  it("hides cost and margin from a technician, and leaves the price", async () => {
    const created = await priceBook.create(owner(), {
      kind: "service", code: code("TUNE"), name: "Tune up",
      price: "218.00", cost: "76.30", taxable: true,
    });

    const asTech = await priceBook.list(ctxFor(ORG_A, USER_A, ["technician"]), {
      limit: 50, includeInactive: false, q: created.code,
    });
    const row = asTech.data.find((r) => r.id === created.id);
    expect(row?.price).toBe("218.0000");
    // Absent, not null. A null reads as "no cost recorded", which is a
    // different fact from "you may not know".
    expect(row && "cost" in row).toBe(false);
    // And margin has to go with it, or the cost is one division away.
    expect(row && "margin" in row).toBe(false);
  });

  it("shows cost and a derived margin to an owner", async () => {
    const created = await priceBook.create(owner(), {
      kind: "material", code: code("CAP"), name: "Capacitor",
      price: "100.00", cost: "40.00", taxable: true,
    });
    expect(created.cost).toBe("40.0000");
    expect(created.margin).toBe("0.6000");
  });

  it("reports no margin rather than a wrong one when cost is absent", async () => {
    const created = await priceBook.create(owner(), {
      kind: "service", code: code("NOCOST"), name: "No cost recorded",
      price: "100.00", taxable: true,
    });
    expect(created.cost).toBeNull();
    expect(created.margin).toBeNull();
  });
});

run("creating", () => {
  it("starts at version 1", async () => {
    const created = await priceBook.create(owner(), {
      kind: "service", code: code("V"), name: "First", price: "10.00", taxable: true,
    });
    expect(created.version).toBe(1);
    expect(created.active).toBe(true);
  });

  it("refuses a duplicate code rather than shadowing the original", async () => {
    const c = code("DUP");
    await priceBook.create(owner(), { kind: "service", code: c, name: "One", price: "10.00", taxable: true });
    await expect(priceBook.create(owner(), {
      kind: "service", code: c, name: "Two", price: "20.00", taxable: true,
    })).rejects.toThrow(ConflictError);
  });

  it("is idempotent on a retry", async () => {
    const key = `pb-${Date.now()}`;
    const input = { kind: "service" as const, code: code("IDEM"), name: "Retry", price: "10.00", taxable: true };
    const first = await priceBook.create({ ...owner(), idempotencyKey: key }, input);
    const second = await priceBook.create({ ...owner(), idempotencyKey: key }, input);
    expect(second.id).toBe(first.id);
  });
});

run("revising", () => {
  it("creates a new version and leaves the old row intact", async () => {
    // The whole point of the table. An invoice priced at 218 must still say
    // 218 after the price goes to 240.
    const created = await priceBook.create(owner(), {
      kind: "service", code: code("RISE"), name: "Diagnostic", price: "218.00", taxable: true,
    });

    const revised = await priceBook.revise(owner(), { id: created.id, price: "240.00" });

    expect(revised.id).toBe(created.id);
    expect(revised.version).toBe(2);
    expect(revised.versionId).not.toBe(created.versionId);
    expect(revised.price).toBe("240.0000");

    const old = await raw`
      select price, effective_to from public.price_book_item_version
      where id = ${created.versionId}`;
    expect(old[0]?.["price"]).toBe("218.0000");
    expect(old[0]?.["effective_to"]).toBeTruthy();
  });

  it("carries every field forward that the revision did not change", async () => {
    // A revision that only raises the price must not blank the description.
    const created = await priceBook.create(owner(), {
      kind: "service", code: code("CARRY"), name: "Full service",
      description: "Two system tune up, filters included",
      price: "300.00", cost: "120.00", laborMinutes: 90, warrantyMonths: 12, taxable: true,
    });

    const revised = await priceBook.revise(owner(), { id: created.id, price: "320.00" });

    expect(revised.name).toBe("Full service");
    expect(revised.description).toBe("Two system tune up, filters included");
    expect(revised.laborMinutes).toBe(90);
    expect(revised.warrantyMonths).toBe(12);
    expect(revised.cost).toBe("120.0000");
  });

  it("leaves exactly one current version after several revisions", async () => {
    // Two rows with no end date means "the price" depends on row order.
    const created = await priceBook.create(owner(), {
      kind: "service", code: code("MANY"), name: "Revised often", price: "10.00", taxable: true,
    });
    for (const price of ["20.00", "30.00", "40.00"]) {
      await priceBook.revise(owner(), { id: created.id, price });
    }

    const current = await raw`
      select count(*)::int as n from public.price_book_item_version
      where item_id = ${created.id} and effective_to is null`;
    expect(current[0]?.["n"]).toBe(1);

    const all = await raw`
      select count(*)::int as n from public.price_book_item_version where item_id = ${created.id}`;
    expect(all[0]?.["n"]).toBe(4);
  });

  it("closes the old window exactly where the new one opens, with no gap", async () => {
    // A gap means a document priced in that window finds no version at all.
    const created = await priceBook.create(owner(), {
      kind: "service", code: code("GAP"), name: "Continuous", price: "10.00", taxable: true,
    });
    await priceBook.revise(owner(), { id: created.id, price: "11.00" });

    const rows = await raw`
      select effective_from, effective_to from public.price_book_item_version
      where item_id = ${created.id} order by version`;
    expect(rows).toHaveLength(2);
    expect(String(rows[0]?.["effective_to"])).toBe(String(rows[1]?.["effective_from"]));
  });

  it("reports a missing item rather than creating one", async () => {
    await expect(priceBook.revise(owner(), { id: fixtureId("pricebook:ghost"), price: "1.00" }))
      .rejects.toThrow(NotFoundError);
  });
});

run("listing", () => {
  it("finds an item by code, name or description", async () => {
    const c = code("FINDME");
    await priceBook.create(owner(), {
      kind: "material", code: c, name: "Blower wheel assembly",
      description: "Squirrel cage, direct drive", price: "180.00", taxable: true,
    });

    for (const q of [c, "Blower wheel", "Squirrel"]) {
      const page = await priceBook.list(owner(), { limit: 50, includeInactive: false, q });
      expect(page.data.some((r) => r.code === c), `q=${q}`).toBe(true);
    }
  });

  it("returns the current version's name after a rename, not the original", async () => {
    const created = await priceBook.create(owner(), {
      kind: "service", code: code("RENAME"), name: "Old name", price: "10.00", taxable: true,
    });
    await priceBook.revise(owner(), { id: created.id, name: "New name" });

    const page = await priceBook.list(owner(), { limit: 50, includeInactive: false, q: created.code });
    const row = page.data.find((r) => r.id === created.id);
    expect(row?.name).toBe("New name");
    // And exactly once, rather than once per version.
    expect(page.data.filter((r) => r.id === created.id)).toHaveLength(1);
  });

  it("hides a discontinued item by default and returns it when asked", async () => {
    const created = await priceBook.create(owner(), {
      kind: "material", code: code("GONE"), name: "Discontinued part", price: "5.00", taxable: true,
    });
    await raw`update public.price_book_item set active = false where id = ${created.id}`;

    const hidden = await priceBook.list(owner(), { limit: 50, includeInactive: false, q: created.code });
    expect(hidden.data.some((r) => r.id === created.id)).toBe(false);

    const shown = await priceBook.list(owner(), { limit: 50, includeInactive: true, q: created.code });
    expect(shown.data.some((r) => r.id === created.id)).toBe(true);
  });

  it("filters by kind", async () => {
    const c = code("KIND");
    await priceBook.create(owner(), { kind: "fee", code: c, name: "Trip fee", price: "89.00", taxable: false });
    const fees = await priceBook.list(owner(), { limit: 50, includeInactive: false, kind: "fee", q: c });
    expect(fees.data.every((r) => r.kind === "fee")).toBe(true);
    const services = await priceBook.list(owner(), { limit: 50, includeInactive: false, kind: "service", q: c });
    expect(services.data).toHaveLength(0);
  });
});

run("the tenant boundary", () => {
  it("does not show one company's prices to another", async () => {
    const created = await priceBook.create(owner(), {
      kind: "service", code: code("SECRET"), name: "Our price", price: "999.00", taxable: true,
    });
    const theirs = await priceBook.list(ctxFor(ORG_B, USER_B, ["owner"]), {
      limit: 100, includeInactive: true, q: created.code,
    });
    expect(theirs.data).toHaveLength(0);
  });

  it("reports another company's item as missing when revising it", async () => {
    const mine = await priceBook.create(owner(), {
      kind: "service", code: code("MINE"), name: "Mine", price: "10.00", taxable: true,
    });
    await expect(
      priceBook.revise(ctxFor(ORG_B, USER_B, ["owner"]), { id: mine.id, price: "1.00" }),
    ).rejects.toThrow(NotFoundError);
  });
});
