import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as dispatchSvc from "../src/services/dispatch";
import { recordDelivery } from "../src/services/comms-outbox";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * "TEXT THE CUSTOMER I AM ON MY WAY"
 *
 * The button in the van says that. For a while the code behind it wrote a row
 * claiming a notice had been sent, wrote a portal event, minted a tracking
 * grant, and returned ok, and sent nothing at all. Every test passed, because
 * every test asserted on the row.
 *
 * So the first assertion in this file is about `public.message`, not about
 * `public.arrival_notice`. A notice row is the software's own account of
 * itself; a queued message is the only thing a customer can receive.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("omw:org");
const USER = fixtureId("omw:user");
const NUMBER = fixtureId("omw:number");
const OUR_NUMBER = "+15125559981";
const CUSTOMER_PHONE = "+15125550171";
const TENANT_PHONE = "+15125550172";
const LANDLORD_PHONE = "+15125550173";
const OTHER_PHONE = "+15125550174";

let raw: postgres.Sql;
const db = () => testDb(url!);
const tech = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["technician"] as Actor["roles"] }, db: db(),
});

let customerId = "";
let propertyId = "";

async function makeVisit() {
  const [job] = await raw`insert into public.job
    (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${Math.floor(Math.random() * 1e6)}, ${customerId}, ${propertyId},
            'scheduled', 'No cooling upstairs') returning id`;
  const [visit] = await raw`insert into public.visit
    (organization_id, job_id, status) values (${ORG}, ${job!.id}, 'dispatched') returning id`;
  return { jobId: job!.id, visitId: visit!.id };
}

const outbound = () => raw<{
  id: string; to_address: string; body: string; status: string; purpose: string;
}[]>`select id, to_address, body, status, purpose from public.message
     where organization_id = ${ORG} and direction = 'outbound' order by created_at`;

const notices = () => raw<{
  id: string; message_id: string | null; failed_reason: string | null;
  delivered_at: Date | null; includes_tracking: boolean;
}[]>`select id, message_id, failed_reason, delivered_at, includes_tracking
     from public.arrival_notice where organization_id = ${ORG} order by sent_at`;

/** Consent on the record, which is the normal case. */
async function allowTexting(address: string) {
  await raw`insert into public.communication_consent
    (organization_id, address, channel, purpose, state, method, captured_at)
    values (${ORG}, ${address}, 'sms', 'transactional', 'granted', 'verbal', now())`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Ridgeline Air", slug: "omw-co" });

  await raw`insert into public.phone_number (id, organization_id, e164, purpose, sms_registered)
            values (${NUMBER}, ${ORG}, ${OUR_NUMBER}, 'main', true)`;

  const [c] = await raw`insert into public.customer (organization_id, name, phone)
    values (${ORG}, 'Nina Patel', ${CUSTOMER_PHONE}) returning id`;
  customerId = c!.id;
  const [p] = await raw`insert into public.property
    (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '88 Ridge Rd', 'Austin', 'TX', '78704') returning id`;
  propertyId = p!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
    values (${ORG}, ${customerId}, ${propertyId})`;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.arrival_notice where organization_id = ${ORG}`;
  await raw`delete from public.message where organization_id = ${ORG}`;
  await raw`delete from public.conversation where organization_id = ${ORG}`;
  await raw`delete from public.suppression where organization_id = ${ORG}`;
  await raw`delete from public.communication_consent where organization_id = ${ORG}`;
  await raw`delete from public.contact where organization_id = ${ORG}`;
  await raw`delete from public.portal_grant where organization_id = ${ORG}`;
  await allowTexting(CUSTOMER_PHONE);
});

run("a button that says it texts the customer", () => {
  it("queues a text the customer can actually receive", async () => {
    const { visitId } = await makeVisit();

    const result = await dispatchSvc.onMyWay(tech(), {
      id: visitId, channel: "sms", etaMinutes: 15, includeTracking: true,
    });

    expect(result.sent).toBe(true);

    /**
     * THE ASSERTION THE OLD CODE FAILED. There was no message anywhere: the
     * notice row was the whole of it.
     */
    const messages = await outbound();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.to_address).toBe(CUSTOMER_PHONE);
    expect(messages[0]!.purpose).toBe("transactional");
    // Queued, not sent. The outbox hands it to a carrier.
    expect(messages[0]!.status).toBe("queued");
    expect(messages[0]!.body).toContain("15 minutes");
    expect(messages[0]!.body).toContain("Ridgeline Air");

    // And the notice points at it, so a delivery receipt has somewhere to land.
    const [notice] = await notices();
    expect(notice!.message_id).toBe(messages[0]!.id);
    expect(notice!.failed_reason).toBeNull();
  });

  it("puts the tracking link in the text, not only in the response", async () => {
    const { visitId } = await makeVisit();

    const result = await dispatchSvc.onMyWay(tech(), {
      id: visitId, channel: "sms", etaMinutes: 20, includeTracking: true,
    });

    /**
     * A tracking URL returned to the van and absent from the customer's text
     * is a link nobody can follow. The grant is minted either way, so only the
     * body proves it reached anybody.
     */
    expect(result.trackingUrl).toBeTruthy();
    const [message] = await outbound();
    expect(message!.body).toContain(result.trackingUrl!);
  });

  it("says about how long rather than inventing a number", async () => {
    const { visitId } = await makeVisit();

    await dispatchSvc.onMyWay(tech(), {
      id: visitId, channel: "sms", includeTracking: false,
    });

    const [message] = await outbound();
    // No ETA supplied, so none is claimed. "about null minutes" has shipped.
    expect(message!.body).not.toContain("null");
    expect(message!.body).not.toMatch(/\d+ minutes/);
    expect(message!.body).toContain("on the way");
  });
});

