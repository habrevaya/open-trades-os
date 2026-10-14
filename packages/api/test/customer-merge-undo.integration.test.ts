import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as lifecycle from "../src/services/customer-lifecycle";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as contacts from "../src/services/contacts";
import * as notes from "../src/services/customer-notes";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { dispatch } from "../src/http/dispatch";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * TAKING A MERGE BACK
 *
 * Two people who share a phone number get merged, and somebody notices a
 * week later. The merge wrote down every row it moved, so an undo moves
 * exactly those back: the jobs, the invoices, the people, the addresses
 * (including the one both had, which the merge took out as a double), the
 * consent, the notes, the tags it added and the blank it filled. The two
 * customers are compared, table by table, to how they were before.
 *
 * And it is refused, in words, when anything has happened since that cannot
 * be put back: money written to the survivor, above all.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("merge-undo:org");
const USER = fixtureId("merge-undo:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Undo Co", slug: "merge-undo-co" });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw.unsafe("set session_replication_role = replica");
  await raw`delete from public.ledger_entry where organization_id = ${ORG}`;
  await raw.unsafe("set session_replication_role = origin");
  for (const table of [
    "payment_allocation", "payment", "invoice_line", "invoice", "visit", "job", "customer_note", "customer_merge",
    "communication_consent", "contact", "customer_property", "property",
  ]) {
    await raw`delete from ${raw(`public.${table}`)} where organization_id = ${ORG}`;
  }
  await raw`update public.customer set merged_into_id = null where organization_id = ${ORG}`;
  await raw`delete from public.customer where organization_id = ${ORG}`;
});

const make = async (name: string, over: Record<string, unknown> = {}) => (await customers.create(owner(), {
  type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {}, ...over,
})).id as string;

const address = (line1: string, customerId: string) => properties.create(owner(), {
  address: { line1, city: "Austin", state: "TX", postalCode: "78701", country: "US" },
  hasDog: false, customFields: {}, customerId, customerRole: "owner",
}).then((p) => p.id as string);

/**
 * Everything that hangs off a customer, by id, so two snapshots compare
 * exactly what each customer holds rather than how many.
 */
async function holdings(customerId: string) {
  const [row] = await raw<Record<string, unknown>[]>`
    select name, email, phone, tags, deleted_at is not null as gone, merged_into_id
    from public.customer where id = ${customerId}`;
  const ids = async (table: string, column = "customer_id") => (await raw<{ id: string }[]>`
    select id from ${raw(`public.${table}`)} where ${raw(column)} = ${customerId} order by id`).map((r) => r.id);
  const links = await raw<{ id: string; property_id: string; role: string; is_primary: boolean }[]>`
    select id, property_id, role, is_primary from public.customer_property where customer_id = ${customerId} order by property_id, id`;
  const [tagRows] = await raw<{ tags: string[] }[]>`
    select coalesce(array_agg(tag order by position), '{}') as tags from public.customer_tag where customer_id = ${customerId}`;
  return {
    customer: row,
    tagRows: tagRows!.tags,
    jobs: await ids("job"),
    invoices: await ids("invoice"),
    payments: await ids("payment"),
    contacts: await ids("contact"),
    consent: await ids("communication_consent"),
    notes: await ids("customer_note"),
    links: links.map((l) => ({ ...l })),
  };
}

