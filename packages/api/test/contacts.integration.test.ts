import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as contacts from "../src/services/contacts";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as dispatchSvc from "../src/services/dispatch";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * WHO OPENS THE DOOR
 *
 * `contact` was in the first migrations and read in exactly one place:
 * `notifiableAddress`, which decides whose phone gets the "your technician is
 * on the way" text. That function carries a four way ranking and a comment
 * explaining why the property's contact beats the customer's, because on a
 * rental the customer is the landlord and the person at the door is the
 * tenant.
 *
 * Nothing ever inserted a contact. The ranking sorted an empty list every
 * time, fell through to the customer's own number, and on every rental the
 * landlord got the text and the tenant did not. The code describing the
 * failure was the code producing it.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("ct2:org");
const USER = fixtureId("ct2:user");
const OUR_NUMBER = "+15125559961";
const LANDLORD_PHONE = "+15125550401";
const TENANT_PHONE = "+15125550402";
const MANAGER_PHONE = "+15125550403";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let landlordId = "";
let rentalId = "";
let otherPropertyId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Contact Co", slug: "contact-co-2" });
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
    values (${ORG}, ${OUR_NUMBER}, 'main', true)`;

  const landlord = await customers.create(owner(), {
    type: "residential", name: "Leo Landlord", phone: LANDLORD_PHONE,
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  landlordId = landlord.id;

  const rental = await properties.create(owner(), {
    address: { line1: "4 Rental Rd", city: "Austin", state: "TX", postalCode: "78702", country: "US" },
    hasDog: false, customFields: {}, customerId: landlord.id, customerRole: "owner",
  });
  rentalId = rental.id;

  const other = await properties.create(owner(), {
    address: { line1: "8 Other Ave", city: "Austin", state: "TX", postalCode: "78703", country: "US" },
    hasDog: false, customFields: {}, customerId: landlord.id, customerRole: "owner",
  });
  otherPropertyId = other.id;

  /** Consent, so the send is about the recipient rather than about the gate. */
  for (const address of [LANDLORD_PHONE, TENANT_PHONE, MANAGER_PHONE]) {
    await raw`insert into public.communication_consent
      (organization_id, address, channel, purpose, state, method, captured_at)
      values (${ORG}, ${address}, 'sms', 'transactional', 'granted', 'verbal', now())`;
  }
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.contact where organization_id = ${ORG}`;
  await raw`delete from public.arrival_notice where organization_id = ${ORG}`;
  await raw`delete from public.message where organization_id = ${ORG}`;
  await raw`delete from public.conversation where organization_id = ${ORG}`;
  await raw`delete from public.portal_grant where organization_id = ${ORG}`;
  await raw`delete from public.portal_event where organization_id = ${ORG}`;
  await raw`delete from public.visit where organization_id = ${ORG}`;
  await raw`delete from public.job where organization_id = ${ORG}`;
});

async function makeVisit(propertyId = rentalId) {
  const [job] = await raw`insert into public.job
    (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${Math.floor(Math.random() * 1e6)}, ${landlordId}, ${propertyId},
            'scheduled', 'No hot water') returning id`;
  const [visit] = await raw`insert into public.visit
    (organization_id, job_id, status) values (${ORG}, ${job!.id}, 'dispatched') returning id`;
  return visit!.id as string;
}

const textedTo = async () => {
  const rows = await raw<{ to_address: string }[]>`
    select to_address from public.message
    where organization_id = ${ORG} and direction = 'outbound' order by created_at`;
  return rows.map((r) => r.to_address);
};

