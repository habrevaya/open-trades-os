import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, time, type Actor, type Permission } from "@opentradesos/core";
import * as priceBook from "../src/services/pricebook";
import * as categories from "../src/services/price-categories";
import * as repricing from "../src/services/repricing";
import { ConflictError, NotFoundError, UnprocessableError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * THE PRICE BOOK'S SHELVES AND CHANGING MANY PRICES AT ONCE
 *
 * The rule the whole module rests on is that a price change is a new version
 * and never an edit, so these check the version rows themselves: a bulk
 * change leaves every old version saying what it said, and an undo is another
 * set of new versions rather than a deletion.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("pbb:org");
const USER = fixtureId("pbb:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
/** May change prices and may not see what anything costs. */
const blind = (): ServiceContext => ({
  actor: {
    userId: USER, organizationId: ORG, roles: [],
    grants: ["pricebook:read", "pricebook:write"] as Permission[],
  }, db: db(),
});

async function item(code: string, price: string, cost?: string, categoryId?: string): Promise<string> {
  const made = await priceBook.create(owner(), {
    kind: "service", code, name: `Item ${code}`, price, taxable: true,
    ...(cost ? { cost } : {}),
    ...(categoryId ? { categoryId } : {}),
  });
  return made.id;
}

const versions = (itemId: string) => raw<{ version: number; price: string; effective_to: Date | null }[]>`
  select version, price, effective_to from public.price_book_item_version
  where item_id = ${itemId} order by version`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Price Co", slug: "price-co" });
});

run("categories", () => {
  it("nests, lists in reading order with a depth, and counts the items on each shelf", async () => {
    const plumbing = await categories.create(owner(), { name: "Plumbing" });
    const heaters = await categories.create(owner(), { name: "Water heaters", parentId: plumbing.id });
    await categories.create(owner(), { name: "Tankless", parentId: heaters.id });
    await categories.create(owner(), { name: "Electrical" });
    await item("WH-1", "1200.00", undefined, heaters.id);

    const list = await categories.list(owner());
    expect(list.map((c) => [c.name, c.depth, c.items])).toEqual([
      ["Plumbing", 0, 0], ["Water heaters", 1, 1], ["Tankless", 2, 0], ["Electrical", 0, 0],
    ]);
  });

  it("stops at three levels, and refuses a category inside itself", async () => {
    const a = await categories.create(owner(), { name: "A" });
    const b = await categories.create(owner(), { name: "B", parentId: a.id });
    const c = await categories.create(owner(), { name: "C", parentId: b.id });
    await expect(categories.create(owner(), { name: "D", parentId: c.id })).rejects.toThrow(/3 levels/);
    await expect(categories.update(owner(), { id: a.id, parentId: c.id })).rejects.toThrow(/inside itself/);
    // Moving a two level branch under another top level shelf would make it four deep.
    const other = await categories.create(owner(), { name: "Other" });
    await expect(categories.update(owner(), { id: a.id, parentId: other.id })).rejects.toThrow(/3 levels/);
  });

  it("refuses two shelves with one name under one parent, in words", async () => {
    await categories.create(owner(), { name: "Drains" });
    await expect(categories.create(owner(), { name: "drains" })).rejects.toThrow(/already a category called/);
    // The same name under another parent is a different shelf.
    const parent = await categories.create(owner(), { name: "Commercial" });
    await expect(categories.create(owner(), { name: "Drains", parentId: parent.id })).resolves.toBeDefined();
  });

  it("renames, and moves to the end of its new siblings", async () => {
    const a = await categories.create(owner(), { name: "A" });
    const b = await categories.create(owner(), { name: "B" });
    await categories.create(owner(), { name: "A child", parentId: a.id });
    await categories.update(owner(), { id: b.id, name: "Bee", parentId: a.id });
    const list = await categories.list(owner());
    expect(list.map((c) => c.name)).toEqual(["A", "A child", "Bee"]);
  });

  it("puts a category at a position, and a retry lands in the same place", async () => {
    const one = await categories.create(owner(), { name: "One" });
    await categories.create(owner(), { name: "Two" });
    const three = await categories.create(owner(), { name: "Three" });
    await categories.place(owner(), { id: three.id, position: 0 });
    await categories.place(owner(), { id: three.id, position: 0 });
    expect((await categories.list(owner())).map((c) => c.name)).toEqual(["Three", "One", "Two"]);
    await categories.place(owner(), { id: one.id, position: 99 });
    expect((await categories.list(owner())).map((c) => c.name)).toEqual(["Three", "Two", "One"]);
  });

  it("removes only an empty category, and says what is in the way", async () => {
    const full = await categories.create(owner(), { name: "Full" });
    const id = await item("X-1", "10.00", undefined, full.id);
    await expect(categories.remove(owner(), { id: full.id })).rejects.toThrow(/still holds 1 item/);
    await categories.fileItems(owner(), { itemIds: [id], categoryId: null });
    await categories.remove(owner(), { id: full.id });
    expect(await categories.list(owner())).toEqual([]);
    // Its name is free again, because only live categories hold one.
    await expect(categories.create(owner(), { name: "Full" })).resolves.toBeDefined();
  });

  it("moves items between shelves without writing a version", async () => {
    const from = await categories.create(owner(), { name: "From" });
    const to = await categories.create(owner(), { name: "To" });
    const id = await item("MV-1", "10.00", undefined, from.id);
    expect(await categories.fileItems(owner(), { itemIds: [id], categoryId: to.id })).toEqual({ moved: 1 });
    expect(await categories.fileItems(owner(), { itemIds: [id], categoryId: to.id })).toEqual({ moved: 0 });
    expect(await versions(id)).toHaveLength(1);
    await expect(categories.fileItems(owner(), { itemIds: [id], categoryId: fixtureId("nope") }))
      .rejects.toThrow(NotFoundError);
  });

  it("needs pricebook:write to change anything", async () => {
    const reader: ServiceContext = {
      actor: { userId: USER, organizationId: ORG, roles: ["technician"] as Actor["roles"] }, db: db(),
    };
    await expect(categories.create(reader, { name: "Nope" })).rejects.toThrow(PermissionError);
  });
});

