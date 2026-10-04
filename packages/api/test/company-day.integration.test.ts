import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as reports from "../src/services/reports";
import * as entitlements from "../src/services/entitlements";
import * as billing from "../src/services/billing";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A REPORT'S DAYS ARE THE COMPANY'S DAYS
 *
 * The company is in America/Chicago. 01:00 UTC on the 1st of July is eight in
 * the evening on the 30th of June there, and a job booked then was booked in
 * June. Read in the database session's zone, which is UTC, the report builder
 * filtered it out of June, grouped it under July, and called it a Wednesday
 * when it was a Tuesday. These run the same reports a screen does and read
 * back which day, month and window the late evening landed in.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("company-day:org");
const USER = fixtureId("company-day:owner");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let customerId = "";
let lateJobId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Late Evening Air", slug: "company-day" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  const [c] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, name) values (${ORG}, 'Evening Customer') returning id`;
  customerId = c!.id;
  const [p] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '9 Night St', 'Austin', 'TX', '78704') returning id`;

  /** Booked at 20:00 on Tuesday 30 June in Chicago, which is 01:00 UTC on Wednesday 1 July. */
  const [late] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary, created_at)
    values (${ORG}, 1, ${customerId}, ${p!.id}, 'scheduled', 'Late evening call', '2026-07-01T01:00:00Z')
    returning id`;
  lateJobId = late!.id;
  /** And one booked at 06:00 UTC on 1 July, which is 01:00 on the 1st in Chicago: July's. */
  await raw`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary, created_at)
    values (${ORG}, 2, ${customerId}, ${p!.id}, 'scheduled', 'Small hours call', '2026-07-01T06:00:00Z')`;
});

afterAll(async () => { if (raw) await raw.end(); });

run("the report builder in the company's calendar", () => {
  it("counts a job booked at 01:00 UTC in the previous day's window", async () => {
    const june = await reports.run(owner(), {
      dataset: "jobs", dimensions: [], measures: ["count"], from: "2026-06-30", to: "2026-07-01",
    });
    expect(Number(june.rows[0]!["count"])).toBe(1);

    const july = await reports.run(owner(), {
      dataset: "jobs", dimensions: [], measures: ["count"], from: "2026-07-01", to: "2026-07-02",
    });
    expect(Number(july.rows[0]!["count"])).toBe(1);
  });

  it("groups it under the company's day and month", async () => {
    const byDay = await reports.run(owner(), {
      dataset: "jobs", dimensions: ["day"], measures: ["count"], from: "2026-06-01", to: "2026-08-01",
    });
    expect(byDay.rows.map((r) => [r["day"], Number(r["count"])])).toEqual([
      ["2026-06-30", 1], ["2026-07-01", 1],
    ]);

    const byMonth = await reports.run(owner(), {
      dataset: "jobs", dimensions: ["month"], measures: ["count"], from: "2026-06-01", to: "2026-08-01",
    });
    expect(byMonth.rows.map((r) => [r["month"], Number(r["count"])])).toEqual([
      ["2026-06", 1], ["2026-07", 1],
    ]);
  });

  it("calls the evening of Tuesday the 30th a Tuesday in the margin report", async () => {
    const byWeekday = await reports.run(owner(), {
      dataset: "profitability", dimensions: ["weekday"], measures: ["count"], from: "2026-06-30", to: "2026-07-01",
    });
    expect(byWeekday.rows.map((r) => r["weekday"])).toEqual(["2 Tue"]);
  });

  it("opens the June row onto the job booked on the evening of the 30th", async () => {
    const drilled = await reports.drill(owner(), {
      definition: { dataset: "jobs", dimensions: ["month"], measures: ["count"], from: "2026-06-01", to: "2026-08-01" },
      match: { month: "2026-06" },
    });
    expect(drilled.rows).toHaveLength(1);
    expect(JSON.stringify(drilled.rows)).toContain(lateJobId);
  });

  it("ages an invoice due today as current, by the company's today", async () => {
    /**
     * `current_date` is the database's date, which from seven in the evening
     * in Austin is already tomorrow; an invoice due today then read as a day
     * late. Today here is the company's.
     */
    const today = companyToday();
    const [row] = await raw<{ id: string }[]>`
      insert into public.invoice
        (organization_id, customer_id, number, status, issued_on, due_on, subtotal, total, balance)
      values (${ORG}, ${customerId}, 7001, 'open', ${today}::date, ${today}::date, 50, 50, 50)
      returning id`;
    try {
      const result = await reports.run(owner(), { dataset: "invoices", dimensions: ["aging"], measures: ["count"] });
      expect(result.rows.map((r) => r["aging"])).toEqual(["1 Current"]);
    } finally {
      await raw`delete from public.invoice where id = ${row!.id}`;
    }
  });

  it("filters an invoice by its issue date as a day, not as midnight in UTC", async () => {
    const [row] = await raw<{ id: string }[]>`
      insert into public.invoice
        (organization_id, customer_id, number, status, issued_on, due_on, subtotal, total, balance)
      values (${ORG}, ${customerId}, 7002, 'open', '2026-06-01', '2026-06-30', 50, 50, 50)
      returning id`;
    try {
      const june = await reports.run(owner(), {
        dataset: "invoices", dimensions: [], measures: ["count"], from: "2026-06-01", to: "2026-06-02",
      });
      expect(Number(june.rows[0]!["count"])).toBe(1);
    } finally {
      await raw`delete from public.invoice where id = ${row!.id}`;
    }
  });
});

run("today, as the company counts it", () => {
  it("ages receivables as of the company's today when no date is given", async () => {
    /** From seven in the evening in Austin, UTC's date is tomorrow; the report is as of today there. */
    const aging = await billing.arAging(owner(), {});
    expect(aging.asOf).toBe(companyToday());
  });
});

run("work done for nothing, by the company's day", () => {
  it("counts a coverage decision made on the evening of the 30th in June's window", async () => {
    const [job] = await raw<{ id: string }[]>`select id from public.job where id = ${lateJobId}`;
    await raw`
      insert into public.entitlement (organization_id, job_id, source, resolved_at)
      values (${ORG}, ${job!.id}, 'labour_warranty', '2026-07-01T01:00:00Z')`;
    const june = await entitlements.bySource(owner(), { from: "2026-06-01", to: "2026-07-01" });
    expect(june.map((row) => [row.source, row.jobs])).toEqual([["labour_warranty", 1]]);
    const july = await entitlements.bySource(owner(), { from: "2026-07-01", to: "2026-08-01" });
    expect(july).toEqual([]);
  });
});
