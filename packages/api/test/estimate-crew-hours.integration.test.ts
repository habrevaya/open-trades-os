import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import { PermissionError } from "@opentradesos/core";
import * as estimates from "../src/services/estimates";
import * as jobs from "../src/services/jobs";
import * as priceBook from "../src/services/pricebook";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, fixtureId, testDb } from "./helpers";

/**
 * A JOB'S CREW HOUR BUDGET COMES FROM ITS ESTIMATE (M10, M07)
 *
 * A price book item, and an estimate line, can say their quantity is crew
 * hours. Converting an approved estimate to a job adds up those lines of the
 * option the customer took, leaves out an optional line they did not tick,
 * and budgets the job with the sum, saying where it came from. The budget is
 * editable until the first punch exactly as a typed one is, and a figure the
 * office changes is the office's again.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("estimate-crew-hours:org");
const USER = fixtureId("estimate-crew-hours:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (role: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db(),
});
const owner = () => as("owner");

let customerId = "";
let propertyId = "";
let techId = "";
let seq = 0;

const line = (over: Record<string, unknown> = {}) => ({
  name: "Crew install", quantity: "1", unitPrice: "100.00", discountAmount: "0",
  taxable: false, isOptional: false, isSelected: false, ...over,
}) as never;

/** An approved estimate whose one option has these lines. Returns its id and the lines as written. */
async function approved(lines: unknown[], opts: { jobId?: string } = {}) {
  const created = await estimates.create(owner(), {
    customerId, propertyId, title: "Back garden",
    ...(opts.jobId ? { jobId: opts.jobId } : {}),
    options: [{ name: "Standard", isRecommended: true, lines }],
  } as Parameters<typeof estimates.create>[1]);
  const option = created.options[0]!;
  const ticked = option.lines.filter((l) => l.isOptional && l.name.includes("ticked")).map((l) => l.id);
  await estimates.approve(owner(), {
    id: created.id, optionId: option.id, selectedLineIds: ticked, signerName: "Rosa", capturedVia: "in_person",
  });
  return { id: created.id, optionId: option.id, lines: option.lines };
}

async function crewItem(code: string, crew: boolean) {
  const item = await priceBook.create(owner(), {
    kind: "labor", code, name: `Crew time ${code}`, price: "65.00",
    ...(crew ? { quantityIsCrewHours: true } : {}),
  } as Parameters<typeof priceBook.create>[1]);
  return item;
}

const jobRow = async (id: string) => (await raw<{ budgeted_hours: string | null; budget_estimate_id: string | null }[]>`
  select budgeted_hours, budget_estimate_id from public.job where id = ${id}`)[0]!;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Crew Hours Co", slug: "estimate-crew-hours-co" });
  const [c] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'Rosa Garden') returning id`;
  customerId = c!.id;
  const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '4 Fern Ln', 'Austin', 'TX', '78704') returning id`;
  propertyId = p!.id;
  const [person] = await raw<{ id: string }[]>`
    insert into public."user" (email, name) values (${`crew-${Date.now()}@estimate-crew-hours.test`}, 'Crew') returning id`;
  const [membership] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role) values (${ORG}, ${person!.id}, 'technician') returning id`;
  const [tech] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name, active)
    values (${ORG}, ${membership!.id}, 'Crew', true) returning id`;
  techId = tech!.id;
});

afterAll(async () => {
  if (!raw) return;
  await raw`delete from public."user" where email like '%@estimate-crew-hours.test'`;
  await resetOrg(raw, ORG);
  await raw.end();
});

