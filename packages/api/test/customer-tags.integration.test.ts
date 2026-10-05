import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as customerTags from "../src/services/customer-tags";
import * as duplicates from "../src/services/customer-duplicates";
import * as lifecycle from "../src/services/customer-lifecycle";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * TAGS THE COMPANY CAN USE, AND DUPLICATES ACROSS THE BOOK
 *
 * Tags were stored and nothing acted on them; the duplicate matcher answered
 * for one customer at a time. Both are checked here against Postgres, because
 * both are mostly SQL: the case blind tag filter, the one statement rename,
 * and the sweep's self joins against the trigram index.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("ctag:org");
const USER = fixtureId("ctag:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], extra: Partial<Actor> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"], ...extra }, db: db(),
});
const owner = () => as(["owner"]);

async function customer(name: string, extra: { phone?: string; email?: string; tags?: string[] } = {}): Promise<string> {
  const made = await customers.create(owner(), {
    type: "residential", name, paymentTermsDays: 0, taxExempt: false,
    tags: extra.tags ?? [], customFields: {},
    ...(extra.phone ? { phone: extra.phone } : {}),
    ...(extra.email ? { email: extra.email } : {}),
  } as Parameters<typeof customers.create>[1]);
  return made.id;
}

const tagsOf = async (id: string) => (await customers.get(owner(), { id })).tags;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Tag Co", slug: "tag-co" });
});

run("tags on one customer", () => {
  it("adds and removes, and keeps each tag once whatever the case", async () => {
    const id = await customer("Ada Lovelace");
    expect((await customerTags.setOnCustomer(owner(), { customerId: id, add: ["VIP", "vip", " Landlord "] })).tags)
      .toEqual(["VIP", "Landlord"]);
    expect((await customerTags.setOnCustomer(owner(), { customerId: id, remove: ["landlord"] })).tags)
      .toEqual(["VIP"]);
  });

  it("gives a new tag the spelling the company already uses", async () => {
    // "VIP" is in the book; somebody typing "vip" on the next customer gets "VIP".
    await customer("First", { tags: ["VIP"] });
    const second = await customer("Second");
    expect((await customerTags.setOnCustomer(owner(), { customerId: second, add: ["vip"] })).tags).toEqual(["VIP"]);
  });

  it("refuses a tag that is a sentence, and an empty request", async () => {
    const id = await customer("Ada");
    await expect(customerTags.setOnCustomer(owner(), { customerId: id, add: ["x".repeat(41)] }))
      .rejects.toThrow(ConflictError);
    await expect(customerTags.setOnCustomer(owner(), { customerId: id })).rejects.toThrow(ConflictError);
  });

  it("needs customer:write", async () => {
    const id = await customer("Ada");
    await expect(customerTags.setOnCustomer(as(["dispatcher"]), { customerId: id, add: ["VIP"] }))
      .rejects.toThrow(PermissionError);
  });

  it("writes an audit line with before and after", async () => {
    const id = await customer("Ada");
    await customerTags.setOnCustomer(owner(), { customerId: id, add: ["VIP"] });
    const [row] = await raw`select before, after from public.audit_log
      where organization_id = ${ORG} and action = 'customer.tags_changed' and entity_id = ${id}`;
    expect(row!.after).toEqual({ tags: ["VIP"] });
  });
});

run("the company's tags", () => {
  it("counts customers per tag, case blind, most used first", async () => {
    await customer("A", { tags: ["VIP", "Landlord"] });
    await customer("B", { tags: ["vip"] });
    await customer("C", { tags: ["Landlord", "VIP"] });
    const list = await customerTags.list(owner());
    expect(list).toEqual([
      { tag: "VIP", customers: 3 },
      { tag: "Landlord", customers: 2 },
    ]);
  });

  it("leaves out customers that were removed", async () => {
    const gone = await customer("Gone", { tags: ["Storm list"] });
    await lifecycle.remove(owner(), { id: gone, reason: "Test" });
    expect(await customerTags.list(owner())).toEqual([]);
  });
});

