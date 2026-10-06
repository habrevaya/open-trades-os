import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as afterHours from "../src/services/after-hours";
import * as holidays from "../src/services/holidays";
import * as priceBook from "../src/services/pricebook";
import * as billing from "../src/services/billing";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * AFTER HOURS AND HOLIDAY RATES: CHOSEN ONCE, OFFERED ON THE INVOICE
 *
 * The rates are price book items marked as the after hours rate, the mark a
 * membership plan reads when it waives it, so choosing one marks it. A job
 * whose visit was booked outside the hours kept that day, or on a holiday,
 * is offered the item on its invoice with the sentence that says why, and
 * nothing puts it on an invoice by itself.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("afterhours:org");
const USER = fixtureId("afterhours:user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let customerId = "";
let propertyId = "";
let nightItem = "";
let holidayItem = "";
let diagnosticItem = "";

/** A job with visits booked at these Chicago wall clock times, `YYYY-MM-DDTHH:MM`. */
async function jobAt(...starts: Array<string | { at: string; status: string }>): Promise<string> {
  const [n] = await raw<{ next: number }[]>`select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
  const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${n!.next}, ${customerId}, ${propertyId}, 'scheduled', 'No heat') returning id`;
  for (const start of starts) {
    const { at, status } = typeof start === "string" ? { at: start, status: "scheduled" } : start;
    await raw`insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes)
      values (${ORG}, ${job!.id}, ${status}::visit_status, (${at}::timestamp at time zone ${ZONE}),
              (${at}::timestamp at time zone ${ZONE}) + interval '2 hours', 60)`;
  }
  return job!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "After Hours Co", slug: "after-hours-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  /** Monday to Friday, eight to five; closed at the weekend. */
  for (const day of [1, 2, 3, 4, 5]) {
    await raw`insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at) values (${ORG}, ${day}, '08:00', '17:00')`;
  }
  for (const day of [0, 6]) {
    await raw`insert into public.business_hours (organization_id, day_of_week, closed) values (${ORG}, ${day}, true)`;
  }
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, name) values (${ORG}, 'Pat Cold') returning id`;
  customerId = c!.id;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '1 Frost Ln', 'Austin', 'TX', '78701') returning id`;
  propertyId = p!.id;
  nightItem = (await priceBook.create(owner(), { kind: "service", code: "DIAG-AH", name: "After hours diagnostic", price: "229.00", taxable: false })).id;
  holidayItem = (await priceBook.create(owner(), { kind: "fee", code: "HOL", name: "Holiday call-out", price: "300.00", taxable: false })).id;
  diagnosticItem = (await priceBook.create(owner(), {
    kind: "fee", code: "DIAG", name: "Diagnostic", price: "89.00", taxable: false, feeRole: "diagnostic",
  })).id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  for (const table of ["invoice_line", "invoice", "visit", "job", "after_hours_rate", "company_holiday"]) {
    await raw.unsafe(`delete from public.${table} where organization_id = $1`, [ORG]);
  }
  await raw`update public.price_book_item set fee_role = null where id in (${nightItem}, ${holidayItem})`;
});

run("choosing the rates", () => {
  it("marks a chosen item as the after hours rate, so a plan that waives that rate waives it", async () => {
    const chosen = await afterHours.setRates(owner(), { afterHoursItemId: nightItem, holidayItemId: holidayItem });
    expect(chosen.afterHoursItem).toMatchObject({ id: nightItem, name: "After hours diagnostic", price: "229.0000" });
    expect(chosen.holidayItem).toMatchObject({ id: holidayItem });
    const marks = await raw<{ id: string; fee_role: string }[]>`
      select id, fee_role from public.price_book_item where id in (${nightItem}, ${holidayItem})`;
    expect(marks.every((m) => m.fee_role === "after_hours")).toBe(true);
    expect(chosen.marked.map((i) => i.code).sort()).toEqual(["DIAG-AH", "HOL"]);
    const lines = await raw`select action from public.audit_log where organization_id = ${ORG} and entity_id = ${nightItem}
      and action = 'pricebook.item_updated'`;
    expect(lines.length).toBeGreaterThan(0);
  });

  it("refuses the diagnostic fee and a retired item, in words", async () => {
    await expect(afterHours.setRates(owner(), { afterHoursItemId: diagnosticItem, holidayItemId: null }))
      .rejects.toThrow(/DIAG is marked as the diagnostic fee/);
    const retired = (await priceBook.create(owner(), { kind: "fee", code: "OLD-AH", name: "Old", price: "1.00", taxable: false })).id;
    await raw`update public.price_book_item set active = false where id = ${retired}`;
    await expect(afterHours.setRates(owner(), { afterHoursItemId: retired, holidayItemId: null })).rejects.toThrow(ConflictError);
  });

  it("is chosen only by somebody who may change the price book", async () => {
    await expect(afterHours.setRates(as(["dispatcher"]), { afterHoursItemId: nightItem, holidayItemId: null }))
      .rejects.toThrow(PermissionError);
  });
});