run("a price book item that counts crew hours", () => {
  it("is marked and unmarked by someone who may write the price book, and no price changes", async () => {
    const item = await crewItem("CH-MARK", false);
    expect(item.quantityIsCrewHours).toBe(false);
    const marked = await priceBook.updateItem(owner(), { id: item.id, quantityIsCrewHours: true });
    expect(marked?.quantityIsCrewHours).toBe(true);
    expect(marked?.version).toBe(1);
    const unmarked = await priceBook.updateItem(owner(), { id: item.id, quantityIsCrewHours: false });
    expect(unmarked?.quantityIsCrewHours).toBe(false);
    await expect(priceBook.updateItem(as("technician"), { id: item.id, quantityIsCrewHours: true }))
      .rejects.toThrow(PermissionError);
  });

  it("is copied onto an estimate line, and a later change to the item does not rewrite the line", async () => {
    const item = await crewItem("CH-COPY", true);
    expect(item.quantityIsCrewHours).toBe(true);
    const { lines, id } = await approved([
      line({ priceBookItemId: item.id, quantity: "12" }),
      line({ name: "Plain part", unitPrice: "30.00" }),
    ]);
    expect(lines.map((l) => l.quantityIsCrewHours)).toEqual([true, false]);
    await priceBook.updateItem(owner(), { id: item.id, quantityIsCrewHours: false });
    const reread = await estimates.get(owner(), { id });
    expect(reread.options[0]!.lines[0]!.quantityIsCrewHours).toBe(true);
  });

  it("lets a line typed by hand say its quantity is crew hours, and a line say otherwise than its item", async () => {
    const item = await crewItem("CH-OVER", true);
    const { lines } = await approved([
      line({ name: "Typed hours", quantityIsCrewHours: true, quantity: "3" }),
      line({ priceBookItemId: item.id, quantity: "2", quantityIsCrewHours: false }),
    ]);
    expect(lines.map((l) => l.quantityIsCrewHours)).toEqual([true, false]);
  });
});