run("filtering the list by tags", () => {
  it("finds customers carrying any of them, or all of them, without case", async () => {
    const both = await customer("Both", { tags: ["VIP", "Landlord"] });
    const vip = await customer("Vip only", { tags: ["VIP"] });
    await customer("Neither", { tags: ["Storm list"] });

    const any = await customers.list(owner(), { limit: 50, includeInactive: false, tags: ["vip", "landlord"] });
    expect(any.data.map((c) => c.id).sort()).toEqual([both, vip].sort());

    const all = await customers.list(owner(), {
      limit: 50, includeInactive: false, tags: ["vip", "LANDLORD"], tagMatch: "all",
    });
    expect(all.data.map((c) => c.id)).toEqual([both]);
  });

  it("honours the single tag the contract always had", async () => {
    const vip = await customer("Vip", { tags: ["VIP"] });
    await customer("Other");
    const page = await customers.list(owner(), { limit: 50, includeInactive: false, tag: "vip" });
    expect(page.data.map((c) => c.id)).toEqual([vip]);
  });
});

run("renaming and merging across the book", () => {
  it("renames in one statement and in place in each list", async () => {
    const a = await customer("A", { tags: ["Landlord", "gold"] });
    const b = await customer("B", { tags: ["Gold"] });
    const done = await customerTags.rename(owner(), { from: "gold", to: "Gold members" });
    expect(done).toEqual({ tag: "Gold members", customers: 2 });
    expect(await tagsOf(a)).toEqual(["Landlord", "Gold members"]);
    expect(await tagsOf(b)).toEqual(["Gold members"]);
  });

  it("refuses to rename onto a tag already in use, and says merge", async () => {
    await customer("A", { tags: ["Gold", "VIP"] });
    await expect(customerTags.rename(owner(), { from: "Gold", to: "vip" })).rejects.toThrow(/merge/);
  });

  it("allows a rename that only fixes the case", async () => {
    const a = await customer("A", { tags: ["vip"] });
    await customerTags.rename(owner(), { from: "vip", to: "VIP" });
    expect(await tagsOf(a)).toEqual(["VIP"]);
  });

  it("refuses to rename a tag nobody has", async () => {
    await expect(customerTags.rename(owner(), { from: "Nope", to: "Yes" })).rejects.toThrow(NotFoundError);
  });

  it("merges several spellings into one, once per customer", async () => {
    const a = await customer("A", { tags: ["V.I.P.", "Landlord", "vip"] });
    const b = await customer("B", { tags: ["VIP"] });
    const done = await customerTags.merge(owner(), { from: ["vip", "V.I.P."], into: "VIP" });
    expect(done.customers).toBe(1);
    expect(await tagsOf(a)).toEqual(["VIP", "Landlord"]);
    expect(await tagsOf(b)).toEqual(["VIP"]);
    expect(await customerTags.list(owner())).toEqual([
      { tag: "VIP", customers: 2 }, { tag: "Landlord", customers: 1 },
    ]);
  });

  it("answers a replay with the first answer rather than renaming nothing", async () => {
    await customer("A", { tags: ["gold"] });
    const keyed = { ...owner(), idempotencyKey: `rename-${Date.now()}` };
    const first = await customerTags.rename(keyed, { from: "gold", to: "Gold" });
    const again = await customerTags.rename(keyed, { from: "gold", to: "Gold" });
    expect(again).toEqual(first);
    expect(first.customers).toBe(1);
  });
});