run("who gets the on-my-way text", () => {
  it("goes to the landlord when nobody is on the property", async () => {
    /**
     * The state the product shipped in, kept as a test rather than deleted:
     * with no contacts this is correct, and it is also the only thing that
     * could ever happen.
     */
    const visitId = await makeVisit();
    await dispatchSvc.onMyWay(owner(), { id: visitId, channel: "sms", includeTracking: false });
    expect(await textedTo()).toEqual([LANDLORD_PHONE]);
  });

  it("goes to the tenant once the tenant exists", async () => {
    await contacts.create(owner(), {
      name: "Tess Tenant", propertyId: rentalId, phone: TENANT_PHONE,
    });

    const visitId = await makeVisit();
    await dispatchSvc.onMyWay(owner(), { id: visitId, channel: "sms", includeTracking: false });

    /**
     * The whole finding. Texting the landlord that somebody is fifteen
     * minutes away helps nobody standing outside a house.
     */
    expect(await textedTo()).toEqual([TENANT_PHONE]);
  });

  it("prefers the person at the property over the customer's own contact", async () => {
    await contacts.create(owner(), {
      name: "Mia Manager", customerId: landlordId, phone: MANAGER_PHONE, isPrimary: true,
    });
    await contacts.create(owner(), {
      name: "Tess Tenant", propertyId: rentalId, phone: TENANT_PHONE,
    });

    const visitId = await makeVisit();
    await dispatchSvc.onMyWay(owner(), { id: visitId, channel: "sms", includeTracking: false });
    expect(await textedTo()).toEqual([TENANT_PHONE]);
  });

  it("does not text a tenant about a different address", async () => {
    await contacts.create(owner(), {
      name: "Tess Tenant", propertyId: rentalId, phone: TENANT_PHONE,
    });

    /**
     * The contact is attached to the rental, and this visit is at the other
     * property. A contact scoped to nothing in particular would text
     * somebody about a house they have never been to.
     */
    const visitId = await makeVisit(otherPropertyId);
    await dispatchSvc.onMyWay(owner(), { id: visitId, channel: "sms", includeTracking: false });
    expect(await textedTo()).toEqual([LANDLORD_PHONE]);
  });

  it("still texts somebody who prefers email when they are the only one there", async () => {
    await contacts.create(owner(), {
      name: "Ed Email", propertyId: rentalId, phone: TENANT_PHONE,
      email: "ed@example.test", preferredChannel: "email",
    });

    /**
     * Preference orders the ranking, it does not filter it. The alternative
     * is a technician arriving at a door nobody knew about.
     */
    const visitId = await makeVisit();
    await dispatchSvc.onMyWay(owner(), { id: visitId, channel: "sms", includeTracking: false });
    expect(await textedTo()).toEqual([TENANT_PHONE]);
  });

  it("stops texting somebody who has been taken off", async () => {
    const tenant = await contacts.create(owner(), {
      name: "Tess Tenant", propertyId: rentalId, phone: TENANT_PHONE,
    });
    await contacts.remove(owner(), { id: tenant.id });

    const visitId = await makeVisit();
    await dispatchSvc.onMyWay(owner(), { id: visitId, channel: "sms", includeTracking: false });
    expect(await textedTo()).toEqual([LANDLORD_PHONE]);
  });
});

