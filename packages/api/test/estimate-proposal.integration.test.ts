import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { PermissionError } from "@opentradesos/core";
import * as estimates from "../src/services/estimates";
import * as proposals from "../src/services/proposals";
import * as portal from "../src/services/portal";
import * as agreements from "../src/services/agreements";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * THE PROPOSAL, SENDING IT, AND WHAT THE CUSTOMER DECIDED
 *
 * Three things the sell path could not do, each of which a contractor
 * notices on the first day:
 *
 *   THE PROPOSAL. The customer read a list on a web page with no company on
 *   it and nothing to print. It is a document now, built for the office and
 *   for the customer's link by one function, with no cost on it by
 *   construction.
 *
 *   SENDING. The contract took email and text as channels and delivered
 *   neither. It sends both now, through the same consent gate as every other
 *   message, into the customer's conversation thread, and a refusal is a row
 *   with a reason that changes nothing else.
 *
 *   THE DECISION. `estimate.approved` and `estimate.declined` were owed in
 *   the catalogue and emitted by nothing, so no automation could start on a
 *   yes. And a migration could not say how an old estimate ended.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("proposal:org");
const USER = fixtureId("proposal:user");
const NUMBER = fixtureId("proposal:number");
const FROM = "quotes@ridgeline.test";
const OUR_NUMBER = "+15125550100";
const CUSTOMER_PHONE = "+15125550142";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], extra: Partial<ServiceContext> = {}): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(), ...extra,
});
const owner = () => as(["owner"]);
const office = () => as(["office_manager"]);

