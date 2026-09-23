import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as labor from "../src/services/labor";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * WHAT THE HOURS COST
 *
 * `timeclock_entry` carries three applied rate columns under a comment that
 * reads "Frozen at close. The scale can change; this entry's cost must not",
 * and `wage_scale_id` under one that reads "THE FIELD THIS TABLE EXISTS FOR".
 * Nothing wrote any of them. Every entry cost null, labour contributed
 * nothing to job costing, and a contractor reading a margin was reading a
 * number with its largest expense missing: the work they thought was their
 * best could have been the work losing them money.
 *
 * So the first assertion here is that a closed entry has a rate on it.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("labor:org");
const USER = fixtureId("labor:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let technicianId = "";

/** Monday the 5th of January 2026, in Austin. */
const MONDAY = "2026-01-05";
const at = (day: number, hour: number, minute = 0) =>
  // 06:00 in Austin is 12:00 UTC in January.
  new Date(Date.UTC(2026, 0, day, hour + 6, minute));

async function punch(
  startDay: number, startHour: number, endHour: number,
  extra: { kind?: string; classification?: string; endDay?: number } = {},
): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.timeclock_entry
      (organization_id, technician_id, kind, started_at, classification)
    values (${ORG}, ${technicianId}, ${extra.kind ?? "on_site"},
            ${at(startDay, startHour)}, ${extra.classification ?? null})
    returning id`;
  const ended = at(extra.endDay ?? startDay, endHour);
  const minutes = Math.round((ended.getTime() - at(startDay, startHour).getTime()) / 60_000);
  await raw`update public.timeclock_entry
    set ended_at = ${ended}, minutes = ${minutes} where id = ${row!.id}`;
  return row!.id;
}

const entryRow = (id: string) => raw<{
  wage_scale_id: string | null; applied_base_rate: string | null;
  applied_fringe_rate: string | null; applied_loaded_rate: string | null;
  approved_at: Date | null; classification: string | null;
}[]>`select wage_scale_id, applied_base_rate, applied_fringe_rate,
             applied_loaded_rate, approved_at, classification
      from public.timeclock_entry where id = ${id}`;

async function setPolicy(over: Record<string, unknown> = {}) {
  await raw`delete from public.overtime_policy where organization_id = ${ORG}`;
  await raw`insert into public.overtime_policy
    (organization_id, label, time_zone, week_starts_on, day_attribution,
     weekly_threshold_minutes, daily_threshold_minutes,
     overtime_multiplier, double_time_multiplier, on_call_treatment, note)
    values (${ORG}, 'Federal', 'America/Chicago', 1, 'shift_start',
            ${(over.weekly as number) ?? 2400}, ${(over.daily as number) ?? null},
            '1.5', '2', 'separate_rate_not_hours_worked',
            'Forty hours a week at time and a half. Nothing daily.')`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Labor Co", slug: "labor-co" });

  const [membership] = await raw<{ id: string }[]>`select id from public.membership
    where organization_id = ${ORG} and user_id = ${USER}`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician
    (organization_id, membership_id, display_name, wage_classification)
    values (${ORG}, ${membership!.id}, 'Ray Nunez', 'Journeyman') returning id`;
  technicianId = t!.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.timeclock_entry where organization_id = ${ORG}`;
  await raw`delete from public.wage_scale where organization_id = ${ORG}`;
  await setPolicy();
});

run("a policy is declared, never assumed", () => {
  it("refuses a timesheet when no policy is set", async () => {
    /**
     * Every plausible default is a legal position on somebody's wages. Forty
     * hours weekly at time and a half is the federal floor and is wrong in
     * California, where a ninth hour in a day is already overtime. A guessed
     * default produces a timesheet that looks authoritative and underpays
     * people, and nothing on the screen can say the numbers rest on an
     * assumption nobody made.
     */
    await raw`delete from public.overtime_policy where organization_id = ${ORG}`;
    await expect(labor.week(owner(), { weekOf: MONDAY })).rejects.toThrow(ConflictError);
    await expect(labor.week(owner(), { weekOf: MONDAY })).rejects.toThrow(/no safe default/i);
  });
});

run("what an hour cost, frozen at close", () => {
  async function scale(over: { base?: string; fringe?: string; from?: string | null; to?: string | null } = {}) {
    const [row] = await raw<{ id: string }[]>`insert into public.wage_scale
      (organization_id, authority, classification, base_rate, fringe_rate,
       effective_from, effective_to)
      values (${ORG}, 'employee_default', 'Journeyman',
              ${over.base ?? "42.5000"}, ${over.fringe ?? null},
              ${over.from ?? null}, ${over.to ?? null})
      returning id`;
    return row!.id;
  }

  it("writes the rate onto the entry when it closes", async () => {
    const scaleId = await scale({ base: "42.5000", fringe: "11.2500" });
    const id = await punch(5, 8, 16, { classification: "Journeyman" });

    await labor.freezeRate(db(), ORG, id);

    const [row] = await entryRow(id);
    expect(row!.wage_scale_id).toBe(scaleId);
    expect(row!.applied_base_rate).toBe("42.5000");
    expect(row!.applied_fringe_rate).toBe("11.2500");
    // Base plus fringe, not a burden multiplier this product did not choose.
    expect(row!.applied_loaded_rate).toBe("53.7500");
  });

  it("falls back to the technician's classification when the punch carried none", async () => {
    // The phone had nowhere to read a classification from, which is why the
    // column was always null and the reconstruction it exists to avoid was
    // the only option anybody had.
    await scale({ base: "38.0000" });
    const id = await punch(5, 8, 16);

    await labor.freezeRate(db(), ORG, id);

    const [row] = await entryRow(id);
    expect(row!.classification).toBe("Journeyman");
    expect(row!.applied_base_rate).toBe("38.0000");
  });

  it("does not move a rate that has already been frozen", async () => {
    /**
     * The whole meaning of the word. A second close on a corrected entry
     * must not reprice a job that has already been costed and invoiced.
     */
    await scale({ base: "40.0000" });
    const id = await punch(5, 8, 16, { classification: "Journeyman" });
    await labor.freezeRate(db(), ORG, id);

    await raw`update public.wage_scale set base_rate = '99.0000' where organization_id = ${ORG}`;
    await labor.freezeRate(db(), ORG, id);

    expect((await entryRow(id))[0]!.applied_base_rate).toBe("40.0000");
  });

  it("uses the scale in effect on the day the work happened", async () => {
    /**
     * A union agreement raises rates on a date. Work done before it must keep
     * costing what it cost, or last year's jobs reprice every time somebody
     * loads a new agreement.
     */
    await scale({ base: "40.0000", from: "2025-01-01", to: "2026-01-06" });
    await scale({ base: "46.0000", from: "2026-01-07", to: null });

    const before = await punch(5, 8, 16, { classification: "Journeyman" });
    const after = await punch(8, 8, 16, { classification: "Journeyman" });
    await labor.freezeRate(db(), ORG, before);
    await labor.freezeRate(db(), ORG, after);

    expect((await entryRow(before))[0]!.applied_base_rate).toBe("40.0000");
    expect((await entryRow(after))[0]!.applied_base_rate).toBe("46.0000");
  });

  it("leaves an entry unpriced rather than wrongly priced when no scale matches", async () => {
    const id = await punch(5, 8, 16, { classification: "Apprentice" });
    await labor.freezeRate(db(), ORG, id);
    // Visibly unpriced beats silently zero.
    expect((await entryRow(id))[0]!.applied_base_rate).toBeNull();
  });
});

run("a week, classified by core", () => {
  async function scale(base = "40.0000") {
    await raw`insert into public.wage_scale
      (organization_id, authority, classification, base_rate)
      values (${ORG}, 'employee_default', 'Journeyman', ${base})`;
  }

  it("splits a long week into regular and overtime", async () => {
    await scale();
    // Five nines is forty-five hours: forty regular, five over.
    for (const day of [5, 6, 7, 8, 9]) {
      const id = await punch(day, 7, 16, { classification: "Journeyman" });
      await labor.freezeRate(db(), ORG, id);
    }

    const { rows } = await labor.week(owner(), { weekOf: MONDAY });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.regularHours).toBe("40.00");
    expect(rows[0]!.overtimeHours).toBe("5.00");
    expect(rows[0]!.totalHours).toBe("45.00");
  });

  it("prices the week at the frozen rate, with the premium on the overtime", async () => {
    await scale("40.0000");
    for (const day of [5, 6, 7, 8, 9]) {
      const id = await punch(day, 7, 16, { classification: "Journeyman" });
      await labor.freezeRate(db(), ORG, id);
    }

    const { rows } = await labor.week(owner(), { weekOf: MONDAY });
    // 40 at 40.00 is 1600, plus 5 at 60.00 is 300.
    expect(rows[0]!.cost).toBe("1900.0000");
  });

  it("reports no cost at all rather than a partial one", async () => {
    /**
     * One unpriced entry makes the whole row's cost null. A partial total
     * that looks complete is worse than a blank: nobody questions a number,
     * and everybody questions an empty cell.
     */
    await scale();
    const priced = await punch(5, 7, 16, { classification: "Journeyman" });
    await labor.freezeRate(db(), ORG, priced);
    await punch(6, 7, 16, { classification: "Apprentice" });

    const { rows } = await labor.week(owner(), { weekOf: MONDAY });
    expect(rows[0]!.cost).toBeNull();
    // The hours are still right. It is the money that is unknown.
    expect(rows[0]!.totalHours).toBe("18.00");
  });

  it("counts an open punch separately instead of paying it as zero", async () => {
    /**
     * Core refuses a week containing an open entry and is right to: an entry
     * still running is worth an unknown amount, and paying an unknown amount
     * as zero is the failure it exists to prevent. The count is what puts it
     * on the screen instead.
     */
    await scale();
    const closed = await punch(5, 7, 16, { classification: "Journeyman" });
    await labor.freezeRate(db(), ORG, closed);
    await raw`insert into public.timeclock_entry
      (organization_id, technician_id, kind, started_at)
      values (${ORG}, ${technicianId}, 'on_site', ${at(6, 7)})`;

    const { rows } = await labor.week(owner(), { weekOf: MONDAY });
    expect(rows[0]!.openEntries).toBe(1);
    expect(rows[0]!.totalHours).toBe("9.00");
  });

  it("keeps a night shift in the week it was worked", async () => {
    /**
     * A shift starting at eleven on the last night of the week has hours in
     * the week and a started_at that a naive UTC bound puts outside it.
     */
    await scale();
    const id = await punch(11, 23, 7, { classification: "Journeyman", endDay: 12 });
    await labor.freezeRate(db(), ORG, id);

    const { rows } = await labor.week(owner(), { weekOf: MONDAY });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.totalHours).toBe("8.00");
  });
});

run("a supervisor signing off", () => {
  it("records who approved and when", async () => {
    // `approved_at` and `approved_by_user_id` were columns nothing wrote, so
    // a screen built on them showed one state forever.
    const id = await punch(5, 8, 16);
    const { approved } = await labor.approve(owner(), { entryIds: [id] });

    expect(approved).toBe(1);
    expect((await entryRow(id))[0]!.approved_at).not.toBeNull();
  });

  it("does not approve the same entry twice", async () => {
    const id = await punch(5, 8, 16);
    await labor.approve(owner(), { entryIds: [id] });
    expect((await labor.approve(owner(), { entryIds: [id] })).approved).toBe(0);
  });

  it("refuses to sign off on hours that have not finished happening", async () => {
    const [open] = await raw<{ id: string }[]>`insert into public.timeclock_entry
      (organization_id, technician_id, kind, started_at)
      values (${ORG}, ${technicianId}, 'on_site', ${at(5, 8)}) returning id`;

    await expect(labor.approve(owner(), { entryIds: [open!.id] }))
      .rejects.toThrow(/still running/i);
    expect((await entryRow(open!.id))[0]!.approved_at).toBeNull();
  });
});
