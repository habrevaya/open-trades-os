import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as rentals from "../src/services/rentals";
import * as rentalBilling from "../src/services/rental-billing";
import * as facilities from "../src/services/disposal-facilities";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * A MARKUP ON A PASSED ON DISPOSAL FEE, AND ADDING IT WITHOUT ASKING
 *
 * Off by default: the facility's fee is passed on at cost and offered every
 * time. A company that sets a markup charges the fee plus that per cent, and
 * the invoice line says the facility's fee and the markup. A company that
 * says to add it without asking gets it on the hire's invoice when it is
 * raised, unless somebody says to leave it off, and a fee that cannot be
 * worked out still stops the invoice.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("dmark:org");
const USER = fixtureId("dmark:user");

let raw: postgres.Sql;
let propertyId = "";
let facilityId = "";
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);
let n = 0;
const can = async () => (await rentals.addAsset(owner(), { assetType: "roll_off_container", identifier: `DM-${++n}`, size: "20 yard" })).id;
const at = (day: number) => `2026-06-${String(day).padStart(2, "0")}T17:00:00Z`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Markup Bins", slug: "disposal-markup-co" });
  await raw`update public.organization set timezone = 'America/Chicago',
    settings = coalesce(settings, '{}'::jsonb) || '{"rentalDispatch": {"automaticCollections": false}}'::jsonb where id = ${ORG}`;
  const customer = await customers.create(owner(), {
    type: "commercial", name: "Ridge Build", phone: "+15125550877", paymentTermsDays: 30, taxExempt: true, tags: [], customFields: {},
  });
  propertyId = (await properties.create(owner(), {
    address: { line1: "3 Kiln Rd", city: "Austin", state: "TX", postalCode: "78702", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  })).id;
  facilityId = (await facilities.createFacility(owner(), {
    name: "Mesa Landfill", feeBasis: "per_ton", feeAmount: "60", minimumFee: "40",
  })).id;
});

/** A collected hire whose terms pass the fee on: 2.5 tons at 60 a ton is 150.00. */
async function collected(pickup: Partial<rentals.PickUpInput> = {}) {
  const hire = await rentals.deliver(owner(), {
    assetId: await can(), propertyId, deliveredAt: at(1), includedDays: 7, dailyRate: "10.00", disposalPassThrough: true,
  });
  await rentals.pickUp(owner(), { id: hire.id, pickedUpAt: at(5), tons: "2.5", facilityId, ticketNumber: `T-${n}`, ...pickup });
  return hire.id;
}

