import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as lifecycle from "../src/services/customer-lifecycle";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as contacts from "../src/services/contacts";
import * as billing from "../src/services/billing";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * TWO PERMISSIONS NOTHING CHECKED
 *
 * `customer:delete` and `customer:merge` were in the catalogue from the
 * first commit, both granted to the office manager preset, and neither was
 * ever asserted. A permission on a role's list that nothing checks is worse
 * than an absent one: the owner reading the list believes they granted a
 * capability, and the person holding the role finds there is no button.
 *
 * What happens instead is not nothing. A company that takes two leads from
 * the same person through two forms edits one row into something else, which
 * is how a CRM ends up with a customer called "DO NOT USE" and another
 * called "Smith (real one)", both carrying history attached to a lie.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cl:org");
const USER = fixtureId("cl:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Dedupe Co", slug: "dedupe-co" });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  /**
   * The ledger refuses a DELETE, by a trigger, on purpose: it is append only
   * and a correction is a reversing entry rather than a removal. A test
   * suspends the trigger for its own session rather than weakening it.
   */
  await raw.unsafe("set session_replication_role = replica");
  await raw`delete from public.ledger_entry where organization_id = ${ORG}`;
  await raw.unsafe("set session_replication_role = origin");
  await raw`delete from public.payment_allocation where organization_id = ${ORG}`;
  await raw`delete from public.payment where organization_id = ${ORG}`;
  await raw`delete from public.invoice_line where organization_id = ${ORG}`;
  await raw`delete from public.invoice where organization_id = ${ORG}`;
  await raw`delete from public.job where organization_id = ${ORG}`;
  await raw`delete from public.contact where organization_id = ${ORG}`;
  await raw`delete from public.customer_property where organization_id = ${ORG}`;
  await raw`delete from public.property where organization_id = ${ORG}`;
  await raw`update public.customer set merged_into_id = null where organization_id = ${ORG}`;
  await raw`delete from public.customer where organization_id = ${ORG}`;
});

const make = (name: string, over: Record<string, unknown> = {}) => customers.create(owner(), {
  type: "residential", name, paymentTermsDays: 0,
  taxExempt: false, tags: [], customFields: {}, ...over,
});

