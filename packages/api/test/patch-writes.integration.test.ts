import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as priceBook from "../src/services/pricebook";
import * as roleService from "../src/services/roles";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * A FIELD A PATCH ACCEPTS IS A FIELD THE PATCH WRITES
 *
 * The quietest defect this codebase produces, and the one nothing else here
 * catches.
 *
 * An update service is a list of spread guards, one per field, and the
 * contract's input is built with `.partial()` off the create shape. Nothing
 * connects them. A field added to the contract and not to the service
 * produces a request that validates, returns 200, returns the unchanged row,
 * and writes nothing. The caller has no way to know: they sent a value, they
 * got a success, and the field they can see in the response is the old one
 * they were trying to replace.
 *
 * That is strictly worse than an unknown field, which at least fails
 * validation. It is also worse than a missing endpoint, which somebody
 * notices.
 *
 * WHAT THIS TEST DOES. For each PATCH-shaped route, it sends a value for
 * every field the contract accepts, reads the row back, and asserts each one
 * changed. Fields genuinely not stored on the row are named individually in
 * an exclusion list with a reason, so the exclusion is a decision somebody
 * made rather than a gap.
 *
 * Found on the first run: `updateCustomer` accepted `paymentTermsDays`,
 * `billingAddress` and `customFields` and wrote none of them.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("patch:org");
const USER = fixtureId("patch:user");

let raw: postgres.Sql;
let customerId = "";
let propertyId = "";