run("previewing a change", () => {
  it("shows every before and after, with margin for whoever may see cost", async () => {
    const shelf = await categories.create(owner(), { name: "Shelf" });
    await item("A-1", "218.40", "100.00", shelf.id);
    await item("A-2", "99.00", undefined, shelf.id);
    await item("B-1", "50.00");

    const out = await repricing.preview(owner(), {
      selection: { categoryId: shelf.id },
      rule: { adjust: { kind: "percent", percent: "5" }, ending: "95" },
    });
    expect(out.description).toBe("Up 5%, rounded up to the next .95");
    expect(out.changing).toBe(2);
    expect(out.lines.map((l) => [l.code, l.priceBefore, l.priceAfter])).toEqual([
      ["A-1", "218.4000", "229.9500"],
      ["A-2", "99.0000", "103.9500"],
    ]);
    expect(out.lines[0]).toMatchObject({ cost: "100.0000", marginBefore: "0.5421", marginAfter: "0.5651" });
  });

  it("leaves cost and margin off for somebody who may not see cost, and refuses them a margin rule", async () => {
    await item("A-1", "100.00", "60.00");
    const out = await repricing.preview(blind(), {
      selection: {}, rule: { adjust: { kind: "amount", amount: "10" } },
    });
    expect(out.lines[0]).not.toHaveProperty("cost");
    expect(out.lines[0]).not.toHaveProperty("marginAfter");
    await expect(repricing.preview(blind(), {
      selection: {}, rule: { adjust: { kind: "margin", margin: "0.5" } },
    })).rejects.toThrow(PermissionError);
  });

  it("says why an item will not change", async () => {
    await item("M-1", "80.00", "55.00");
    await item("M-2", "80.00");
    const out = await repricing.preview(owner(), {
      selection: {}, rule: { adjust: { kind: "margin", margin: "0.45" } },
    });
    expect(out.lines.find((l) => l.code === "M-1")).toMatchObject({ priceAfter: "100.0000", skipped: null });
    expect(out.lines.find((l) => l.code === "M-2")?.skipped).toMatch(/No cost recorded/);
  });

  it("refuses a rule that is a typo", async () => {
    await expect(repricing.preview(owner(), {
      selection: {}, rule: { adjust: { kind: "percent", percent: "5000" } },
    })).rejects.toThrow(UnprocessableError);
  });
});