/** Two records of one household: each with history, an address of its own and one they share. */
async function household() {
  const keep = await make("Dana Reyes", { phone: "+15125550801", tags: ["VIP"] });
  const dupe = await make("Dana Reyes (web form)", {
    phone: "+15125550802", email: "dana@example.test", tags: ["vip", "Landlord"],
  });
  const keepHome = await address("1 Keep St", keep);
  const dupeRental = await address("9 Rental Rd", dupe);
  const shared = await address("5 Shared Ave", keep);
  await properties.link(owner(), { id: shared, customerId: dupe, role: "owner", isPrimary: false });

  await jobs.create(owner(), { customerId: keep, propertyId: keepHome, summary: "Keep's tune up", tags: [], customFields: {} });
  await jobs.create(owner(), { customerId: dupe, propertyId: dupeRental, summary: "Rental leak", tags: [], customFields: {} });
  await billing.create(owner(), {
    customerId: dupe,
    lines: [{ name: "Service call", quantity: "1", unitPrice: "129.00", discountAmount: "0", taxable: false }],
  });
  await billing.pay(owner(), { customerId: dupe, method: "check", amount: "50.00", tipAmount: "0", allocations: [] });
  await contacts.create(owner(), { name: "Tess Tenant", customerId: dupe, propertyId: dupeRental, phone: "+15125550803" });
  await raw`insert into public.communication_consent (organization_id, customer_id, address, channel, purpose, state, method, proof_text)
    values (${ORG}, ${dupe}, '+15125550802', 'sms'::comm_channel, 'marketing'::comm_purpose, 'granted'::consent_state, 'verbal', 'Said yes on the phone')`;
  await notes.add(owner(), { id: dupe, body: "Rents out the place on Rental Rd." });
  return { keep, dupe, keepHome, dupeRental, shared };
}