run("the offer on the invoice", () => {
  beforeEach(async () => {
    await afterHours.setRates(owner(), { afterHoursItemId: nightItem, holidayItemId: holidayItem });
  });

  it("offers nothing for a visit booked inside the hours", async () => {
    // Tuesday 6 October 2026 at ten.
    expect(await afterHours.offersForJob(owner(), { jobId: await jobAt("2026-10-06T10:00") })).toEqual([]);
  });

  it("offers the after hours rate for a visit booked after the close or on a closed weekday, one per visit, saying why", async () => {
    const jobId = await jobAt("2026-10-06T19:00", "2026-10-10T10:00");
    const [offer] = await afterHours.offersForJob(owner(), { jobId });
    expect(offer).toMatchObject({ kind: "after_hours", quantity: 2, item: { id: nightItem } });
    expect(offer!.because).toEqual([
      "2026-10-06 at 19:00, after the 17:00 close",
      "2026-10-10 at 10:00, on a day you are closed",
    ]);
  });

  it("offers the holiday rate on a holiday, and not the after hours rate as well", async () => {
    await holidays.create(owner(), { name: "Christmas Day", date: "2020-12-25", repeatsYearly: true, closed: true });
    const offers = await afterHours.offersForJob(owner(), { jobId: await jobAt("2026-12-25T10:00") });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ kind: "holiday", quantity: 1, item: { id: holidayItem } });
    expect(offers[0]!.because).toEqual(["2026-12-25 at 10:00, on Christmas Day, when you are closed"]);
  });

  it("offers the after hours rate on a holiday when there is no holiday rate", async () => {
    await afterHours.setRates(owner(), { afterHoursItemId: nightItem, holidayItemId: null });
    await holidays.create(owner(), { name: "Christmas Day", date: "2026-12-25", closed: true });
    const [offer] = await afterHours.offersForJob(owner(), { jobId: await jobAt("2026-12-25T10:00") });
    expect(offer).toMatchObject({ kind: "after_hours", item: { id: nightItem } });
  });

  it("does not count a cancelled visit", async () => {
    expect(await afterHours.offersForJob(owner(), {
      jobId: await jobAt({ at: "2026-10-06T19:00", status: "cancelled" }),
    })).toEqual([]);
  });

  it("is never added to an invoice by itself, and is not offered again once an invoice carries it", async () => {
    const jobId = await jobAt("2026-10-06T19:00");
    const plain = await billing.create(owner(), {
      customerId, jobId, draft: true,
      lines: [{ name: "Repair", quantity: "1", unitPrice: "100.00", discountAmount: "0", taxable: false }],
    });
    expect(plain.lines.map((l) => l.name)).toEqual(["Repair"]);
    expect(await afterHours.offersForJob(owner(), { jobId })).toHaveLength(1);

    await billing.updateDraft(owner(), {
      id: plain.id,
      lines: [
        { name: "Repair", quantity: "1", unitPrice: "100.00", discountAmount: "0", taxable: false },
        { priceBookItemId: nightItem, name: "After hours diagnostic", quantity: "1", unitPrice: "229.00", discountAmount: "0", taxable: false },
      ],
    });
    expect(await afterHours.offersForJob(owner(), { jobId })).toEqual([]);
    // Editing that same draft, its own lines are on the screen: the offer stands for the screen to match against.
    expect(await afterHours.offersForJob(owner(), { jobId, exceptInvoiceId: plain.id })).toHaveLength(1);
  });

  it("offers nothing until a rate is chosen", async () => {
    await raw`delete from public.after_hours_rate where organization_id = ${ORG}`;
    expect(await afterHours.offersForJob(owner(), { jobId: await jobAt("2026-10-06T19:00") })).toEqual([]);
  });
});