run("applying a change", () => {
  it("writes a new version per item and edits no version in place", async () => {
    const a = await item("A-1", "100.00", "40.00");
    const b = await item("A-2", "200.00");
    const applied = await repricing.apply(owner(), {
      selection: { q: "A-" }, rule: { adjust: { kind: "percent", percent: "10" } },
    });
    expect(applied.changed).toBe(2);

    const history = await versions(a);
    expect(history.map((v) => [v.version, v.price])).toEqual([[1, "100.0000"], [2, "110.0000"]]);
    expect(history[0]!.effective_to).not.toBeNull();
    expect(history[1]!.effective_to).toBeNull();
    expect((await versions(b)).map((v) => v.price)).toEqual(["200.0000", "220.0000"]);

    const listed = await priceBook.list(owner(), { limit: 50, includeInactive: false });
    expect(listed.data.find((i) => i.id === a)?.price).toBe("110.0000");
  });

  it("applies only the items left ticked", async () => {
    const a = await item("A-1", "100.00");
    const b = await item("A-2", "100.00");
    await repricing.apply(owner(), {
      selection: { itemIds: [a] }, rule: { adjust: { kind: "amount", amount: "5" } },
    });
    expect((await versions(a)).map((v) => v.price)).toEqual(["100.0000", "105.0000"]);
    expect(await versions(b)).toHaveLength(1);
  });

  it("records the change, the rule in words, and an audit line", async () => {
    await item("A-1", "100.00");
    const applied = await repricing.apply(owner(), {
      selection: {}, rule: { adjust: { kind: "none" }, ending: "99" },
    });
    const [change] = await repricing.history(owner());
    expect(change).toMatchObject({ id: applied.id, kind: "change", description: "Rounded up to the next .99", itemCount: 1 });
    const detail = await repricing.lines(owner(), { id: applied.id });
    expect(detail.lines).toEqual([expect.objectContaining({ code: "A-1", priceBefore: "100.0000", priceAfter: "100.9900" })]);
    const audits = await raw`select action from public.audit_log where organization_id = ${ORG} and action like 'pricebook.%' order by created_at`;
    expect(audits.map((a) => a.action)).toEqual(["pricebook.item_created", "pricebook.item_revised", "pricebook.repriced"]);
  });

  it("answers a replay with the first change rather than applying it twice", async () => {
    const a = await item("A-1", "100.00");
    const keyed = { ...owner(), idempotencyKey: `reprice-${Date.now()}` };
    const first = await repricing.apply(keyed, { selection: {}, rule: { adjust: { kind: "percent", percent: "10" } } });
    const again = await repricing.apply(keyed, { selection: {}, rule: { adjust: { kind: "percent", percent: "10" } } });
    expect(again).toEqual(first);
    expect((await versions(a)).map((v) => v.price)).toEqual(["100.0000", "110.0000"]);
  });

  it("leaves out an item with a revision already scheduled, and says so", async () => {
    const a = await item("A-1", "100.00");
    await priceBook.revise(owner(), {
      id: a, price: "150.00", effectiveFrom: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const out = await repricing.preview(owner(), { selection: {}, rule: { adjust: { kind: "percent", percent: "10" } } });
    expect(out.lines[0]?.skipped).toMatch(/already scheduled/);
    await expect(repricing.apply(owner(), { selection: {}, rule: { adjust: { kind: "percent", percent: "10" } } }))
      .rejects.toThrow(ConflictError);
  });
});

run("undoing a change", () => {
  it("puts each price back as another new version, not the opposite percentage", async () => {
    const a = await item("A-1", "100.00");
    const applied = await repricing.apply(owner(), { selection: {}, rule: { adjust: { kind: "percent", percent: "5" } } });
    const undone = await repricing.reverse(owner(), { id: applied.id });
    expect(undone).toMatchObject({ changed: 1, skipped: [] });
    expect((await versions(a)).map((v) => v.price)).toEqual(["100.0000", "105.0000", "100.0000"]);

    const changes = await repricing.history(owner());
    expect(changes[0]).toMatchObject({ kind: "reversal", reversesId: applied.id });
    expect(changes[1]).toMatchObject({ kind: "change", reversedById: undone.id });
    await expect(repricing.reverse(owner(), { id: applied.id })).rejects.toThrow(/already been undone/);
  });

  it("skips and names an item somebody changed again since", async () => {
    const a = await item("A-1", "100.00");
    const b = await item("A-2", "100.00");
    const applied = await repricing.apply(owner(), { selection: {}, rule: { adjust: { kind: "amount", amount: "10" } } });
    await priceBook.revise(owner(), { id: b, price: "130.00" });

    const undone = await repricing.reverse(owner(), { id: applied.id });
    expect(undone.changed).toBe(1);
    expect(undone.skipped).toEqual([expect.objectContaining({ code: "A-2", reason: expect.stringMatching(/changed again/) })]);
    expect((await versions(a)).at(-1)?.price).toBe("100.0000");
    expect((await versions(b)).at(-1)?.price).toBe("130.0000");
    // Kept on the undo, so the answer outlives the button press.
    expect((await repricing.lines(owner(), { id: undone.id })).skipped).toEqual([
      expect.objectContaining({ code: "A-2" }),
    ]);
  });
});

run("a change dated ahead", () => {
  const ahead = (days: number) => companyToday(days);

  it("waits as a scheduled revision per item from the start of that day, and the price in force stays until then", async () => {
    const a = await item(`DATED-A-${Date.now()}`, "100.00");
    const b = await item(`DATED-B-${Date.now()}`, "250.00");
    const applied = await repricing.apply(owner(), {
      selection: { itemIds: [a, b] }, rule: { adjust: { kind: "percent", percent: "10" } }, effectiveOn: ahead(30),
    });
    expect(applied.changed).toBe(2);
    expect(applied.description).toContain(`from ${ahead(30)}`);

    /** In force now: the old price. Waiting: the new one, from that day. */
    expect((await priceBook.detail(owner(), { id: a })).price).toBe("100.0000");
    const waiting = await priceBook.scheduledRevisions(owner());
    const mine = waiting.filter((w) => [a, b].includes(w.itemId));
    expect(mine.map((w) => [w.currentPrice, w.price]).sort()).toEqual([["100.0000", "110.0000"], ["250.0000", "275.0000"]]);
    const [row] = await raw<{ effective_from: Date }[]>`
      select effective_from from public.price_book_item_version where item_id = ${a} and version = 2`;
    expect(row!.effective_from.toISOString()).toBe(time.startOfDayIn(ahead(30), "America/Chicago").toISOString());

    const listed = (await repricing.history(owner())).find((c) => c.id === applied.id)!;
    expect(listed.effectiveFrom).toBe(row!.effective_from.toISOString());
  });

  it("is called off rather than undone before its day, leaving the price in force as it was", async () => {
    const a = await item(`DATED-C-${Date.now()}`, "80.00");
    const applied = await repricing.apply(owner(), {
      selection: { itemIds: [a] }, rule: { adjust: { kind: "amount", amount: "5" } }, effectiveOn: ahead(14),
    });
    const undone = await repricing.reverse(owner(), { id: applied.id });
    expect(undone.description).toMatch(/^Called off/);
    expect(undone.changed).toBe(1);
    const rows = await versions(a);
    expect(rows.map((r) => [r.version, r.price, r.effective_to])).toEqual([[1, "80.0000", null], [2, "85.0000", null]]);
    const [called] = await raw<{ deleted_at: Date | null }[]>`
      select deleted_at from public.price_book_item_version where item_id = ${a} and version = 2`;
    expect(called!.deleted_at).not.toBeNull();
    /** Nothing waits for it any more. */
    expect((await priceBook.scheduledRevisions(owner())).some((w) => w.itemId === a)).toBe(false);
  });

  it("takes today as now, and refuses a day gone by", async () => {
    const a = await item(`DATED-D-${Date.now()}`, "40.00");
    await repricing.apply(owner(), {
      selection: { itemIds: [a] }, rule: { adjust: { kind: "amount", amount: "1" } }, effectiveOn: ahead(0),
    });
    expect((await priceBook.detail(owner(), { id: a })).price).toBe("41.0000");
    await expect(repricing.apply(owner(), {
      selection: { itemIds: [a] }, rule: { adjust: { kind: "amount", amount: "1" } }, effectiveOn: ahead(-1),
    })).rejects.toBeInstanceOf(UnprocessableError);
  });
});

run("a kit's parts", () => {
  it("are changed as a new revision, carried forward by every revision after", async () => {
    const stamp = Date.now();
    const kit = await item(`KIT-${stamp}`, "450.00");
    const valve = await item(`KV-${stamp}`, "60.00");
    const hose = await item(`KH-${stamp}`, "15.00");
    const revised = await priceBook.revise(owner(), {
      id: kit, components: [{ itemId: valve, quantity: 1 }, { itemId: hose, quantity: 2 }, { itemId: hose, quantity: 1 }],
    });
    expect(revised.version).toBe(2);
    expect(revised.components).toEqual([{ itemId: valve, quantity: 1 }, { itemId: hose, quantity: 3 }]);
    /** The version before still lists what it listed. */
    const [first] = await raw<{ components: unknown }[]>`
      select components from public.price_book_item_version where item_id = ${kit} and version = 1`;
    expect(first!.components).toEqual([]);

    const repriced = await priceBook.revise(owner(), { id: kit, price: "475.00" });
    expect(repriced.components).toEqual([{ itemId: valve, quantity: 1 }, { itemId: hose, quantity: 3 }]);
    expect((await priceBook.revise(owner(), { id: kit, components: [] })).components).toEqual([]);
  });

  it("refuses the kit inside itself, however deep, and a part that is not sold", async () => {
    const stamp = Date.now();
    const outer = await item(`KO-${stamp}`, "900.00");
    const inner = await item(`KI-${stamp}`, "300.00");
    await expect(priceBook.revise(owner(), { id: outer, components: [{ itemId: outer, quantity: 1 }] }))
      .rejects.toThrow(/cannot contain itself/);
    await priceBook.revise(owner(), { id: outer, components: [{ itemId: inner, quantity: 1 }] });
    await expect(priceBook.revise(owner(), { id: inner, components: [{ itemId: outer, quantity: 1 }] }))
      .rejects.toThrow(/already contains this one/);
    const retired = await item(`KR-${stamp}`, "10.00");
    await priceBook.setActive(owner(), { id: retired, active: false });
    await expect(priceBook.revise(owner(), { id: outer, components: [{ itemId: retired, quantity: 1 }] }))
      .rejects.toThrow(/no longer sold/);
  });
});
