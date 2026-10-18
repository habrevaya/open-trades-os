import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as lifecycle from "../src/services/customer-lifecycle";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import { type ServiceContext } from "../src/services/context";
import { dispatch } from "../src/http/dispatch";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A MERGE MOVES EVERYTHING
 *
 * Every table that names a customer either moves with a merge or is named as
 * staying, with why, and the first test here reads the database's own foreign
 * keys to make sure a new table cannot be forgotten. The rest seed one row in
 * each of the tables the merge used to leave behind (a project, a credit note,
 * a statement, a saved card and its agreement, a file, a task and the rest),
 * merge, check they all moved inside the one company, undo, and check both
 * customers are exactly as they were.
 *
 * What may not move is said: a statement for a month the record kept already
 * has, a card that pays automatically when the record kept already pays
 * automatically with another. And a no to advertising wins over a yes.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("merge-all:org");
const USER = fixtureId("merge-all:user");
const OTHER_ORG = fixtureId("merge-all:other-org");
const OTHER_USER = fixtureId("merge-all:other-user");

let raw: postgres.Sql;
let connection: string;
let counter = 0;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Merge All Co", slug: "merge-all-co" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Next Door Co", slug: "merge-all-next-door" });
  const [made] = await raw<{ id: string }[]>`
    insert into public.integration_connection (organization_id, capability, provider)
    values (${ORG}, 'payments', 'stripe') returning id`;
  connection = made!.id;
});

afterAll(async () => { if (raw) await raw.end(); });

const make = async (name: string, over: Record<string, unknown> = {}) => (await customers.create(owner(), {
  type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {}, ...over,
})).id as string;

const address = (line1: string, customerId: string) => properties.create(owner(), {
  address: { line1, city: "Austin", state: "TX", postalCode: "78701", country: "US" },
  hasDog: false, customFields: {}, customerId, customerRole: "owner",
}).then((p) => p.id as string);

/** A card saved by this customer at the processor, and their agreement to charge it, paying automatically when asked. */
async function card(customerId: string, opts: { autopay: boolean; profile?: string } = { autopay: false }) {
  const [existing] = await raw<{ id: string }[]>`
    select id from public.payment_profile where customer_id = ${customerId} and connection_id = ${connection}`;
  const profile = opts.profile ?? existing?.id ?? (await raw<{ id: string }[]>`
    insert into public.payment_profile (organization_id, customer_id, connection_id, provider, external_ref)
    values (${ORG}, ${customerId}, ${connection}, 'stripe', ${`cus_${randomUUID()}`}) returning id`)[0]!.id;
  const [saved] = await raw<{ id: string }[]>`
    insert into public.saved_payment_method (organization_id, customer_id, profile_id, provider, external_ref, brand, last4)
    values (${ORG}, ${customerId}, ${profile}, 'stripe', ${`pm_${randomUUID()}`}, 'visa', '4242') returning id`;
  const [agreement] = await raw<{ id: string }[]>`
    insert into public.payment_agreement (organization_id, customer_id, saved_payment_method_id, wording, agreed_via, autopay_at, autopay_wording)
    values (${ORG}, ${customerId}, ${saved!.id}, 'You may charge this card for my bills.', 'portal_sign_in',
      ${opts.autopay ? new Date() : null}, ${opts.autopay ? "Charge it for every bill." : null}) returning id`;
  return { profile, card: saved!.id, agreement: agreement!.id };
}

/**
 * The duplicate with one of everything the merge used to leave behind, and the
 * record kept with a statement for September and a yes to advertising.
 */
