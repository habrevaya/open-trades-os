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
 * A MARKUP FOR ONE FACILITY OR ONE MATERIAL
 *
 * The company marks every passed on fee up 15%. Mesa Landfill has 25% of its
 * own and concrete 5% of its own; a haul at Mesa takes Mesa's, a haul of
 * concrete takes concrete's, a haul of concrete at Mesa takes the smaller, and
 * a haul anywhere else of anything else takes the company's. A markup of 0
 * passes that fee on at cost. The invoice line says whose markup it was.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("dmark-scope:org");
const USER = fixtureId("dmark-scope:user");

let raw: postgres.Sql;
let propertyId = "";
let mesa = "";
let ridge = "";
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);
let n = 0;
const can = async () => (await rentals.addAsset(owner(), { assetType: "roll_off_container", identifier: `DS-${++n}`, size: "20 yard" })).id;
const at = (day: number) => `2026-06-${String(day).padStart(2, "0")}T17:00:00Z`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Markup Scope Bins", slug: "disposal-markup-scope-co" });
  await raw`update public.organization set timezone = 'America/Chicago',
    settings = coalesce(settings, '{}'::jsonb) || '{"rentalDispatch": {"automaticCollections": false}}'::jsonb where id = ${ORG}`;
  const customer = await customers.create(owner(), {
    type: "commercial", name: "Kiln Build", phone: "+15125550878", paymentTermsDays: 30, taxExempt: true, tags: [], customFields: {},
  });
  propertyId = (await properties.create(owner(), {
    address: { line1: "4 Kiln Rd", city: "Austin", state: "TX", postalCode: "78702", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  })).id;
  mesa = (await facilities.createFacility(owner(), { name: "Mesa Landfill", feeBasis: "per_ton", feeAmount: "60", minimumFee: "40" })).id;
  ridge = (await facilities.createFacility(owner(), { name: "Ridge Transfer", feeBasis: "per_ton", feeAmount: "60", minimumFee: "40" })).id;
  await facilities.setDisposalBilling(owner(), { markup: "0.15" });
});

/** A collected hire whose terms pass the fee on: 2.5 tons at 60 a ton is 150.00. */
async function collected(facilityId: string, materialType: string | null = null) {
  const hire = await rentals.deliver(owner(), {
    assetId: await can(), propertyId, deliveredAt: at(1), includedDays: 7, dailyRate: "10.00", disposalPassThrough: true,
  });
  await rentals.pickUp(owner(), { id: hire.id, pickedUpAt: at(5), tons: "2.5", facilityId, ticketNumber: `T-${n}` });
  if (materialType) await raw`update public.rental set material_type = ${materialType} where id = ${hire.id}`;
  return hire.id;
}
const offer = async (id: string) => (await rentals.getRental(owner(), { id })).disposalFeeOffer;

