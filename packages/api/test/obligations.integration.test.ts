import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as obligations from "../src/services/obligations";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * THE DEADLINE NOBODY COULD SEE
 *
 * `obligation` is the schema's one primitive for every deadline in the
 * product, under a comment explaining that one table exists because "the
 * thing everyone actually needs is what is about to breach, across all of
 * them". One place inserted into it and nothing selected from it, so every
 * row was written and never read.
 *
 * The one that was real: a technician completing work on a visit that had
 * already been cancelled raised an obligation reading "confirm whether to
 * bill it", promising in a comment that it "shows up in the same place every
 * other approaching deadline does". Nobody ever confirmed anything, because
 * nobody was ever shown it, and the completed work went uninvoiced.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("obligations:org");
const USER = fixtureId("obligations:user");

let raw: postgres.Sql;
let jobId = "";
let customerId = "";
let propertyId = "";

const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

const insert = (over: Record<string, unknown> = {}) => raw<{ id: string }[]>`
  insert into public.obligation
    (organization_id, kind, entity_type, entity_id, due_at, consequence, escalate_at, state)
  values (${ORG},
          ${(over["kind"] as string) ?? "sla.on_site"},
          'job', ${jobId},
          ${(over["dueAt"] as Date) ?? new Date(Date.now() + 3600_000)},
          'A commercial contract says four hours.',
          ${(over["escalateAt"] as Date | null) ?? null},
          ${(over["state"] as string) ?? "open"})
  returning id`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Deadline Co", slug: "deadline-co" });

  const customer = await customers.create(owner(), {
    type: "commercial", name: "Contract Customer", phone: "+15125550188",
    paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const property = await properties.create(owner(), {
    address: { line1: "9 Deadline Dr", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  propertyId = property.id;
  const job = await jobs.create(owner(), {
    customerId, propertyId, summary: "Chiller down", tags: [], customFields: {},
  });
  jobId = job.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.obligation where organization_id = ${ORG}`;
});

run("what is about to breach", () => {
  it("shows a live deadline with the time left on it", async () => {
    await insert({ dueAt: new Date(Date.now() + 2 * 3600_000) });

    const live = await obligations.open(owner());
    expect(live).toHaveLength(1);
    expect(live[0]!.overdue).toBe(false);
    expect(live[0]!.minutesRemaining).toBeGreaterThan(100);
    expect(live[0]!.consequence).toContain("four hours");
  });

  it("reports a past deadline as overdue WITHOUT the sweep having run", async () => {
    /**
     * The most important assertion in this file. The stored state is still
     * `open`, because nothing has swept. A read that filtered on
     * `state = 'breached'` would report a clean queue here, which is how a
     * monitoring system's own outage turns into a clean bill of health.
     */
    await insert({ dueAt: new Date(Date.now() - 3600_000) });

    const live = await obligations.open(owner());
    expect(live[0]!.state).toBe("open");
    expect(live[0]!.overdue).toBe(true);
    expect(live[0]!.minutesRemaining).toBeLessThan(0);
  });

  it("puts what is already late above what is merely coming", async () => {
    await insert({ dueAt: new Date(Date.now() + 3600_000), kind: "later" });
    await insert({ dueAt: new Date(Date.now() - 3600_000), kind: "already_late" });

    const live = await obligations.open(owner());
    expect(live.map((o) => o.kind)).toEqual(["already_late", "later"]);
  });

  it("hides what somebody has finished with", async () => {
    await insert({ state: "satisfied" });
    await insert({ state: "waived" });
    await insert({ state: "cancelled" });
    await insert({ kind: "still_owed" });

    const live = await obligations.open(owner());
    expect(live.map((o) => o.kind)).toEqual(["still_owed"]);
  });

  it("does not let a page of finished work crowd out the live queue", async () => {
    /**
     * The state filter has to be in the QUERY, not applied to the page after
     * it is cut. Filtering afterwards means a company with a long history of
     * satisfied deadlines gets a limit's worth of finished rows and an empty
     * screen, and the screen is right there saying nothing is due.
     */
    for (let i = 0; i < 5; i += 1) {
      await insert({ state: "satisfied", dueAt: new Date(Date.now() - 86_400_000) });
    }
    await insert({ kind: "the_only_live_one" });

    const live = await obligations.open(owner(), { limit: 3 });
    expect(live.map((o) => o.kind)).toEqual(["the_only_live_one"]);
  });

  it("counts the live ones and how many are already past", async () => {
    await insert({ dueAt: new Date(Date.now() + 3600_000) });
    await insert({ dueAt: new Date(Date.now() - 3600_000) });
    await insert({ state: "satisfied" });

    expect(await obligations.counts(owner())).toEqual({ live: 2, overdue: 1 });
  });

  it("filters by kind, because one table holds every sort of deadline", async () => {
    await insert({ kind: "sla.on_site" });
    await insert({ kind: "warranty.register_by" });

    const live = await obligations.open(owner(), { kind: "warranty.register_by" });
    expect(live.map((o) => o.kind)).toEqual(["warranty.register_by"]);
  });
});

run("closing one out", () => {
  it("requires saying what satisfied it", async () => {
    const [row] = await insert();
    await expect(obligations.satisfy(owner(), { id: row!.id, satisfiedByEvent: "   " }))
      .rejects.toThrow(/cannot be audited/);
  });

  it("records what satisfied it, so a scorecard can be defended", async () => {
    const [row] = await insert();
    const done = await obligations.satisfy(owner(), {
      id: row!.id, satisfiedByEvent: "Technician on site at 14:12, visit a3f2.",
    });
    expect(done.state).toBe("satisfied");

    const [stored] = await raw<{ satisfied_by_event: string; satisfied_at: Date }[]>`
      select satisfied_by_event, satisfied_at from public.obligation where id = ${row!.id}`;
    expect(stored!.satisfied_by_event).toContain("14:12");
    expect(stored!.satisfied_at).not.toBeNull();
  });

  it("requires a reason to waive, because one with none is forgetting", async () => {
    const [row] = await insert();
    await expect(obligations.waive(owner(), { id: row!.id, reason: "" }))
      .rejects.toThrow(/indistinguishable from forgetting/);
  });

  it("will not let a waived deadline be recorded as met", async () => {
    /**
     * The absorbing rule that matters. Waiving is a decision somebody made
     * on the record; satisfying it afterwards would quietly rewrite "we
     * agreed not to" into "we did it", and a scorecard is exactly where
     * somebody would want to.
     */
    const [row] = await insert();
    await obligations.waive(owner(), { id: row!.id, reason: "Customer moved the appointment." });

    await expect(obligations.satisfy(owner(), { id: row!.id, satisfiedByEvent: "On site." }))
      .rejects.toThrow(ConflictError);
  });

  it("refuses an obligation belonging to another company", async () => {
    const [row] = await insert();
    const stranger: ServiceContext = {
      actor: { userId: USER, organizationId: fixtureId("obligations:other"), roles: ["owner"] as Actor["roles"] },
      db: db(),
    };
    await expect(stranger && obligations.satisfy(stranger, { id: row!.id, satisfiedByEvent: "x" }))
      .rejects.toThrow(NotFoundError);
  });
});

run("the sweep, which is a record rather than the alarm", () => {
  it("stamps what has gone past and escalates what asked to be", async () => {
    await insert({
      dueAt: new Date(Date.now() - 3600_000),
      escalateAt: new Date(Date.now() - 1800_000),
    });

    const first = await obligations.sweep(owner());
    expect(first).toEqual({ breached: 1, escalated: 1 });

    const [stored] = await raw<{ state: string; breached_at: Date; escalated_at: Date }[]>`
      select state, breached_at, escalated_at from public.obligation
      where organization_id = ${ORG}`;
    expect(stored!.state).toBe("breached");
    expect(stored!.breached_at).not.toBeNull();
    expect(stored!.escalated_at).not.toBeNull();
  });

  it("is safe on any schedule, because it stamps each row once", async () => {
    await insert({
      dueAt: new Date(Date.now() - 3600_000),
      escalateAt: new Date(Date.now() - 1800_000),
    });
    await obligations.sweep(owner());
    expect(await obligations.sweep(owner())).toEqual({ breached: 0, escalated: 0 });
  });

  it("leaves a breached deadline in the live queue, because it is still owed", async () => {
    await insert({ dueAt: new Date(Date.now() - 3600_000) });
    await obligations.sweep(owner());

    const live = await obligations.open(owner());
    expect(live).toHaveLength(1);
    expect(live[0]!.state).toBe("breached");
    expect(live[0]!.overdue).toBe(true);
  });

  it("does not touch a deadline that is not due yet", async () => {
    await insert({ dueAt: new Date(Date.now() + 3600_000) });
    expect(await obligations.sweep(owner())).toEqual({ breached: 0, escalated: 0 });
  });
});

run("the one writer that already existed", () => {
  it("raises a billing decision when a cancelled visit is completed", async () => {
    const job = await jobs.create(owner(), {
      customerId, propertyId, summary: "Cancelled then done", tags: [], customFields: {},
    });
    const visit = await jobs.addVisit(owner(), {
      id: job.id,
      windowStart: new Date(Date.now() + 86_400_000).toISOString(),
      windowEnd: new Date(Date.now() + 90_000_000).toISOString(),
      estimatedDurationMinutes: 60,
      technicianIds: [],
    });
    await raw`update public.visit set status = 'cancelled' where id = ${visit.id}`;

    await jobs.complete(owner(), { id: visit.id });

    const live = await obligations.open(owner());
    const raised = live.find((o) => o.kind === "dispatch.completed_after_cancellation");
    expect(raised, "the row a technician's completion raises and nobody ever saw").toBeTruthy();
    expect(raised!.consequence).toContain("Confirm whether to bill it");

    /**
     * Keyed by the VISIT. A job can carry several and only one of them was
     * done after the cancellation; collapsing it to the job would lose
     * which, and the billing decision is about that one piece of work. The
     * screen resolves the visit's job for its link, which is the right place
     * to pay for the precision.
     */
    expect(raised!.entityType).toBe("visit");
    expect(raised!.entityId).toBe(visit.id);
  });

  it("does not raise one when the visit was never cancelled", async () => {
    const job = await jobs.create(owner(), {
      customerId, propertyId, summary: "Ordinary", tags: [], customFields: {},
    });
    const visit = await jobs.addVisit(owner(), {
      id: job.id,
      windowStart: new Date(Date.now() + 86_400_000).toISOString(),
      windowEnd: new Date(Date.now() + 90_000_000).toISOString(),
      estimatedDurationMinutes: 60,
      technicianIds: [],
    });
    await jobs.complete(owner(), { id: visit.id });

    const live = await obligations.open(owner());
    expect(live.filter((o) => o.kind === "dispatch.completed_after_cancellation")).toEqual([]);
  });
});
