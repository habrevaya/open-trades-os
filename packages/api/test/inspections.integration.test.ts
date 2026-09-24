import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as inspections from "../src/services/inspections";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * INSPECTIONS AND THE DEFICIENCY BACKLOG
 *
 * `packages/core/src/inspection` is thirteen hundred lines with forty three
 * exports and it had no caller. Not a thin one: none. Template validation,
 * reading evaluation, the completeness rollup that refuses to call a half
 * finished inspection a pass, the proposal builder that refuses to price a
 * finding with no evidence, the backlog ageing. All written, all tested in
 * core, and no line of it reachable from the product.
 *
 * The tables were the same. `inspection` was touched by nothing at all, and
 * `deficiency` was read by the equipment history and written by nothing,
 * which is why that screen's faults section was always empty.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("in:org");
const USER = fixtureId("in:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let customerId = "";
let propertyId = "";

const PROGRAM = {
  name: "Annual backflow test",
  standard: "AWWA",
  frequencyMonths: 12,
  checkpoints: [
    { key: "shutoff", label: "Number 1 shutoff holds", severityOnFail: "critical" as const },
    { key: "relief", label: "Relief valve opens", severityOnFail: "major" as const },
    /**
     * A reading needs a range, because core refuses one without: a number
     * with nothing to judge it against goes in the report and decides
     * nothing. The checkpoint shape had no range at all until this module
     * was wired, so no pack could ever ship a judgeable reading.
     */
    { key: "psi", label: "Differential pressure", requiresReading: true, unit: "psi",
      range: { min: 5, max: null }, severityOnFail: "major" as const },
    { key: "housekeeping", label: "Enclosure tidy", severityOnFail: "advisory" as const },
  ],
};

const answer = (itemKey: string, value: unknown) => ({
  itemKey, value: value as never, at: new Date("2026-05-01T15:00:00Z"), by: "Ray Nunez",
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Backflow Co", slug: "backflow-co" });

  const customer = await customers.create(owner(), {
    type: "commercial", name: "Riverside Plaza", phone: "+15125550801",
    paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;

  const property = await properties.create(owner(), {
    address: { line1: "9 Riverside Dr", city: "Austin", state: "TX", postalCode: "78704", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  propertyId = property.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.deficiency where organization_id = ${ORG}`;
  await raw`delete from public.inspection where organization_id = ${ORG}`;
  await raw`delete from public.inspection_program where organization_id = ${ORG}`;
});

run("defining a programme", () => {
  it("refuses one with no checkpoints", async () => {
    await expect(inspections.defineProgram(owner(), { ...PROGRAM, checkpoints: [] }))
      .rejects.toThrow(/inspects nothing/i);
  });

  it("refuses a template core will not accept, at the save", async () => {
    /**
     * `validateTemplate` had never been called. Its problems are about items
     * that cannot be answered and items that can fail with no stated meaning,
     * and every one is invisible until a technician is in a plant room with
     * a phone, where none of them is recoverable.
     */
    await expect(inspections.defineProgram(owner(), {
      ...PROGRAM,
      checkpoints: [{
        key: "psi", label: "Differential pressure",
        requiresReading: true, unit: "psi", severityOnFail: "major" as const,
      }],
    })).rejects.toThrow(/no acceptable range/i);
  });

  it("publishes a new version rather than editing in place", async () => {
    const program = await inspections.defineProgram(owner(), PROGRAM);
    expect(program.version).toBe(1);

    const revised = await inspections.reviseProgram(owner(), {
      id: program.id,
      checkpoints: [...PROGRAM.checkpoints,
        { key: "gauge", label: "Gauge in calibration", severityOnFail: "major" as const }],
    });

    /**
     * An inspection records the version it was performed under. Editing
     * checkpoints in place rewrites what every past inspection claims to
     * have checked, which is the one thing a compliance record must not do.
     */
    expect(revised.version).toBe(2);
  });

  it("refuses a role without compliance:write", async () => {
    await expect(inspections.defineProgram(as(["technician"]), PROGRAM))
      .rejects.toBeInstanceOf(PermissionError);
  });
});

run("recording one", () => {
  const program = () => inspections.defineProgram(owner(), PROGRAM);

  it("decides the outcome rather than being told it", async () => {
    const p = await program();
    const result = await inspections.record(owner(), {
      programId: p.id, propertyId, customerId,
      performedOn: "2026-05-01",
      answers: [
        answer("shutoff", { kind: "pass_fail", passed: true }),
        answer("relief", { kind: "pass_fail", passed: true }),
        answer("psi", { kind: "reading", raw: 8 }),
        answer("housekeeping", { kind: "pass_fail", passed: true }),
      ],
    });

    /**
     * The outcome is not an input. A technician says what they saw; whether
     * that is a pass is a conclusion from the template.
     */
    expect(result.result).toBe("pass");
    expect(result.complete).toBe(true);
    expect(result.statement).toBeTruthy();
  });

  it("will not call a half finished inspection a pass", async () => {
    const p = await program();
    const result = await inspections.record(owner(), {
      programId: p.id, propertyId, customerId, performedOn: "2026-05-01",
      answers: [answer("shutoff", { kind: "pass_fail", passed: true })],
    });

    /**
     * The most dangerous artefact this module could produce: an inspection
     * with half its items skipped reporting "passed". That report goes in a
     * compliance file, gets handed to a buyer, gets shown to an insurer, and
     * asserts that somebody looked at things nobody looked at.
     *
     * `partial` rather than `fail`, because they are different facts: a fail
     * says the thing is wrong, a partial says nobody finished looking.
     */
    expect(result.result).toBe("partial");
    expect(result.complete).toBe(false);
    expect(result.unanswered).toEqual(expect.arrayContaining(["relief", "psi", "housekeeping"]));
  });

  it("turns findings into rows on a backlog", async () => {
    const p = await program();
    const result = await inspections.record(owner(), {
      programId: p.id, propertyId, customerId, performedOn: "2026-05-01",
      answers: [
        answer("shutoff", { kind: "pass_fail", passed: false }),
        answer("relief", { kind: "pass_fail", passed: true }),
        answer("psi", { kind: "reading", raw: 8 }),
        answer("housekeeping", { kind: "pass_fail", passed: false }),
      ],
    });

    expect(result.result).toBe("fail");
    expect(result.deficiencies).toBe(2);

    /**
     * A deficiency that exists only inside one report is a fault nobody
     * follows up. These are rows.
     */
    const open = await inspections.backlog(owner(), { propertyId, now: new Date("2026-05-10") });
    expect(open.map((d) => d.severity)).toEqual(["safety", "recommendation"]);
  });

  it("sets the deadline from the severity, not from a field somebody types", async () => {
    const p = await program();
    await inspections.record(owner(), {
      programId: p.id, propertyId, customerId, performedOn: "2026-05-01",
      answers: [
        answer("shutoff", { kind: "pass_fail", passed: false }),
        answer("relief", { kind: "pass_fail", passed: false }),
        answer("psi", { kind: "reading", raw: 8 }),
        answer("housekeeping", { kind: "pass_fail", passed: false }),
      ],
    });

    const rows = await raw<{ severity: string; correct_by_on: string | null }[]>`
      select severity, correct_by_on::text from public.deficiency where organization_id = ${ORG}`;
    const by = new Map(rows.map((r) => [r.severity, r.correct_by_on]));

    /**
     * Safety is today, a failure is thirty days, a recommendation has no
     * deadline at all. Leaving that to be typed is how every finding ends up
     * with the same date.
     */
    expect(by.get("critical")).toBe("2026-05-01");
    expect(by.get("major")).toBe("2026-05-31");
    expect(by.get("advisory")).toBeNull();
  });

  it("stamps the programme version it was performed under", async () => {
    const p = await program();
    await inspections.reviseProgram(owner(), { id: p.id, name: "Annual backflow test v2" });

    const result = await inspections.record(owner(), {
      programId: p.id, propertyId, customerId, performedOn: "2026-05-01",
      answers: PROGRAM.checkpoints.map((c) =>
        answer(c.key, c.requiresReading
          ? { kind: "reading", raw: 8 }
          : { kind: "pass_fail", passed: true })),
    });

    const [row] = await raw<{ program_version: number }[]>`
      select program_version from public.inspection where id = ${result.id}`;
    expect(row!.program_version).toBe(2);
  });

  it("schedules the next one from the programme's frequency", async () => {
    const p = await program();
    const result = await inspections.record(owner(), {
      programId: p.id, propertyId, customerId, performedOn: "2026-05-01",
      answers: PROGRAM.checkpoints.map((c) =>
        answer(c.key, c.requiresReading
          ? { kind: "reading", raw: 8 }
          : { kind: "pass_fail", passed: true })),
    });
    expect(result.nextDueOn).toBe("2027-05-01");
  });

  it("refuses an answer to an item the programme no longer has", async () => {
    const p = await program();
    /**
     * The template changed under a technician who was offline, and the work
     * they did recording it is real. Refused rather than dropped, naming the
     * items, so somebody can put it somewhere.
     */
    await expect(inspections.record(owner(), {
      programId: p.id, propertyId, customerId,
      answers: [answer("gone", { kind: "pass_fail", passed: true })],
    })).rejects.toThrow(/no longer has/i);
  });
});

run("the backlog", () => {
  const withFindings = async () => {
    const p = await inspections.defineProgram(owner(), PROGRAM);
    await inspections.record(owner(), {
      programId: p.id, propertyId, customerId, performedOn: "2026-05-01",
      answers: [
        answer("shutoff", { kind: "pass_fail", passed: false }),
        answer("relief", { kind: "pass_fail", passed: false }),
        answer("psi", { kind: "reading", raw: 8 }),
        answer("housekeeping", { kind: "pass_fail", passed: false }),
      ],
    });
    return p;
  };

  it("ages against a date it is given, so it is reproducible", async () => {
    await withFindings();

    /**
     * `now` is a parameter in core for a reason: a backlog run twice for the
     * same month end has to say the same thing, which it cannot if the
     * ageing is measured against whenever it happened to run.
     */
    const early = await inspections.backlog(owner(), { propertyId, now: new Date("2026-05-10") });
    const later = await inspections.backlog(owner(), { propertyId, now: new Date("2026-06-10") });

    expect(early.find((d) => d.recordedSeverity === "critical")!.ageDays).toBe(9);
    expect(later.find((d) => d.recordedSeverity === "critical")!.ageDays).toBe(40);
  });

  it("puts the overdue safety finding first", async () => {
    await withFindings();
    const open = await inspections.backlog(owner(), { propertyId, now: new Date("2026-06-10") });
    expect(open[0]!.severity).toBe("safety");
    expect(open[0]!.overdue).toBe(true);
    /** A recommendation has no deadline, so it is never overdue. */
    expect(open.find((d) => d.severity === "recommendation")!.overdue).toBe(false);
  });

  it("drops a corrected finding off the list", async () => {
    await withFindings();
    const open = await inspections.backlog(owner(), { propertyId, now: new Date("2026-06-10") });
    const safety = open.find((d) => d.severity === "safety")!;

    await inspections.setDeficiencyStatus(owner(), { id: safety.id, status: "corrected" });

    const after = await inspections.backlog(owner(), { propertyId, now: new Date("2026-06-10") });
    expect(after.map((d) => d.id)).not.toContain(safety.id);
    expect((await inspections.backlog(owner(), {
      propertyId, includeSettled: true, now: new Date("2026-06-10"),
    })).map((d) => d.id)).toContain(safety.id);
  });

  it("needs a reason to decline a finding", async () => {
    await withFindings();
    const open = await inspections.backlog(owner(), { propertyId, now: new Date("2026-06-10") });
    const safety = open.find((d) => d.severity === "safety")!;

    /**
     * A customer who declined a safety finding is the single sentence
     * somebody will want in writing later.
     */
    await expect(inspections.setDeficiencyStatus(owner(), { id: safety.id, status: "declined" }))
      .rejects.toThrow(/needs a reason/i);

    await expect(inspections.setDeficiencyStatus(owner(), {
      id: safety.id, status: "declined", reason: "Customer says the tenant is moving out.",
    })).resolves.toBeTruthy();
  });

  it("refuses to reopen something recorded as corrected", async () => {
    await withFindings();
    const open = await inspections.backlog(owner(), { propertyId, now: new Date("2026-06-10") });
    const one = open[0]!;
    await inspections.setDeficiencyStatus(owner(), { id: one.id, status: "corrected" });

    await expect(inspections.setDeficiencyStatus(owner(), { id: one.id, status: "open" }))
      .rejects.toThrow(/repair did not happen/i);
  });

  it("reaches the equipment history, which was always empty", async () => {
    await withFindings();
    /**
     * The equipment screen read deficiencies by unit and nothing wrote one.
     * These findings carry no equipment id yet, so the property backlog is
     * where they land, and that is the honest state until a checkpoint names
     * a unit.
     */
    const all = await inspections.backlog(owner(), { customerId, now: new Date("2026-06-10") });
    expect(all.length).toBeGreaterThan(0);
  });
});

run("what it would be quoted as", () => {
  const WITH_REMEDY = {
    ...PROGRAM,
    checkpoints: PROGRAM.checkpoints.map((c) => c.key === "shutoff"
      ? {
          ...c,
          remedies: [{
            priceBookItemKey: "RP-REBUILD",
            label: "Rebuild kit, 3/4 inch",
            quantity: 1,
            rationale: "The number 1 shutoff failed to hold, which is what the kit replaces.",
          }],
        }
      : c),
  };

  const failShutoff = async (program: { id: string }) => inspections.record(owner(), {
    programId: program.id, propertyId, customerId, performedOn: "2026-05-01",
    answers: [
      answer("shutoff", { kind: "pass_fail", passed: false }),
      answer("relief", { kind: "pass_fail", passed: true }),
      answer("psi", { kind: "reading", raw: 8 }),
      answer("housekeeping", { kind: "pass_fail", passed: true }),
    ],
  });

  it("proposes the work a checkpoint declared", async () => {
    const p = await inspections.defineProgram(owner(), WITH_REMEDY);
    await failShutoff(p);

    /**
     * Core has carried a `Remedy` type since it was written and the
     * checkpoint shape had nowhere to put one, so every finding came out of
     * the proposal builder as `unmapped`: real, shown, and with no work
     * behind it. A backlog where nothing can be quoted is a list somebody
     * stops reading.
     */
    const result = await inspections.proposal(owner(), { propertyId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.lineCount).toBe(1);
    expect(result.groups[0]!.lines[0]).toMatchObject({
      priceBookItemKey: "RP-REBUILD",
      severity: "safety",
    });
    /** The evidence travels with the line, by construction. */
    expect(result.groups[0]!.lines[0]!.observation.recorded).toBeTruthy();
  });

  it("shows a finding with no remedy rather than dropping it", async () => {
    const p = await inspections.defineProgram(owner(), PROGRAM);
    await failShutoff(p);

    const result = await inspections.proposal(owner(), { propertyId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    /**
     * Found, and with no price book item behind it. Shown, never dropped:
     * the office has to know there is a fault they cannot quote.
     */
    expect(result.lineCount).toBe(0);
    expect(result.unmapped.map((u) => u.itemKey)).toEqual(["shutoff"]);
  });

  it("refuses to price a finding with no evidence behind it", async () => {
    const p = await inspections.defineProgram(owner(), WITH_REMEDY);
    await failShutoff(p);

    /**
     * A finding entered by hand, or written before the observation column
     * existed, carries no evidence. Core refuses to price it rather than
     * producing a quote with a story and nothing behind it, and names the
     * item so somebody can go and attach the photo they took.
     */
    await raw`update public.deficiency set observation = null where organization_id = ${ORG}`;

    const result = await inspections.proposal(owner(), { propertyId });
    expect(result).toMatchObject({ ok: false, reason: "unobserved_deficiency" });
    if (result.ok) throw new Error("unreachable");
    expect(result.detail).toContain("shutoff");
  });

  it("refuses a remedy that does not justify itself", async () => {
    const p = await inspections.defineProgram(owner(), WITH_REMEDY);
    await failShutoff(p);

    /**
     * Evidence with no argument is the unevidenced proposal arriving by the
     * other door: a line with a blank rationale is a price with no sentence
     * saying why the finding implies the work.
     */
    await raw`update public.deficiency
      set remedies = '[{"priceBookItemKey":"RP-REBUILD","label":"Rebuild kit","quantity":1,"rationale":"  "}]'::jsonb
      where organization_id = ${ORG}`;

    expect(await inspections.proposal(owner(), { propertyId }))
      .toMatchObject({ ok: false, reason: "unjustified_remedy" });
  });

  it("says so plainly when there is nothing open", async () => {
    const result = await inspections.proposal(owner(), { propertyId });
    expect(result).toMatchObject({ ok: false, reason: "nothing_to_propose" });
  });
});