run("what a contact has to be", () => {
  it("refuses one attached to neither a customer nor a property", async () => {
    await expect(contacts.create(owner(), { name: "Nobody", phone: TENANT_PHONE }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses one with no way to reach them", async () => {
    await expect(contacts.create(owner(), { name: "Unreachable", propertyId: rentalId }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a preference for a channel they have no address on", async () => {
    await expect(contacts.create(owner(), {
      name: "Ed", propertyId: rentalId, email: "ed@example.test", preferredChannel: "sms",
    })).rejects.toThrow(/prefer texts/i);

    await expect(contacts.create(owner(), {
      name: "Tess", propertyId: rentalId, phone: TENANT_PHONE, preferredChannel: "email",
    })).rejects.toThrow(/prefer email/i);
  });

  it("refuses a channel this product does not send on", async () => {
    await expect(contacts.create(owner(), {
      name: "Fax Frank", propertyId: rentalId, phone: TENANT_PHONE,
      preferredChannel: "fax" as never,
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a property that does not exist", async () => {
    await expect(contacts.create(owner(), {
      name: "Ghost", propertyId: fixtureId("ct2:missing"), phone: TENANT_PHONE,
    })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a contact to a role that cannot edit customers", async () => {
    await expect(contacts.create(as(["technician"]), {
      name: "Tess", propertyId: rentalId, phone: TENANT_PHONE,
    })).rejects.toBeInstanceOf(PermissionError);
  });
});

run("one primary", () => {
  it("demotes the others when a new one is promoted", async () => {
    const first = await contacts.create(owner(), {
      name: "First", customerId: landlordId, phone: MANAGER_PHONE, isPrimary: true,
    });
    const second = await contacts.create(owner(), {
      name: "Second", customerId: landlordId, phone: TENANT_PHONE, isPrimary: true,
    });

    /**
     * `isPrimary` is a term in the ranking that decides who gets a text. Two
     * of them means the recipient is settled by whichever row the index
     * returned, which is a message to a customer decided by a race.
     */
    const rows = await contacts.list(owner(), { customerId: landlordId });
    expect(rows.filter((r) => r.isPrimary).map((r) => r.id)).toEqual([second.id]);
    expect(rows.find((r) => r.id === first.id)!.isPrimary).toBe(false);
  });

  it("demotes on an update too, not only on create", async () => {
    const first = await contacts.create(owner(), {
      name: "First", customerId: landlordId, phone: MANAGER_PHONE, isPrimary: true,
    });
    const second = await contacts.create(owner(), {
      name: "Second", customerId: landlordId, phone: TENANT_PHONE,
    });

    await contacts.update(owner(), { id: second.id, name: "Second", isPrimary: true });

    const rows = await contacts.list(owner(), { customerId: landlordId });
    expect(rows.filter((r) => r.isPrimary).map((r) => r.id)).toEqual([second.id]);
    void first;
  });

  it("keeps the customer's primary and the property's primary apart", async () => {
    const atCustomer = await contacts.create(owner(), {
      name: "Mia Manager", customerId: landlordId, phone: MANAGER_PHONE, isPrimary: true,
    });
    const atProperty = await contacts.create(owner(), {
      name: "Tess Tenant", propertyId: rentalId, phone: TENANT_PHONE, isPrimary: true,
    });

    /**
     * Two different questions: the primary person for this landlord, and the
     * primary person at this address. Demoting across one scope only would
     * leave the other with two; demoting across both as if they were one
     * would mean naming a tenant primary silently unnames the manager.
     */
    const byCustomer = await contacts.list(owner(), { customerId: landlordId });
    expect(byCustomer.find((r) => r.id === atCustomer.id)!.isPrimary).toBe(true);

    const byProperty = await contacts.list(owner(), { propertyId: rentalId });
    expect(byProperty.find((r) => r.id === atProperty.id)!.isPrimary).toBe(true);
  });

  it("does not leave a removed contact as the primary", async () => {
    const only = await contacts.create(owner(), {
      name: "Gone", customerId: landlordId, phone: MANAGER_PHONE, isPrimary: true,
    });
    await contacts.remove(owner(), { id: only.id });

    const [row] = await raw<{ is_primary: boolean }[]>`
      select is_primary from public.contact where id = ${only.id}`;
    expect(row!.is_primary).toBe(false);
  });
});

run("editing one", () => {
  it("validates what the row becomes, not what the patch says", async () => {
    /**
     * With an email on them, so clearing the phone leaves them reachable and
     * the ONLY thing that breaks is the channel they said they preferred.
     * Without it the earlier "no way to reach them" guard fires first and
     * this test would pass without ever reaching the rule it names.
     */
    const tenant = await contacts.create(owner(), {
      name: "Tess Tenant", propertyId: rentalId, phone: TENANT_PHONE,
      email: "tess@example.test", preferredChannel: "sms",
    });

    /**
     * The patch names only the phone, and on its own it is unremarkable.
     * Merged, it leaves somebody who prefers texts with no number, which is
     * the state the guard exists to prevent and the state a guard reading
     * only the patch would let through.
     */
    await expect(contacts.update(owner(), { id: tenant.id, name: "Tess Tenant", phone: "" }))
      .rejects.toThrow(/prefer texts/i);
  });

  it("keeps fields the patch does not mention", async () => {
    const tenant = await contacts.create(owner(), {
      name: "Tess Tenant", propertyId: rentalId, phone: TENANT_PHONE,
      title: "Tenant", email: "tess@example.test",
    });

    const after = await contacts.update(owner(), { id: tenant.id, name: "Tess T." });
    expect(after).toMatchObject({
      name: "Tess T.", title: "Tenant", email: "tess@example.test",
      phone: TENANT_PHONE, propertyId: rentalId,
    });
  });

  it("refuses to edit one that has been removed", async () => {
    const tenant = await contacts.create(owner(), {
      name: "Tess", propertyId: rentalId, phone: TENANT_PHONE,
    });
    await contacts.remove(owner(), { id: tenant.id });
    await expect(contacts.update(owner(), { id: tenant.id, name: "Back" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});

run("listing them", () => {
  it("puts the person who would get the text first", async () => {
    await contacts.create(owner(), {
      name: "Aaron At Customer", customerId: landlordId, phone: MANAGER_PHONE, isPrimary: true,
    });
    await contacts.create(owner(), {
      name: "Zoe At Property", propertyId: rentalId, phone: TENANT_PHONE,
    });

    /**
     * Alphabetically Aaron wins and by the rule that matters Zoe does. A list
     * sorted by name would be tidier and would not answer the question people
     * open it with.
     */
    const rows = await contacts.list(owner(), { customerId: landlordId, propertyId: rentalId });
    expect(rows[0]!.name).toBe("Zoe At Property");
  });

  it("refuses a listing scoped to nothing", async () => {
    await expect(contacts.list(owner(), {})).rejects.toBeInstanceOf(ConflictError);
  });
});
