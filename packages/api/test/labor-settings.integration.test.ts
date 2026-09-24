import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as settings from "../src/services/labor-settings";
import * as labor from "../src/services/labor";
import { inTenant } from "../src/services/context";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A COMPANY COULD NOT SAY WHAT ANYBODY EARNS
 *
 * Three columns, one broken path.
 *
 * `policyFor` refuses to run a timesheet without an overtime policy, and it
 * is right to: every plausible default is a legal position on somebody's
 * wages. Its message says "set one before running a timesheet". Nothing
 * could set one. So the timesheet screen threw that error for every company
 * that ever opened it, and the error told them to do something the product
 * had no way of doing, which reads as the reader's fault.
 *
 * `freezeRate` resolves the wage scale in effect on the day a punch was
 * worked, which is careful and dated and correct, and it bailed at
 * `if (!scale) return` every time, because no scale could exist. Every entry
 * was unpriced and every job's labour cost was zero.
 *
 * And `technician.wage_classification` says it in its own schema comment:
 * "Nothing supplied it, because the phone had nowhere to read it from."
 *
 * The tell, in the existing labour suite: its fixtures insert the policy and
 * the technician with raw SQL. A test that has to bypass the product to set
 * the product up is describing a missing surface.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("ls:org");
const USER = fixtureId("ls:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let technicianId = "";

const POLICY = {
  label: "Federal",
  note: "Forty hours a week at time and a half. Nothing daily, because Texas has no daily rule.",
  timeZone: "America/Chicago",
  weekStartsOn: 1,
  weeklyThresholdMinutes: 40 * 60,
  onCallTreatment: "separate_rate_not_hours_worked" as const,
};

const SCALE = {
  classification: "Journeyman Electrician",
  baseRate: "42.00",
  fringeRate: "13.25",
  authority: "employee_default" as const,
};

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Scale Co", slug: "scale-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;

  const [membership] = await raw<{ id: string }[]>`select id from public.membership
    where organization_id = ${ORG} and user_id = ${USER}`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician
    (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, 'Ray Nunez') returning id`;
  technicianId = t!.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.timeclock_entry where organization_id = ${ORG}`;
  await raw`delete from public.wage_scale where organization_id = ${ORG}`;
  await raw`delete from public.overtime_policy where organization_id = ${ORG}`;
  await raw`update public.technician set wage_classification = null where organization_id = ${ORG}`;
});

