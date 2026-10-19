import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as kpis from "../src/services/kpis";
import * as jobs from "../src/services/jobs";
import * as visits from "../src/services/visits";
import * as cancellations from "../src/services/visit-cancellations";
import { ConflictError, UnprocessableError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * WHY THE COMPANY CALLED A DAY OFF
 *
 * Cleaning's cancellation rate leaves out the visits the company called off
 * itself. A coded reason (rain or weather, crew short, equipment, something
 * else with its words) now rides on the company's own cancellations, on both
 * calls that call a day off, shows on the visit, and is read on the records the
 * scorecard opens. A customer is never asked, and a reason on theirs is refused.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cancelwhy:org");
const USER = fixtureId("cancelwhy:user");
const WINDOW = { from: "2026-06-01", to: "2026-06-30" };
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (key?: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
  ...(key ? { idempotencyKey: key } : {}),
});
const as = (role: string): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: [role] as Actor["roles"] }, db: db(),
});

let customerId = "";
let propertyId = "";
let routeId = "";
let typeId = "";
let seq = 0;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  seq = 0;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Cancel Why Cleaning Co", slug: "cancel-why-co" });
  await raw`update public.organization set timezone = ${ZONE}, primary_trade = 'cleaning' where id = ${ORG}`;
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name, payment_terms_days)
    values (${ORG}, 'residential', 'Rosa Reyes', 0) returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '12 Willow', 'Austin', 'TX', '78704') returning id`;
  propertyId = property!.id;
  const [route] = await raw<{ id: string }[]>`
    insert into public.route (organization_id, name, day_of_week) values (${ORG}, 'North', 3) returning id`;
  routeId = route!.id;
  const [type] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name, code, capacity_model, revenue_class)
    values (${ORG}, 'recurring', 'cw-recurring', 'route', 'recurring') returning id`;
  typeId = type!.id;
});

