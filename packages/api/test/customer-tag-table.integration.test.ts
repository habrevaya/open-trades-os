import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { tags as tagRules, type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as customerTags from "../src/services/customer-tags";
import * as campaigns from "../src/services/campaigns";
import * as lifecycle from "../src/services/customer-lifecycle";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * TAGS IN A TABLE OF THEIR OWN
 *
 * The tag filter, the tag counts and a campaign's `tagged_any` read
 * `customer_tag` under an index on the case blind key, instead of every
 * customer's list. That is only safe if the table says exactly what the lists
 * say, always, so this file holds it to that three ways:
 *
 *   The migration's own backfill statement, read out of the migration file
 *   and run again, carries every tag on every live customer across exactly:
 *   the spelling, the order, the odd spaces, the duplicate in another case,
 *   the null that is not a tag, the list that is not a list at all.
 *
 *   The trigger that keeps the table afterwards produces the same rows, for
 *   a customer written by the service, by hand in SQL, renamed across the
 *   book, soft deleted, merged away and removed.
 *
 *   The readers find customers through it without caring about capitals.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("ctagtable:org");
const USER = fixtureId("ctagtable:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

/** A customer inserted by hand, the way an import or a restore writes one, trigger and all. */
async function byHand(name: string, tags: unknown, extra: { deleted?: boolean; phone?: string } = {}): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, phone, tags, payment_terms_days, deleted_at)
    values (${ORG}, 'residential', ${name}, ${extra.phone ?? null}, ${raw.json(tags as postgres.JSONValue)}, 0,
            ${extra.deleted ? new Date() : null})
    returning id`;
  return row!.id;
}

type Row = { customer_id: string; position: number; tag: string; tag_key: string };

/** What the lists say the table should hold, worked out here rather than in SQL. */
async function expected(): Promise<Row[]> {
  const live = await raw<{ id: string; tags: unknown }[]>`
    select id, tags from public.customer where organization_id = ${ORG} and deleted_at is null`;
  const out: Row[] = [];
  for (const customer of live) {
    if (!Array.isArray(customer.tags)) continue;
    customer.tags.forEach((value, position) => {
      if (value === null) return;
      const tag = typeof value === "string" ? value : JSON.stringify(value);
      out.push({ customer_id: customer.id, position, tag, tag_key: tagRules.tagKey(tag) });
    });
  }
  return sorted(out);
}

const sorted = (rows: Row[]) => [...rows]
  .map((r) => ({ customer_id: r.customer_id, position: Number(r.position), tag: r.tag, tag_key: r.tag_key }))
  .sort((a, b) => a.customer_id.localeCompare(b.customer_id) || a.position - b.position);

const tableRows = async (table = "customer_tag") => sorted(await raw.unsafe<Row[]>(
  `select customer_id, position, tag, tag_key from ${table} where organization_id = $1`, [ORG],
));

/** The backfill statement exactly as the migration that made the table carries it. */
function backfillStatement(): string {
  const dir = join(import.meta.dirname, "../../db/migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const text = readFileSync(join(dir, file), "utf8");
    const statement = text.split("--> statement-breakpoint")
      .find((part) => part.includes("customer_tag backfill"));
    if (statement) return statement;
  }
  throw new Error("No migration carries the customer_tag backfill.");
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Tag Table Co", slug: "tag-table-co" });

  ids["mixed"] = await byHand("Mixed Case", ["VIP", " vip ", "Gold  Member", "gold member", "Ünïcödé", "a, b"], { phone: "+15125550901" });
  ids["empty"] = await byHand("No Tags", []);
  ids["nulls"] = await byHand("Has A Null", ["first", null, "third"]);
  ids["object"] = await byHand("Not A List", { vip: true });
  ids["string"] = await byHand("A String", "[\"vip\"]");
  ids["deleted"] = await byHand("Gone", ["VIP", "Gold"], { deleted: true });
  ids["plain"] = await byHand("Plain Vip", ["vip"], { phone: "+15125550902" });
  const made = await customers.create(owner(), {
    type: "residential", name: "Through The Service", paymentTermsDays: 0, taxExempt: false,
    tags: ["Spring", "VIP"], customFields: {}, phone: "+15125550903",
  } as Parameters<typeof customers.create>[1]);
  ids["service"] = made.id;
});

afterAll(async () => { if (raw) await raw.end(); });

run("the migration's backfill", () => {
  it("carries every tag on every live customer across exactly", async () => {
    const statement = backfillStatement();
    expect(statement).toMatch(/INSERT INTO "customer_tag"/);

    /**
     * Run into a temporary copy of the table rather than the real one, so the
     * statement is the migration's own, byte for byte apart from its target,
     * and nothing any other test reads is touched.
     */
    await raw.unsafe(`create temporary table customer_tag_check (like public.customer_tag including defaults)`);
    try {
      await raw.unsafe(statement.replace(/INSERT INTO "customer_tag"/, `INSERT INTO "customer_tag_check"`));
      const migrated = await tableRows("customer_tag_check");
      const want = await expected();
      expect(migrated).toEqual(want);

      // The awkward ones, said out loud rather than left inside a deep equal.
      const mixed = migrated.filter((r) => r.customer_id === ids["mixed"]);
      expect(mixed.map((r) => r.tag)).toEqual(["VIP", " vip ", "Gold  Member", "gold member", "Ünïcödé", "a, b"]);
      expect(mixed.map((r) => r.tag_key)).toEqual(["vip", "vip", "gold member", "gold member", "ünïcödé", "a, b"]);
      expect(migrated.filter((r) => r.customer_id === ids["nulls"]).map((r) => [r.position, r.tag]))
        .toEqual([[0, "first"], [2, "third"]]);
      for (const none of ["empty", "object", "string", "deleted"]) {
        expect(migrated.some((r) => r.customer_id === ids[none])).toBe(false);
      }
    } finally {
      await raw.unsafe(`drop table if exists customer_tag_check`);
    }
  });

  it("agrees with what the trigger wrote for the same customers", async () => {
    expect(await tableRows()).toEqual(await expected());
  });
});

run("the trigger keeps the table equal to the lists", () => {
  it("follows a change to the list, by the service and by hand", async () => {
    await customerTags.setOnCustomer(owner(), { customerId: ids["service"]!, add: ["Fall"], remove: ["spring"] });
    await raw`update public.customer set tags = ${raw.json(["Hand", "Written"])} where id = ${ids["empty"]!}`;
    expect(await tableRows()).toEqual(await expected());
    const service = (await tableRows()).filter((r) => r.customer_id === ids["service"]);
    expect(service.map((r) => r.tag)).toEqual(["VIP", "Fall"]);
  });

  it("follows a rename and a merge across the book", async () => {
    await customerTags.rename(owner(), { from: "written", to: "Typed" });
    await customerTags.merge(owner(), { from: ["Gold Member", "Hand"], into: "Platinum" });
    expect(await tableRows()).toEqual(await expected());
    const keys = (await tableRows()).map((r) => r.tag_key);
    expect(keys).toContain("platinum");
    expect(keys).not.toContain("gold member");
    expect(keys).not.toContain("written");
  });

  it("drops a customer's rows when it is soft deleted or merged away, and brings them back with it", async () => {
    const throwaway = await byHand("Throwaway", ["Seasonal"]);
    await raw`update public.customer set deleted_at = now() where id = ${throwaway}`;
    expect((await tableRows()).some((r) => r.customer_id === throwaway)).toBe(false);
    await raw`update public.customer set deleted_at = null where id = ${throwaway}`;
    expect((await tableRows()).filter((r) => r.customer_id === throwaway).map((r) => r.tag)).toEqual(["Seasonal"]);

    const duplicate = await byHand("Plain Vip Again", ["vip", "Duplicate Only"]);
    await lifecycle.merge(owner(), { keepId: ids["plain"]!, mergeId: duplicate });
    expect((await tableRows()).some((r) => r.customer_id === duplicate)).toBe(false);
    expect(await tableRows()).toEqual(await expected());
  });

  it("goes with a customer that is removed outright", async () => {
    const removed = await byHand("Removed", ["Short Lived"]);
    await raw`delete from public.customer where id = ${removed}`;
    const [left] = await raw<{ n: number }[]>`select count(*)::int as n from public.customer_tag where customer_id = ${removed}`;
    expect(left!.n).toBe(0);
  });
});

run("reading through the table", () => {
  const listed = async (input: { tags: string[]; tagMatch?: "any" | "all" }) =>
    (await customers.list(owner(), { limit: 100, includeInactive: false, ...input })).data.map((c) => c.name).sort();

  it("filters the customer list by any or all of several tags, without capitals", async () => {
    expect(await listed({ tags: ["vIp"] })).toEqual(["Mixed Case", "Plain Vip", "Through The Service"]);
    expect(await listed({ tags: ["VIP", "fall"], tagMatch: "all" })).toEqual(["Through The Service"]);
    expect(await listed({ tags: ["  FALL ", "platinum"], tagMatch: "any" })).toEqual(["Mixed Case", "No Tags", "Through The Service"]);
    // A customer carrying one key twice, in two cases, still counts once for "all".
    expect(await listed({ tags: ["vip", "platinum"], tagMatch: "all" })).toEqual(["Mixed Case"]);
  });

  it("counts each tag once per live customer, in the spelling the book uses", async () => {
    const counts = await customerTags.list(owner());
    const vip = counts.find((c) => tagRules.tagKey(c.tag) === "vip")!;
    expect(vip.customers).toBe(3);
    expect(counts.some((c) => c.tag === "Gold")).toBe(false);
  });

  it("matches a campaign's tagged_any without capitals", async () => {
    const result = await campaigns.preview(owner(), {
      channel: "sms", audience: [{ kind: "tagged_any", tags: ["vip"] }],
    });
    expect(result.sample.map((s) => s.name).sort()).toEqual(["Mixed Case", "Plain Vip", "Through The Service"]);
    const upper = await campaigns.preview(owner(), {
      channel: "sms", audience: [{ kind: "tagged_any", tags: ["FALL"] }],
    });
    expect(upper.sample.map((s) => s.name)).toEqual(["Through The Service"]);
  });
});