run("a markup on a passed on disposal fee", () => {
  it("is off by default, and the line says the fee is at cost", async () => {
    expect(await facilities.disposalBilling(owner())).toEqual({ markup: null, addWithoutAsking: false });
    const id = await collected();
    expect((await rentals.getRental(owner(), { id })).disposalFeeOffer)
      .toMatchObject({ amount: "150.0000", cost: "150.0000", markup: null, automatic: false });
    const raised = await rentalBilling.invoiceHire(owner(), { id, disposalFee: "pass_on" });
    const invoice = await billing.get(owner(), { id: raised.invoiceId });
    const fee = invoice.lines.find((l) => /disposal at Mesa Landfill/.test(l.name))!;
    expect(fee).toMatchObject({ unitPrice: "150.0000" });
    expect(fee.description).toMatch(/2\.5 tons at 60\.0000 a ton, scale ticket T-\d+, at cost$/);
  });

  it("charges the fee plus the markup, says both on the line, and keeps who set it", async () => {
    await expect(facilities.setDisposalBilling(as(["office_manager"]), { markup: "0.15" })).rejects.toBeInstanceOf(PermissionError);
    await expect(facilities.setDisposalBilling(owner(), { markup: "15" })).rejects.toBeInstanceOf(ConflictError);
    expect(await facilities.setDisposalBilling(owner(), { markup: "0.15" })).toEqual({ markup: "0.15", addWithoutAsking: false });
    const [audited] = await raw<{ action: string }[]>`select action from public.audit_log
      where organization_id = ${ORG} and action = 'rental.disposal_billing_set'`;
    expect(audited).toBeDefined();

    const id = await collected();
    expect((await rentals.getRental(owner(), { id })).disposalFeeOffer)
      .toMatchObject({ amount: "172.5000", cost: "150.0000", markup: "0.15" });
    const preview = await rentalBilling.previewHireInvoice(owner(), { id });
    expect(preview).toMatchObject({ decisionNeeded: true, disposalFeeAutomatic: false });
    expect(preview.disposalFee[0]).toMatchObject({ amount: "172.5000", cost: "150.0000", markup: "0.15" });
    /** Still asked: a markup is not a decision to add it. */
    await expect(rentalBilling.invoiceHire(owner(), { id })).rejects.toThrow(/172\.50 at Mesa Landfill[^]*150\.00 plus 15%/);

    const raised = await rentalBilling.invoiceHire(owner(), { id, disposalFee: "pass_on" });
    expect(raised.lines.map((l) => l.amount)).toEqual(["50.0000", "172.5000"]);
    const invoice = await billing.get(owner(), { id: raised.invoiceId });
    const fee = invoice.lines.find((l) => /disposal at Mesa Landfill/.test(l.name))!;
    expect(fee.description).toMatch(/the facility's fee of 150\.00 plus a 15% handling markup$/);
    expect(await rentals.getRental(owner(), { id })).toMatchObject({ disposalFeePassedOn: true, disposalFeeAmount: "172.5000" });

    /** Turned off again, the next fee is at cost. */
    await facilities.setDisposalBilling(owner(), { markup: null });
    const next = await collected();
    expect((await rentals.getRental(owner(), { id: next })).disposalFeeOffer).toMatchObject({ amount: "150.0000", markup: null });
  });
});

run("adding the fee without asking", () => {
  it("puts it on when the invoice is raised, leaves it off when told to, and records the decision", async () => {
    await facilities.setDisposalBilling(owner(), { addWithoutAsking: true, markup: "0.1" });
    const id = await collected();
    expect((await rentals.getRental(owner(), { id })).disposalFeeOffer).toMatchObject({ amount: "165.0000", automatic: true });
    expect(await rentalBilling.previewHireInvoice(owner(), { id })).toMatchObject({ decisionNeeded: false, disposalFeeAutomatic: true });

    const raised = await rentalBilling.invoiceHire(owner(), { id });
    expect(raised.disposalFee).toEqual({ passedOn: true, amount: "165.0000" });
    expect(raised.lines.map((l) => l.amount)).toEqual(["50.0000", "165.0000"]);
    const [row] = await raw<{ decided_by: string | null }[]>`
      select disposal_fee_decided_by_user_id as decided_by from public.rental where id = ${id}`;
    expect(row!.decided_by).toBe(USER);
    const [audit] = await raw<{ after: { disposalFeeAutomatic?: boolean; disposalFeeCost?: string } }[]>`
      select after from public.audit_log where organization_id = ${ORG} and action = 'rental.invoiced' and entity_id = ${id}`;
    expect(audit!.after).toMatchObject({ disposalFeeAutomatic: true, disposalFeeCost: "150.0000" });

    const other = await collected();
    const left = await rentalBilling.invoiceHire(owner(), { id: other, disposalFee: "leave_off" });
    expect(left.disposalFee).toEqual({ passedOn: false, amount: "165.0000" });
    expect(left.lines.map((l) => l.amount)).toEqual(["50.0000"]);
  });

  it("still stops the invoice when a fee cannot be worked out", async () => {
    await facilities.setDisposalBilling(owner(), { addWithoutAsking: true });
    const hire = await rentals.deliver(owner(), {
      assetId: await can(), propertyId, deliveredAt: at(1), includedDays: 7, dailyRate: "10.00", disposalPassThrough: true,
    });
    await rentals.pickUp(owner(), { id: hire.id, pickedUpAt: at(5), tons: "2.5" });
    expect(await rentalBilling.previewHireInvoice(owner(), { id: hire.id })).toMatchObject({ decisionNeeded: true, disposalFeeAutomatic: false });
    await expect(rentalBilling.invoiceHire(owner(), { id: hire.id })).rejects.toThrow(/cannot be worked out/);
    const raised = await rentalBilling.invoiceHire(owner(), { id: hire.id, disposalFee: "leave_off" });
    expect(raised.disposalFee).toEqual({ passedOn: false, amount: null });
  });
});