let customerId = "";
let propertyId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Ridgeline Air", slug: "ridgeline-proposal" });
  await raw`update public.organization set brand_color = '#0f766e', timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: FROM } as never)})`;
  await raw`insert into public.phone_number (id, organization_id, e164, purpose, sms_registered)
    values (${NUMBER}, ${ORG}, ${OUR_NUMBER}, 'main', true)`;
  await raw`insert into public.communication_consent
    (organization_id, address, channel, purpose, state, method, captured_at)
    values (${ORG}, ${CUSTOMER_PHONE}, 'sms', 'transactional', 'granted', 'verbal', now())`;

  const [c] = await raw`insert into public.customer (organization_id, name, email, phone)
    values (${ORG}, 'Nina Patel', 'nina@example.test', ${CUSTOMER_PHONE}) returning id`;
  customerId = c!.id;
  const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '88 Ridge Rd', 'Austin', 'TX', '78704') returning id`;
  propertyId = p!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
    values (${ORG}, ${customerId}, ${propertyId})`;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.suppression where organization_id = ${ORG}`;
  await raw`update public.organization set settings = settings - 'proposalTerms' where id = ${ORG}`;
});

const lines = (name: string, price: string, cost: string) => [{
  name, quantity: "1", unitPrice: price, unitCost: cost, discountAmount: "0",
  taxable: true, isOptional: false, isSelected: false,
}];

const threeOptions = (over: Record<string, unknown> = {}) => ({
  customerId, propertyId, taxRate: "0.0825",
  options: [
    { name: "Repair the motor", isRecommended: false, lines: lines("Fan motor", "680.00", "290.00") },
    {
      name: "New condenser", isRecommended: true,
      lines: [
        ...lines("Condenser", "3400.00", "1980.00"),
        {
          name: "Surge protector", quantity: "1", unitPrice: "289.00", unitCost: "96.00",
          discountAmount: "0", taxable: true, isOptional: true, isSelected: false,
        },
      ],
    },
    { name: "Whole system", isRecommended: false, lines: lines("System replacement", "9850.00", "5900.00") },
  ],
  ...over,
});

const eventsNamed = (name: string) => raw<{ payload: Record<string, unknown> }[]>`
  select payload from public.domain_event where organization_id = ${ORG} and name = ${name} order by sequence`;

const tokenOf = (link: string | null) => link!.split("/").pop()!;

run("the proposal", () => {
  it("names the options Good, Better and Best by price and carries the company's look", async () => {
    const written = await estimates.create(owner(), threeOptions());
    const doc = await proposals.proposal(owner(), { id: written.id });

    expect(doc.company).toMatchObject({ name: "Ridgeline Air", color: "#0f766e", hasLogo: false });
    expect(doc.customerName).toBe("Nina Patel");
    expect(doc.propertyAddress).toBe("88 Ridge Rd, Austin, TX 78704");
    /** The recommended one first, then most expensive, each named by where its price sits. */
    expect(doc.options.map((o) => [o.name, o.tier])).toEqual([
      ["New condenser", "Better"], ["Whole system", "Best"], ["Repair the motor", "Good"],
    ]);
    const condenser = doc.options[0]!;
    expect(condenser).toMatchObject({ subtotal: "3400.0000", discountTotal: "0.0000", total: "3680.5000" });
    expect(condenser.optionalTotal).not.toBe("0.0000");
  });

  it("carries no cost or margin, whoever is reading", async () => {
    /**
     * By construction: the document is built from what a customer may see,
     * so an owner who may see cost still gets a proposal without it. A
     * printed page has no reader to redact for.
     */
    const written = await estimates.create(owner(), threeOptions());
    const doc = JSON.stringify(await proposals.proposal(owner(), { id: written.id }));
    expect(doc).not.toMatch(/unitCost|"cost"|margin/);
    expect(doc).not.toContain("1980");
  });

  it("is the same document on the customer's link, and reading it spends nothing", async () => {
    const written = await estimates.create(owner(), threeOptions());
    const sent = await estimates.send(owner(), { id: written.id, channel: "link", expiresInDays: 30 });
    const token = tokenOf(sent.approvalUrl);

    const office = await proposals.proposal(owner(), { id: written.id });
    const theirs = await proposals.proposalForToken(db(), token);
    expect(theirs.options).toEqual(office.options);

    /** Printing is reading. The single use on the link is for approving, which still works. */
    await proposals.proposalForToken(db(), token);
    const view = await portal.viewEstimate(db(), { token });
    await expect(portal.approveEstimate(db(), {
      token, optionId: view.options[0]!.id, selectedLineIds: [], signerName: "Nina Patel", acceptedTerms: true,
    })).resolves.toBeDefined();
  });

  it("says a member discount on the line it came off, with the plan's name", async () => {
    const plan = await agreements.createPlan(owner(), {
      name: "Comfort Club", price: "180.00", billingFrequency: "annual", termMonths: 12,
      includedVisitsPerTerm: 2, discountRate: "0.10",
    });
    const sold = await agreements.sell(owner(), { planId: plan.id, customerId, propertyId });
    try {
      const written = await estimates.create(owner(), {
        customerId, propertyId, taxRate: "0",
        options: [{ name: "Repair", isRecommended: false, lines: lines("Fan motor", "680.00", "290.00") }],
      });
      const doc = await proposals.proposal(owner(), { id: written.id });
      expect(doc.options[0]!.tier).toBeNull();
      expect(doc.options[0]!.lines[0]).toMatchObject({
        memberDiscountAmount: "68.0000", memberPlan: "Comfort Club", lineTotal: "612.0000",
      });
      expect(doc.options[0]!.discountTotal).toBe("68.0000");
    } finally {
      await agreements.cancel(owner(), { id: sold.id, reason: "Test over", keepThePrepayment: true });
    }
  });
});

run("the terms printed on it", () => {
  it("copies the company's terms onto an estimate when it is written and never again", async () => {
    await estimates.setProposalTerms(owner(), { terms: "Prices hold for 30 days. Labour warranty one year." });
    const first = await estimates.create(owner(), threeOptions());
    await estimates.setProposalTerms(owner(), { terms: "Prices hold for 14 days." });
    const second = await estimates.create(owner(), threeOptions());

    expect((await proposals.proposal(owner(), { id: first.id })).terms)
      .toBe("Prices hold for 30 days. Labour warranty one year.");
    expect((await proposals.proposal(owner(), { id: second.id })).terms).toBe("Prices hold for 14 days.");

    const sent = await estimates.send(owner(), { id: first.id, channel: "link", expiresInDays: 30 });
    const view = await portal.viewEstimate(db(), { token: tokenOf(sent.approvalUrl) });
    expect(view.termsText).toBe("Prices hold for 30 days. Labour warranty one year.");
  });

  it("lets one estimate carry its own terms, or none", async () => {
    await estimates.setProposalTerms(owner(), { terms: "Company terms." });
    const own = await estimates.create(owner(), threeOptions({ terms: "Commercial terms apply." }));
    const none = await estimates.create(owner(), threeOptions({ terms: "" }));
    expect(own.terms).toBe("Commercial terms apply.");
    expect(none.terms).toBeNull();
  });

  it("is a company decision, so writing an estimate is not enough to change it", async () => {
    await expect(estimates.setProposalTerms(as(["technician"]), { terms: "Anything goes." }))
      .rejects.toThrow(PermissionError);
    expect((await estimates.proposalTerms(as(["technician"]))).terms).toBeNull();
  });
});

const outbound = () => raw<{
  id: string; channel: string; to_address: string; body: string | null; subject: string | null;
  conversation_id: string;
}[]>`select id, channel, to_address, body, subject, conversation_id from public.message
     where organization_id = ${ORG} and direction = 'outbound' order by created_at`;

run("sending it from the office", () => {
  it("emails it, with the link, into the customer's conversation thread", async () => {
    const before = (await outbound()).length;
    const written = await estimates.create(owner(), threeOptions({ title: "Condenser replacement" }));
    const sent = await estimates.send(office(), {
      id: written.id, channel: "email", message: "As discussed on site.", expiresInDays: 30,
    });

    expect(sent.delivery).toMatchObject({ channel: "email", destination: "nina@example.test", state: "queued", error: null });
    expect(sent.approvalUrl).toMatch(/\/e\//);
    expect(sent.estimate.status).toBe("sent");

    const message = (await outbound()).slice(before).find((m) => m.id === sent.delivery.messageId)!;
    expect(message.channel).toBe("email");
    expect(message.subject).toContain("Condenser replacement");
    expect(message.body).toContain(sent.approvalUrl!);
    expect(message.body).toContain("As discussed on site.");
    expect(message.body).toContain("3 options");

    const [thread] = await raw`select customer_id from public.conversation where id = ${message.conversation_id}`;
    expect(thread!.customer_id).toBe(customerId);
    expect((await estimates.deliveries(office(), { id: written.id })).map((d) => d.id)).toEqual([sent.delivery.id]);
  });

  it("texts it from the company's number, into the same customer's thread", async () => {
    const written = await estimates.create(owner(), threeOptions());
    const sent = await estimates.send(office(), { id: written.id, channel: "sms", expiresInDays: 30 });

    expect(sent.delivery).toMatchObject({ channel: "sms", destination: CUSTOMER_PHONE, state: "queued" });
    const [message] = await raw`select to_address, from_address, body, conversation_id from public.message
      where id = ${sent.delivery.messageId}`;
    expect(message).toMatchObject({ to_address: CUSTOMER_PHONE, from_address: OUR_NUMBER });
    expect(message!.body).toMatch(/^Hi Nina, it's Ridgeline Air\./);
    expect(message!.body).toContain(sent.approvalUrl!);
    const [thread] = await raw`select customer_id from public.conversation where id = ${message!.conversation_id}`;
    expect(thread!.customer_id).toBe(customerId);
  });

  it("records a refusal with the reason and changes nothing else", async () => {
    /**
     * The customer replied STOP. Nothing goes, the estimate keeps its status,
     * the link they already hold keeps working, and nothing is emitted, so
     * an "unanswered estimate" follow up does not start on a quote they never
     * received.
     */
    const written = await estimates.create(owner(), threeOptions());
    const first = await estimates.send(office(), { id: written.id, channel: "link", expiresInDays: 30 });
    const sentEvents = (await eventsNamed("estimate.sent")).length;

    await raw`insert into public.suppression (organization_id, address, channel, reason)
      values (${ORG}, ${CUSTOMER_PHONE}, 'sms', 'stop')`;
    const refused = await estimates.send(office(), { id: written.id, channel: "sms", expiresInDays: 30 });

    expect(refused.approvalUrl).toBeNull();
    expect(refused.delivery.state).toBe("refused");
    expect(refused.delivery.error).toMatch(/STOP/);
    expect(refused.estimate.status).toBe("sent");
    expect((await eventsNamed("estimate.sent")).length).toBe(sentEvents);
    await expect(portal.viewEstimate(db(), { token: tokenOf(first.approvalUrl) })).resolves.toBeDefined();
  });

  it("refuses a channel the customer has no address for, rather than recording a send to nowhere", async () => {
    const [c] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'No Details') returning id`;
    await raw`insert into public.customer_property (organization_id, customer_id, property_id)
      values (${ORG}, ${c!.id}, ${propertyId})`;
    const written = await estimates.create(owner(), threeOptions({ customerId: c!.id }));
    await expect(estimates.send(office(), { id: written.id, channel: "email", expiresInDays: 30 }))
      .rejects.toThrow(/no email address on file/);
    expect(await estimates.deliveries(office(), { id: written.id })).toEqual([]);
  });

  it("withdraws the earlier link only once the new one has gone", async () => {
    const written = await estimates.create(owner(), threeOptions());
    const first = await estimates.send(office(), { id: written.id, channel: "link", expiresInDays: 30 });
    await estimates.send(office(), { id: written.id, channel: "email", expiresInDays: 30 });
    await expect(portal.viewEstimate(db(), { token: tokenOf(first.approvalUrl) }))
      .rejects.toThrow(portal.InvalidGrantError);
  });

  it("answers a retried send with the first attempt and sends nothing twice", async () => {
    const written = await estimates.create(owner(), threeOptions());
    const keyed = () => as(["office_manager"], { idempotencyKey: `send-${written.id}` });
    const first = await estimates.send(keyed(), { id: written.id, channel: "email", expiresInDays: 30 });
    const again = await estimates.send(keyed(), { id: written.id, channel: "email", expiresInDays: 30 });

    expect(again.delivery.id).toBe(first.delivery.id);
    /** The link existed once, in the first answer; a retry cannot be handed it. */
    expect(again.approvalUrl).toBeNull();
    expect(await estimates.deliveries(office(), { id: written.id })).toHaveLength(1);
  });
});