run("converting an approved estimate to a job", () => {
  it("budgets the job with the crew hour lines the customer took, and says so", async () => {
    const item = await crewItem("CH-SUM", true);
    const { id } = await approved([
      line({ priceBookItemId: item.id, quantity: "16" }),
      line({ name: "Second crew ticked", quantity: "8.5", quantityIsCrewHours: true, isOptional: true }),
      line({ name: "Edging left alone", quantity: "5", quantityIsCrewHours: true, isOptional: true }),
      line({ name: "Mulch", quantity: "9", unitPrice: "40.00" }),
    ]);
    // The second line's name carries the word `approved` ticks it by; the third is left unticked.
    const result = await estimates.convert(owner(), { id, createJob: true, createInvoice: false });
    expect(result.budgetedHours).toBe("24.5000");
    const job = await jobRow(result.jobId!);
    expect(Number(job.budgeted_hours)).toBe(24.5);
    expect(job.budget_estimate_id).toBe(id);

    const read = await jobs.get(owner(), { id: result.jobId! });
    expect(Number(read.budgetedHours)).toBe(24.5);
    expect(read.budgetEstimateId).toBe(id);

    const page = await jobs.hoursAgainstBudget(owner(), { id: result.jobId! });
    expect(Number(page.budgetedHours)).toBe(24.5);
    expect(page.fromEstimate?.id).toBe(id);
    expect(page.locked).toBe(false);
  });

  it("converting again changes nothing, and reports the same budget", async () => {
    const { id } = await approved([line({ quantity: "6", quantityIsCrewHours: true })]);
    const first = await estimates.convert(owner(), { id, createJob: true, createInvoice: false });
    const again = await estimates.convert(owner(), { id, createJob: true, createInvoice: false });
    expect(again.jobId).toBe(first.jobId);
    expect(again.budgetedHours).toBe("6.0000");
  });

  it("leaves the job without a budget when no line counts hours", async () => {
    const { id } = await approved([line({ quantity: "40" })]);
    const result = await estimates.convert(owner(), { id, createJob: true, createInvoice: false });
    expect(result.budgetedHours).toBeNull();
    const job = await jobRow(result.jobId!);
    expect(job.budgeted_hours).toBeNull();
    expect(job.budget_estimate_id).toBeNull();
    expect((await jobs.hoursAgainstBudget(owner(), { id: result.jobId! })).fromEstimate).toBeNull();
  });

  it("makes the job without a budget rather than refusing when the hours are more than a job can carry", async () => {
    const { id } = await approved([line({ quantity: "100001", quantityIsCrewHours: true })]);
    const result = await estimates.convert(owner(), { id, createJob: true, createInvoice: false });
    expect(result.jobId).not.toBeNull();
    expect(result.budgetedHours).toBeNull();
  });

  it("budgets no job when only the invoice is asked for", async () => {
    const { id } = await approved([line({ quantity: "6", quantityIsCrewHours: true })]);
    const result = await estimates.convert(owner(), { id, createJob: false, createInvoice: true });
    expect(result.jobId).toBeNull();
    expect(result.budgetedHours).toBeNull();
  });

  it("stays editable until the first punch, and a figure the office changes is no longer the estimate's", async () => {
    const { id } = await approved([line({ quantity: "20", quantityIsCrewHours: true })]);
    const { jobId } = await estimates.convert(owner(), { id, createJob: true, createInvoice: false });

    // The same figure typed again is no change, so it still says where it came from.
    await jobs.update(owner(), { id: jobId!, budgetedHours: "20" });
    expect((await jobs.hoursAgainstBudget(owner(), { id: jobId! })).fromEstimate?.id).toBe(id);

    await jobs.update(owner(), { id: jobId!, budgetedHours: "26" });
    const changed = await jobs.hoursAgainstBudget(owner(), { id: jobId! });
    expect(Number(changed.budgetedHours)).toBe(26);
    expect(changed.fromEstimate).toBeNull();
    expect((await jobRow(jobId!)).budget_estimate_id).toBeNull();
  });

  it("is fixed from the first punch like a typed budget", async () => {
    const { id } = await approved([line({ quantity: "10", quantityIsCrewHours: true })]);
    const { jobId } = await estimates.convert(owner(), { id, createJob: true, createInvoice: false });
    await raw`insert into public.timeclock_entry (organization_id, technician_id, job_id, kind, started_at, ended_at, minutes)
      values (${ORG}, ${techId}, ${jobId}, 'on_site', now() - interval '3 hours', now() - interval '2 hours', 60)`;
    await expect(jobs.update(owner(), { id: jobId!, budgetedHours: "12" })).rejects.toThrow(ConflictError);
    const page = await jobs.hoursAgainstBudget(owner(), { id: jobId! });
    expect(page.locked).toBe(true);
    expect(page.fromEstimate?.id).toBe(id);
  });

  it("budgets a job the estimate was already written for only if it has no budget and no punches", async () => {
    const makeJob = async (budget: string | null) => {
      seq += 1;
      const [row] = await raw<{ id: string }[]>`
        insert into public.job (organization_id, number, customer_id, property_id, status, summary, budgeted_hours)
        values (${ORG}, ${900 + seq}, ${customerId}, ${propertyId}, 'scheduled', 'Booked first', ${budget}) returning id`;
      return row!.id;
    };

    const bare = await makeJob(null);
    const a = await approved([line({ quantity: "14", quantityIsCrewHours: true })], { jobId: bare });
    const done = await estimates.convert(owner(), { id: a.id, createJob: true, createInvoice: false });
    expect(done.jobId).toBe(bare);
    expect(Number((await jobRow(bare)).budgeted_hours)).toBe(14);
    expect((await jobRow(bare)).budget_estimate_id).toBe(a.id);

    const typed = await makeJob("30");
    const b = await approved([line({ quantity: "14", quantityIsCrewHours: true })], { jobId: typed });
    await estimates.convert(owner(), { id: b.id, createJob: true, createInvoice: false });
    expect(Number((await jobRow(typed)).budgeted_hours)).toBe(30);
    expect((await jobRow(typed)).budget_estimate_id).toBeNull();

    const started = await makeJob(null);
    await raw`insert into public.timeclock_entry (organization_id, technician_id, job_id, kind, started_at, ended_at, minutes)
      values (${ORG}, ${techId}, ${started}, 'on_site', now() - interval '3 hours', now() - interval '2 hours', 60)`;
    const c = await approved([line({ quantity: "14", quantityIsCrewHours: true })], { jobId: started });
    await estimates.convert(owner(), { id: c.id, createJob: true, createInvoice: false });
    expect((await jobRow(started)).budgeted_hours).toBeNull();
  });
});
