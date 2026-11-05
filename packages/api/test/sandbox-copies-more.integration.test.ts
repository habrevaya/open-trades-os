import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as sandbox from "../src/services/sandbox";
import { type ServiceContext } from "../src/services/context";
import { resetOrg, seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE SANDBOX ALSO COPIES MESSAGE TEMPLATES, THE PRICE BOOK, ROLES AND BRANCHES
 *
 * What is copied is a practice copy of how the company is set up, as it is
 * today, in a second company that shares nothing with the first. So each test
 * changes the copy and shows the real company did not move, and the copy of
 * the price book is the price in force now, without the picture, without the
 * history and without the link to the system it was imported from.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("sbxmore:org");
const USER = fixtureId("sbxmore:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });

async function clearSandboxes() {
  const rows = await raw<{ id: string }[]>`select id from public.organization where sandbox_of_organization_id = ${ORG}`;
  await raw`update public.organization set sandbox_organization_id = null where id = ${ORG}`;
  for (const row of rows) await resetOrg(raw, row.id);
}

let houston = "";
let drains = "";
let snake = "";
let kit = "";
let realMaker = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await clearSandboxes().catch(() => undefined);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "More Co", slug: "more-co-sbx" });

  const [branch] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name, code) values (${ORG}, 'Houston', 'HOU') returning id`;
  houston = branch!.id;
  await raw`insert into public.business_unit (organization_id, name, active) values (${ORG}, 'Closed branch', false)`;
  await raw`insert into public.job_type (organization_id, name, business_unit_id) values (${ORG}, 'Houston drains', ${houston})`;

  await raw`insert into public.message_template (organization_id, code, name, channel, purpose, subject, body, variables)
            values (${ORG}, 'on_the_way', 'On the way', 'sms', 'transactional', null, 'Hi {{first_name}}, we are on the way.', ${raw.json(["first_name"])})`;
  await raw`insert into public.message_template (organization_id, code, name, channel, body, active, deleted_at)
            values (${ORG}, 'old_one', 'Old one', 'sms', 'gone', false, now())`;

  const [top] = await raw<{ id: string }[]>`insert into public.price_book_category (organization_id, name, taxable) values (${ORG}, 'Plumbing', false) returning id`;
  const [child] = await raw<{ id: string }[]>`insert into public.price_book_category (organization_id, parent_id, name) values (${ORG}, ${top!.id}, 'Drains') returning id`;
  drains = child!.id;
  const item = async (code: string, name: string, price: string) => {
    const [row] = await raw<{ id: string }[]>`insert into public.price_book_item
      (organization_id, category_id, kind, code, source_system, source_id)
      values (${ORG}, ${drains}, 'service', ${code}, 'jobber', ${`J-${code}`}) returning id`;
    await raw`insert into public.price_book_item_version (organization_id, item_id, version, name, price, cost, picture_key, effective_from, effective_to)
      values (${ORG}, ${row!.id}, 1, ${`${name} (old)`}, '1.00', '0.50', null, now() - interval '30 days', now() - interval '10 days')`;
    await raw`insert into public.price_book_item_version (organization_id, item_id, version, name, price, cost, picture_key, effective_from)
      values (${ORG}, ${row!.id}, 2, ${name}, ${price}, '40.00', 'real-company-file-key', now() - interval '10 days')`;
    return row!.id;
  };
  snake = await item("SNAKE", "Snake a drain", "189.00");
  const [maker] = await raw<{ id: string }[]>`insert into public.warranty_maker (organization_id, name, registration_days)
    values (${ORG}, 'Rheem', 45) returning id`;
  realMaker = maker!.id;
  await raw`update public.price_book_item set warranty_maker_id = ${realMaker} where id = ${snake}`;
  const part = await item("TRAP", "P-trap", "35.00");
  kit = await item("KIT", "Drain kit", "260.00");
  await raw`update public.price_book_item_version set components = ${raw.json([{ itemId: snake, quantity: 1 }, { itemId: part, quantity: 2 }, { itemId: crypto.randomUUID(), quantity: 1 }])}
            where item_id = ${kit} and version = 2`;
  await raw`insert into public.price_book_item (organization_id, kind, code, deleted_at) values (${ORG}, 'service', 'GONE', now())`;

  await raw`insert into public.role (organization_id, name, description, based_on, permissions, scopes)
            values (${ORG}, 'Warehouse', 'Reads stock only', 'readonly', ${raw.json(["inventory:read"])}, ${raw.json({ job: "own" })})`;
  await raw`insert into public.role (organization_id, name, permissions, deleted_at) values (${ORG}, 'Retired role', ${raw.json([])}, now())`;
});

afterAll(async () => {
  if (!raw) return;
  await clearSandboxes();
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await clearSandboxes();
});

run("making one copies more of how the company is set up", () => {
  it("counts what it copied, and leaves out what was deleted", async () => {
    const [live] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.message_template where organization_id = ${ORG} and deleted_at is null`;
    const made = await sandbox.create(owner());
    // Ours, and not the one that was deleted.
    expect(live!.n).toBe(1);
    expect(made.copied).toMatchObject({
      messageTemplates: live!.n, priceBookCategories: 2, priceBookItems: 3, roles: 1, branches: 2,
    });
  });

  it("copies branches, and a job type keeps its branch in the copy", async () => {
    const made = await sandbox.create(owner());
    const inside = made.sandboxOrganizationId;
    const branches = await raw<{ id: string; name: string; code: string | null; active: boolean }[]>`
      select id, name, code, active from public.business_unit where organization_id = ${inside} order by name`;
    // A retired branch is copied as retired: branches are marked, never deleted.
    expect(branches.map((b) => [b.name, b.code, b.active])).toEqual([["Closed branch", null, false], ["Houston", "HOU", true]]);
    const copy = branches.find((b) => b.name === "Houston")!;
    expect(copy.id).not.toBe(houston);
    const [type] = await raw<{ business_unit_id: string | null }[]>`
      select business_unit_id from public.job_type where organization_id = ${inside} and name = 'Houston drains'`;
    expect(type!.business_unit_id).toBe(copy.id);
  });

  it("copies message templates as their own rows", async () => {
    const made = await sandbox.create(owner());
    const inside = made.sandboxOrganizationId;
    const copied = await raw<{ code: string; body: string; variables: string[]; id: string }[]>`
      select id, code, body, variables from public.message_template where organization_id = ${inside}`;
    expect(copied.filter((t) => t.code === "on_the_way").map((t) => [t.code, t.body, t.variables])).toEqual([
      ["on_the_way", "Hi {{first_name}}, we are on the way.", ["first_name"]],
    ]);
    expect(copied.map((t) => t.code)).not.toContain("old_one");
    await raw`update public.message_template set body = 'Changed in the sandbox' where organization_id = ${inside} and code = 'on_the_way'`;
    const [real] = await raw<{ body: string }[]>`select body from public.message_template where organization_id = ${ORG} and code = 'on_the_way'`;
    expect(real!.body).toBe("Hi {{first_name}}, we are on the way.");
  });

  it("copies the price book at today's price, with its shelves, kits, and without picture, history or source", async () => {
    const made = await sandbox.create(owner());
    const inside = made.sandboxOrganizationId;

    const shelves = await raw<{ id: string; name: string; parent_id: string | null; taxable: boolean | null }[]>`
      select id, name, parent_id, taxable from public.price_book_category where organization_id = ${inside} order by name`;
    const byName = new Map(shelves.map((s) => [s.name, s]));
    expect(byName.get("Drains")!.parent_id).toBe(byName.get("Plumbing")!.id);
    expect(byName.get("Plumbing")!.taxable).toBe(false);
    expect(shelves.map((s) => s.id)).not.toContain(drains);

    const items = await raw<{ id: string; code: string; category_id: string | null; source_system: string | null; source_id: string | null }[]>`
      select id, code, category_id, source_system, source_id from public.price_book_item where organization_id = ${inside} order by code`;
    expect(items.map((i) => i.code)).toEqual(["KIT", "SNAKE", "TRAP"]);
    for (const item of items) {
      expect(item.category_id).toBe(byName.get("Drains")!.id);
      expect(item.source_system).toBeNull();
      expect(item.source_id).toBeNull();
    }

    const versions = await raw<{ item_id: string; version: number; name: string; price: string; picture_key: string | null; effective_to: Date | null; components: { itemId: string; quantity: number }[] }[]>`
      select item_id, version, name, price::text, picture_key, effective_to, components
      from public.price_book_item_version where organization_id = ${inside} order by name`;
    expect(versions.map((v) => [v.name, Number(v.price), v.version])).toEqual([
      ["Drain kit", 260, 1], ["P-trap", 35, 1], ["Snake a drain", 189, 1],
    ]);
    for (const v of versions) {
      expect(v.picture_key).toBeNull();
      expect(v.effective_to).toBeNull();
    }
    // The kit's parts point at the copies; the part that was not in the book is dropped.
    const copyOf = new Map(items.map((i) => [i.code, i.id]));
    const kitVersion = versions.find((v) => v.name === "Drain kit")!;
    expect(kitVersion.item_id).toBe(copyOf.get("KIT"));
    expect(kitVersion.components).toEqual([
      { itemId: copyOf.get("SNAKE"), quantity: 1 }, { itemId: copyOf.get("TRAP"), quantity: 2 },
    ]);

    // The maker an item comes from is the sandbox's own copy, with its days, and never the real company's row.
    const copiedMakers = await raw<{ id: string; name: string; registration_days: number | null }[]>`
      select id, name, registration_days from public.warranty_maker where organization_id = ${inside}`;
    expect(copiedMakers.map((m) => [m.name, m.registration_days])).toEqual([["Rheem", 45]]);
    expect(copiedMakers[0]!.id).not.toBe(realMaker);
    const snakeCopy = items.find((i) => i.code === "SNAKE")!;
    const [named] = await raw<{ warranty_maker_id: string | null }[]>`
      select warranty_maker_id from public.price_book_item where id = ${snakeCopy.id}`;
    expect(named!.warranty_maker_id).toBe(copiedMakers[0]!.id);
    expect(made.copied.warrantyMakers).toBe(1);

    // A price changed in the practice copy is not changed at home.
    await raw`update public.price_book_item_version set price = '1.00' where organization_id = ${inside}`;
    const [real] = await raw<{ price: string }[]>`
      select price::text from public.price_book_item_version where organization_id = ${ORG} and item_id = ${snake} and version = 2`;
    expect(Number(real!.price)).toBe(189);
  });

  it("copies the roles the company made as definitions, held by nobody in the sandbox", async () => {
    const made = await sandbox.create(owner());
    const inside = made.sandboxOrganizationId;
    const roles = await raw<{ name: string; description: string | null; based_on: string | null; permissions: string[]; scopes: Record<string, string>; created_by_user_id: string }[]>`
      select name, description, based_on, permissions, scopes, created_by_user_id from public.role where organization_id = ${inside}`;
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({
      name: "Warehouse", description: "Reads stock only", based_on: "readonly",
      permissions: ["inventory:read"], scopes: { job: "own" }, created_by_user_id: USER,
    });
    const held = await raw<{ n: number }[]>`select count(*)::int as n from public.membership where organization_id = ${inside} and role_id is not null`;
    expect(held[0]!.n).toBe(0);
  });
});

run("a company that started with the renewal notices", () => {
  it("copies its edited wording over the sandbox's own starting words, once per code", async () => {
    await raw`insert into public.message_template (organization_id, code, name, channel, purpose, subject, body, variables)
              values (${ORG}, 'agreement_renewal.renews.sms', 'Renewal heads up', 'sms', 'transactional', null, 'Our own words about renewing.', ${raw.json([])})`;
    try {
      const made = await sandbox.create(owner());
      const inside = made.sandboxOrganizationId;
      const rows = await raw<{ body: string; name: string }[]>`
        select body, name from public.message_template
        where organization_id = ${inside} and code = 'agreement_renewal.renews.sms'`;
      expect(rows).toEqual([{ body: "Our own words about renewing.", name: "Renewal heads up" }]);
    } finally {
      await clearSandboxes();
      await raw`delete from public.message_template where organization_id = ${ORG} and code = 'agreement_renewal.renews.sms'`;
    }
  });
});