const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Patch Co", slug: "patch-co" });

  const customer = await customers.create(owner(), {
    type: "residential", name: "Before", phone: "+15125550111",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const property = await properties.create(owner(), {
    address: { line1: "1 Patch Pl", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  propertyId = property.id;
});

afterAll(async () => { if (raw) await raw.end(); });

run("updating a customer writes everything it accepts", () => {
  it("does not silently drop a field", async () => {
    const changed = {
      name: "After",
      email: "after@example.test",
      phone: "+15125559999",
      type: "commercial" as const,
      leadSource: "referral_customer",
      paymentTermsDays: 30,
      taxExempt: true,
      tags: ["vip"],
      customFields: { gateCode: "4417" },
      billingAddress: {
        line1: "2 Billing Way", city: "Dallas", state: "TX",
        postalCode: "75201", country: "US",
      },
      doNotService: true,
      doNotServiceReason: "Threatened a technician in March.",
    };

    await customers.update(owner(), { id: customerId, ...changed });

    const [row] = await raw<Record<string, unknown>[]>`
      select name, email, phone, type, lead_source, payment_terms_days,
             tax_exempt, tags, custom_fields,
             billing_address_line1, billing_city, billing_state, billing_postal_code,
             do_not_service, do_not_service_reason
      from public.customer where id = ${customerId}`;

    /**
     * Asserted field by field rather than as one object, so a failure names
     * the column that was dropped instead of printing two rows to diff.
     */
    expect(row!["name"]).toBe("After");
    expect(row!["email"]).toBe("after@example.test");
    expect(row!["phone"]).toBe("+15125559999");
    expect(row!["type"]).toBe("commercial");
    expect(row!["lead_source"]).toBe("referral_customer");
    /** Stored as text: imports arrive with "30 days" in the field. */
    expect(row!["payment_terms_days"], "accepted and dropped").toBe("30");
    expect(row!["tax_exempt"]).toBe(true);
    expect(row!["tags"]).toEqual(["vip"]);
    expect(row!["custom_fields"], "accepted and dropped").toEqual({ gateCode: "4417" });
    /**
     * Spread across columns rather than held as one blob, so the assertion
     * names them. An address kept as jsonb cannot be searched, and finding
     * every customer in one city is an ordinary thing to want.
     */
    expect(row!["billing_address_line1"], "accepted and dropped").toBe("2 Billing Way");
    expect(row!["billing_city"]).toBe("Dallas");
    expect(row!["billing_state"]).toBe("TX");
    expect(row!["billing_postal_code"]).toBe("75201");
    expect(row!["do_not_service"]).toBe(true);
    expect(row!["do_not_service_reason"]).toContain("March");
  });

  it("leaves a field alone when the patch omits it", async () => {
    /**
     * The other half, and the one a naive fix breaks: a PATCH that wrote
     * every column unconditionally would blank everything the caller did
     * not mention, which is the classic way a partial update destroys data.
     */
    await customers.update(owner(), { id: customerId, name: "Renamed" });

    const [row] = await raw<Record<string, unknown>[]>`
      select name, payment_terms_days, custom_fields, do_not_service
      from public.customer where id = ${customerId}`;
    expect(row!["name"]).toBe("Renamed");
    expect(row!["payment_terms_days"]).toBe("30");
    expect(row!["custom_fields"]).toEqual({ gateCode: "4417" });
    expect(row!["do_not_service"]).toBe(true);
  });

  it("refuses to bar a customer with no reason recorded", async () => {
    /**
     * A customer nobody may work for, with no reason, is a decision the
     * next person cannot evaluate and will not overturn. It stays on the
     * record forever because nobody dares lift something they cannot
     * explain.
     */
    const fresh = await customers.create(owner(), {
      type: "residential", name: "Unexplained", phone: "+15125550444",
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });
    await expect(customers.update(owner(), { id: fresh.id, doNotService: true }))
      .rejects.toThrow(/Say why/);
  });

  it("clears the reason when the bar is lifted", async () => {
    /**
     * So a customer reinstated in March does not keep last year's note
     * sitting under a flag that is no longer set.
     */
    const fresh = await customers.create(owner(), {
      type: "residential", name: "Reinstated", phone: "+15125550555",
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });
    await customers.update(owner(), {
      id: fresh.id, doNotService: true, doNotServiceReason: "Non payment.",
    });
    await customers.update(owner(), { id: fresh.id, doNotService: false });

    const [row] = await raw<{ do_not_service: boolean; do_not_service_reason: string | null }[]>`
      select do_not_service, do_not_service_reason from public.customer where id = ${fresh.id}`;
    expect(row!.do_not_service).toBe(false);
    expect(row!.do_not_service_reason).toBeNull();
  });

  it("can clear a nullable field rather than only setting one", async () => {
    /**
     * `undefined` means "leave it" and `null` means "clear it", and the
     * spread guard pattern collapses them if it tests truthiness instead of
     * `!== undefined`. A customer whose email is wrong needs a way to remove
     * it, not only to replace it.
     */
    await customers.update(owner(), { id: customerId, email: null });
    const [row] = await raw<{ email: string | null }[]>`
      select email from public.customer where id = ${customerId}`;
    expect(row!.email).toBeNull();
  });
});

run("updating a job writes everything it accepts", () => {
  it("does not silently drop a field", async () => {
    const job = await jobs.create(owner(), {
      customerId, propertyId, summary: "Before", tags: [], customFields: {},
    });

    await jobs.update(owner(), {
      id: job.id,
      summary: "After",
      description: "A description.",
      customerComplaint: "It makes a noise.",
      leadSource: "yard_sign",
      purchaseOrderNumber: "PO-991",
      costCode: "CC-4",
      priority: 2,
      tags: ["urgent"],
      customFields: { floor: "2" },
    });

    const [row] = await raw<Record<string, unknown>[]>`
      select summary, description, customer_complaint, lead_source,
             purchase_order_number, cost_code, priority, tags, custom_fields
      from public.job where id = ${job.id}`;

    expect(row!["summary"]).toBe("After");
    expect(row!["description"]).toBe("A description.");
    expect(row!["customer_complaint"]).toBe("It makes a noise.");
    expect(row!["lead_source"]).toBe("yard_sign");
    expect(row!["purchase_order_number"]).toBe("PO-991");
    expect(row!["cost_code"]).toBe("CC-4");
    expect(row!["priority"]).toBe(2);
    expect(row!["tags"]).toEqual(["urgent"]);
    expect(row!["custom_fields"]).toEqual({ floor: "2" });
  });
});

/**
 * A FIELD A CONTRACT PUBLISHES IS A FIELD SOMETHING WRITES
 *
 * The same defect one layer up. `parentJobId`, `isWarranty` and
 * `priceSource` were on the Job shape from the beginning and nothing ever
 * wrote any of them, so a generated client had three fields whose values
 * were permanently the column defaults.
 *
 * Two of those were not merely cosmetic. Without `parentJobId` the callback
 * rate, which is the number a service manager watches, had no numerator; and
 * the review request rule that withholds an ask while a callback is open
 * could never fire, so customers were asked to review work we were still
 * coming back to fix.
 */
run("a job can be a return visit for another job", () => {
  it("links a callback to its parent", async () => {
    const original = await jobs.create(owner(), {
      customerId, propertyId, summary: "Original", tags: [], customFields: {},
    });
    const callback = await jobs.create(owner(), {
      customerId, propertyId, summary: "Back again", tags: [], customFields: {},
      parentJobId: original.id, isWarranty: true,
    });

    const [row] = await raw<{ parent_job_id: string; is_warranty: boolean }[]>`
      select parent_job_id, is_warranty from public.job where id = ${callback.id}`;
    expect(row!.parent_job_id).toBe(original.id);
    expect(row!.is_warranty).toBe(true);
  });

  it("refuses a parent belonging to a different customer", async () => {
    /**
     * The one that would slip through. A callback counted against unrelated
     * work makes the callback rate meaningless, and makes the review rule
     * withhold an ask from the wrong person.
     */
    const other = await customers.create(owner(), {
      type: "residential", name: "Someone Else", phone: "+15125550777",
      paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    });
    const theirs = await properties.create(owner(), {
      address: { line1: "9 Other Ave", city: "Austin", state: "TX", postalCode: "78702", country: "US" },
      hasDog: false, customFields: {}, customerId: other.id, customerRole: "owner",
    });
    const theirJob = await jobs.create(owner(), {
      customerId: other.id, propertyId: theirs.id, summary: "Theirs",
      tags: [], customFields: {},
    });

    await expect(jobs.create(owner(), {
      customerId, propertyId, summary: "Wrong parent", tags: [], customFields: {},
      parentJobId: theirJob.id,
    })).rejects.toThrow(/different customer/);
  });

  it("refuses a job that is its own parent", async () => {
    const job = await jobs.create(owner(), {
      customerId, propertyId, summary: "Self", tags: [], customFields: {},
    });
    await expect(jobs.update(owner(), { id: job.id, parentJobId: job.id }))
      .rejects.toThrow(/itself/);
  });

  it("records whose price governed, rather than always the price book", async () => {
    /**
     * Published as a bare string while nothing wrote it, so the value was
     * permanently the literal "price_book". A job priced off a commercial
     * rate card that reported price_book makes every margin report wrong
     * about work we did not price.
     */
    const job = await jobs.create(owner(), {
      customerId, propertyId, summary: "On contract", tags: [], customFields: {},
      priceSource: "rate_card",
    });
    const [row] = await raw<{ price_source: string }[]>`
      select price_source from public.job where id = ${job.id}`;
    expect(row!.price_source).toBe("rate_card");
  });
});

/**
 * A FILTER OVER A COLUMN NOTHING CAN CLEAR
 *
 * Three of these, and one of them was a working password for somebody who
 * left.
 */
run("things that could be filtered and never set", () => {
  it("retires a price book item, which nothing could do", async () => {
    /**
     * `active` was filtered on by the list and published as
     * `includeInactive`, so the filter's only possible answer was
     * everything, and an item discontinued last season stayed on every
     * technician's tablet forever.
     */
    const [jobType] = await raw<{ id: string }[]>`insert into public.job_type
      (organization_id, name, capacity_model)
      values (${ORG}, 'Retire test', 'technician_dispatch') returning id`;
    void jobType;

    const item = await priceBook.create(owner(), {
      kind: "material", code: "OLD-1", name: "Discontinued capacitor",
      price: "40.00", taxable: true,
    });

    const before = await priceBook.list(owner(), { limit: 100, includeInactive: false });
    expect(before.data.map((i) => i.code)).toContain("OLD-1");

    await priceBook.setActive(owner(), { id: item.id, active: false, reason: "Superseded." });

    const after = await priceBook.list(owner(), { limit: 100, includeInactive: false });
    expect(after.data.map((i) => i.code)).not.toContain("OLD-1");

    /** Retired, not gone: the flag exists so old invoice lines keep resolving. */
    const withInactive = await priceBook.list(owner(), { limit: 100, includeInactive: true });
    expect(withInactive.data.map((i) => i.code)).toContain("OLD-1");
  });

  it("deactivating twice is not an error", async () => {
    const item = await priceBook.create(owner(), {
      kind: "material", code: "OLD-2", name: "Another",
      price: "10.00", taxable: true,
    });
    await priceBook.setActive(owner(), { id: item.id, active: false });
    await expect(priceBook.setActive(owner(), { id: item.id, active: false }))
      .resolves.toMatchObject({ active: false });
  });

  it("sets a property's territory, which only a filter could read", async () => {
    const [territory] = await raw<{ id: string }[]>`insert into public.territory
      (organization_id, name) values (${ORG}, 'North') returning id`;

    await properties.update(owner(), { id: propertyId, territoryId: territory!.id });

    const [row] = await raw<{ territory_id: string }[]>`
      select territory_id from public.property where id = ${propertyId}`;
    expect(row!.territory_id).toBe(territory!.id);

    const found = await properties.list(owner(), { limit: 10, territoryId: territory!.id });
    expect(found.data.map((p) => p.id)).toContain(propertyId);
  });

  it("refuses a territory that is not there", async () => {
    await expect(properties.update(owner(), {
      id: propertyId, territoryId: fixtureId("patch:nonexistent"),
    })).rejects.toThrow(/Territory/);
  });

  it("does not touch the address, because a property is its address", async () => {
    /**
     * Left off the update deliberately. Retyping it turns one house into
     * another with ten years of service history attached.
     */
    const before = await raw<{ address_line1: string }[]>`
      select address_line1 from public.property where id = ${propertyId}`;
    await properties.update(owner(), { id: propertyId, gateCode: "9182" });
    const after = await raw<{ address_line1: string; gate_code: string }[]>`
      select address_line1, gate_code from public.property where id = ${propertyId}`;
    expect(after[0]!.address_line1).toBe(before[0]!.address_line1);
    expect(after[0]!.gate_code).toBe("9182");
  });
});

run("the door", () => {
  const aMember = async (name: string) => {
    /**
     * A unique address per call. The email index is global rather than per
     * tenant, so a fixture reusing one collides with whatever a previous run
     * left behind.
     */
    const email = `${name}-${Math.random().toString(36).slice(2, 10)}@patch.test`;
    const [user] = await raw<{ id: string }[]>`
      insert into public."user" (email, name) values (${email}, ${name}) returning id`;
    const [membership] = await raw<{ id: string }[]>`
      insert into public.membership (organization_id, user_id, role, active)
      values (${ORG}, ${user!.id}, 'technician', true) returning id`;
    return { userId: user!.id, membershipId: membership!.id };
  };

  it("offboards somebody and ends their sessions in the same transaction", async () => {
    /**
     * `membership.active` decides whether a login succeeds and nothing could
     * make it false. An employee who left on Friday kept a working password,
     * their sessions and every permission their role carried.
     *
     * Flipping the flag alone would leave anybody already signed in signed
     * in for days. An offboarding that takes effect on Thursday is not an
     * offboarding.
     */
    const { userId, membershipId } = await aMember("leaver");
    const token = () => `hash-${Math.random().toString(36).slice(2, 12)}`;
    await raw`insert into public.session (user_id, token_hash, expires_at)
      values (${userId}, ${token()}, now() + interval '7 days')`;
    await raw`insert into public.session (user_id, token_hash, expires_at)
      values (${userId}, ${token()}, now() + interval '7 days')`;

    const result = await roleService.setMembershipActive(owner(), {
      membershipId, active: false, reason: "Left the company.",
    });
    expect(result.sessionsRevoked).toBe(2);

    const [row] = await raw<{ active: boolean }[]>`
      select active from public.membership where id = ${membershipId}`;
    expect(row!.active).toBe(false);

    const live = await raw<{ id: string }[]>`
      select id from public.session where user_id = ${userId} and revoked_at is null`;
    expect(live).toHaveLength(0);
  });

  it("keeps the record of what they did", async () => {
    /**
     * Deactivated, not deleted. Every job they ran points at them, and "who
     * was on site" has to have an answer years later.
     */
    const { userId, membershipId } = await aMember("kept");
    await roleService.setMembershipActive(owner(), { membershipId, active: false });

    const [user] = await raw<{ id: string }[]>`
      select id from public."user" where id = ${userId}`;
    expect(user, "the user row survives").toBeTruthy();
  });

  it("brings somebody back", async () => {
    const { membershipId } = await aMember("returner");
    await roleService.setMembershipActive(owner(), { membershipId, active: false });
    const back = await roleService.setMembershipActive(owner(), { membershipId, active: true });
    expect(back.active).toBe(true);
    expect(back.sessionsRevoked, "nothing to revoke on the way back in").toBe(0);
  });

  it("refuses to let somebody lock themselves out", async () => {
    /**
     * The account that could undo it is the one they just turned off.
     */
    const [mine] = await raw<{ id: string }[]>`
      select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
    await expect(roleService.setMembershipActive(owner(), { membershipId: mine!.id, active: false }))
      .rejects.toThrow(/your own membership/);
  });

  it("refuses to deactivate the last owner", async () => {
    /**
     * THE ONLY SHAPE THIS RULE CAN FIRE IN, and my first version of this
     * test could not reach it.
     *
     * If the actor is an owner and the target is a different owner, there
     * are by definition two, so the check never applies. It exists for the
     * administrator who is not an owner: an admin can edit users,
     * and deactivating the company's only owner leaves nobody who can grant
     * anybody the permission to become one.
     */
    const [manager] = await raw<{ id: string }[]>`
      insert into public."user" (email, name)
      values (${`mgr-${Math.random().toString(36).slice(2, 10)}@patch.test`}, 'Manager')
      returning id`;
    await raw`insert into public.membership (organization_id, user_id, role, active)
      values (${ORG}, ${manager!.id}, 'admin', true)`;

    const [onlyOwner] = await raw<{ id: string }[]>`
      select id from public.membership
       where organization_id = ${ORG} and user_id = ${USER}`;

    const asManager: ServiceContext = {
      actor: {
        userId: manager!.id, organizationId: ORG,
        roles: ["admin"] as Actor["roles"],
      },
      db: db(),
    };

    await expect(roleService.setMembershipActive(asManager, {
      membershipId: onlyOwner!.id, active: false,
    })).rejects.toThrow(/only active owner/);
  });
});
