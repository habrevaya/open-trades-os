import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { type Actor } from "@opentradesos/core";
import * as rentals from "../src/services/rentals";
import * as rentalBilling from "../src/services/rental-billing";
import * as facilities from "../src/services/disposal-facilities";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * PASSING DISPOSAL ON, AND INVOICING A SWAP CHAIN AS ONE
 *
 * The facility's fee is the customer's only when the hire's terms say so, it is
 * offered and never added without a person saying to, and whether it went on is
 * kept on the hire. A swap chain is invoiced one haul at a time or as one invoice
 * for the whole hire, the company's choice per rental.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("hi:org");
const USER = fixtureId("hi:user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
let propertyId = "";
let facilityId = "";
const db = () => testDb(url!);
const as = (roles: string[], key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(["owner"], key);
let n = 0;
const can = async () => (await rentals.addAsset(owner(), { assetType: "roll_off_container", identifier: `HI-${++n}`, size: "20 yard" })).id;
/** Noon in Austin on a day in June 2026, as an instant. */
const at = (day: number) => `2026-06-${String(day).padStart(2, "0")}T17:00:00Z`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Chain Bins", slug: "hire-invoicing-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`update public.organization set settings = coalesce(settings, '{}'::jsonb)
    || '{"rentalDispatch": {"automaticCollections": false}}'::jsonb where id = ${ORG}`;
  const customer = await customers.create(owner(), {
    type: "commercial", name: "Ridge Build", phone: "+15125550133",
    paymentTermsDays: 30, taxExempt: true, tags: [], customFields: {},
  });
  propertyId = (await properties.create(owner(), {
    address: { line1: "14 Kiln Rd", city: "Austin", state: "TX", postalCode: "78702", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  })).id;
  facilityId = (await facilities.createFacility(owner(), {
    name: "Pass Through Landfill", feeBasis: "per_ton", feeAmount: "60", minimumFee: "40",
  })).id;
});

afterAll(async () => { if (raw) await raw.end(); });

/** A collected hire priced by the day at $10, seven days included, with the terms given. */
async function collected(terms: Partial<rentals.DeliverInput>, pickup: Partial<rentals.PickUpInput> = {}) {
  const hire = await rentals.deliver(owner(), {
    assetId: await can(), propertyId, deliveredAt: at(1), includedDays: 7, dailyRate: "10.00", ...terms,
  });
  await rentals.pickUp(owner(), { id: hire.id, pickedUpAt: at(5), tons: "2.5", facilityId, ticketNumber: `T-${n}`, ...pickup });
  return hire.id;
}

run("passing the facility's disposal fee on", () => {
  it("offers it and refuses to raise the invoice until a person says whether to add it", async () => {
    const id = await collected({ disposalPassThrough: true });
    const view = await rentals.getRental(owner(), { id });
    expect(view).toMatchObject({ disposalPassThrough: true, disposalFeePassedOn: null });
    /** 2.5 tons at 60 a ton, worked out from the ticket's weight and the facility's rate. */
    expect(view.disposalFeeOffer).toMatchObject({ amount: "150.0000", source: "worked_out", facility: "Pass Through Landfill" });

    const preview = await rentalBilling.previewHireInvoice(owner(), { id });
    expect(preview).toMatchObject({ refused: null, hauls: 1, decisionNeeded: true });
    expect(preview.disposalFee).toEqual([expect.objectContaining({ amount: "150.0000", source: "worked_out" })]);
    expect(preview.lines.map((l) => l.amount)).toEqual(["50.0000"]);

    await expect(rentalBilling.invoiceHire(owner(), { id })).rejects.toThrow(/pass the facility's disposal fee on[^]*150\.00 at Pass Through Landfill[^]*never added without you saying so/);
    /** Nothing was written by the refusal. */
    expect((await rentals.getRental(owner(), { id })).invoiceId).toBeNull();
  });

  it("puts the fee on the invoice at cost when told to, and keeps that it was", async () => {
    const id = await collected({ disposalPassThrough: true });
    const invoice = await rentalBilling.invoiceHire(owner(), { id, disposalFee: "pass_on" });
    expect(invoice.lines.map((l) => l.amount)).toEqual(["50.0000", "150.0000"]);
    expect(invoice.lines[1]!.name).toBe("Container HI-2 (20 yard), disposal at Pass Through Landfill");
    expect(invoice.disposalFee).toEqual({ passedOn: true, amount: "150.0000" });
    const after = await rentals.getRental(owner(), { id });
    expect(after).toMatchObject({ disposalFeePassedOn: true, disposalFeeAmount: "150.0000", disposalFeeOffer: null });
    const [row] = await raw<{ decided_by: string | null; decided_at: Date | null }[]>`
      select disposal_fee_decided_by_user_id as decided_by, disposal_fee_decided_at as decided_at from public.rental where id = ${id}`;
    expect(row!.decided_by).toBe(USER);
    expect(row!.decided_at).not.toBeNull();
  });

  it("leaves it off when told to, and keeps that it was left off", async () => {
    const id = await collected({ disposalPassThrough: true });
    const invoice = await rentalBilling.invoiceHire(owner(), { id, disposalFee: "leave_off" });
    expect(invoice.lines.map((l) => l.amount)).toEqual(["50.0000"]);
    expect(invoice.disposalFee).toEqual({ passedOn: false, amount: "150.0000" });
    expect(await rentals.getRental(owner(), { id })).toMatchObject({ disposalFeePassedOn: false, disposalFeeAmount: "150.0000" });
  });

  it("offers what the facility billed when one was recorded, over what the rate works out", async () => {
    const id = await collected({ disposalPassThrough: true }, { disposalFee: "142.5000" });
    expect((await rentals.getRental(owner(), { id })).disposalFeeOffer).toMatchObject({ amount: "142.5000", source: "recorded" });
    const invoice = await rentalBilling.invoiceHire(owner(), { id, disposalFee: "pass_on" });
    expect(invoice.lines.map((l) => l.amount)).toEqual(["50.0000", "142.5000"]);
  });

  it("charges the facility's minimum for a light load", async () => {
    const id = await collected({ disposalPassThrough: true }, { tons: "0.3" });
    expect((await rentals.getRental(owner(), { id })).disposalFeeOffer).toMatchObject({ amount: "40.0000", why: "the facility's minimum for a load" });
  });

  it("never adds it when the terms do not pass it on, and refuses to pass it on then", async () => {
    /** No weight recorded either: a weight with no tonnage terms is a meter with no rate, which is refused as ever. */
    const id = await collected({}, { tons: null });
    expect((await rentals.getRental(owner(), { id })).disposalFeeOffer).toBeNull();
    await expect(rentalBilling.invoiceHire(owner(), { id, disposalFee: "pass_on" })).rejects.toThrow(/do not pass the disposal fee on/);
    const invoice = await rentalBilling.invoiceHire(owner(), { id });
    expect(invoice.lines.map((l) => l.amount)).toEqual(["50.0000"]);
    expect(invoice.disposalFee).toBeNull();
    expect(await rentals.getRental(owner(), { id })).toMatchObject({ disposalFeePassedOn: null });
  });

  it("says what is missing rather than passing on nothing, and lets a person leave it off", async () => {
    const hire = await rentals.deliver(owner(), {
      assetId: await can(), propertyId, deliveredAt: at(1), includedDays: 7, dailyRate: "10.00", disposalPassThrough: true,
    });
    /** No facility recorded and no fee typed. */
    await rentals.pickUp(owner(), { id: hire.id, pickedUpAt: at(5), tons: "2" });
    expect((await rentals.getRental(owner(), { id: hire.id })).disposalFeeOffer).toMatchObject({ amount: null });
    await expect(rentalBilling.invoiceHire(owner(), { id: hire.id })).rejects.toThrow(/cannot be worked out[^]*no recorded facility/);
    await expect(rentalBilling.invoiceHire(owner(), { id: hire.id, disposalFee: "pass_on" })).rejects.toThrow(/cannot be passed on/);
    const invoice = await rentalBilling.invoiceHire(owner(), { id: hire.id, disposalFee: "leave_off" });
    expect(invoice.disposalFee).toEqual({ passedOn: false, amount: null });
  });

  it("will not pass the fee on for a hire that bills disposal by the ton, which charges the load twice", async () => {
    await expect(rentals.deliver(owner(), {
      assetId: await can(), propertyId, deliveredAt: at(1), disposalPassThrough: true, perTonRate: "60.00", includedTons: "2",
    })).rejects.toThrow(/same load twice/);
    const hire = await rentals.deliver(owner(), { assetId: await can(), propertyId, deliveredAt: at(1), perTonRate: "60.00", includedTons: "2" });
    await expect(rentalBilling.setBillingTerms(owner(), { id: hire.id, disposalPassThrough: true })).rejects.toThrow(/same load twice|charge the customer for the same load twice/);
  });

  it("asks again when the invoice is voided and raised anew, because the decision belonged to that invoice", async () => {
    const id = await collected({ disposalPassThrough: true });
    const first = await rentalBilling.invoiceHire(owner(), { id, disposalFee: "pass_on" });
    await raw`update public.invoice set status = 'void' where id = ${first.invoiceId}`;
    await expect(rentalBilling.invoiceHire(owner(), { id })).rejects.toThrow(/Say whether to put it on the invoice/);
    const second = await rentalBilling.invoiceHire(owner(), { id, disposalFee: "leave_off" });
    expect(second.invoiceId).not.toBe(first.invoiceId);
    expect(await rentals.getRental(owner(), { id })).toMatchObject({ disposalFeePassedOn: false });
  });

  it("needs invoice:write to raise or preview, and asset:write to change the terms", async () => {
    const id = await collected({ disposalPassThrough: true });
    await expect(rentalBilling.invoiceHire(as(["dispatcher"]), { id, disposalFee: "pass_on" })).rejects.toMatchObject({ name: "PermissionError" });
    await expect(rentalBilling.previewHireInvoice(as(["dispatcher"]), { id })).rejects.toMatchObject({ name: "PermissionError" });
    await expect(rentalBilling.setBillingTerms(as(["dispatcher"]), { id, invoiceAs: "chain" })).rejects.toMatchObject({ name: "PermissionError" });
  });
});

run("a swap chain on one invoice", () => {
  /**
   * Seven days included at $10 and $12 a day over. The first can is out 1 to 8 June
   * (eight container days), the second 8 to 15 June (eight), the third 15 to 20 (six).
   */
  async function chain(invoiceAs: "per_haul" | "chain", extra: Partial<rentals.DeliverInput> = {}) {
    const first = await rentals.deliver(owner(), {
      assetId: await can(), propertyId, deliveredAt: at(1), includedDays: 7, dailyRate: "10.00", overageRate: "12.00", invoiceAs, ...extra,
    });
    /** Weights are recorded only where the terms pass disposal on: a weight with no tonnage terms is a meter with no rate. */
    const weighed = (tons: string) => (extra.disposalPassThrough ? { tons, facilityId } : {});
    const s1 = await rentals.swap(owner(), { id: first.id, replacementAssetId: await can(), at: at(8), ...weighed("1.0") });
    const s2 = await rentals.swap(owner(), { id: s1.opened.id, replacementAssetId: await can(), at: at(15), ...weighed("1.5") });
    return { ids: [first.id, s1.opened.id, s2.opened.id] as const, swaps: [s1, s2] as const };
  }

  it("carries the choice through every swap like the rates", async () => {
    const { swaps } = await chain("chain", { disposalPassThrough: true });
    expect(swaps[0].opened).toMatchObject({ invoiceAs: "chain", disposalPassThrough: true, previousRentalId: swaps[0].closed.id });
    expect(swaps[1].opened).toMatchObject({ invoiceAs: "chain", disposalPassThrough: true });
  });

  it("waits for the last can to be collected, then raises one invoice with a group of lines per can", async () => {
    const { ids } = await chain("chain");
    /** Asked from the middle of the chain; it does not matter which link. */
    await expect(rentalBilling.invoiceHire(owner(), { id: ids[1] })).rejects.toThrow(/whole swap chain[^]*still on site/);
    expect((await rentalBilling.previewHireInvoice(owner(), { id: ids[1] })).refused).toMatch(/still on site/);
    await rentals.pickUp(owner(), { id: ids[2], pickedUpAt: at(20) });

    const preview = await rentalBilling.previewHireInvoice(owner(), { id: ids[1] });
    expect(preview).toMatchObject({ refused: null, hauls: 3, invoiceAs: "chain", decisionNeeded: false });
    const invoice = await rentalBilling.invoiceHire(owner(), { id: ids[1] });
    expect(invoice.hauls).toBe(3);
    /** Can 1: 7 days at 10 and 1 over at 12. Can 2 the same. Can 3: 6 days at 10. */
    expect(invoice.lines.map((l) => l.amount)).toEqual(["70.0000", "12.0000", "70.0000", "12.0000", "60.0000"]);
    expect(invoice.lines[0]!.name).toMatch(/^Container HI-\d+ \(20 yard\), rental 2026-06-01 to 2026-06-08$/);
    expect(invoice.lines[4]!.name).toMatch(/rental 2026-06-15 to 2026-06-20$/);
    expect(Number(invoice.total)).toBeCloseTo(224, 2);
    for (const id of ids) expect((await rentals.getRental(owner(), { id })).invoiceId).toBe(invoice.invoiceId);
    const [count] = await raw<{ n: number }[]>`select count(*)::int as n from public.invoice_line where invoice_id = ${invoice.invoiceId}`;
    expect(count!.n).toBe(5);
    await expect(rentalBilling.invoiceHire(owner(), { id: ids[0] })).rejects.toThrow(/Every haul in this swap chain is already on an invoice/);
  });

  it("invoices a chain one haul at a time when the hire is not billed as a chain", async () => {
    const { ids } = await chain("per_haul");
    await rentals.pickUp(owner(), { id: ids[2], pickedUpAt: at(20) });
    const first = await rentalBilling.invoiceHire(owner(), { id: ids[0] });
    const second = await rentalBilling.invoiceHire(owner(), { id: ids[1] });
    expect(first.hauls).toBe(1);
    expect(first.invoiceId).not.toBe(second.invoiceId);
    expect(first.lines.map((l) => l.amount)).toEqual(["70.0000", "12.0000"]);
    await expect(rentalBilling.invoiceHire(owner(), { id: ids[0] })).rejects.toThrow(/already on invoice/);
  });

  it("can be changed to one invoice for the chain, billing only the hauls not already on one", async () => {
    const { ids } = await chain("per_haul");
    await rentals.pickUp(owner(), { id: ids[2], pickedUpAt: at(20) });
    await rentalBilling.invoiceHire(owner(), { id: ids[0] });
    const changed = await rentalBilling.setBillingTerms(owner(), { id: ids[2], invoiceAs: "chain" });
    expect(changed).toMatchObject({ invoiceAs: "chain", hauls: 2 });
    /** The one already invoiced was left alone. */
    expect((await rentals.getRental(owner(), { id: ids[0] })).invoiceAs).toBe("per_haul");
    const rest = await rentalBilling.invoiceHire(owner(), { id: ids[1] });
    expect(rest.hauls).toBe(2);
    expect(rest.lines.map((l) => l.amount)).toEqual(["70.0000", "12.0000", "60.0000"]);
    await expect(rentalBilling.setBillingTerms(owner(), { id: ids[0], invoiceAs: "per_haul" })).rejects.toThrow(/already on an invoice/);
  });

  it("passes the fee of every can on, or none, in one decision", async () => {
    const { ids } = await chain("chain", { disposalPassThrough: true });
    await rentals.pickUp(owner(), { id: ids[2], pickedUpAt: at(20), tons: "2", facilityId });
    const preview = await rentalBilling.previewHireInvoice(owner(), { id: ids[0] });
    /** 1.0 ton, 1.5 tons and 2 tons at 60 a ton. */
    expect(preview.disposalFee.map((o) => o.amount)).toEqual(["60.0000", "90.0000", "120.0000"]);
    await expect(rentalBilling.invoiceHire(owner(), { id: ids[0] })).rejects.toThrow(/Say whether/);
    const invoice = await rentalBilling.invoiceHire(owner(), { id: ids[0], disposalFee: "pass_on" });
    expect(invoice.lines.filter((l) => /disposal at Pass Through Landfill/.test(l.name)).map((l) => l.amount)).toEqual(["60.0000", "90.0000", "120.0000"]);
    expect(invoice.disposalFee).toEqual({ passedOn: true, amount: "270.0000" });
    for (const id of ids) expect(await rentals.getRental(owner(), { id })).toMatchObject({ disposalFeePassedOn: true });
  });

  it("names the can when one in the chain has a meter with no rate", async () => {
    const first = await rentals.deliver(owner(), {
      assetId: await can(), propertyId, deliveredAt: at(1), includedDays: 2, dailyRate: "10.00", invoiceAs: "chain",
    });
    await rentals.pickUp(owner(), { id: first.id, pickedUpAt: at(10) });
    await expect(rentalBilling.invoiceHire(owner(), { id: first.id })).rejects.toThrow(/no daily rate/);
  });
});