run("sending it by email and text at once", () => {
  it("sends both, carrying one link, as two attempts each with its own message", async () => {
    const written = await estimates.create(owner(), threeOptions({ title: "Both ways" }));
    const sentEvents = (await eventsNamed("estimate.sent")).length;
    const sent = await estimates.send(office(), { id: written.id, channel: "both", expiresInDays: 30 });

    expect(sent.estimate.status).toBe("sent");
    expect(sent.deliveries.map((d) => [d.channel, d.destination, d.state])).toEqual([
      ["email", "nina@example.test", "queued"],
      ["sms", CUSTOMER_PHONE, "queued"],
    ]);
    expect(sent.delivery.id).toBe(sent.deliveries[0]!.id);

    // The same link in both, so approving from either is approving the one document.
    const bodies = await raw`select channel, body from public.message
      where id in ${raw(sent.deliveries.map((d) => d.messageId!))}`;
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body.body).toContain(sent.approvalUrl!);
    const grants = await raw`select distinct portal_grant_id from public.estimate_delivery where estimate_id = ${written.id}`;
    expect(grants).toHaveLength(1);

    // One send, so one event: the follow up's clock starts once.
    expect((await eventsNamed("estimate.sent")).length).toBe(sentEvents + 1);
    const [event] = await raw`select detail from public.portal_event
      where estimate_id = ${written.id} and kind = 'estimate_sent'`;
    expect(event!.detail).toBe(`By email to nina@example.test and by text to ${CUSTOMER_PHONE}`);
  });

  it("goes by email when the text is refused, and records the refused text beside it", async () => {
    await raw`insert into public.suppression (organization_id, address, channel, reason)
      values (${ORG}, ${CUSTOMER_PHONE}, 'sms', 'stop')`;
    const written = await estimates.create(owner(), threeOptions());
    const sent = await estimates.send(office(), { id: written.id, channel: "both", expiresInDays: 30 });

    expect(sent.estimate.status).toBe("sent");
    expect(sent.approvalUrl).toMatch(/\/e\//);
    const [email, text] = sent.deliveries;
    expect(email).toMatchObject({ channel: "email", state: "queued" });
    expect(text).toMatchObject({ channel: "sms", state: "refused" });
    expect(text!.error).toMatch(/STOP/);
    // The link that went by email still works.
    await expect(portal.viewEstimate(db(), { token: tokenOf(sent.approvalUrl) })).resolves.toBeDefined();
  });

  it("changes nothing when both are refused", async () => {
    await raw`insert into public.suppression (organization_id, address, channel, reason)
      values (${ORG}, ${CUSTOMER_PHONE}, 'sms', 'stop'), (${ORG}, 'nina@example.test', 'email', 'bounce')`;
    const written = await estimates.create(owner(), threeOptions());
    const sentEvents = (await eventsNamed("estimate.sent")).length;
    const sent = await estimates.send(office(), { id: written.id, channel: "both", expiresInDays: 30 });

    expect(sent.approvalUrl).toBeNull();
    expect(sent.deliveries.map((d) => d.state)).toEqual(["refused", "refused"]);
    expect(sent.estimate.status).toBe("draft");
    expect((await eventsNamed("estimate.sent")).length).toBe(sentEvents);
  });

  it("refuses a typed address and a customer missing either, before anything is sent", async () => {
    const written = await estimates.create(owner(), threeOptions());
    await expect(estimates.send(office(), { id: written.id, channel: "both", to: "other@example.test", expiresInDays: 30 }))
      .rejects.toBeInstanceOf(ConflictError);

    const [c] = await raw`insert into public.customer (organization_id, name, email) values (${ORG}, 'Email Only', 'only@example.test') returning id`;
    await raw`insert into public.customer_property (organization_id, customer_id, property_id)
      values (${ORG}, ${c!.id}, ${propertyId})`;
    const emailOnly = await estimates.create(owner(), threeOptions({ customerId: c!.id }));
    await expect(estimates.send(office(), { id: emailOnly.id, channel: "both", expiresInDays: 30 }))
      .rejects.toThrow(/no mobile number on file/);
    expect(await estimates.deliveries(office(), { id: emailOnly.id })).toEqual([]);
  });

  it("answers a retried send with both of its attempts and sends nothing twice", async () => {
    const written = await estimates.create(owner(), threeOptions());
    const keyed = () => as(["office_manager"], { idempotencyKey: `both-${written.id}` });
    const first = await estimates.send(keyed(), { id: written.id, channel: "both", expiresInDays: 30 });
    const again = await estimates.send(keyed(), { id: written.id, channel: "both", expiresInDays: 30 });

    expect(again.deliveries.map((d) => d.id)).toEqual(first.deliveries.map((d) => d.id));
    expect(again.approvalUrl).toBeNull();
    expect(await estimates.deliveries(office(), { id: written.id })).toHaveLength(2);
  });
});