async function household() {
  counter += 1;
  const tag = `${Date.now()}-${counter}`;
  const keep = await make(`Ruth Okafor ${tag}`, { phone: `+1512555${String(counter).padStart(4, "0")}` });
  const dupe = await make(`Ruth Okafor (web) ${tag}`);
  const home = await address(`${counter} Okafor Way`, dupe);

  await raw`insert into public.project (organization_id, customer_id, property_id, name)
    values (${ORG}, ${dupe}, ${home}, 'Kitchen remodel')`;
  const [credit] = await raw<{ id: string }[]>`
    insert into public.credit_note (organization_id, number, customer_id, reason)
    values (${ORG}, ${900000 + counter}, ${dupe}, 'goodwill') returning id`;
  await raw`insert into public.credit_note_payout (organization_id, credit_note_id, customer_id, method, amount)
    values (${ORG}, ${credit!.id}, ${dupe}, 'check', '10.00')`;
  for (const [who, period] of [[dupe, "2026-08"], [dupe, "2026-09"], [keep, "2026-09"]] as const) {
    const [year, month] = period.split("-");
    await raw`insert into public.statement_delivery (organization_id, customer_id, period, period_from, period_to)
      values (${ORG}, ${who}, ${period}, ${`${year}-${month}-01`}, ${`${year}-${month}-28`})`;
  }
  await raw`insert into public.portal_sign_in (organization_id, channel, address, expires_at, customer_id)
    values (${ORG}, 'email', 'ruth@example.test', now(), ${dupe})`;
  const saved = await card(dupe, { autopay: true });
  await raw`insert into public.advertising_consent (organization_id, customer_id, choice, method)
    values (${ORG}, ${keep}, 'granted', 'web_form')`;
  await raw`insert into public.advertising_consent (organization_id, customer_id, choice, method, superseded_at)
    values (${ORG}, ${dupe}, 'granted', 'verbal', now() - interval '1 day')`;
  await raw`insert into public.advertising_consent (organization_id, customer_id, choice, method)
    values (${ORG}, ${dupe}, 'refused', 'verbal')`;
  await raw`insert into public.attachment (organization_id, entity_type, entity_id, storage_key)
    values (${ORG}, 'customer', ${dupe}, ${`files/${tag}.pdf`})`;
  await raw`insert into public.task (organization_id, title, entity_type, entity_id)
    values (${ORG}, 'Ring Ruth about the remodel', 'customer', ${dupe})`;
  const [asset] = await raw<{ id: string }[]>`
    insert into public.rentable_asset (organization_id, asset_type, identifier)
    values (${ORG}, 'dumpster', ${`CAN-${tag}`}) returning id`;
  await raw`insert into public.container_hold (organization_id, asset_id, kind, reason, customer_id)
    values (${ORG}, ${asset!.id}, 'customer', 'Wants this one on Monday', ${dupe})`;
  const [kind] = await raw<{ id: string }[]>`
    insert into public.custom_object_type (organization_id, key, label, plural_label)
    values (${ORG}, ${`permit_${counter}_${Date.now()}`}, 'Permit', 'Permits') returning id`;
  await raw`insert into public.custom_object_record (organization_id, object_type_id, title, customer_id)
    values (${ORG}, ${kind!.id}, 'Remodel permit', ${dupe})`;
  const [campaign] = await raw<{ id: string }[]>`
    insert into public.marketing_campaign (organization_id, name, channel, body, utm_campaign)
    values (${ORG}, 'Spring', 'email', 'Hello', ${`spring-${tag}`}) returning id`;
  await raw`insert into public.campaign_recipient (organization_id, campaign_id, customer_id, address)
    values (${ORG}, ${campaign!.id}, ${dupe}, ${`ruth-${tag}@example.test`})`;
  const friend = await make(`Friend of Ruth ${tag}`);
  await raw`update public.customer set referred_by_customer_id = ${dupe} where id = ${friend}`;
  await raw`insert into public.referral_reward (organization_id, referrer_customer_id, referred_customer_id, kind, amount, state)
    values (${ORG}, ${dupe}, ${friend}, 'owed', '25.00', 'owed')`;
  await raw`insert into public.review (organization_id, platform, rating, posted_at, suggested_customer_id)
    values (${ORG}, 'google', 5, now(), ${dupe})`;
  return { keep, dupe, saved, friend };
}

/** Every row naming this customer in every column a merge moves, by id. */
async function holdings(customerId: string) {
  const out: Record<string, string[]> = {};
  for (const { table, column } of lifecycle.MERGE_MOVES) {
    const rows = await raw<{ id: string }[]>`
      select id from ${raw(`public.${table}`)} where ${raw(column)} = ${customerId} order by id`;
    if (rows.length > 0) out[`${table}.${column}`] = rows.map((r) => r.id);
  }
  return out;
}

