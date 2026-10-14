import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { type Actor, type field } from "@opentradesos/core";
import * as fieldOps from "../src/services/field";
import * as dispatchSvc from "../src/services/dispatch";
import * as afterHours from "../src/services/after-hours";
import * as estimates from "../src/services/estimates";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb, companyToday } from "./helpers";

/**
 * THE AFTER HOURS RATE, ON ESTIMATES AND ON SITE
 *
 * The same offer the office's invoice has, with the same sentence saying why,
 * on an estimate and on the phone: served with the day so it works with no
 * signal, put on an estimate as an ordinary price book line, and on an
 * invoice for recorded work as a line the server prices and checks is still
 * on offer. Offered and never added: nothing here puts the rate on a document
 * the technician or the office did not ask for it on.
 *
 * The company is in Chicago, open eight to five on weekdays. A visit at seven
 * in the evening today is outside those hours whatever day today is.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("ahf:org");
const OWNER = fixtureId("ahf:owner");
const RAY = fixtureId("ahf:ray");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
const ray = (): ServiceContext => ({
  actor: { userId: RAY, organizationId: ORG, roles: ["technician"], technicianId: rayTech }, db: db(),
});

let rayTech = "";
let customerId = "";
let propertyId = "";
let nightItem = "";
let nightVersion = "";
let partItem = "";

async function bookItem(code: string, name: string, price: string, kind: string, feeRole: string | null) {
  const [row] = await raw`insert into public.price_book_item (organization_id, code, kind, fee_role)
    values (${ORG}, ${code}, ${kind}::item_kind, ${feeRole}::price_book_fee_role) returning id`;
  const [version] = await raw`insert into public.price_book_item_version
    (organization_id, item_id, version, name, price, taxable, effective_from)
    values (${ORG}, ${row!.id}, 1, ${name}, ${price}, false, now() - interval '30 days') returning id`;
  return { itemId: row!.id as string, versionId: version!.id as string };
}

/** A job with a visit at these Chicago wall clock times today, the technician on it. */
async function jobAt(time: string): Promise<{ jobId: string; visitId: string }> {
  const [n] = await raw<{ next: number }[]>`select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
  const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${n!.next}, ${customerId}, ${propertyId}, 'scheduled', 'No heat') returning id`;
  const at = `${companyToday()} ${time}`;
  const [visit] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes)
    values (${ORG}, ${job!.id}, 'scheduled', (${at}::timestamp at time zone ${ZONE}),
            (${at}::timestamp at time zone ${ZONE}) + interval '2 hours', 60) returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${visit!.id}, ${rayTech})`;
  return { jobId: job!.id, visitId: visit!.id };
}

async function day(visitId: string) {
  const device = await fieldOps.register(ray(), { installationId: `ahf-${crypto.randomUUID()}` });
  const snapshot = await dispatchSvc.snapshot(ray(), { deviceId: device.deviceId, from: companyToday(), days: 2 });
  const visit = snapshot.visits.find((v) => v.id === visitId)!;
  return { visit, book: snapshot.priceBook };
}

async function send(ops: Array<{ kind: field.OperationKind; subjectId?: string; payload?: Record<string, unknown> }>) {
  const device = await fieldOps.register(ray(), { installationId: `phone-${crypto.randomUUID()}` });
  const result = await fieldOps.sync(ray(), {
    deviceId: device.deviceId,
    operations: ops.map((op, i) => ({
      clientId: crypto.randomUUID(), sequence: i + 1, kind: op.kind,
      ...(op.subjectId ? { subjectId: op.subjectId } : {}),
      occurredAt: new Date(Date.now() - (ops.length - i) * 60_000).toISOString(),
      payload: op.payload ?? {},
    })),
  });
  return result.results;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "After Hours Field Co", slug: "after-hours-field-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  for (const dow of [1, 2, 3, 4, 5]) {
    await raw`insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at) values (${ORG}, ${dow}, '08:00', '17:00')`;
  }
  for (const dow of [0, 6]) {
    await raw`insert into public.business_hours (organization_id, day_of_week, closed) values (${ORG}, ${dow}, true)`;
  }
  const email = "ray@after-hours-field.test";
  await raw`delete from public."user" where id = ${RAY} or email = ${email}`;
  await raw`insert into public."user" (id, email, name) values (${RAY}, ${email}, 'Ray Nunez')`;
  const [membership] = await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${RAY}, 'technician') returning id`;
  const [tech] = await raw`insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${membership!.id}, 'Ray Nunez') returning id`;
  rayTech = tech!.id as string;
  const [c] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'Pat Cold') returning id`;
  customerId = c!.id;
  const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '1 Frost Ln', 'Austin', 'TX', '78701') returning id`;
  propertyId = p!.id;
  const night = await bookItem("AH", "After hours call out", "150.0000", "fee", "after_hours");
  nightItem = night.itemId;
  nightVersion = night.versionId;
  const part = await bookItem("CAP", "Run capacitor", "40.0000", "material", null);
  partItem = part.itemId;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  /** Each test makes its own job, so only the chosen rates need putting back. */
  await afterHours.setRates(owner(), { afterHoursItemId: nightItem, holidayItemId: null });
});

