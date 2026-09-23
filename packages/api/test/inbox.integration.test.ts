import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as jobs from "../src/services/jobs";
import * as properties from "../src/services/properties";
import * as inbox from "../src/services/comms";
import { store } from "../src/services/comms-inbound";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE INBOX
 *
 * Inbound messages were stored, threaded and acted on for STOP, and nothing
 * read them back: a customer could reply to an appointment reminder and
 * nobody would ever see it.
 *
 * The property worth defending here is that a person replying by hand goes
 * through the SAME consent decision as an automation. A human pressing send
 * is not an exemption, because the customer who replied STOP said it to the
 * company rather than to the workflow.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("ib:org");
const USER = fixtureId("ib:user");
const NUMBER = fixtureId("ib:number");
const TECH = fixtureId("ib:tech");
const OURS = "+15125559990";
const THEIRS = "+15125550120";

let customerId = "";
let technicianId = "";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

const inbound = (body: string, from = THEIRS) => ({
  from, to: OURS, body, media: [], providerMessageId: `IN${Math.random()}`,
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Inbox Co", slug: "inbox-co" });
  await raw`insert into public.phone_number (id, organization_id, e164, purpose, sms_registered)
            values (${NUMBER}, ${ORG}, ${OURS}, 'main', true)`;
  const customer = await customers.create(owner(), {
    type: "residential", name: "Ida Inbox", phone: THEIRS,
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;

  const property = await properties.create(owner(), {
    address: { line1: "9 Inbox Way", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });

  /**
   * A technician assigned to a real visit on this customer's job. Without
   * one, "a technician sees nothing" passes for the wrong reason: it would
   * pass against a filter that returns nothing for everybody.
   */
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${USER}, 'technician')
    on conflict (organization_id, user_id) do update set role = 'technician'
    returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (id, organization_id, membership_id, display_name)
    values (${TECH}, ${ORG}, ${m!.id}, 'Tess Field')
    on conflict (id) do nothing returning id`;
  technicianId = t?.id ?? TECH;

  const job = await jobs.create(owner(), {
    customerId, propertyId: property.id, summary: "Their job", tags: [], customFields: {},
  });
  const [visit] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, status) values (${ORG}, ${job.id}, 'scheduled')
    returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id)
            values (${ORG}, ${visit!.id}, ${technicianId})`;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.message where organization_id = ${ORG}`;
  await raw`delete from public.conversation where organization_id = ${ORG}`;
  await raw`delete from public.suppression where organization_id = ${ORG}`;
  await raw`delete from public.communication_consent where organization_id = ${ORG}`;
});

run("reading what came in", () => {
  it("shows a reply that arrived, against the customer it came from", async () => {
    await store(db(), ORG, inbound("Can you come Thursday instead?"));

    const page = await inbox.threads(owner());
    expect(page.data).toHaveLength(1);
    expect(page.data[0]!.customerName).toBe("Ida Inbox");
    expect(page.data[0]!.lastMessagePreview).toBe("Can you come Thursday instead?");
  });

  it("says which threads are waiting on us", async () => {
    // The only sort that matters in an inbox: did the last thing said come
    // from them.
    await store(db(), ORG, inbound("Are you still coming?"));
    const [waiting] = (await inbox.threads(owner())).data;
    expect(waiting!.awaitingReply).toBe(true);
    expect(waiting!.unread).toBe(1);

    await inbox.reply(owner(), { id: waiting!.id, body: "On our way." });
    const [answered] = (await inbox.threads(owner())).data;
    expect(answered!.awaitingReply).toBe(false);
  });

  it("counts unread until somebody opens the thread", async () => {
    await store(db(), ORG, inbound("One"));
    await store(db(), ORG, inbound("Two"));
    const [thread] = (await inbox.threads(owner())).data;
    expect(thread!.unread).toBe(2);

    // Marked on the thread, not per message. Asking somebody to tick each
    // one is a chore they stop doing within a week.
    await inbox.markRead(owner(), { id: thread!.id });
    expect((await inbox.threads(owner())).data[0]!.unread).toBe(0);
  });

  it("returns the whole conversation in order", async () => {
    await store(db(), ORG, inbound("First"));
    const [thread] = (await inbox.threads(owner())).data;
    await inbox.reply(owner(), { id: thread!.id, body: "Second" });
    await store(db(), ORG, inbound("Third"));

    const full = await inbox.thread(owner(), { id: thread!.id });
    expect(full.messages.map((m) => m.body)).toEqual(["First", "Second", "Third"]);
    expect(full.customer?.name).toBe("Ida Inbox");
  });

  it("does not read messages for somebody without the permission", async () => {
    await store(db(), ORG, inbound("Private"));
    const reader: ServiceContext = {
      actor: { userId: USER, organizationId: ORG, roles: [] },
      db: db(),
    };
    await expect(inbox.threads(reader)).rejects.toThrow(/message:read/);
  });

  it("does not hand a technician the company's inbox", async () => {
    /**
     * A technician HOLDS `message:read`, because they text customers from
     * the field. That is a permission question and it is answered yes. Which
     * conversations is a scope question, and it was answered "all of them":
     * every thread the company had ever had, for every customer, readable by
     * anybody with a phone in a truck.
     *
     * Same failure as the customer book before it, and this one was live,
     * because the preset grants the permission.
     */
    await store(db(), ORG, inbound("Private"));

    const technician: ServiceContext = {
      actor: {
        userId: USER, organizationId: ORG,
        roles: ["technician"] as Actor["roles"],
        // A technician id that exists and is assigned to nothing for this
        // customer, so the refusal is about scope rather than about a
        // missing record.
        technicianId: fixtureId("ib:stranger"),
      },
      db: db(),
    };
    expect((await inbox.threads(technician)).data).toHaveLength(0);
  });

  it("does hand a technician the thread for a customer they were sent to", async () => {
    /**
     * The other half, and the half that makes the test above mean something.
     * A filter that returns nothing for everybody would pass that one, so
     * this asserts the technician assigned to this customer's job DOES see
     * it: they are the person most likely to be answering.
     */
    await store(db(), ORG, inbound("Running late?"));

    const assigned: ServiceContext = {
      actor: {
        userId: USER, organizationId: ORG,
        roles: ["technician"] as Actor["roles"],
        technicianId,
      },
      db: db(),
    };
    const page = await inbox.threads(assigned);
    expect(page.data).toHaveLength(1);
    expect(page.data[0]!.customerName).toBe("Ida Inbox");
  });

  it("fails closed for a technician with no technician record", async () => {
    // `own` compares against a technician id. Absent one, it matches nothing
    // rather than everything, which is the right way round.
    await store(db(), ORG, inbound("Private"));
    const broken: ServiceContext = {
      actor: { userId: USER, organizationId: ORG, roles: ["technician"] as Actor["roles"] },
      db: db(),
    };
    expect((await inbox.threads(broken)).data).toHaveLength(0);
  });
});

run("replying by hand", () => {
  it("queues the reply rather than claiming it was sent", async () => {
    await store(db(), ORG, inbound("Hello"));
    const [thread] = (await inbox.threads(owner())).data;

    const sent = await inbox.reply(owner(), { id: thread!.id, body: "Hello back" });
    expect(sent.status).toBe("queued");
    expect(sent.sentByUserId).toBe(USER);
    // The outbox hands it to the carrier. Claiming sent here would make the
    // log say something the company cannot stand behind.
  });

  it("refuses a reply to somebody who said STOP", async () => {
    /**
     * The property this file exists for. A person pressing send is not an
     * exemption: an inbox that quietly bypasses the suppression list is how
     * a company ends up explaining a message somebody sent personally.
     */
    await store(db(), ORG, inbound("STOP"));
    const [thread] = (await inbox.threads(owner())).data;

    await expect(inbox.reply(owner(), { id: thread!.id, body: "Just one more thing" }))
      .rejects.toThrow(/STOP/);
    const sent = await raw`select id from public.message
      where organization_id = ${ORG} and direction = 'outbound'`;
    expect(sent).toHaveLength(0);
  });

  it("says why the box is closed before somebody types into it", async () => {
    // A screen that offers a reply box and then refuses the send has wasted
    // somebody's typing and taught them the guard is an obstacle.
    await store(db(), ORG, inbound("STOP"));
    const [thread] = (await inbox.threads(owner())).data;

    const full = await inbox.thread(owner(), { id: thread!.id });
    expect(full.canReply).toBe(false);
    expect(full.blockedReason).toBe("suppressed");
  });

  it("allows the reply again once they opt back in", async () => {
    await store(db(), ORG, inbound("stop"));
    await store(db(), ORG, inbound("START"));
    const [thread] = (await inbox.threads(owner())).data;

    expect((await inbox.thread(owner(), { id: thread!.id })).canReply).toBe(true);
    await expect(inbox.reply(owner(), { id: thread!.id, body: "Welcome back" }))
      .resolves.toBeTruthy();
  });

  it("refuses an empty message", async () => {
    await store(db(), ORG, inbound("Hello"));
    const [thread] = (await inbox.threads(owner())).data;
    await expect(inbox.reply(owner(), { id: thread!.id, body: "   " }))
      .rejects.toThrow(/empty/);
  });

  it("refuses a reply from somebody who may read but not send", async () => {
    await store(db(), ORG, inbound("Hello"));
    const [thread] = (await inbox.threads(owner())).data;
    const reader: ServiceContext = {
      actor: {
        userId: USER, organizationId: ORG, roles: [],
        grants: ["message:read"] as NonNullable<Actor["grants"]>,
      },
      db: db(),
    };
    await expect(inbox.reply(reader, { id: thread!.id, body: "Hi" }))
      .rejects.toThrow(/message:send/);
  });
});
