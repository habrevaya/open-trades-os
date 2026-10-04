import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { time, type Actor } from "@opentradesos/core";
import * as rentals from "../src/services/rentals";
import * as rentalBilling from "../src/services/rental-billing";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A HIRE AFTER THE CAN HAS GONE OUT, THROUGH A REAL DATABASE
 *
 * Collections put on the board once and never twice, a contamination charge
 * and the two meters on one draft invoice and never on two, and a facility's
 * file of tickets matched to the hauls it weighed without overwriting what a
 * driver typed.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("rb:org");
const USER = fixtureId("rb:user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
let propertyId = "";
let customerId = "";
let fee = "";
const db = () => testDb(url!);
const as = (roles: string[], key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const owner = (key?: string) => as(["owner"], key);

const daysAgo = (days: number) => new Date(Date.now() - days * 864e5).toISOString();
const today = () => time.dateIn(new Date(), ZONE);

async function can(identifier: string) {
  return (await rentals.addAsset(owner(), { assetType: "roll_off_container", identifier, size: "20 yard" })).id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Bin Co", slug: "bin-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const customer = await customers.create(owner(), {
    type: "commercial", name: "Ridge Build", phone: "+15125550177",
    paymentTermsDays: 30, taxExempt: true, tags: [], customFields: {},
  });
  customerId = customer.id;
  propertyId = (await properties.create(owner(), {
    address: { line1: "14 Kiln Rd", city: "Austin", state: "TX", postalCode: "78702", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  })).id;
  await raw`insert into public.job_type (organization_id, name, code, capacity_model)
    values (${ORG}, 'Final pickup', 'pickup', 'asset_rental')`;
  const [item] = await raw<{ id: string }[]>`
    insert into public.price_book_item (organization_id, kind, code) values (${ORG}, 'fee', 'FEE-PROH-TIRE') returning id`;
  fee = item!.id;
  await raw`insert into public.price_book_item_version (organization_id, item_id, version, name, price, effective_from)
    values (${ORG}, ${fee}, 1, 'Prohibited item, tire, each', '25.00', now() - interval '1 day')`;
});

afterAll(async () => { if (raw) await raw.end(); });

run("collections on the board", () => {
  it("books the late hire for today and the hire with a job on its own job, once, and leaves the rest", async () => {
    const late = await rentals.deliver(owner(), { assetId: await can("C-501"), propertyId, deliveredAt: daysAgo(10), includedDays: 7 });
    await rentals.deliver(owner(), { assetId: await can("C-502"), propertyId, deliveredAt: daysAgo(0), includedDays: 7 });
    const standing = await rentals.deliver(owner(), { assetId: await can("C-503"), propertyId, deliveredAt: daysAgo(40) });
    const deliveryJob = await jobs.create(owner(), {
      customerId, propertyId, summary: "Drop a 20 yard", tags: [], customFields: {},
      visit: { windowStart: daysAgo(9), windowEnd: daysAgo(9), estimatedDurationMinutes: 30, technicianIds: [] },
    });
    const withJob = await rentals.deliver(owner(), {
      assetId: await can("C-504"), propertyId, deliveredAt: daysAgo(8), includedDays: 3, jobId: deliveryJob.id,
    });

    const first = await rentalBilling.scheduleCollections(owner(), {});
    expect(first.scheduled.map((s) => s.assetIdentifier).sort()).toEqual(["C-501", "C-504"]);
    const lateOne = first.scheduled.find((s) => s.assetIdentifier === "C-501")!;
    expect(lateOne).toMatchObject({ collectOn: today(), daysLate: 4 });
    expect(first.skipped.map((s) => s.rentalId)).toEqual([standing.id]);
    expect(first.scheduled.find((s) => s.assetIdentifier === "C-504")!.jobId).toBe(deliveryJob.id);

    const stops = await raw<{ rental_id: string; rental_event: string; status: string; job_type: string | null }[]>`
      select v.rental_id, v.rental_event, v.status, jt.code as job_type from public.visit v
      join public.job j on j.id = v.job_id left join public.job_type jt on jt.id = j.job_type_id
      where v.organization_id = ${ORG} and v.rental_event = 'pickup'`;
    expect(stops).toHaveLength(2);
    expect(stops.find((s) => s.rental_id === late.id)).toMatchObject({ status: "unassigned", job_type: "pickup" });

    const second = await rentalBilling.scheduleCollections(owner(), {});
    expect(second.scheduled).toEqual([]);

    // A collection cancelled on the board is offered again.
    await raw`update public.visit set status = 'cancelled' where id = ${lateOne.visitId}`;
    const third = await rentalBilling.scheduleCollections(owner(), {});
    expect(third.scheduled.map((s) => s.rentalId)).toEqual([late.id]);
    expect((await rentals.getRental(owner(), { id: withJob.id })).collectionVisitId).not.toBeNull();
  });

  it("needs job:write as well as asset:write", async () => {
    await expect(rentalBilling.scheduleCollections(as(["dispatcher"]), {})).rejects.toThrow();
  });
});

run("charges and the invoice", () => {
  it("invoices the period, both meters and a tire found on the haul, once", async () => {
    const hire = await rentals.deliver(owner(), {
      assetId: await can("C-601"), propertyId, deliveredAt: "2026-06-01T17:00:00Z",
      includedDays: 7, dailyRate: "10.00", overageRate: "12.00", includedTons: "2", perTonRate: "60.00",
    });
    const tires = await rentalBilling.recordCharge(owner("tire-1"), {
      rentalId: hire.id, kind: "prohibited_item", priceBookItemId: fee, quantity: "2", note: "Under the shingles",
    });
    expect(tires).toMatchObject({ description: "Prohibited item, tire, each", unitPrice: "25.0000", amount: "50.0000" });
    // A replay is the same charge.
    await rentalBilling.recordCharge(owner("tire-1"), { rentalId: hire.id, kind: "prohibited_item", priceBookItemId: fee, quantity: "2" });
    await expect(rentalBilling.recordCharge(owner(), { rentalId: hire.id, kind: "other", description: "Gate repair" }))
      .rejects.toThrow(/Give the charge a price/);

    await expect(rentalBilling.invoiceHire(owner(), { id: hire.id })).rejects.toThrow(/still on site/);
    await rentals.pickUp(owner(), { id: hire.id, pickedUpAt: "2026-06-10T17:00:00Z", tons: "3.1", ticketNumber: "T-9" });

    const invoice = await rentalBilling.invoiceHire(owner(), { id: hire.id });
    /**
     * 1 to 10 June is ten container days. Seven at $10 is $70, three over at
     * $12 is $36, 1.1 tons over at $60 is $66, two tires at $25 is $50.
     */
    expect(invoice.lines.map((l) => l.amount)).toEqual(["70.0000", "36.0000", "66.0000", "50.0000"]);
    expect(Number(invoice.total)).toBeCloseTo(222, 2);

    const [row] = await raw<{ status: string; customer_id: string }[]>`
      select status, customer_id from public.invoice where id = ${invoice.invoiceId}`;
    expect(row).toEqual({ status: "draft", customer_id: customerId });
    await expect(rentalBilling.invoiceHire(owner(), { id: hire.id })).rejects.toThrow(/already on invoice/);
    await expect(rentalBilling.removeCharge(owner(), { id: tires.id })).rejects.toThrow(/on an invoice/);
    await expect(rentalBilling.recordCharge(owner(), { rentalId: hire.id, kind: "overfill", unitPrice: "125", description: "Overfilled" }))
      .rejects.toThrow(/already been invoiced/);
  });

  it("refuses a meter with no rate in that meter's own words", async () => {
    const hire = await rentals.deliver(owner(), {
      assetId: await can("C-602"), propertyId, deliveredAt: "2026-06-01T17:00:00Z", includedDays: 2,
    });
    await rentals.pickUp(owner(), { id: hire.id, pickedUpAt: "2026-06-10T17:00:00Z" });
    await expect(rentalBilling.invoiceHire(owner(), { id: hire.id })).rejects.toThrow(/no daily rate/);
  });
});

run("a facility's scale tickets", () => {
  it("previews, applies only what matches, and overwrites nothing typed", async () => {
    const one = await rentals.deliver(owner(), { assetId: await can("C-701"), propertyId, deliveredAt: "2026-05-01T17:00:00Z" });
    await rentals.pickUp(owner(), { id: one.id, pickedUpAt: "2026-05-14T20:00:00Z" });
    const typed = await rentals.deliver(owner(), { assetId: await can("C-702"), propertyId, deliveredAt: "2026-05-01T17:00:00Z" });
    await rentals.pickUp(owner(), { id: typed.id, pickedUpAt: "2026-05-14T20:00:00Z", tons: "4.5" });

    const csv = [
      "Ticket #,Weigh Date,Container No,Gross Lbs,Tare Lbs,Material,Facility",
      "W-1001,05/15/2026,C-701,\"36,400\",\"28,200\",C&D,Travis Landfill",
      "W-1002,05/14/2026,C-702,\"40,000\",\"28,000\",C&D,Travis Landfill",
      "W-1003,05/14/2026,C-999,30000,28000,C&D,Travis Landfill",
      "W-1004,not a date,C-701,30000,28000,C&D,Travis Landfill",
    ].join("\n");
    const preview = await rentalBilling.previewTickets(owner(), { csv });
    expect(preview.counts).toEqual({ attach: 1, unchanged: 0, skip: 2 });
    expect(preview.problems.map((p) => p.line)).toEqual([5]);
    expect(preview.rows.find((r) => r.ticketNumber === "W-1002")!.why).toContain("typed in at 4.5 tons");

    const applied = await rentalBilling.applyTickets(owner(), { csv });
    expect(applied.attached).toBe(1);
    const after = await rentals.getRental(owner(), { id: one.id });
    expect(after).toMatchObject({ disposalTicketNumber: "W-1001", weightTons: "4.1000", disposalFacility: "Travis Landfill", materialType: "C&D" });
    expect((await rentals.getRental(owner(), { id: typed.id })).weightTons).toBe("4.5000");

    // The same file again changes nothing: the ticket is already on its haul.
    const again = await rentalBilling.previewTickets(owner(), { csv });
    expect(again.counts.attach).toBe(0);
    expect(again.rows.find((r) => r.ticketNumber === "W-1001")!.action).toBe("unchanged");
  });
});