run("what the customer decided, as events", () => {
  it("emits estimate.approved from the portal, with what they chose and how", async () => {
    const written = await estimates.create(owner(), threeOptions());
    const sent = await estimates.send(office(), { id: written.id, channel: "link", expiresInDays: 30 });
    const token = tokenOf(sent.approvalUrl);
    const view = await portal.viewEstimate(db(), { token });
    const condenser = view.options.find((o) => o.name === "New condenser")!;
    const surge = condenser.lines.find((l) => l.isOptional)!;
    await portal.approveEstimate(db(), {
      token, optionId: condenser.id, selectedLineIds: [surge.id], signerName: "Nina Patel", acceptedTerms: true,
    });

    const [event] = (await eventsNamed("estimate.approved")).slice(-1);
    expect(event!.payload).toMatchObject({
      estimate: {
        id: written.id, optionId: condenser.id, optionName: "New condenser",
        total: "3993.3400", signerName: "Nina Patel",
      },
      customer: { id: customerId, name: "Nina Patel" },
      capturedVia: "portal",
      previous: { estimate: { status: "viewed" } },
    });
  });

  it("emits estimate.approved for a yes the office records, saying how it came", async () => {
    const written = await estimates.create(owner(), threeOptions());
    await estimates.approve(office(), {
      id: written.id, optionId: written.options[0]!.id, selectedLineIds: [],
      signerName: "Nina Patel", capturedVia: "phone",
    });
    const [event] = (await eventsNamed("estimate.approved")).slice(-1);
    expect(event!.payload).toMatchObject({ estimate: { id: written.id }, capturedVia: "phone" });
  });

  it("emits estimate.declined from either side, saying which", async () => {
    const byOffice = await estimates.create(owner(), threeOptions());
    await estimates.decline(office(), { id: byOffice.id, reason: "Went with a cheaper quote" });

    const byCustomer = await estimates.create(owner(), threeOptions());
    const sent = await estimates.send(office(), { id: byCustomer.id, channel: "link", expiresInDays: 30 });
    await portal.declineEstimate(db(), { token: tokenOf(sent.approvalUrl), reason: "Not this year" });

    const declined = (await eventsNamed("estimate.declined")).slice(-2);
    expect(declined.map((e) => [
      (e.payload["estimate"] as Record<string, unknown>)["id"], e.payload["declinedBy"],
      (e.payload["estimate"] as Record<string, unknown>)["reason"],
    ])).toEqual([
      [byOffice.id, "office", "Went with a cheaper quote"],
      [byCustomer.id, "customer", "Not this year"],
    ]);
  });
});