run("declaring an overtime policy", () => {
  it("is what makes the timesheet screen work at all", async () => {
    /**
     * The error the product gave every company, forever, naming an action
     * nobody could take.
     */
    await expect(labor.week(owner(), { weekOf: "2026-01-05" }))
      .rejects.toThrow(/no safe default/i);

    await settings.setPolicy(owner(), POLICY);

    await expect(labor.week(owner(), { weekOf: "2026-01-05" })).resolves.toBeTruthy();
  });

  it("is validated by core rather than by a second set of rules here", async () => {
    /**
     * `checkOvertimePolicy` already refuses each of these and had no caller
     * outside its own tests, so every refusal in it was unreachable from the
     * product. Writing new checks here would have made two rules about wages
     * that can disagree.
     */
    await expect(settings.setPolicy(owner(), { ...POLICY, note: "   " }))
      .rejects.toThrow(/note/i);

    await expect(settings.setPolicy(owner(), {
      ...POLICY, roundingMinutes: 15, roundingMode: "down",
    })).rejects.toThrow(/only ever runs in the employer's direction/i);

    await expect(settings.setPolicy(owner(), { ...POLICY, overtimeMultiplier: "0.9" }))
      .rejects.toThrow(/less than 1/i);

    await expect(settings.setPolicy(owner(), {
      ...POLICY, weeklyDoubleTimeThresholdMinutes: 30 * 60,
    })).rejects.toThrow(/double time threshold is below/i);
  });

  it("refuses an on call treatment it was not given", async () => {
    await expect(settings.setPolicy(owner(), {
      ...POLICY, onCallTreatment: "whatever" as never,
    })).rejects.toThrow(/on call/i);
  });

  it("supersedes rather than edits, so what was declared in March survives", async () => {
    await settings.setPolicy(owner(), POLICY);
    const second = await settings.setPolicy(owner(), {
      ...POLICY, label: "California", dailyThresholdMinutes: 8 * 60,
      note: "Eight hours a day, because a ninth hour in California is already overtime.",
    });

    expect(second.replaced).toBe("Federal");

    const all = await settings.policies(owner());
    expect(all).toHaveLength(2);
    expect(all.filter((p) => p.active).map((p) => p.label)).toEqual(["California"]);
  });

  it("says when a new declaration reclassifies time already approved", async () => {
    await settings.setPolicy(owner(), POLICY);

    const quiet = await settings.setPolicy(owner(), { ...POLICY, label: "Second" });
    expect(quiet.reclassifiesApprovedTime).toBe(false);

    await raw`insert into public.timeclock_entry
      (organization_id, technician_id, kind, started_at, ended_at, minutes, approved_at)
      values (${ORG}, ${technicianId}, 'on_site', now() - interval '3 hours', now(), 180, now())`;

    /**
     * Overtime classification is DERIVED on read, so a new policy moves the
     * straight time and overtime split on weeks already signed off. The
     * rates themselves are frozen at the punch and do not move. Said here
     * rather than discovered in a payroll run.
     */
    const loud = await settings.setPolicy(owner(), { ...POLICY, label: "Third" });
    expect(loud.reclassifiesApprovedTime).toBe(true);
  });

  it("refuses a role without payroll:configure", async () => {
    /**
     * Not the same permission as reading payroll or running an export. The
     * person who runs the export is usually not the person entitled to
     * decide what anybody is owed.
     */
    await expect(settings.setPolicy(as(["office_manager"]), POLICY))
      .rejects.toBeInstanceOf(PermissionError);
  });
});

run("loading a wage scale", () => {
  it("is what makes a punch cost anything", async () => {
    await settings.setPolicy(owner(), POLICY);
    const scale = await settings.setScale(owner(), SCALE);
    await settings.setClassification(owner(), {
      technicianId, classification: SCALE.classification,
    });

    const [entry] = await raw<{ id: string }[]>`insert into public.timeclock_entry
      (organization_id, technician_id, kind, started_at, ended_at, minutes)
      values (${ORG}, ${technicianId}, 'on_site',
              '2026-03-02T14:00:00Z', '2026-03-02T22:00:00Z', 480) returning id`;

    await inTenant(owner(), (tx) => labor.freezeRate(tx, ORG, entry!.id));

    const [row] = await raw<{
      wage_scale_id: string | null; applied_base_rate: string | null;
      applied_loaded_rate: string | null; classification: string | null;
    }[]>`select wage_scale_id, applied_base_rate, applied_loaded_rate, classification
         from public.timeclock_entry where id = ${entry!.id}`;

    expect(row!.wage_scale_id).toBe(scale.id);
    expect(Number(row!.applied_base_rate)).toBe(42);
    /** Base plus fringe, never a burden multiplier this product did not choose. */
    expect(Number(row!.applied_loaded_rate)).toBe(55.25);
    expect(row!.classification).toBe(SCALE.classification);
  });

  it("resolves the scale in effect on the day worked, not the newest", async () => {
    await settings.setPolicy(owner(), POLICY);
    await settings.setScale(owner(), {
      ...SCALE, baseRate: "40.00", effectiveFrom: "2025-01-01", effectiveTo: "2025-12-31",
    });
    await settings.setScale(owner(), { ...SCALE, baseRate: "42.00", effectiveFrom: "2026-01-01" });
    await settings.setClassification(owner(), {
      technicianId, classification: SCALE.classification,
    });

    /**
     * A union agreement raises rates on a date, and an entry worked before
     * that date must keep costing what it cost. This is why loading a raise
     * writes a NEW row: editing the old one reprices every job it had
     * already costed.
     */
    const [old] = await raw<{ id: string }[]>`insert into public.timeclock_entry
      (organization_id, technician_id, kind, started_at, ended_at, minutes)
      values (${ORG}, ${technicianId}, 'on_site',
              '2025-06-02T14:00:00Z', '2025-06-02T22:00:00Z', 480) returning id`;
    await inTenant(owner(), (tx) => labor.freezeRate(tx, ORG, old!.id));

    const [row] = await raw<{ applied_base_rate: string | null }[]>`
      select applied_base_rate from public.timeclock_entry where id = ${old!.id}`;
    expect(Number(row!.applied_base_rate)).toBe(40);
  });

  it("refuses a rate of zero", async () => {
    await expect(settings.setScale(owner(), { ...SCALE, baseRate: "0" }))
      .rejects.toThrow(/not a rate/i);
  });

  it("refuses a prevailing wage that cites nothing", async () => {
    /**
     * The whole reason those authorities are named separately is that they
     * can be checked against a document, and one with no reference cannot
     * be.
     */
    await expect(settings.setScale(owner(), { ...SCALE, authority: "wage_determination" }))
      .rejects.toThrow(/reference/i);

    await expect(settings.setScale(owner(), {
      ...SCALE, authority: "wage_determination", externalReference: "TX20260012",
    })).resolves.toBeTruthy();
  });

  it("refuses a scale that ends before it starts", async () => {
    await expect(settings.setScale(owner(), {
      ...SCALE, effectiveFrom: "2027-01-01", effectiveTo: "2026-01-01",
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("closes a scale on a date rather than deleting it", async () => {
    const scale = await settings.setScale(owner(), { ...SCALE, effectiveFrom: "2025-01-01" });
    const closed = await settings.closeScale(owner(), { id: scale.id, effectiveTo: "2025-12-31" });

    /**
     * A deleted scale unprices every entry that resolved against it, and
     * those entries have already been approved and paid.
     */
    expect(closed.effectiveTo).toBe("2025-12-31");
    expect((await settings.scales(owner(), {})).map((s) => s.id)).toContain(scale.id);
  });

  it("refuses to close a scale before it began", async () => {
    const scale = await settings.setScale(owner(), { ...SCALE, effectiveFrom: "2026-01-01" });
    await expect(settings.closeScale(owner(), { id: scale.id, effectiveTo: "2025-06-01" }))
      .rejects.toBeInstanceOf(ConflictError);
  });
});

run("who is paid at what", () => {
  it("refuses a classification no scale has ever carried", async () => {
    await settings.setScale(owner(), SCALE);

    /**
     * A typo produces a technician whose entries resolve against nothing and
     * cost zero, and zero labour cost on a job reads as a very profitable
     * job rather than as a misspelling.
     */
    await expect(settings.setClassification(owner(), {
      technicianId, classification: "Journeyman Electician",
    })).rejects.toThrow(/no wage scale has ever been loaded/i);
  });

  it("accepts one whose scale has expired, since people go back to old grades", async () => {
    const scale = await settings.setScale(owner(), {
      ...SCALE, effectiveFrom: "2020-01-01", effectiveTo: "2020-12-31",
    });
    await expect(settings.setClassification(owner(), {
      technicianId, classification: SCALE.classification,
    })).resolves.toBeTruthy();
    void scale;
  });

  it("refuses a technician who is not ours", async () => {
    await settings.setScale(owner(), SCALE);
    await expect(settings.setClassification(owner(), {
      technicianId: fixtureId("ls:missing"), classification: SCALE.classification,
    })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("names everybody whose time would cost nothing, and why", async () => {
    await settings.setScale(owner(), SCALE);

    /**
     * The reason this read exists. A technician with no classification, or
     * one no scale covers today, freezes no rate, and the only symptom is a
     * job that looks unusually profitable.
     */
    const before = await settings.crewRates(owner(), {});
    expect(before[0]).toMatchObject({
      classification: null,
      baseRate: null,
      unpricedBecause: expect.stringMatching(/No classification set/),
    });

    await settings.setClassification(owner(), {
      technicianId, classification: SCALE.classification,
    });

    const after = await settings.crewRates(owner(), {});
    expect(after[0]).toMatchObject({ baseRate: "42.0000", unpricedBecause: null });
  });

  it("says so when the scale exists but is not in effect today", async () => {
    await settings.setScale(owner(), {
      ...SCALE, effectiveFrom: "2020-01-01", effectiveTo: "2020-12-31",
    });
    await settings.setClassification(owner(), {
      technicianId, classification: SCALE.classification,
    });

    const rates = await settings.crewRates(owner(), {});
    expect(rates[0]!.unpricedBecause).toMatch(/is in effect today/i);
    expect(rates[0]!.baseRate).toBeNull();
  });
});