const NIGHT_LINE = (extra: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), priceBookItemId: nightItem, versionId: nightVersion,
  name: "After hours call out", quantity: "1", unitPrice: "150.0000", taxable: false, ...extra,
});

run("the offer on an estimate", () => {
  it("is the same offer as the invoice's, with the same sentence, and nothing is added by it", async () => {
    const { jobId } = await jobAt("19:00");
    const [forEstimate] = await afterHours.offersForJob(owner(), { jobId, for: "estimate" });
    const [forInvoice] = await afterHours.offersForJob(owner(), { jobId });
    expect(forEstimate).toMatchObject({ kind: "after_hours", quantity: 1, item: { id: nightItem, name: "After hours call out" } });
    expect(forEstimate!.because[0]).toMatch(/ at 19:00, (after the 17:00 close|on a day you are closed)$/);
    expect(forEstimate!.because).toEqual(forInvoice!.because);
    const rows = await raw`select count(*)::int as n from public.estimate where organization_id = ${ORG}`;
    expect(rows[0]!.n).toBe(0);
  });

  it("is not offered for a visit inside the hours", async () => {
    // Today may be a weekend, so the clean case is a visit on a weekday inside the hours.
    const [n] = await raw<{ next: number }[]>`select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
    const [job] = await raw<{ id: string }[]>`insert into public.job (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, ${n!.next}, ${customerId}, ${propertyId}, 'scheduled', 'Tune up') returning id`;
    await raw`insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes)
      values (${ORG}, ${job!.id}, 'scheduled', ('2026-10-06 10:00'::timestamp at time zone ${ZONE}), ('2026-10-06 12:00'::timestamp at time zone ${ZONE}), 60)`;
    expect(await afterHours.offersForJob(owner(), { jobId: job!.id, for: "estimate" })).toEqual([]);
  });

  it("is not offered again once another live estimate carries it, except for the one being revised", async () => {
    const { jobId } = await jobAt("19:00");
    const made = await estimates.create(owner(), {
      customerId, propertyId, jobId,
      options: [{ name: "Repair", isRecommended: true, lines: [{ priceBookItemId: nightItem, name: "x", quantity: "1", unitPrice: "150.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false }] }],
    });
    expect(await afterHours.offersForJob(owner(), { jobId, for: "estimate" })).toEqual([]);
    expect(await afterHours.offersForJob(owner(), { jobId, for: "estimate", exceptEstimateId: made.id as string })).toHaveLength(1);
    // A draft does not stop the invoice offering it: only an approved estimate is what will be billed.
    expect(await afterHours.offersForJob(owner(), { jobId })).toHaveLength(1);
    await raw`update public.estimate set status = 'approved' where id = ${made.id as string}`;
    expect(await afterHours.offersForJob(owner(), { jobId })).toEqual([]);
    // A declined estimate carries nothing forward.
    await raw`update public.estimate set status = 'declined' where id = ${made.id as string}`;
    expect(await afterHours.offersForJob(owner(), { jobId, for: "estimate" })).toHaveLength(1);
    expect(await afterHours.offersForJob(owner(), { jobId })).toHaveLength(1);
  });

  it("is served with the same two lists by the route's handler", async () => {
    const { jobId } = await jobAt("19:00");
    const out = await afterHours.handlers.getJobRateOffers(owner(), { id: jobId, for: "estimate" });
    expect(out.offers).toHaveLength(1);
  });
});

run("the offer on the phone's day", () => {
  it("comes with the visit, with why, for an estimate and for an invoice", async () => {
    const { visitId } = await jobAt("19:00");
    const { visit } = await day(visitId);
    expect(visit.rateOffers.forEstimate).toEqual([expect.objectContaining({ kind: "after_hours", itemId: nightItem, name: "After hours call out", quantity: 1 })]);
    expect(visit.rateOffers.forInvoice).toHaveLength(1);
    expect(visit.rateOffers.forInvoice[0]!.because[0]).toMatch(/ at 19:00, (after the 17:00 close|on a day you are closed)$/);
  });

  it("comes with nothing when no rate is chosen", async () => {
    await afterHours.setRates(owner(), { afterHoursItemId: null, holidayItemId: null });
    const { visitId } = await jobAt("19:00");
    const { visit } = await day(visitId);
    expect(visit.rateOffers).toEqual({ forEstimate: [], forInvoice: [] });
  });

  it("changes the day's revision when the company's hours change, so the phone fetches the new offer", async () => {
    const { visitId } = await jobAt("19:00");
    const device = await fieldOps.register(ray(), { installationId: `rev-${crypto.randomUUID()}` });
    const first = await dispatchSvc.snapshot(ray(), { deviceId: device.deviceId, from: companyToday(), days: 2 });
    await raw`update public.business_hours set closes_at = '20:00', updated_at = now() + interval '1 minute' where organization_id = ${ORG} and day_of_week = 1`;
    const second = await dispatchSvc.snapshot(ray(), {
      deviceId: device.deviceId, from: companyToday(), days: 2, sinceRevision: first.revision,
    });
    expect(second.unchanged).toBe(false);
    expect(visitId).toBeTruthy();
    await raw`update public.business_hours set closes_at = '17:00', updated_at = now() where organization_id = ${ORG} and day_of_week = 1`;
  });
});

run("the rate on an estimate built on the phone", () => {
  it("goes on as an ordinary price book line, and is not offered again", async () => {
    const { visitId } = await jobAt("19:00");
    const estimateId = crypto.randomUUID();
    const [result] = await send([{
      kind: "estimate.create", subjectId: estimateId,
      payload: { visitId, options: [{ id: crypto.randomUUID(), name: "Repair", isRecommended: true, lines: [NIGHT_LINE()] }] },
    }]);
    expect(result).toMatchObject({ status: "applied", rejection: null });
    const [line] = await raw`select l.unit_price::text, l.name from public.estimate_line l
      join public.estimate_option o on o.id = l.option_id where o.estimate_id = ${estimateId}`;
    expect(line).toMatchObject({ unit_price: "150.0000", name: "After hours call out" });
    const { visit } = await day(visitId);
    expect(visit.rateOffers.forEstimate).toEqual([]);
  });
});

run("the rate on an invoice raised on the phone for recorded work", () => {
  async function withWork(): Promise<{ visitId: string; jobId: string; lineId: string }> {
    const { visitId, jobId } = await jobAt("19:00");
    const lineId = crypto.randomUUID();
    const [added] = await send([{
      kind: "visit.add_line", subjectId: visitId,
      payload: { lineId, kind: "part", name: "Run capacitor", quantity: "1", unitPrice: "40.0000", priceBookItemId: partItem, taxable: false },
    }]);
    expect(added).toMatchObject({ status: "applied" });
    return { visitId, jobId, lineId };
  }

  it("is charged when the technician added what the phone offered, at the book's price, and then not offered", async () => {
    const { visitId, jobId, lineId } = await withWork();
    const invoiceId = crypto.randomUUID();
    const [result] = await send([{
      kind: "invoice.raise", subjectId: invoiceId,
      payload: {
        visitId, source: "work", jobLineIds: [lineId], shownTotal: "190.00",
        rateItems: [{ priceBookItemId: nightItem, quantity: "1" }],
      },
    }]);
    expect(result).toMatchObject({ status: "applied", rejection: null });
    const [invoice] = await raw`select status, total::text from public.invoice where id = ${invoiceId}`;
    expect(invoice).toMatchObject({ status: "open", total: "190.0000" });
    const lines = await raw`select name, unit_price::text from public.invoice_line where invoice_id = ${invoiceId} order by sort_order`;
    expect(lines.map((l) => l.name)).toEqual(["Run capacitor", "After hours call out"]);
    expect(await afterHours.offersForJob(owner(), { jobId })).toEqual([]);
  });

  it("is not charged when the technician did not add it, however late the visit was", async () => {
    const { visitId, lineId } = await withWork();
    const invoiceId = crypto.randomUUID();
    const [result] = await send([{
      kind: "invoice.raise", subjectId: invoiceId,
      payload: { visitId, source: "work", jobLineIds: [lineId], shownTotal: "40.00" },
    }]);
    expect(result).toMatchObject({ status: "applied" });
    const lines = await raw`select name from public.invoice_line where invoice_id = ${invoiceId}`;
    expect(lines.map((l) => l.name)).toEqual(["Run capacitor"]);
  });

  it("is refused in words when it is no longer on offer, so a customer is not charged twice", async () => {
    const { visitId, lineId } = await withWork();
    const [first] = await send([{
      kind: "invoice.raise", subjectId: crypto.randomUUID(),
      payload: { visitId, source: "work", jobLineIds: [lineId], shownTotal: "190.00", rateItems: [{ priceBookItemId: nightItem, quantity: "1" }] },
    }]);
    expect(first).toMatchObject({ status: "applied" });

    const secondLine = crypto.randomUUID();
    await send([{
      kind: "visit.add_line", subjectId: visitId,
      payload: { lineId: secondLine, kind: "part", name: "Contactor", quantity: "1", unitPrice: "30.0000", priceBookItemId: partItem, taxable: false },
    }]);
    const [second] = await send([{
      kind: "invoice.raise", subjectId: crypto.randomUUID(),
      payload: { visitId, source: "work", jobLineIds: [secondLine], shownTotal: "180.00", rateItems: [{ priceBookItemId: nightItem, quantity: "1" }] },
    }]);
    expect(second!.status).toBe("rejected");
    expect(second!.rejection).toMatch(/not offered on this job any more/);
  });

  it("refuses an item that is not the company's rate, and more visits than were booked", async () => {
    const { visitId, lineId } = await withWork();
    const [notARate] = await send([{
      kind: "invoice.raise", subjectId: crypto.randomUUID(),
      payload: { visitId, source: "work", jobLineIds: [lineId], shownTotal: "80.00", rateItems: [{ priceBookItemId: partItem, quantity: "1" }] },
    }]);
    expect(notARate!.rejection).toMatch(/not offered on this job any more/);
    const [tooMany] = await send([{
      kind: "invoice.raise", subjectId: crypto.randomUUID(),
      payload: { visitId, source: "work", jobLineIds: [lineId], shownTotal: "340.00", rateItems: [{ priceBookItemId: nightItem, quantity: "2" }] },
    }]);
    expect(tooMany!.rejection).toMatch(/is for one visit/);
  });

  it("keeps a draft for the office when the figure the customer saw is not the server's", async () => {
    const { visitId, lineId } = await withWork();
    const invoiceId = crypto.randomUUID();
    const [result] = await send([{
      kind: "invoice.raise", subjectId: invoiceId,
      payload: { visitId, source: "work", jobLineIds: [lineId], shownTotal: "170.00", rateItems: [{ priceBookItemId: nightItem, quantity: "1" }] },
    }]);
    expect(result!.status).toBe("conflicted");
    const [invoice] = await raw`select status, total::text from public.invoice where id = ${invoiceId}`;
    expect(invoice).toMatchObject({ status: "draft", total: "190.0000" });
    const lines = await raw`select name from public.invoice_line where invoice_id = ${invoiceId} order by sort_order`;
    expect(lines.map((l) => l.name)).toEqual(["Run capacitor", "After hours call out"]);
  });
});