run("an estimate's history from another system", () => {
  const history = (outcome: Record<string, unknown>) => threeOptions({
    issuedOn: "2024-03-01", externalRef: { source: "jobber", id: `Q-${Math.random()}` }, outcome,
  });

  it("brings a won estimate in as approved on its option and its day, and fires nothing", async () => {
    const approvedBefore = (await eventsNamed("estimate.approved")).length;
    const won = await estimates.create(owner(), history({
      status: "approved", on: "2024-03-09", chosenOption: 1, signerName: "Nina Patel",
    }));
    expect(won.status).toBe("approved");
    expect(won.selectedOptionId).toBe(won.options.find((o) => o.name === "New condenser")!.id);
    expect(won.signerName).toBe("Nina Patel");
    expect(new Date(won.decidedAt as unknown as string).toISOString()).toBe("2024-03-09T06:00:00.000Z");
    /** A migration loading four thousand wins must not start four thousand automations. */
    expect((await eventsNamed("estimate.approved")).length).toBe(approvedBefore);
    const [signatures] = await raw`select count(*)::int as n from public.document_signature where subject_id = ${won.id}`;
    expect(signatures!.n).toBe(0);
  });

  it("brings a lost one in as declined with its reason, and a lapsed one as expired on its day", async () => {
    const lost = await estimates.create(owner(), history({ status: "declined", on: "2024-03-12", reason: "Price" }));
    expect(lost).toMatchObject({ status: "declined", declineReason: "Price", selectedOptionId: null });
    const lapsed = await estimates.create(owner(), history({ status: "expired", on: "2024-04-01" }));
    expect(lapsed).toMatchObject({ status: "expired", expiresOn: "2024-04-01", decidedAt: null });
  });

  it("needs data:import, and refuses an outcome that cannot be true", async () => {
    await expect(estimates.create(office(), history({ status: "declined", on: "2024-03-12" })))
      .rejects.toThrow(PermissionError);
    await expect(estimates.create(owner(), history({ status: "approved", on: "2024-03-12" })))
      .rejects.toThrow(/which option was approved/);
    await expect(estimates.create(owner(), history({ status: "declined", on: "2024-02-01" })))
      .rejects.toThrow(ConflictError);
  });

  it("converts an imported win like any other, copying the option that won", async () => {
    const won = await estimates.create(owner(), history({ status: "approved", on: "2024-03-09", chosenOption: 2 }));
    const converted = await estimates.convert(owner(), { id: won.id, createJob: true, createInvoice: true });
    const [invoice] = await raw`select total from public.invoice where id = ${converted.invoiceId}`;
    expect(invoice!.total).toBe("10662.6300");
  });
});
