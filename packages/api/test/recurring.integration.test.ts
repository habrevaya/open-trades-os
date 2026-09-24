import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as recurring from "../src/services/recurring";
import { visitDueDates } from "../src/services/agreements";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * RECURRING WORK
 *
 * A pool route, a quarterly pest treatment, a commercial filter change.
 * `packages/core/src/recurrence` knew how to do all of it and had no
 * callers; `recurring_schedule` had no writers and could not have had any,
 * because it carried a cadence and a horizon with nothing on it saying whose
 * pool it was.
 *
 * The model that earns the other three is `anchored_to_completion`: weekly
 * means seven days from when the technician was ACTUALLY there. A cadence
 * only system silently skips the rain day and the customer is short a visit
 * by the quarter.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("recurring:org");
const USER = fixtureId("recurring:user");

let raw: postgres.Sql;
let customerId = "";
let propertyId = "";

const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

const aSchedule = (over: Partial<recurring.ScheduleInput> = {}) =>
  recurring.create(owner(), {
    label: "Pool, weekly",
    customerId,
    propertyId,
    summary: "Weekly pool service",
    model: "rule",
    startsOn: "2026-03-02",
    intervalDays: 7,
    ...over,
  });

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Route Co", slug: "route-co" });

  const customer = await customers.create(owner(), {
    type: "residential", name: "Route Customer", phone: "+15125550122",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const property = await properties.create(owner(), {
    address: { line1: "8 Route Rd", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  propertyId = property.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.visit where organization_id = ${ORG}`;
  await raw`delete from public.job where organization_id = ${ORG}`;
  await raw`delete from public.recurring_schedule where organization_id = ${ORG}`;
});

run("setting one up", () => {
  it("refuses a rule that would generate nothing", async () => {
    /**
     * The failure this prevents is invisible: a schedule producing no
     * occurrences looks identical on every screen to one whose work is
     * simply not due yet.
     */
    await expect(aSchedule({ model: "rule", intervalDays: null, anchorMonths: [] }))
      .rejects.toThrow(/would generate nothing/);
  });

  it("refuses work measured from completion with no interval", async () => {
    await expect(aSchedule({ model: "anchored_to_completion", intervalDays: null }))
      .rejects.toThrow(/how many days/);
  });

  it("refuses a month that is not a month", async () => {
    await expect(aSchedule({ anchorMonths: [4, 13], intervalDays: null }))
      .rejects.toThrow(/not a month/);
  });

  it("refuses a series that ends before it starts", async () => {
    await expect(aSchedule({ endsOn: "2026-01-01" })).rejects.toThrow(ConflictError);
  });

  it("computes the first due date rather than defaulting to the start", async () => {
    /**
     * A seasonal schedule created in January is not due in January. A
     * `next_due_on` that said so would put it at the top of every list of
     * work that is due.
     */
    const row = await aSchedule({
      label: "Seasonal", model: "rule", intervalDays: null,
      anchorMonths: [4, 10], startsOn: "2026-01-05",
    });
    expect(row.nextDueOn).toBe("2026-04-15");
  });
});

run("what it would produce", () => {
  it("previews without producing", async () => {
    const row = await aSchedule();
    const result = await recurring.preview(owner(), {
      id: row.id, from: "2026-03-01", to: "2026-03-31",
    });

    expect(result.occurrences.map((o) => o.date)).toEqual([
      "2026-03-02", "2026-03-09", "2026-03-16", "2026-03-23", "2026-03-30",
    ]);

    const [count] = await raw<{ n: string }[]>`
      select count(*) as n from public.job where organization_id = ${ORG}`;
    expect(Number(count!.n), "a preview creates nothing").toBe(0);
  });

  it("gives exactly one future date for work measured from completion", async () => {
    /**
     * The date after next depends on when next actually completes.
     * Inventing it is the lie that makes a route drift, so the preview is
     * short and says why.
     */
    const row = await aSchedule({
      model: "anchored_to_completion", intervalDays: 7, startsOn: "2026-03-02",
    });
    const result = await recurring.preview(owner(), {
      id: row.id, from: "2026-03-01", to: "2026-06-30",
    });

    expect(result.occurrences).toHaveLength(1);
    expect(result.onlyOneKnowable).toBe(true);
  });

  it("pins a seasonal series to its months, whenever it was sold", async () => {
    /**
     * Counting six months forward from the sale date instead produces a
     * heating tune up in July, which is the single most common way a
     * seasonal plan gets built wrong.
     */
    const row = await aSchedule({
      model: "rule", intervalDays: null, anchorMonths: [4, 10], startsOn: "2026-01-05",
    });
    const result = await recurring.preview(owner(), {
      id: row.id, from: "2026-01-01", to: "2026-12-31",
    });
    expect(result.occurrences.map((o) => o.date)).toEqual(["2026-04-15", "2026-10-15"]);
  });
});

run("turning it into work", () => {
  it("creates a job and a visit per occurrence", async () => {
    const row = await aSchedule({ startsOn: "2026-03-02", endsOn: "2026-03-23" });
    const result = await recurring.materialise(owner(), { id: row.id, through: "2026-03-31" });

    expect(result.created.map((c) => c.dueOn)).toEqual([
      "2026-03-02", "2026-03-09", "2026-03-16", "2026-03-23",
    ]);

    const [visits] = await raw<{ n: string }[]>`
      select count(*) as n from public.visit where organization_id = ${ORG}`;
    expect(Number(visits!.n)).toBe(4);
  });

  it("is safe to run twice, because a timer runs it", async () => {
    /**
     * A worker running twice in a minute would otherwise put two technicians
     * on one pool.
     */
    const row = await aSchedule({ startsOn: "2026-03-02", endsOn: "2026-03-16" });
    await recurring.materialise(owner(), { id: row.id, through: "2026-03-31" });
    const second = await recurring.materialise(owner(), { id: row.id, through: "2026-03-31" });

    expect(second.created).toEqual([]);
    expect(second.alreadyThere).toBe(3);

    const [count] = await raw<{ n: string }[]>`
      select count(*) as n from public.job where organization_id = ${ORG}`;
    expect(Number(count!.n)).toBe(3);
  });

  it("keys on the schedule AND the date, so the second visit is not a duplicate", async () => {
    const row = await aSchedule({ startsOn: "2026-03-02", endsOn: "2026-03-09" });
    const result = await recurring.materialise(owner(), { id: row.id, through: "2026-03-31" });

    const refs = await raw<{ source_id: string }[]>`
      select source_id from public.job where organization_id = ${ORG} order by source_id`;
    expect(refs.map((r) => r.source_id)).toEqual([
      `${row.id}:2026-03-02`, `${row.id}:2026-03-09`,
    ]);
    expect(result.created).toHaveLength(2);
  });

  it("does not create work from a paused schedule", async () => {
    const row = await aSchedule();
    await recurring.setActive(owner(), { id: row.id, active: false });
    await expect(recurring.materialise(owner(), { id: row.id })).rejects.toThrow(/paused/);
  });

  it("creates the occurrences already in the past, not only the future ones", async () => {
    /**
     * A schedule created today for a series that started last month still
     * owes those occurrences. A window beginning today would silently drop
     * them and nobody would know the route was short.
     */
    const row = await aSchedule({ startsOn: "2026-01-05", endsOn: "2026-01-26" });
    const result = await recurring.materialise(owner(), { id: row.id, through: "2026-02-28" });
    expect(result.created.map((c) => c.dueOn)).toEqual([
      "2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26",
    ]);
  });
});

run("work measured from when it actually happened", () => {
  it("counts the next visit from the completion, not from the calendar", async () => {
    /**
     * The rain day case. A calendar rule would say the next visit is the
     * following Monday regardless; this says seven days from Thursday.
     */
    const row = await aSchedule({
      model: "anchored_to_completion", intervalDays: 7, startsOn: "2026-03-02",
    });

    const result = await recurring.recordCompletion(owner(), {
      id: row.id, completedOn: "2026-03-05",
    });
    expect(result.nextDueOn).toBe("2026-03-12");
  });

  it("shifts the whole series rather than losing a visit", async () => {
    const row = await aSchedule({
      model: "anchored_to_completion", intervalDays: 7, startsOn: "2026-03-02",
    });

    await recurring.recordCompletion(owner(), { id: row.id, completedOn: "2026-03-05" });
    const second = await recurring.recordCompletion(owner(), { id: row.id, completedOn: "2026-03-13" });
    expect(second.nextDueOn).toBe("2026-03-20");
  });

  it("refuses a backdated completion", async () => {
    /**
     * The series counts forward from this date, so a backdated one pulls
     * every future occurrence backwards. On a weekly route that silently
     * reschedules the next two months.
     */
    const row = await aSchedule({
      model: "anchored_to_completion", intervalDays: 7, startsOn: "2026-03-02",
    });
    await recurring.recordCompletion(owner(), { id: row.id, completedOn: "2026-03-12" });

    await expect(recurring.recordCompletion(owner(), { id: row.id, completedOn: "2026-03-05" }))
      .rejects.toThrow(/backwards/);
  });

  it("leaves a calendar rule on its calendar", async () => {
    const row = await aSchedule({ model: "rule", intervalDays: 7, startsOn: "2026-03-02" });
    const result = await recurring.recordCompletion(owner(), {
      id: row.id, completedOn: "2026-03-05",
    });
    /** Every Monday, whatever day the technician was actually there. */
    expect(result.nextDueOn).toBe("2026-03-09");
  });
});

run("the ones the customer declined", () => {
  it("skips an occurrence and keeps knowing about it", async () => {
    const row = await aSchedule({ startsOn: "2026-03-02", endsOn: "2026-03-23" });
    await recurring.except(owner(), {
      id: row.id, date: "2026-03-09", action: "skipped", reason: "They are away.",
    });

    const result = await recurring.preview(owner(), {
      id: row.id, from: "2026-03-01", to: "2026-03-31",
    });
    expect(result.occurrences.map((o) => o.date)).toEqual([
      "2026-03-02", "2026-03-16", "2026-03-23",
    ]);

    /**
     * Kept, not deleted. A customer who said no has told us something, and
     * losing it means re-offering work they already refused.
     */
    const [stored] = await raw<{ exceptions: { date: string; reason: string }[] }[]>`
      select exceptions from public.recurring_schedule where id = ${row.id}`;
    expect(stored!.exceptions[0]).toMatchObject({ date: "2026-03-09", reason: "They are away." });
  });

  it("moves an occurrence and keeps its place in the sequence", async () => {
    /**
     * So "visit two of four" stays true on the invoice.
     */
    const row = await aSchedule({ startsOn: "2026-03-02", endsOn: "2026-03-23" });
    await recurring.except(owner(), {
      id: row.id, date: "2026-03-09", action: "moved", movedTo: "2026-03-11",
    });

    const result = await recurring.preview(owner(), {
      id: row.id, from: "2026-03-01", to: "2026-03-31",
    });
    const moved = result.occurrences.find((o) => o.date === "2026-03-11")!;
    expect(moved.moved).toBe(true);
    expect(moved.sequence).toBe(2);
  });

  it("refuses a move with nowhere to move to", async () => {
    const row = await aSchedule();
    await expect(recurring.except(owner(), {
      id: row.id, date: "2026-03-09", action: "moved",
    })).rejects.toThrow(/it is a skip/);
  });

  it("does not create work for a skipped occurrence", async () => {
    const row = await aSchedule({ startsOn: "2026-03-02", endsOn: "2026-03-16" });
    await recurring.except(owner(), { id: row.id, date: "2026-03-09", action: "skipped" });

    const result = await recurring.materialise(owner(), { id: row.id, through: "2026-03-31" });
    expect(result.created.map((c) => c.dueOn)).toEqual(["2026-03-02", "2026-03-16"]);
  });
});

run("tenancy", () => {
  it("refuses a schedule belonging to another company", async () => {
    const row = await aSchedule();
    const stranger: ServiceContext = {
      actor: { userId: USER, organizationId: fixtureId("recurring:other"), roles: ["owner"] as Actor["roles"] },
      db: db(),
    };
    await expect(recurring.preview(stranger, { id: row.id })).rejects.toThrow(NotFoundError);
  });
});

/**
 * ONE IMPLEMENTATION OF THE VISIT DATES, NOT TWO
 *
 * `agreements.visitDueDates` and `recurrence.agreementVisitDates` were two
 * implementations of the same policy and they disagreed on every seasonal
 * case: a plan sold on 10 January with spring and autumn anchors produced
 * 10 April from one and 15 April from the other.
 *
 * Neither was wrong in principle, which is what made it dangerous. Which one
 * a company got depended on which function somebody happened to call.
 */
run("agreement visit dates come from core now", () => {
  it("keeps the sale's day of month when the plan says nothing", async () => {
    /**
     * The behaviour this product had before the anchor day column existed.
     * Preserved deliberately: choosing a day would have moved every future
     * sale's visit dates on the day it shipped, with nothing on any screen
     * saying why.
     */
    expect(visitDueDates({
      startedOn: "2026-01-10", termMonths: 12, count: 2, anchorMonths: [4, 10],
    })).toEqual(["2026-04-10", "2026-10-10"]);
  });

  it("clamps a sale on the 31st to the month's length rather than rolling over", async () => {
    expect(visitDueDates({
      startedOn: "2026-01-31", termMonths: 12, count: 2, anchorMonths: [4, 10],
    })).toEqual(["2026-04-30", "2026-10-31"]);
  });

  it("uses the plan's day when the operator set one", async () => {
    expect(visitDueDates({
      startedOn: "2026-01-10", termMonths: 12, count: 2, anchorMonths: [4, 10], anchorDay: 15,
    })).toEqual(["2026-04-15", "2026-10-15"]);
  });

  it("gets this autumn rather than next for a plan sold in October", async () => {
    expect(visitDueDates({
      startedOn: "2026-10-05", termMonths: 12, count: 2, anchorMonths: [4, 10],
    })).toEqual(["2026-10-05", "2027-04-05"]);
  });

  it("spreads evenly with no anchors, which is what two a year means", async () => {
    expect(visitDueDates({ startedOn: "2026-01-15", termMonths: 12, count: 4 }))
      .toEqual(["2026-04-15", "2026-07-15", "2026-10-15", "2027-01-15"]);
  });

  it("owes every visit the plan sold, even when the count does not divide the term", async () => {
    /**
     * A compounding rounded step was dropping one. Four visits in six
     * months rounds to a two month step, so the fourth landed at eight
     * months, fell outside the term and was filtered away: the member paid
     * for four and the schedule owed three.
     *
     * Each position is rounded from its own fraction now, so the last lands
     * exactly at the term end.
     */
    const dates = visitDueDates({ startedOn: "2026-01-15", termMonths: 6, count: 4 });
    expect(dates).toHaveLength(4);
    expect(dates[dates.length - 1]).toBe("2026-07-15");
  });

  it("gives the same dates as before whenever the count divides the term", async () => {
    /**
     * The change above had to be invisible for the common plans. Two, three
     * and four visits a year all step evenly and are unchanged.
     */
    expect(visitDueDates({ startedOn: "2026-01-15", termMonths: 12, count: 2 }))
      .toEqual(["2026-07-15", "2027-01-15"]);
    expect(visitDueDates({ startedOn: "2026-01-15", termMonths: 12, count: 3 }))
      .toEqual(["2026-05-15", "2026-09-15", "2027-01-15"]);
  });
});