const liveAdvertising = async (customerId: string) => (await raw<{ choice: string }[]>`
  select choice from public.advertising_consent where customer_id = ${customerId} and superseded_at is null`)
  .map((r) => r.choice);

run("what a merge moves", () => {
  it("names every column that points at a customer, as moved or as staying with a reason", async () => {
    const keys = await raw<{ table: string; column: string }[]>`
      select c.conrelid::regclass::text as table, a.attname as column
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.contype = 'f' and c.confrelid = 'public.customer'::regclass`;
    expect(keys.length).toBeGreaterThan(40);
    const named = new Set([
      ...lifecycle.MERGE_MOVES.map((r) => `${r.table}.${r.column}`),
      ...lifecycle.MERGE_LEAVES.map((r) => `${r.table}.${r.column}`),
    ]);
    const forgotten = keys.map((k) => `${k.table.replace(/^public\./, "")}.${k.column}`).filter((k) => !named.has(k));
    /**
     * A new table with a foreign key to `customer` goes in MOVES, HISTORY or
     * REFERENCES in `customer-lifecycle.ts`, or in MERGE_LEAVES with why.
     */
    expect(forgotten).toEqual([]);

    // And nothing named is a column that does not exist.
    for (const ref of [...lifecycle.MERGE_MOVES, ...lifecycle.MERGE_LEAVES]) {
      const [found] = await raw<{ n: number }[]>`
        select count(*)::int as n from information_schema.columns
        where table_schema = 'public' and table_name = ${ref.table} and column_name = ${ref.column}`;
      expect(found!.n, `${ref.table}.${ref.column}`).toBe(1);
    }
    const leaves = lifecycle.MERGE_LEAVES.filter((l) => l.why.trim() === "");
    expect(leaves).toEqual([]);
  });

  it("moves every table, says what stayed and why, and the undo puts both back exactly", async () => {
    const { keep, dupe, friend } = await household();
    const before = { keep: await holdings(keep), dupe: await holdings(dupe) };

    const merged = await lifecycle.merge(owner(), { keepId: keep, mergeId: dupe });
    const labels = merged.moved.map((m) => m.label);
    for (const label of [
      "projects", "credit notes", "credit payouts", "statements sent", "portal sign ins", "card processor records",
      "saved cards", "card payment agreements", "advertising answers", "files", "tasks", "container holds",
      "custom records", "campaign sends", "customers they referred", "referral rewards", "reviews matched to them",
      "property links",
    ]) expect(labels, label).toContain(label);
    expect(merged.stayed).toEqual([{
      label: "statements sent", n: 1, why: "The record kept was sent its own statement for the same month.",
    }]);

    // Everything but the one statement left the duplicate.
    const left = await holdings(dupe);
    expect(Object.keys(left)).toEqual(["statement_delivery.customer_id"]);
    expect(left["statement_delivery.customer_id"]).toHaveLength(1);
    const [friendRow] = await raw<{ referred_by_customer_id: string }[]>`
      select referred_by_customer_id from public.customer where id = ${friend}`;
    expect(friendRow!.referred_by_customer_id).toBe(keep);

    // The duplicate said no to advertising, so the person's live answer is no.
    expect(await liveAdvertising(keep)).toEqual(["refused"]);

    // Written down on the merge, and in the audit log with what stayed.
    const listed = await lifecycle.merges(owner(), { id: keep });
    expect(listed.merges[0]!.stayed).toEqual(merged.stayed);
    const [audited] = await raw<{ after: { stayed: unknown[]; superseded: unknown[] } }[]>`
      select after from public.audit_log
      where organization_id = ${ORG} and action = 'customer.merged' and entity_id = ${keep}`;
    expect(audited!.after.stayed).toHaveLength(1);
    expect(audited!.after.superseded).toHaveLength(1);

    await lifecycle.undoMerge(owner(), { id: merged.mergeRecordId });
    expect(await holdings(keep)).toEqual(before.keep);
    expect(await holdings(dupe)).toEqual(before.dupe);
    expect(await liveAdvertising(keep)).toEqual(["granted"]);
    expect(await liveAdvertising(dupe)).toEqual(["refused"]);
  });

  it("leaves a card that pays automatically with the duplicate when the record kept already pays automatically", async () => {
    const { keep, dupe, saved } = await household();
    const own = await card(keep, { autopay: true });
    // A second card of the duplicate's at the same processor, not paying automatically: it moves.
    const plain = await card(dupe, { autopay: false, profile: saved.profile });

    const merged = await lifecycle.merge(owner(), { keepId: keep, mergeId: dupe });
    const stayed = Object.fromEntries(merged.stayed.map((s) => [s.label, s]));
    expect(stayed["saved cards"]).toMatchObject({ n: 1 });
    expect(stayed["card payment agreements"]).toMatchObject({ n: 1, why: "Its card stayed with the duplicate." });
    expect(stayed["card processor records"]).toMatchObject({ n: 1 });

    const owners = async (table: string, ids: string[]) => (await raw<{ customer_id: string }[]>`
      select customer_id from ${raw(`public.${table}`)} where id = any(${ids}::uuid[]) order by id`).map((r) => r.customer_id);
    expect(await owners("saved_payment_method", [saved.card])).toEqual([dupe]);
    expect(await owners("payment_agreement", [saved.agreement])).toEqual([dupe]);
    expect(await owners("saved_payment_method", [plain.card])).toEqual([keep]);
    expect(await owners("payment_agreement", [plain.agreement])).toEqual([keep]);
    // The moved card still charges through the processor record it was saved under.
    const [through] = await raw<{ profile_id: string }[]>`select profile_id from public.saved_payment_method where id = ${plain.card}`;
    expect(through!.profile_id).toBe(saved.profile);
    expect(await owners("payment_profile", [saved.profile, own.profile])).toEqual(
      [saved.profile, own.profile].sort().map((id) => (id === saved.profile ? dupe : keep)),
    );
    // One card pays automatically for the record kept, as before.
    const [autopay] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.payment_agreement
      where customer_id = ${keep} and withdrawn_at is null and autopay_at is not null`;
    expect(autopay!.n).toBe(1);
  });

  it("refuses the undo once a card agreement is written to the record kept since", async () => {
    const { keep, dupe } = await household();
    const merged = await lifecycle.merge(owner(), { keepId: keep, mergeId: dupe });
    await card(keep, { autopay: false });
    await expect(lifecycle.undoMerge(owner(), { id: merged.mergeRecordId }))
      .rejects.toThrow(/1 card payment agreement was written to/);
  });

  it("moves nothing of another company's, whatever id it names", async () => {
    const { keep, dupe } = await household();
    const [theirs] = await raw<{ id: string }[]>`
      insert into public.portal_sign_in (organization_id, channel, address, expires_at, customer_id)
      values (${OTHER_ORG}, 'email', 'stranger@example.test', now(), ${dupe}) returning id`;
    await lifecycle.merge(owner(), { keepId: keep, mergeId: dupe });
    const [row] = await raw<{ customer_id: string }[]>`select customer_id from public.portal_sign_in where id = ${theirs!.id}`;
    expect(row!.customer_id).toBe(dupe);
    await raw`delete from public.portal_sign_in where id = ${theirs!.id}`;
  });

  it("refuses a removal while a credit note points at the customer", async () => {
    const someone = await make(`Credit Only ${Date.now()}`);
    await raw`insert into public.credit_note (organization_id, number, customer_id, reason)
      values (${ORG}, ${800000 + (++counter)}, ${someone}, 'goodwill')`;
    const check = await lifecycle.deletability(owner(), { id: someone });
    expect(check.deletable).toBe(false);
    expect(check.blockedBy.map((b) => b.label)).toEqual(["credit notes"]);
  });

  it("answers on the API with what stayed", async () => {
    const { keep, dupe } = await household();
    const response = await dispatch(new Request(`http://x/v1/customers/${keep}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `merge-all-${Date.now()}` },
      body: JSON.stringify({ mergeId: dupe }),
    }), { db: db(), resolveSession: async () => owner() });
    expect(response.status).toBe(201);
    const body = await response.json() as { stayed: { label: string; n: number; why: string }[] };
    expect(body.stayed).toEqual([{
      label: "statements sent", n: 1, why: "The record kept was sent its own statement for the same month.",
    }]);
  });
});