run("a markup for one facility or one material", () => {
  it("is read before the company's, the smaller when both apply, and the company's otherwise", async () => {
    await facilities.setDisposalMarkup(owner(), { facilityId: mesa, markup: "0.25" });
    const listed = await facilities.setDisposalMarkup(owner(), { material: "  Concrete ", markup: "0.05" });
    expect(listed).toEqual({
      facilityMarkups: [{ facilityId: mesa, facilityName: "Mesa Landfill", markup: "0.25" }],
      materialMarkups: [{ material: "Concrete", markup: "0.05" }],
    });

    expect(await offer(await collected(mesa))).toMatchObject({ amount: "187.5000", cost: "150.0000", markup: "0.25" });
    expect(await offer(await collected(ridge, "concrete"))).toMatchObject({ amount: "157.5000", markup: "0.05" });
    expect(await offer(await collected(mesa, "CONCRETE"))).toMatchObject({ amount: "157.5000", markup: "0.05" });
    expect(await offer(await collected(ridge, "Brush"))).toMatchObject({ amount: "172.5000", markup: "0.15" });
  });

  it("passes the fee on at cost with a markup of 0, and the line says whose it was", async () => {
    await facilities.setDisposalMarkup(owner(), { facilityId: ridge, markup: "0" });
    await facilities.setDisposalMarkup(owner(), { facilityId: mesa, markup: "0.25" });
    const atCost = await collected(ridge);
    expect(await offer(atCost)).toMatchObject({ amount: "150.0000", markup: null });
    const raised = await rentalBilling.invoiceHire(owner(), { id: atCost, disposalFee: "pass_on" });
    const line = (await billing.get(owner(), { id: raised.invoiceId })).lines.find((l) => /disposal at Ridge Transfer/.test(l.name))!;
    expect(line.description).toMatch(/at cost, as set for Ridge Transfer$/);

    const marked = await collected(mesa);
    const second = await rentalBilling.invoiceHire(owner(), { id: marked, disposalFee: "pass_on" });
    const mesaLine = (await billing.get(owner(), { id: second.invoiceId })).lines.find((l) => /disposal at Mesa Landfill/.test(l.name))!;
    expect(mesaLine.description).toMatch(/the facility's fee of 150\.00 plus a 25% handling markup set for Mesa Landfill$/);
  });

  it("is taken off with null, falling back to the company's, and a hire already invoiced keeps what it was charged", async () => {
    await facilities.setDisposalMarkup(owner(), { facilityId: mesa, markup: "0.25" });
    const first = await collected(mesa);
    const raised = await rentalBilling.invoiceHire(owner(), { id: first, disposalFee: "pass_on" });
    expect(raised.disposalFee).toEqual({ passedOn: true, amount: "187.5000" });
    const off = await facilities.setDisposalMarkup(owner(), { facilityId: mesa, markup: null });
    expect(off.facilityMarkups).toEqual([]);
    expect(await offer(await collected(mesa))).toMatchObject({ amount: "172.5000", markup: "0.15" });
    expect(await rentals.getRental(owner(), { id: first })).toMatchObject({ disposalFeeAmount: "187.5000" });
  });

  it("is a company setting: refused to others, refused in words when unclear, audited, and the company's own is untouched", async () => {
    await expect(facilities.setDisposalMarkup(as(["office_manager"]), { facilityId: mesa, markup: "0.2" })).rejects.toBeInstanceOf(PermissionError);
    await expect(facilities.setDisposalMarkup(owner(), { facilityId: mesa, material: "Concrete", markup: "0.2" })).rejects.toThrow(/one of them/);
    await expect(facilities.setDisposalMarkup(owner(), { markup: "0.2" })).rejects.toBeInstanceOf(ConflictError);
    await expect(facilities.setDisposalMarkup(owner(), { facilityId: mesa, markup: "20" })).rejects.toThrow(/at most 100%/);
    await expect(facilities.setDisposalMarkup(owner(), { facilityId: fixtureId("dmark-scope:elsewhere"), markup: "0.2" }))
      .rejects.toThrow(/Disposal facility/);
    await facilities.setDisposalMarkup(owner(), { material: "Concrete", markup: "0.1" });
    await facilities.setDisposalMarkup(owner(), { material: "concrete", markup: "0.1" });
    const audits = await raw<{ after: { materialMarkups: Record<string, unknown> } }[]>`select after from public.audit_log
      where organization_id = ${ORG} and action = 'rental.disposal_billing_set' order by created_at`;
    /** The company's 15% and the one material markup: setting it again the same changes nothing. */
    expect(audits).toHaveLength(2);
    expect(audits[1]!.after.materialMarkups).toEqual({ concrete: { material: "Concrete", markup: "0.1" } });
    expect(await facilities.disposalBilling(owner())).toEqual({ markup: "0.15", addWithoutAsking: false });
    await facilities.setDisposalBilling(owner(), { markup: "0.2" });
    expect((await facilities.disposalMarkups(owner())).materialMarkups).toEqual([{ material: "Concrete", markup: "0.1" }]);
  });
});
