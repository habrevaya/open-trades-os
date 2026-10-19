import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as priceBook from "../src/services/pricebook";
import * as contracts from "../src/services/contracts";
import * as rateCards from "../src/services/rate-cards";
import * as jobBilling from "../src/services/job-billing";
import * as commercial from "../src/services/commercial";
import * as entitlements from "../src/services/entitlements";
import * as creditNotes from "../src/services/credit-notes";
import * as claims from "../src/services/claims";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * M32. BILLING THE HOMEOWNER FOR WHAT THE WARRANTY COMPANY DID NOT PAY
 *
 * A home warranty job billed in two parts: 290.00 to the warranty company
 * and the rest to the homeowner. The warranty company approves less, or
 * denies it, and the office, on the claim, bills the rest to the homeowner as
 * a draft. Explicit, per claim, once, and only once the warranty company's
 * own invoice no longer owes the money.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("claim-bill-rest:org");
const USER = fixtureId("claim-bill-rest:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(), ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(["owner"], key);

let warrantyCo = "", homeowner = "", home = "";
let labourItem = "", motor = "", flush = "";

const person = (name: string, type: "residential" | "commercial") => customers.create(owner(), {
  type, name, phone: `+1512556${String(Math.floor(Math.random() * 9000) + 1000)}`,
  paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
});

/** A warranty job, worked, billed in two parts, with a claim filed on the warranty company's invoice. */
async function claimed(): Promise<{ claimId: string; jobId: string; payerInvoiceId: string }> {
  const job = await jobs.create(owner(), {
    customerId: homeowner, propertyId: home, summary: "Condenser fan", tags: [], customFields: {},
    visit: {
      windowStart: "2026-10-06T14:00:00.000Z", windowEnd: "2026-10-06T17:00:00.000Z",
      estimatedDurationMinutes: 120, technicianIds: [],
    },
  });
  const jobId = job.id as string;
  const [visit] = await raw<{ id: string }[]>`select id from public.visit where job_id = ${jobId}`;
  await raw`update public.visit set arrived_at = '2026-10-06T15:00:00Z' where id = ${visit!.id}`;
  await jobs.complete(owner(), {
    id: visit!.id,
    partsUsed: [
      { priceBookItemId: labourItem, quantity: "2" }, { priceBookItemId: motor, quantity: "1" }, { priceBookItemId: flush, quantity: "1" },
    ],
  });
  await entitlements.resolve(owner(), { jobId, source: "home_warranty", customerResponsibility: "100.00", externalReference: "SHW-7001" });
  await commercial.setParties(owner(), { jobId, parties: [{ role: "payer", customerId: warrantyCo }] });
  const billed = await jobBilling.bill(owner(), { jobId });
  const payerInvoiceId = billed.invoices.find((i) => i.customerId === warrantyCo)!.id;
  const claim = await claims.file(owner(), { invoiceId: payerInvoiceId, externalReference: "SHW-7001" });
  return { claimId: claim.id, jobId, payerInvoiceId };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Claim Bill Rest Co", slug: "claim-bill-rest-co" });
  warrantyCo = (await person("Shield Home Warranty", "commercial")).id;
  homeowner = (await person("Hana Homeowner", "residential")).id;
  home = (await properties.create(owner(), {
    address: { line1: "12 Elm St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: homeowner, customerRole: "owner",
  })).id;
  labourItem = (await priceBook.create(owner(), { kind: "labor", code: "LAB-HR", name: "Labour, per hour", price: "120.00", cost: "45.00", taxable: false })).id;
  motor = (await priceBook.create(owner(), { kind: "material", code: "MOT-1", name: "Condenser fan motor", price: "749.00", cost: "200.00", taxable: false })).id;
  flush = (await priceBook.create(owner(), { kind: "service", code: "FLUSH", name: "Drain flush", price: "150.00", cost: "10.00", taxable: false })).id;
  const contract = await contracts.createContract(owner(), {
    customerId: warrantyCo, name: "Shield network agreement", claimWithinDays: 60, invoiceFormat: "csv",
  });
  const card = (await contracts.createRateCard(owner(), { name: "Shield schedule", contractId: contract.id, authority: "warranty_network" })).id;
  await rateCards.setTerms(owner(), {
    rateCardId: card,
    labourRates: [{ band: "standard", hourlyRate: "85.00" }],
    materialMarkup: [{ upToCost: null, percent: "0.1" }],
  });
});
afterAll(async () => { if (raw) await raw.end(); });

run("billing the rest of a claim to the customer", () => {
  it("is refused while the warranty company has not finished with the claim, and says so on the claim", async () => {
    const { claimId } = await claimed();
    const waiting = await claims.get(owner(), { id: claimId });
    expect(waiting.billOn).toEqual({ amount: null, refusal: expect.stringContaining("has not finished with this claim") });
    await expect(claims.billRest(owner(), { id: claimId })).rejects.toThrow(/has not finished with this claim/);
  });

  it("is refused while their invoice still owes it, then bills a draft to the homeowner once it is credited", async () => {
    const { claimId, jobId, payerInvoiceId } = await claimed();
    await claims.decide(owner(), { id: claimId, outcome: "approved", amount: "260.00" });
    await claims.recordPayment(owner(), { id: claimId, amount: "260.00", method: "check", reference: "88112" });
    await expect(claims.billRest(owner(), { id: claimId }))
      .rejects.toThrow("Their invoice still shows $30.00 owing. Credit it or write it off on their invoice first, so the same money is not owed by two people.");

    /** Their schedule never covered the 30.00: a credit on their invoice. */
    await creditNotes.create(owner(), {
      customerId: warrantyCo, invoiceId: payerInvoiceId, reason: "price_adjustment",
      lines: [{ name: "Not covered by their schedule", quantity: "1", unitPrice: "30.00", taxable: false }],
      draft: false, apply: true,
    });
    const ready = await claims.get(owner(), { id: claimId });
    expect(ready.billOn).toEqual({ amount: "30.0000", refusal: null });

    const billedOn = await claims.billRest(owner(), { id: claimId });
    expect(billedOn.billedInvoice).toMatchObject({ status: "draft", total: "30.0000" });
    const draft = await billing.get(owner(), { id: billedOn.billedInvoice!.id });
    expect(draft).toMatchObject({ customerId: homeowner, jobId, status: "draft", total: "30.0000" });
    expect(draft.lines).toHaveLength(1);
    /** Its whole price: the job's coverage takes nothing off it again. */
    expect(draft.lines[0]).toMatchObject({ name: "Not paid by Shield Home Warranty", taxable: false, lineTotal: "30.0000" });
    expect(draft.lines[0]!.description).toContain("was claimed $290.00");
    expect(draft.lines[0]!.description).toContain("paid $260.00");
    expect(draft.lines[0]!.description).toContain("SHW-7001");

    /** Once, and the claim says so. */
    expect(billedOn.billOn.refusal).toBe(`This claim has already been billed to the customer, on invoice ${billedOn.billedInvoice!.number}.`);
    await expect(claims.billRest(owner(), { id: claimId })).rejects.toThrow(/already been billed/);

    /** A draft posts nothing. */
    const [{ n } = { n: "0" }] = await raw<{ n: string }[]>`
      select count(*)::text as n from public.ledger_entry where organization_id = ${ORG} and source_id = ${billedOn.billedInvoice!.id}`;
    expect(n).toBe("0");
    const [audit] = await raw<{ after: { amount: string } }[]>`
      select after from public.audit_log where organization_id = ${ORG} and action = 'claim.billed_on' and entity_id = ${claimId}`;
    expect(audit!.after.amount).toBe("30.0000");
  });

  it("bills the whole claim once a denial is written off on their invoice", async () => {
    const { claimId, payerInvoiceId } = await claimed();
    await claims.decide(owner(), { id: claimId, outcome: "denied", note: "Pre-existing condition" });
    await billing.writeOff(owner(), { id: payerInvoiceId, reason: "Denied by Shield, pre-existing condition" });
    const billedOn = await claims.billRest(owner(), { id: claimId });
    expect(billedOn.billedInvoice!.total).toBe("290.0000");
    const draft = await billing.get(owner(), { id: billedOn.billedInvoice!.id });
    expect(draft.lines[0]!.description).toContain("having denied the claim");
  });

  it("can be billed again once the draft is deleted, and answers a retry with the claim as billed", async () => {
    const { claimId, payerInvoiceId } = await claimed();
    await claims.recordPayment(owner(), { id: claimId, amount: "200.00", method: "ach" });
    await billing.writeOff(owner(), { id: payerInvoiceId, reason: "They will not pay the rest" });
    const first = await claims.billRest(owner("bill-rest-retry"), { id: claimId });
    const again = await claims.billRest(owner("bill-rest-retry"), { id: claimId });
    expect(again.billedInvoice!.id).toBe(first.billedInvoice!.id);
    expect(first.billedInvoice!.total).toBe("90.0000");

    await billing.deleteDraft(owner(), { id: first.billedInvoice!.id });
    const cleared = await claims.get(owner(), { id: claimId });
    expect(cleared.billedInvoice).toBeNull();
    expect(cleared.billOn.amount).toBe("90.0000");
    const second = await claims.billRest(owner(), { id: claimId });
    expect(second.billedInvoice!.id).not.toBe(first.billedInvoice!.id);
  });

  it("refuses when they paid all of it", async () => {
    const { claimId } = await claimed();
    await claims.recordPayment(owner(), { id: claimId, amount: "290.00", method: "check" });
    await expect(claims.billRest(owner(), { id: claimId }))
      .rejects.toThrow("They paid everything that was claimed, so there is nothing to bill the customer.");
  });

  it("is refused to a role that cannot write invoices", async () => {
    const { claimId } = await claimed();
    await expect(claims.billRest(as(["dispatcher"]), { id: claimId })).rejects.toThrow();
  });
});