run("removing one", () => {
  it("takes a mis-keyed record off the books", async () => {
    const typo = await make("Jhon Smiht", { phone: "+15125550601" });

    const before = await lifecycle.deletability(owner(), { id: typo.id });
    expect(before.deletable).toBe(true);

    await lifecycle.remove(owner(), { id: typo.id, reason: "Keyed wrong at the counter." });

    const listed = await customers.list(owner(), { limit: 50, includeInactive: false });
    expect(listed.data.map((c) => c.id)).not.toContain(typo.id);
  });

  it("refuses when money points at them, and says merge instead", async () => {
    const real = await make("Ada Real", { phone: "+15125550602" });
    await billing.create(owner(), {
      customerId: real.id,
      lines: [{ name: "Service call", quantity: "1", unitPrice: "129.00", discountAmount: "0", taxable: false }],
    });

    /**
     * A hard delete cascades through the foreign keys and takes the invoice
     * with it. A soft delete leaves a receivable nobody can explain. Both
     * are worse than refusing, so this refuses.
     */
    const check = await lifecycle.deletability(owner(), { id: real.id });
    expect(check.deletable).toBe(false);
    expect(check.blockedBy.map((b) => b.label)).toContain("invoices");

    await expect(lifecycle.remove(owner(), { id: real.id, reason: "Duplicate." }))
      .rejects.toThrow(/merge them into the real one/i);
  });

  it("says what would go with them before anybody clicks", async () => {
    const customer = await make("Has History", { phone: "+15125550603" });
    const property = await properties.create(owner(), {
      address: { line1: "3 Gone Ln", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
      hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
    });
    await contacts.create(owner(), {
      name: "Site contact", customerId: customer.id, phone: "+15125550604",
    });

    /**
     * A delete refused after the click, with a list of reasons, is a worse
     * version of the same information. The answer decides which button the
     * screen should show.
     */
    const check = await lifecycle.deletability(owner(), { id: customer.id });
    expect(check.deletable).toBe(true);
    expect(check.wouldRemove.map((w) => w.label)).toEqual(
      expect.arrayContaining(["property links", "contacts"]),
    );
    void property;
  });

  it("refuses a removal with no reason", async () => {
    const customer = await make("No Reason", { phone: "+15125550605" });
    await expect(lifecycle.remove(owner(), { id: customer.id, reason: "  " }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a role without customer:delete", async () => {
    const customer = await make("Guarded", { phone: "+15125550606" });
    await expect(lifecycle.remove(as(["technician"]), { id: customer.id, reason: "No." }))
      .rejects.toBeInstanceOf(PermissionError);
  });
});

run("merging two", () => {
  it("moves the money as well as the history", async () => {
    const keep = await make("Ada Lovelace", { phone: "+15125550611" });
    const dupe = await make("A. Lovelace", { phone: "+15125550612" });

    await billing.create(owner(), {
      customerId: dupe.id,
      lines: [{ name: "Service call", quantity: "1", unitPrice: "129.00", discountAmount: "0", taxable: false }],
    });

    const result = await lifecycle.merge(owner(), { keepId: keep.id, mergeId: dupe.id });

    /**
     * The difference between this and delete. A merge does not discard a
     * history, it re-parents one, so the invoice raised against the
     * duplicate becomes an invoice against the survivor and the balance is
     * right for the first time.
     */
    expect(result.moved.map((m) => m.label)).toContain("invoices");

    const survivor = await customers.get(owner(), { id: keep.id });
    expect(Number(survivor.balance)).toBe(129);
  });

  it("does not rewrite the ledger, which is the one thing it must not move", async () => {
    const keep = await make("Ada Lovelace", { phone: "+15125550631" });
    const dupe = await make("A. Lovelace", { phone: "+15125550632" });

    const invoice = await billing.create(owner(), {
      customerId: dupe.id,
      lines: [{ name: "Service call", quantity: "1", unitPrice: "129.00", discountAmount: "0", taxable: false }],
    });
    void invoice;

    const [before] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.ledger_entry
      where organization_id = ${ORG} and customer_id = ${dupe.id}`;
    /** The fixture has to have posted something, or this asserts nothing. */
    expect(before!.n).toBeGreaterThan(0);

    await lifecycle.merge(owner(), { keepId: keep.id, mergeId: dupe.id });

    /**
     * `ledger_entry` has a trigger refusing UPDATE, because it is append
     * only and a correction is a reversing entry rather than an edit. The
     * trigger is right: a posting recorded against the duplicate WAS made
     * against the duplicate on the day it was made, and rewriting it changes
     * what the books say happened. The pointer left on the merged record is
     * what makes those entries resolve to the survivor, which is a different
     * thing from pretending they were always theirs.
     */
    const [after] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.ledger_entry
      where organization_id = ${ORG} and customer_id = ${dupe.id}`;
    expect(after!.n).toBe(before!.n);

    /** And the old id still resolves, which is what makes that bearable. */
    expect(await lifecycle.mergedInto(owner(), { id: dupe.id }))
      .toMatchObject({ id: keep.id });
  });

  it("keeps the duplicate and points it at the survivor", async () => {
    const keep = await make("Ada Lovelace", { phone: "+15125550613" });
    const dupe = await make("A. Lovelace", { phone: "+15125550614" });

    await lifecycle.merge(owner(), { keepId: keep.id, mergeId: dupe.id });

    /**
     * The duplicate's id is in a link somebody emailed, in an integration
     * that stored it, and in every audit row naming it. A merge that deleted
     * the row turns every one of those into a dead end.
     */
    const went = await lifecycle.mergedInto(owner(), { id: dupe.id });
    expect(went).toMatchObject({ id: keep.id, name: "Ada Lovelace" });

    /** And it is off the list, because it is not a customer any more. */
    const listed = await customers.list(owner(), { limit: 50, includeInactive: false });
    expect(listed.data.map((c) => c.id)).not.toContain(dupe.id);
  });

  it("fills the survivor's blanks and never overwrites them", async () => {
    const keep = await make("Ada Lovelace", { phone: "+15125550615" });
    const dupe = await make("A. Lovelace", {
      phone: "+15125550616", email: "ada@example.test",
    });

    const result = await lifecycle.merge(owner(), { keepId: keep.id, mergeId: dupe.id });
    expect(result.filled).toContain("email");

    /**
     * Never the other way. A merge is a decision about which record is
     * right, and overwriting the survivor's phone with the duplicate's would
     * undo the decision that was just made.
     */
    const survivor = await customers.get(owner(), { id: keep.id });
    expect(survivor.phone).toBe("+15125550615");
    expect(survivor.email).toBe("ada@example.test");
  });

  it("does not leave a property linked to the survivor twice", async () => {
    const keep = await make("Ada Lovelace", { phone: "+15125550617" });
    const dupe = await make("A. Lovelace", { phone: "+15125550618" });

    const property = await properties.create(owner(), {
      address: { line1: "5 Shared St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
      hasDog: false, customFields: {}, customerId: keep.id, customerRole: "owner",
    });
    await properties.link(owner(), {
      id: property.id, customerId: dupe.id, role: "owner", isPrimary: false,
    });

    await lifecycle.merge(owner(), { keepId: keep.id, mergeId: dupe.id });

    /**
     * Both rows are right and the address is one address. Every screen
     * listing the customer's properties would show it twice.
     */
    const [row] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.customer_property
      where organization_id = ${ORG} and customer_id = ${keep.id}
        and property_id = ${property.id}`;
    expect(row!.n).toBe(1);
  });

  it("refuses to merge a record into itself", async () => {
    const customer = await make("Only One", { phone: "+15125550619" });
    await expect(lifecycle.merge(owner(), { keepId: customer.id, mergeId: customer.id }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses to merge one that is already gone", async () => {
    const keep = await make("Ada", { phone: "+15125550620" });
    const dupe = await make("A.", { phone: "+15125550621" });
    await lifecycle.merge(owner(), { keepId: keep.id, mergeId: dupe.id });

    await expect(lifecycle.merge(owner(), { keepId: keep.id, mergeId: dupe.id }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a role without customer:merge", async () => {
    const keep = await make("Ada", { phone: "+15125550622" });
    const dupe = await make("A.", { phone: "+15125550623" });
    await expect(lifecycle.merge(as(["technician"]), { keepId: keep.id, mergeId: dupe.id }))
      .rejects.toBeInstanceOf(PermissionError);
  });

  it("returns nothing for a customer that was never merged", async () => {
    const customer = await make("Untouched", { phone: "+15125550624" });
    expect(await lifecycle.mergedInto(owner(), { id: customer.id })).toBeNull();
  });
});