run("consent is not a formality a technician can step around", () => {
  it("does not text somebody who replied STOP, and says why", async () => {
    await raw`insert into public.suppression
      (organization_id, address, channel, purpose, reason)
      values (${ORG}, ${CUSTOMER_PHONE}, 'sms', null, 'stop')`;
    const { visitId } = await makeVisit();

    const result = await dispatchSvc.onMyWay(tech(), {
      id: visitId, channel: "sms", etaMinutes: 10, includeTracking: true,
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toContain("STOP");
    expect(await outbound()).toHaveLength(0);

    /**
     * The notice still exists. The technician DID say they were on their way,
     * and that is a fact about the visit. What changed is that the row now
     * admits the customer never heard it, which is the difference between a
     * record and a claim.
     */
    const [notice] = await notices();
    expect(notice!.failed_reason).toBe("suppressed");
    expect(notice!.message_id).toBeNull();
  });

  it("does not claim tracking on a notice nobody received", async () => {
    await raw`insert into public.suppression
      (organization_id, address, channel, purpose, reason)
      values (${ORG}, ${CUSTOMER_PHONE}, 'sms', null, 'stop')`;
    const { visitId } = await makeVisit();

    const result = await dispatchSvc.onMyWay(tech(), {
      id: visitId, channel: "sms", includeTracking: true,
    });

    expect(result.trackingUrl).toBeNull();
    const [notice] = await notices();
    expect(notice!.includes_tracking).toBe(false);
  });

  it("lets the technician try again after a refusal", async () => {
    const { visitId } = await makeVisit();
    await raw`insert into public.suppression
      (organization_id, address, channel, purpose, reason)
      values (${ORG}, ${CUSTOMER_PHONE}, 'sms', null, 'stop')`;

    await dispatchSvc.onMyWay(tech(), { id: visitId, channel: "sms", includeTracking: false });
    // They opt back in from the front office.
    await raw`update public.suppression set lifted_at = now() where organization_id = ${ORG}`;
    const second = await dispatchSvc.onMyWay(tech(), {
      id: visitId, channel: "sms", includeTracking: false,
    });

    // A notice that failed is not a send, so it must not block one.
    expect(second.sent).toBe(true);
    expect(await outbound()).toHaveLength(1);
  });
});

run("who gets the text", () => {
  it("texts the person at the property rather than the account holder", async () => {
    /**
     * A rental. The customer is the landlord; the tenant opens the door.
     * Texting the landlord that somebody is ten minutes away helps nobody
     * standing outside the house.
     *
     * BOTH contacts exist, and that is the whole test. The first version of
     * this fixture attached only the tenant, so the one candidate won whatever
     * the ranking said: deleting the property term from the ranking left the
     * test green. A preference between two things needs two things.
     */
    await raw`insert into public.contact
      (organization_id, customer_id, name, phone, is_primary, preferred_channel)
      values (${ORG}, ${customerId}, 'Marcus Vaile', ${LANDLORD_PHONE}, true, 'sms')`;
    await raw`insert into public.contact
      (organization_id, property_id, name, phone, is_primary, preferred_channel)
      values (${ORG}, ${propertyId}, 'Dee Okafor', ${TENANT_PHONE}, true, 'sms')`;
    await allowTexting(TENANT_PHONE);
    await allowTexting(LANDLORD_PHONE);
    const { visitId } = await makeVisit();

    await dispatchSvc.onMyWay(tech(), { id: visitId, channel: "sms", includeTracking: false });

    const [message] = await outbound();
    expect(message!.to_address).toBe(TENANT_PHONE);
  });

  it("prefers the primary contact, and sms over any other channel", async () => {
    /**
     * Three candidates at one property, so every term in the ordering has
     * something to decide. A contact who prefers email is still in the list:
     * the alternative to texting the only person attached to a property is a
     * technician arriving at a door nobody knew about.
     */
    await raw`insert into public.contact
      (organization_id, property_id, name, phone, is_primary, preferred_channel)
      values (${ORG}, ${propertyId}, 'Back Office', ${OTHER_PHONE}, false, 'sms')`;
    await raw`insert into public.contact
      (organization_id, property_id, name, phone, is_primary, preferred_channel)
      values (${ORG}, ${propertyId}, 'Emails Only', ${LANDLORD_PHONE}, true, 'email')`;
    await raw`insert into public.contact
      (organization_id, property_id, name, phone, is_primary, preferred_channel)
      values (${ORG}, ${propertyId}, 'Dee Okafor', ${TENANT_PHONE}, true, 'sms')`;
    for (const a of [OTHER_PHONE, LANDLORD_PHONE, TENANT_PHONE]) await allowTexting(a);
    const { visitId } = await makeVisit();

    await dispatchSvc.onMyWay(tech(), { id: visitId, channel: "sms", includeTracking: false });

    const [message] = await outbound();
    expect(message!.to_address).toBe(TENANT_PHONE);
  });

  it("skips a contact with no number rather than sending nowhere", async () => {
    await raw`insert into public.contact
      (organization_id, property_id, name, phone, is_primary, preferred_channel)
      values (${ORG}, ${propertyId}, 'No Number', '   ', true, 'sms')`;
    const { visitId } = await makeVisit();

    await dispatchSvc.onMyWay(tech(), { id: visitId, channel: "sms", includeTracking: false });

    // Falls through to the customer rather than queueing a text to whitespace.
    const [message] = await outbound();
    expect(message!.to_address).toBe(CUSTOMER_PHONE);
  });

  it("falls back to the number on the customer when nobody is attached", async () => {
    const { visitId } = await makeVisit();

    await dispatchSvc.onMyWay(tech(), { id: visitId, channel: "sms", includeTracking: false });

    const [message] = await outbound();
    expect(message!.to_address).toBe(CUSTOMER_PHONE);
  });

  it("records a notice with a reason when there is no number at all", async () => {
    await raw`update public.customer set phone = null where id = ${customerId}`;
    try {
      const { visitId } = await makeVisit();

      const result = await dispatchSvc.onMyWay(tech(), {
        id: visitId, channel: "sms", includeTracking: false,
      });

      expect(result.sent).toBe(false);
      const [notice] = await notices();
      expect(notice!.failed_reason).toBe("no_address");
    } finally {
      await raw`update public.customer set phone = ${CUSTOMER_PHONE} where id = ${customerId}`;
    }
  });
});

run("a retry from a van with one bar", () => {
  it("does not text the customer twice", async () => {
    const { visitId } = await makeVisit();

    await dispatchSvc.onMyWay(tech(), { id: visitId, channel: "sms", includeTracking: true });
    const second = await dispatchSvc.onMyWay(tech(), {
      id: visitId, channel: "sms", includeTracking: true,
    });

    expect(second.alreadySent).toBe(true);
    expect(second.sent).toBe(false);
    expect(await outbound()).toHaveLength(1);
  });

  it("does not mint a second tracking grant on the retry", async () => {
    const { visitId } = await makeVisit();

    await dispatchSvc.onMyWay(tech(), { id: visitId, channel: "sms", includeTracking: true });
    await dispatchSvc.onMyWay(tech(), { id: visitId, channel: "sms", includeTracking: true });

    /**
     * Two live links to one property, one of which nobody can produce again
     * because the token is stored hashed. The grant that cannot be handed out
     * is the one worth not creating.
     */
    const grants = await raw`select id from public.portal_grant
      where organization_id = ${ORG} and revoked_at is null`;
    expect(grants).toHaveLength(1);
  });
});

run("what the customer's phone did with it", () => {
  it("marks the notice delivered when the carrier says so", async () => {
    const { visitId } = await makeVisit();
    await dispatchSvc.onMyWay(tech(), { id: visitId, channel: "sms", etaMinutes: 20, includeTracking: false });
    const [message] = await outbound();

    await recordDelivery(db(), ORG, {
      providerMessageId: "SM-omw-1", reference: message!.id, status: "delivered",
    });

    const [notice] = await notices();
    expect(notice!.delivered_at).not.toBeNull();
  });

  it("marks the notice failed when the carrier could not deliver it", async () => {
    const { visitId } = await makeVisit();
    await dispatchSvc.onMyWay(tech(), { id: visitId, channel: "sms", includeTracking: false });
    const [message] = await outbound();

    await recordDelivery(db(), ORG, {
      providerMessageId: "SM-omw-2", reference: message!.id,
      status: "undelivered", errorCode: "30003", errorMessage: "Handset unreachable",
    });

    /**
     * The one screen that matters answers "did they hear that somebody was
     * coming". Before this, `delivered_at` and `failed_reason` were columns
     * nothing wrote, so the answer was always a confident yes.
     */
    const [notice] = await notices();
    expect(notice!.failed_reason).toBe("Handset unreachable");
    expect(notice!.delivered_at).toBeNull();
  });
});