run("the duplicate sweep", () => {
  it("pairs the whole book by phone, email and name, strongest first, each pair once", async () => {
    const a = await customer("Robert Smith", { phone: "+15125550101", email: "bob@example.com" });
    const b = await customer("Bob Smith", { phone: "+15125550101" });
    const c = await customer("Carla Jones", { email: "CARLA@example.com" });
    const d = await customer("Carla Jonas", { email: "carla@example.com" });
    const e = await customer("Margaret Thatcherson");
    const f = await customer("Margaret Thatchersen");
    await customer("Somebody Else Entirely");

    const page = await duplicates.sweep(owner());
    const pairs = page.data.map((p) => [[p.a.id, p.b.id].sort().join("|"), p.because]);
    expect(pairs).toEqual([
      [[a, b].sort().join("|"), "Same phone number"],
      [[c, d].sort().join("|"), "Same email address"],
      [[e, f].sort().join("|"), "Similar name"],
    ]);
  });

  it("gives the same reason the customer's own page gives", async () => {
    const a = await customer("Robert Smith", { phone: "+15125550101" });
    await customer("Robbie Smith", { phone: "+15125550101" });
    const own = await lifecycle.likelyDuplicates(owner(), { id: a });
    const swept = await duplicates.sweep(owner());
    expect(own.map((c) => c.because)).toEqual(swept.data.map((p) => p.because));
  });

  it("pages by position, so the next page starts after the last pair", async () => {
    // Names nothing like each other, so the phone is the only signal.
    const names = [["Alder", "Quint"], ["Birch", "Rook"], ["Cedar", "Sable"], ["Dogwood", "Tansy"], ["Elm", "Umber"]];
    for (const [i, [one, two]] of names.entries()) {
      await customer(one!, { phone: `+1512555020${i}` });
      await customer(two!, { phone: `+1512555020${i}` });
    }
    const first = await duplicates.sweep(owner(), { limit: 3 });
    expect(first.data).toHaveLength(3);
    expect(first.hasMore).toBe(true);
    const second = await duplicates.sweep(owner(), { limit: 3, cursor: first.nextCursor! });
    expect(second.data).toHaveLength(2);
    expect(second.hasMore).toBe(false);
    const seen = [...first.data, ...second.data].map((p) => p.a.name);
    expect(new Set(seen).size).toBe(5);
  });

  it("stops showing a pair somebody said is two people, here and on each customer's page", async () => {
    const landlord = await customer("Sarah Landlord", { phone: "+15125550300" });
    const tenant = await customer("Tom Tenant", { phone: "+15125550300" });
    expect((await duplicates.sweep(owner())).data).toHaveLength(1);

    await duplicates.dismiss(owner(), { customerId: tenant, otherId: landlord, reason: "Landlord pays" });
    // Said twice, from the other side: still one decision.
    await duplicates.dismiss(owner(), { customerId: landlord, otherId: tenant });

    expect((await duplicates.sweep(owner())).data).toEqual([]);
    expect(await lifecycle.likelyDuplicates(owner(), { id: landlord })).toEqual([]);
    const rows = await raw`select count(*)::int as n from public.customer_not_duplicate where organization_id = ${ORG}`;
    expect(rows[0]!.n).toBe(1);
    expect(await duplicates.dismissedCount(owner())).toBe(1);
  });

  it("counts every pair still to look at, on whichever page it is asked", async () => {
    const names = [["Alder", "Quint"], ["Birch", "Rook"], ["Cedar", "Sable"], ["Dogwood", "Tansy"], ["Elm", "Umber"]];
    for (const [i, [one, two]] of names.entries()) {
      await customer(one!, { phone: `+1512555030${i}` });
      await customer(two!, { phone: `+1512555030${i}` });
    }
    const first = await duplicates.sweep(owner(), { limit: 2 });
    const second = await duplicates.sweep(owner(), { limit: 2, cursor: first.nextCursor! });
    const last = await duplicates.sweep(owner(), { limit: 2, cursor: second.nextCursor! });
    expect([first.total, second.total, last.total]).toEqual([5, 5, 5]);

    // A pair set aside is not still to look at, and a pair put back is again.
    const [a, b] = [first.data[0]!.a.id, first.data[0]!.b.id];
    await duplicates.dismiss(owner(), { customerId: a, otherId: b });
    expect((await duplicates.sweep(owner(), { limit: 2 })).total).toBe(4);
    await duplicates.restore(owner(), { customerId: a, otherId: b });
    expect((await duplicates.sweep(owner(), { limit: 2 })).total).toBe(5);
  });

  it("puts a pair back from either side, and says so twice without harm", async () => {
    const landlord = await customer("Sarah Landlord", { phone: "+15125550300" });
    const tenant = await customer("Tom Tenant", { phone: "+15125550300" });
    await duplicates.dismiss(owner(), { customerId: tenant, otherId: landlord, reason: "Landlord pays" });
    expect((await duplicates.sweep(owner())).data).toEqual([]);

    const listed = await duplicates.setAside(owner());
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({ reason: "Landlord pays" });
    expect([listed.data[0]!.a.name, listed.data[0]!.b.name].sort()).toEqual(["Sarah Landlord", "Tom Tenant"]);

    // Said from the side that did not mark it.
    const first = await duplicates.restore(owner(), { customerId: landlord, otherId: tenant });
    expect(first).toMatchObject({ dismissed: false, wasMarked: true });
    expect((await duplicates.sweep(owner())).data).toHaveLength(1);
    expect(await lifecycle.likelyDuplicates(owner(), { id: landlord })).toHaveLength(1);
    expect(await duplicates.dismissedCount(owner())).toBe(0);
    expect((await duplicates.setAside(owner())).data).toEqual([]);

    const again = await duplicates.restore(owner(), { customerId: tenant, otherId: landlord });
    expect(again.wasMarked).toBe(false);
    const audits = await raw`
      select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action = 'customer.duplicate_restored'`;
    expect(audits[0]!.n).toBe(1);
  });

  it("lists a mark whose customer was merged since, so it can still be taken off", async () => {
    const keep = await customer("Robert Smith", { phone: "+15125550101" });
    const other = await customer("Bob Smith", { phone: "+15125550101" });
    const third = await customer("Roberta Smythe", { phone: "+15125550101" });
    await duplicates.dismiss(owner(), { customerId: other, otherId: third });
    await lifecycle.merge(owner(), { keepId: keep, mergeId: other });
    const listed = await duplicates.setAside(owner());
    expect(listed.data).toHaveLength(1);
    const done = await duplicates.restore(owner(), { customerId: other, otherId: third });
    expect(done.wasMarked).toBe(true);
  });

  it("pages the set aside list newest first", async () => {
    for (const [i, [one, two]] of [["Alder", "Quint"], ["Birch", "Rook"], ["Cedar", "Sable"]].entries()) {
      const a = await customer(one!, { phone: `+1512555040${i}` });
      const b = await customer(two!, { phone: `+1512555040${i}` });
      await duplicates.dismiss(owner(), { customerId: a, otherId: b, reason: `pair ${i}` });
    }
    const first = await duplicates.setAside(owner(), { limit: 2 });
    expect(first.data.map((p) => p.reason)).toEqual(["pair 2", "pair 1"]);
    expect(first.hasMore).toBe(true);
    const second = await duplicates.setAside(owner(), { limit: 2, cursor: first.nextCursor! });
    expect(second.data.map((p) => p.reason)).toEqual(["pair 0"]);
    expect(second.hasMore).toBe(false);
  });

  it("puts a pair back only for whoever may merge", async () => {
    const a = await customer("A One", { phone: "+15125550500" });
    const b = await customer("B Two", { phone: "+15125550500" });
    await expect(duplicates.restore(as(["csr"]), { customerId: a, otherId: b })).rejects.toThrow(PermissionError);
    await expect(duplicates.setAside(as(["csr"]))).rejects.toThrow(PermissionError);
    await expect(duplicates.restore(owner(), { customerId: a, otherId: a })).rejects.toThrow(ConflictError);
  });

  it("drops a pair once the two are merged", async () => {
    const keep = await customer("Robert Smith", { phone: "+15125550101" });
    const loser = await customer("Bob Smith", { phone: "+15125550101" });
    await lifecycle.merge(owner(), { keepId: keep, mergeId: loser });
    expect((await duplicates.sweep(owner())).data).toEqual([]);
  });

  it("is for whoever may merge, because it reads the whole book", async () => {
    await expect(duplicates.sweep(as(["csr"]))).rejects.toThrow(PermissionError);
    await expect(duplicates.sweep(as(["office_manager"]))).resolves.toBeDefined();
  });

  it("refuses a record paired with itself", async () => {
    const a = await customer("A");
    await expect(duplicates.dismiss(owner(), { customerId: a, otherId: a })).rejects.toThrow(ConflictError);
  });
});