/** A job with `visitCount` visits a few days from now, booked two days ago. */
async function booked(visitCount = 1): Promise<{ jobId: string; visitIds: string[] }> {
  seq += 1;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, ${typeId}, 'scheduled', 'Clean') returning id`;
  const visitIds: string[] = [];
  for (let n = 1; n <= visitCount; n += 1) {
    const start = new Date(Date.now() + (3 + n) * 86_400_000);
    const [visit] = await raw<{ id: string }[]>`
      insert into public.visit (organization_id, job_id, sequence, status, window_start, window_end, created_at)
      values (${ORG}, ${job!.id}, ${n}, 'scheduled', ${start}, ${new Date(start.getTime() + 7_200_000)}, now() - interval '2 days')
      returning id`;
    visitIds.push(visit!.id);
  }
  return { jobId: job!.id, visitIds };
}

const row = async (id: string) => (await raw<{
  status: string; cancelled_by: string | null; cancel_reason: string | null; cancel_reason_note: string | null;
}[]>`select status::text, cancelled_by::text as cancelled_by, cancel_reason::text as cancel_reason, cancel_reason_note
     from public.visit where id = ${id}`)[0]!;

run("calling off one visit, saying why", () => {
  it("keeps a coded reason on the company's own cancellation, shows it on the visit and audits it", async () => {
    const { visitIds: [visitId] } = await booked();
    const done = await cancellations.cancel(owner(), { id: visitId!, by: "company", reason: { code: "weather" } });
    expect(done.reason).toEqual({ code: "weather", label: "Rain or weather", note: null, words: "Rain or weather" });
    expect(await row(visitId!)).toMatchObject({ status: "cancelled", cancelled_by: "company", cancel_reason: "weather", cancel_reason_note: null });

    const page = await visits.get(owner(), { id: visitId! });
    expect(page.cancellation).toMatchObject({ by: "company", reason: { code: "weather", words: "Rain or weather" } });

    const [audited] = await raw<{ after: { reason?: string } }[]>`
      select after from public.audit_log where organization_id = ${ORG} and entity_id = ${visitId!} and action = 'visit.called_off'`;
    expect(audited!.after.reason).toBe("weather");
  });

  it("keeps the words beside the code, and asks for words when the reason is something else", async () => {
    const a = (await booked()).visitIds[0]!;
    const b = (await booked()).visitIds[0]!;
    const crew = await cancellations.cancel(owner(), { id: a, by: "company", reason: { code: "crew_short", note: "  Two out sick  " } });
    expect(crew.reason).toMatchObject({ code: "crew_short", note: "Two out sick", words: "Crew short: Two out sick" });

    await expect(cancellations.cancel(owner(), { id: b, by: "company", reason: { code: "other" } }))
      .rejects.toThrow(/Say what the reason was/);
    await expect(cancellations.cancel(owner(), { id: b, by: "company", reason: { code: "other", note: "   " } }))
      .rejects.toBeInstanceOf(ConflictError);
    expect((await row(b)).status).toBe("scheduled");
    const other = await cancellations.cancel(owner(), { id: b, by: "company", reason: { code: "other", note: "The van was stolen" } });
    expect(other.reason?.words).toBe("Something else: The van was stolen");
  });

  it("never asks the customer why: a reason on their cancellation is refused and nothing is cancelled", async () => {
    const { visitIds: [visitId] } = await booked();
    await expect(cancellations.cancel(owner(), { id: visitId!, by: "customer", reason: { code: "weather" } }))
      .rejects.toThrow(/Only a day the company called off has a reason/);
    expect((await row(visitId!)).status).toBe("scheduled");

    const done = await cancellations.cancel(owner(), { id: visitId!, by: "customer" });
    expect(done.reason).toBeNull();
    expect(await row(visitId!)).toMatchObject({ cancelled_by: "customer", cancel_reason: null });
    expect((await visits.get(owner(), { id: visitId! })).cancellation?.reason).toBeNull();
  });

  it("records a company cancellation from a caller that gave no reason as no reason given", async () => {
    const { visitIds: [visitId] } = await booked();
    const done = await cancellations.cancel(owner(), { id: visitId!, by: "company" });
    expect(done.reason).toBeNull();
    expect(await row(visitId!)).toMatchObject({ cancelled_by: "company", cancel_reason: null, cancel_reason_note: null });
  });

  it("gives the first answer back to a retry, reason included", async () => {
    const { visitIds: [visitId] } = await booked();
    const first = await cancellations.cancel(owner("why-once"), { id: visitId!, by: "company", reason: { code: "equipment" } });
    const again = await cancellations.cancel(owner("why-once"), { id: visitId!, by: "company", reason: { code: "equipment" } });
    expect(again).toEqual(first);
    expect(first.reason?.code).toBe("equipment");
  });

  it("still needs the permission that reschedules a visit", async () => {
    const { visitIds: [visitId] } = await booked();
    await expect(cancellations.cancel(as("technician"), { id: visitId!, by: "company", reason: { code: "weather" } }))
      .rejects.toThrow(PermissionError);
  });
});

run("cancelling a job with its visits, saying why", () => {
  it("puts the one reason on every visit it calls off", async () => {
    const { jobId, visitIds } = await booked(3);
    await jobs.update(owner(), {
      id: jobId, status: "cancelled", cancelVisits: true, cancelledBy: "company",
      cancelReason: { code: "weather", note: "Ice storm" },
    });
    for (const id of visitIds) {
      expect(await row(id)).toMatchObject({ status: "cancelled", cancelled_by: "company", cancel_reason: "weather", cancel_reason_note: "Ice storm" });
    }
    const [audited] = await raw<{ after: { reason?: string; reasonNote?: string } }[]>`
      select after from public.audit_log where organization_id = ${ORG} and entity_id = ${jobId} and action = 'job.visits_cancelled'`;
    expect(audited!.after).toMatchObject({ reason: "weather", reasonNote: "Ice storm" });
  });

  it("refuses a reason with the customer, a reason with no one saying who, and a reason without the visits going", async () => {
    const customer = await booked();
    await expect(jobs.update(owner(), {
      id: customer.jobId, status: "cancelled", cancelVisits: true, cancelledBy: "customer", cancelReason: { code: "weather" },
    })).rejects.toThrow(/Only a day the company called off has a reason/);

    const nobody = await booked();
    await expect(jobs.update(owner(), {
      id: nobody.jobId, status: "cancelled", cancelVisits: true, cancelReason: { code: "weather" },
    })).rejects.toBeInstanceOf(UnprocessableError);

    const stray = await booked();
    await expect(jobs.update(owner(), {
      id: stray.jobId, status: "cancelled", cancelledBy: "company", cancelReason: { code: "weather" },
    })).rejects.toBeInstanceOf(UnprocessableError);
    for (const { visitIds: [id] } of [customer, nobody, stray]) expect((await row(id!)).status).toBe("scheduled");
  });

  it("asks \"something else\" for words here too", async () => {
    const { jobId, visitIds: [visitId] } = await booked();
    await expect(jobs.update(owner(), {
      id: jobId, status: "cancelled", cancelVisits: true, cancelledBy: "company", cancelReason: { code: "other" },
    })).rejects.toThrow(/Say what the reason was/);
    expect((await row(visitId!)).status).toBe("scheduled");
  });
});

run("the database holds the same line", () => {
  it("refuses a reason on a customer's cancellation, words with no code, and something else with no words", async () => {
    const { visitIds: [visitId] } = await booked();
    await expect(raw`update public.visit set status = 'cancelled', cancelled_by = 'customer', cancelled_at = now(),
                     cancel_notice_hours = 24, cancel_reason = 'weather' where id = ${visitId!}`)
      .rejects.toThrow(/visit_cancel_reason_company/);
    await expect(raw`update public.visit set status = 'cancelled', cancelled_by = 'company', cancelled_at = now(),
                     cancel_notice_hours = 24, cancel_reason_note = 'Rain' where id = ${visitId!}`)
      .rejects.toThrow(/visit_cancel_reason_says_what/);
    await expect(raw`update public.visit set status = 'cancelled', cancelled_by = 'company', cancelled_at = now(),
                     cancel_notice_hours = 24, cancel_reason = 'other' where id = ${visitId!}`)
      .rejects.toThrow(/visit_cancel_reason_says_what/);
  });
});

/* ================================================== the records the scorecard opens */

const local = (day: string, clock: string) => raw.unsafe(`('${day} ${clock}'::timestamp at time zone '${ZONE}')`);

async function stop(name: string, by: "customer" | "company", reason?: { code: string; note?: string }): Promise<string> {
  seq += 1;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
    values (${ORG}, ${seq}, ${customerId}, ${propertyId}, ${typeId}, 'scheduled', ${name}) returning id`;
  const [visit] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, status, window_start, window_end, route_id,
                              cancelled_by, cancelled_at, cancel_notice_hours, cancel_reason, cancel_reason_note)
    values (${ORG}, ${job!.id}, 'cancelled', ${local("2026-06-10", "09:00")}, ${local("2026-06-10", "11:00")}, ${routeId},
            ${by}::visit_cancelled_by, ${local("2026-06-10", "08:00")}, 24,
            ${reason?.code ?? null}::visit_cancel_reason, ${reason?.note ?? null})
    returning id`;
  return visit!.id;
}

run("the cancellation records on the scorecard", () => {
  it("say why each of the company's days was called off, and say so when nobody did", async () => {
    const rain = await stop("Rain", "company", { code: "weather" });
    const words = await stop("Sick", "company", { code: "crew_short", note: "Two out sick" });
    const silent = await stop("Silent", "company");
    const theirs = await stop("Theirs", "customer");

    const drill = await kpis.drill(owner(), { key: "cancel_rate_route", half: "excluded", ...WINDOW });
    const label = (id: string) => drill.records.find((r) => r.id === id)?.label;
    expect(label(rain)).toBe("#1 Rosa Reyes, North, Wednesday, Rain or weather");
    expect(label(words)).toBe("#2 Rosa Reyes, North, Wednesday, Crew short: Two out sick");
    expect(label(silent)).toBe("#3 Rosa Reyes, North, Wednesday, no reason given");
    expect(label(theirs)).toBeUndefined();

    /** The customer's own, in the late and scheduled lists, are never labelled with a reason. */
    const scheduled = await kpis.drill(owner(), { key: "cancel_rate_route", half: "denominator", ...WINDOW });
    expect(scheduled.records.find((r) => r.id === theirs)!.label).toBe("#4 Rosa Reyes, North, Wednesday");
  });
});