run("undoing a merge", () => {
  it("moves exactly what the merge moved back, and both customers are as they were", async () => {
    const { keep, dupe } = await household();
    const before = { keep: await holdings(keep), dupe: await holdings(dupe) };

    const merged = await lifecycle.merge(owner(), { keepId: keep, mergeId: dupe, reason: "Same phone." });
    expect(merged.filled).toEqual(["email"]);
    expect(merged.tagsAdded).toEqual(["Landlord"]);
    const during = await holdings(keep);
    expect(during.jobs).toHaveLength(2);
    expect(during.invoices).toHaveLength(1);
    expect(during.notes).toHaveLength(1);
    expect(during.tagRows).toEqual(["VIP", "Landlord"]);
    // The shared address is linked once, not twice.
    expect(new Set(during.links.map((l) => l.property_id)).size).toBe(during.links.length);

    const listed = await lifecycle.merges(owner(), { id: keep });
    expect(listed.merges).toHaveLength(1);
    expect(listed.merges[0]).toMatchObject({ canUndo: true, blockedBy: [], merged: { id: dupe }, reason: "Same phone." });

    const undone = await lifecycle.undoMerge(owner(), { id: merged.mergeRecordId, reason: "Two people." });
    expect(undone).toMatchObject({ restoredId: dupe, filledCleared: ["email"], filledKept: [], tagsRemoved: ["Landlord"] });

    expect(await holdings(keep)).toEqual(before.keep);
    expect(await holdings(dupe)).toEqual(before.dupe);
    expect((await customers.get(owner(), { id: dupe })).name).toBe("Dana Reyes (web form)");

    const [audited] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action = 'customer.merge_undone' and entity_id = ${keep}`;
    expect(audited!.n).toBe(1);

    // Kept on the record, as something that happened, and not undone twice.
    const after = await lifecycle.merges(owner(), { id: keep });
    expect(after.merges[0]!.undone).toMatchObject({ reason: "Two people." });
    expect(after.merges[0]!.canUndo).toBe(false);
    await expect(lifecycle.undoMerge(owner(), { id: merged.mergeRecordId }))
      .rejects.toThrow(/already undone/);
  });

  it("is refused, naming it, once an invoice or a payment is written to the survivor", async () => {
    const { keep, dupe } = await household();
    const merged = await lifecycle.merge(owner(), { keepId: keep, mergeId: dupe });

    await billing.pay(owner(), { customerId: keep, method: "cash", amount: "20.00", tipAmount: "0", allocations: [] });
    await expect(lifecycle.undoMerge(owner(), { id: merged.mergeRecordId }))
      .rejects.toThrow(/Since the merge, 1 payment.*written to Dana Reyes\./);

    await billing.create(owner(), {
      customerId: keep,
      lines: [{ name: "Filter", quantity: "1", unitPrice: "20.00", discountAmount: "0", taxable: false }],
    });
    const listed = await lifecycle.merges(owner(), { id: keep });
    expect(listed.merges[0]!.canUndo).toBe(false);
    expect(listed.merges[0]!.blockedBy.join(" ")).toMatch(/1 invoice/);
    expect(listed.merges[0]!.blockedBy.join(" ")).toMatch(/payment/);

    // Nothing moved: the refusal changed nothing.
    expect((await holdings(dupe)).customer).toMatchObject({ gone: true, merged_into_id: keep });
  });

  it("leaves what was written to the survivor since with the survivor", async () => {
    const { keep, dupe, keepHome } = await household();
    const merged = await lifecycle.merge(owner(), { keepId: keep, mergeId: dupe });
    const later = await notes.add(owner(), { id: keep, body: "Written after the merge." });
    const job = await jobs.create(owner(), { customerId: keep, propertyId: keepHome, summary: "Booked since, at home", tags: [], customFields: {} });

    await lifecycle.undoMerge(owner(), { id: merged.mergeRecordId });
    const kept = await holdings(keep);
    expect(kept.notes).toContain(later.id);
    expect(kept.jobs).toContain(job.id);
  });

  it("is refused for work booked since at an address that would go back", async () => {
    const { keep, dupe, dupeRental } = await household();
    const merged = await lifecycle.merge(owner(), { keepId: keep, mergeId: dupe });
    await jobs.create(owner(), { customerId: keep, propertyId: dupeRental, summary: "At the rental", tags: [], customFields: {} });
    await expect(lifecycle.undoMerge(owner(), { id: merged.mergeRecordId }))
      .rejects.toThrow(/1 job was booked for Dana Reyes at an address that would go back/);
  });

  it("is refused when something it moved has moved on, and after thirty days", async () => {
    const { keep, dupe } = await household();
    const merged = await lifecycle.merge(owner(), { keepId: keep, mergeId: dupe });
    const third = await make("Somebody Else", { phone: "+15125550899" });
    await raw`update public.contact set customer_id = ${third} where customer_id = ${keep}`;
    await raw`update public.customer_merge set created_at = now() - interval '31 days' where id = ${merged.mergeRecordId}`;
    const listed = await lifecycle.merges(owner(), { id: keep });
    const said = listed.merges[0]!.blockedBy.join(" ");
    expect(said).toMatch(/can be undone for 30 days/);
    expect(said).toMatch(/1 contact the merge moved is no longer on Dana Reyes/);
    await expect(lifecycle.undoMerge(owner(), { id: merged.mergeRecordId })).rejects.toBeInstanceOf(ConflictError);
  });

  it("needs the permission the merge needs, on the API, and a retry is the first answer", async () => {
    const { keep, dupe } = await household();
    const merged = await lifecycle.merge(owner(), { keepId: keep, mergeId: dupe });
    await expect(lifecycle.undoMerge(as(["csr"]), { id: merged.mergeRecordId })).rejects.toBeInstanceOf(PermissionError);
    await expect(lifecycle.merges(as(["csr"]), { id: keep })).rejects.toBeInstanceOf(PermissionError);

    const call = async (method: string, path: string, body: unknown, ctx: ServiceContext, key: string) => {
      const response = await dispatch(new Request(`http://x${path}`, {
        method, headers: { "content-type": "application/json", "idempotency-key": key },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { db: db(), resolveSession: async () => ctx });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const refused = await call("POST", `/v1/customer-merges/${merged.mergeRecordId}/undo`, {}, as(["csr"]), "undo-csr");
    expect(refused.status).toBe(403);
    const listed = await call("GET", `/v1/customers/${keep}/merges`, undefined, owner(), "undo-list");
    expect(listed.status).toBe(200);
    const key = `undo-${Date.now()}`;
    const first = await call("POST", `/v1/customer-merges/${merged.mergeRecordId}/undo`, { reason: "Two people." }, owner(), key);
    expect(first.status).toBe(201);
    const again = await call("POST", `/v1/customer-merges/${merged.mergeRecordId}/undo`, { reason: "Two people." }, owner(), key);
    expect(again).toEqual(first);
  });
});
