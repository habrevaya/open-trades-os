import { describe, it, expect } from "vitest";
import * as assets from "../src/assets/index.js";
import { nextOccurrence, type RecurrenceSpec } from "../src/recurrence/index.js";
import { money, toString as m } from "../src/money/index.js";

/**
 * FLEET, TOOLS AND COMPANY ASSETS
 *
 * Custody is a history and never a field. A time interval is a recurrence and
 * goes through the recurrence module. A meter interval is not a recurrence at
 * all and its answer is sometimes an honest refusal rather than a date.
 *
 * The fixtures below deliberately do not divide evenly and deliberately do not
 * move at a round rate. A cost per mile test where the money divides cleanly
 * by the mileage passes just as happily against an implementation that uses
 * floats, and a usage test where every reading gains the same amount passes
 * against one that never looks at the dates.
 */

const TODAY = "2026-09-23";
const usd = (v: string) => money(v, "USD");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const custody = (
  over: Partial<assets.CustodyAssignment> = {},
): assets.CustodyAssignment => ({
  assetId: "imager-1",
  custodianKind: "technician",
  custodianId: "tech-a",
  from: "2026-02-02",
  ...over,
});

/** Half open handover: tech-a until the 16th, tech-b from the 16th. */
const cleanHistory: assets.CustodyAssignment[] = [
  custody({ custodianId: "tech-a", from: "2026-02-02", until: "2026-03-16" }),
  custody({ custodianId: "tech-b", from: "2026-03-16" }),
];

const reading = (
  over: Partial<assets.MeterReading> & Pick<assets.MeterReading, "value" | "takenOn">,
): assets.MeterReading => ({
  assetId: "drill-7",
  unit: "hours",
  source: "technician",
  ...over,
});

/**
 * A core drill whose hour meter failed in May and was replaced. The machine
 * kept running the whole time: 812 to 977 on the old meter is 165 hours, and
 * the new gauge went on at zero and is up to 63, which is 63 more. 228 hours
 * of work, and not the negative number naive subtraction produces.
 *
 * The 14 on the new face on 8 June is the point of the fixture. It is real
 * work done after the swap, on a meter that started at zero, and a reset that
 * only credits the old gauge throws it away.
 */
const drillReadings: assets.MeterReading[] = [
  reading({ value: 812, takenOn: "2026-03-02" }),
  reading({ value: 878, takenOn: "2026-04-06" }),
  reading({ value: 941, takenOn: "2026-05-11" }),
  reading({
    value: 14,
    takenOn: "2026-06-08",
    reset: { previousFinalValue: 977, reason: "Hour meter failed, replaced under warranty" },
  }),
  reading({ value: 63, takenOn: "2026-07-13" }),
];

/** A boom lift read every fortnight, current as of two days ago. */
const liftReadings: assets.MeterReading[] = [
  reading({ assetId: "lift-2", value: 3112, takenOn: "2026-06-14" }),
  reading({ assetId: "lift-2", value: 3149, takenOn: "2026-06-29" }),
  reading({ assetId: "lift-2", value: 3181, takenOn: "2026-07-13" }),
  reading({ assetId: "lift-2", value: 3223, takenOn: "2026-07-27" }),
  reading({ assetId: "lift-2", value: 3258, takenOn: "2026-08-10" }),
  reading({ assetId: "lift-2", value: 3297, takenOn: "2026-08-24" }),
  reading({ assetId: "lift-2", value: 3334, takenOn: "2026-09-07" }),
  reading({ assetId: "lift-2", value: 3371, takenOn: "2026-09-21" }),
];

/** The same lift, but nobody has read it since the start of June. */
const staleLiftReadings: assets.MeterReading[] = [
  reading({ assetId: "lift-2", value: 2908, takenOn: "2026-03-09" }),
  reading({ assetId: "lift-2", value: 2961, takenOn: "2026-04-06" }),
  reading({ assetId: "lift-2", value: 3024, takenOn: "2026-05-04" }),
  reading({ assetId: "lift-2", value: 3088, takenOn: "2026-06-02" }),
];

const vanReadings: assets.MeterReading[] = [
  reading({ assetId: "van-4", unit: "miles", value: 41207, takenOn: "2026-01-05" }),
  reading({ assetId: "van-4", unit: "miles", value: 44913, takenOn: "2026-04-06" }),
  reading({ assetId: "van-4", unit: "miles", value: 48641, takenOn: "2026-07-06" }),
  reading({ assetId: "van-4", unit: "miles", value: 50486, takenOn: "2026-09-01" }),
  reading({ assetId: "van-4", unit: "miles", value: 51102, takenOn: "2026-09-21" }),
];

const vanCosts: assets.AssetCost[] = [
  { assetId: "van-4", kind: "acquisition", amount: usd("38500.00"), incurredOn: "2026-01-05" },
  { assetId: "van-4", kind: "fuel", amount: usd("1284.37"), incurredOn: "2026-02-11" },
  { assetId: "van-4", kind: "fuel", amount: usd("1391.08"), incurredOn: "2026-05-19" },
  { assetId: "van-4", kind: "maintenance", amount: usd("487.90"), incurredOn: "2026-06-02" },
  { assetId: "van-4", kind: "repair", amount: usd("2214.63"), incurredOn: "2026-08-07" },
  { assetId: "van-4", kind: "fuel", amount: usd("1102.55"), incurredOn: "2026-09-04" },
];

// ---------------------------------------------------------------------------
// 1. An asset and where it is
// ---------------------------------------------------------------------------

describe("an asset kind says what makes it different to manage", () => {
  it("gives every kind a label and a sentence a person would recognise", () => {
    for (const kind of assets.ASSET_KINDS) {
      const profile = assets.ASSET_KIND_PROFILES[kind];
      expect(profile.label.length, kind).toBeGreaterThan(0);
      expect(profile.distinguishedBy.length, kind).toBeGreaterThan(40);
    }
  });

  it("counts hand tools rather than serialising them, and serialises the rest", () => {
    // Serialising a screwdriver costs more than the screwdriver, and a
    // register that demands it is a register nobody fills in.
    expect(assets.ASSET_KIND_PROFILES.hand_tool.trackedIndividually).toBe(false);
    expect(assets.ASSET_KIND_PROFILES.instrument.trackedIndividually).toBe(true);
    expect(assets.ASSET_KIND_PROFILES.vehicle.trackedIndividually).toBe(true);
  });

  it("meters vehicles in miles and powered things in hours, and nothing else at all", () => {
    expect(assets.ASSET_KIND_PROFILES.vehicle.meter).toBe("miles");
    expect(assets.ASSET_KIND_PROFILES.equipment.meter).toBe("hours");
    expect(assets.ASSET_KIND_PROFILES.powered_tool.meter).toBe("hours");
    // A trailer has no engine, so its service interval can only ever be by
    // time. Offering it a meter interval would be offering a reading nobody
    // can take.
    expect(assets.ASSET_KIND_PROFILES.trailer.meter).toBeNull();
    expect(assets.ASSET_KIND_PROFILES.hand_tool.meter).toBeNull();
  });

  it("says which kinds sit with a PERSON and which sit in a PLACE", () => {
    /**
     * "Who has it" and "where is it" are different questions, and getting them
     * backwards is how a trailer ends up recorded as being in somebody's
     * pocket. Nothing in the module reads this field yet, so the policy is
     * pinned here rather than left as an unchecked note in a table.
     */
    expect(assets.ASSET_KIND_PROFILES.instrument.travelsWithATechnician).toBe(true);
    expect(assets.ASSET_KIND_PROFILES.powered_tool.travelsWithATechnician).toBe(true);
    expect(assets.ASSET_KIND_PROFILES.hand_tool.travelsWithATechnician).toBe(true);
    expect(assets.ASSET_KIND_PROFILES.trailer.travelsWithATechnician).toBe(false);
    expect(assets.ASSET_KIND_PROFILES.equipment.travelsWithATechnician).toBe(false);
  });

  it("asks an instrument for a calibration date and a van for a registration", () => {
    expect(assets.ASSET_KIND_PROFILES.instrument.obligations).toContain("calibration");
    expect(assets.ASSET_KIND_PROFILES.vehicle.obligations).toContain("registration");
    expect(assets.ASSET_KIND_PROFILES.hand_tool.obligations).toHaveLength(0);
  });
});

describe("custody is derived from the history, never stored", () => {
  it("names who has it today from an open assignment", () => {
    const at = assets.custodyAt(cleanHistory, TODAY);
    expect(at.ok).toBe(true);
    if (!at.ok || !at.held) throw new Error("expected somebody to hold it");
    expect(at.assignment.custodianId).toBe("tech-b");
  });

  it("puts the asset in exactly one place on the day of a handover", () => {
    /**
     * Half open, [from, until). The alternative double counts the handover
     * day, and a register that says two people had the imager on the 16th is
     * a register that cannot answer the only question it exists for.
     */
    const before = assets.custodyAt(cleanHistory, "2026-03-15");
    const day = assets.custodyAt(cleanHistory, "2026-03-16");
    if (!before.ok || !before.held) throw new Error("expected a holder");
    if (!day.ok || !day.held) throw new Error("expected a holder");
    expect(before.assignment.custodianId).toBe("tech-a");
    expect(day.assignment.custodianId).toBe("tech-b");
  });

  it("resolves the same answer from a history recorded out of order", () => {
    // Rows come back in whatever order the database felt like. The fold sorts.
    const shuffled = [cleanHistory[1]!, cleanHistory[0]!];
    const at = assets.custodyAt(shuffled, "2026-02-20");
    if (!at.ok || !at.held) throw new Error("expected a holder");
    expect(at.assignment.custodianId).toBe("tech-a");
  });

  it("refuses two overlapping assignments of one asset", () => {
    /**
     * THE CASE THIS EXISTS FOR. A technician hands a core drill to somebody on
     * site and mentions it to the office, and nobody closes the first
     * assignment. With a mutable holder field the second write silently wins
     * and the first custodian is forgotten.
     */
    const overlapping = [
      ...cleanHistory,
      custody({ custodianId: "tech-c", from: "2026-03-10", until: "2026-04-01" }),
    ];
    const checked = assets.checkCustodyHistory(overlapping);
    expect(checked.ok).toBe(false);
    if (checked.ok) throw new Error("expected a refusal");
    expect(checked.reason).toBe("custody_overlap");
    if (checked.reason !== "custody_overlap") throw new Error("wrong refusal");
    expect(checked.first.custodianId).toBe("tech-a");
    expect(checked.second.custodianId).toBe("tech-c");
    // The refusal has to name both sides, because the fix is closing one of
    // them on the day it really ended and you cannot do that from "invalid".
    expect(assets.explainRefusal(checked)).toContain("tech-c");
    expect(assets.explainRefusal(checked)).toContain("2026-03-10");
  });

  it("refuses two open assignments, which is how this really happens", () => {
    const twoOpen = [
      custody({ custodianId: "tech-a", from: "2026-02-02" }),
      custody({ custodianId: "tech-b", from: "2026-05-04" }),
    ];
    const checked = assets.checkCustodyHistory(twoOpen);
    expect(checked.ok).toBe(false);
    if (checked.ok) throw new Error("expected a refusal");
    expect(checked.reason).toBe("custody_overlap");
  });

  it("refuses an assignment that ends before it starts", () => {
    const backwards = [custody({ from: "2026-02-02", until: "2026-01-01" })];
    const checked = assets.checkCustodyHistory(backwards);
    if (checked.ok) throw new Error("expected a refusal");
    expect(checked.reason).toBe("custody_ends_before_it_starts");
  });

  it("refuses a history that mixes two assets, because they cannot share one", () => {
    const mixed = [custody({ until: "2026-03-16" }), custody({ assetId: "lift-2", from: "2026-04-01" })];
    const checked = assets.checkCustodyHistory(mixed);
    if (checked.ok) throw new Error("expected a refusal");
    expect(checked.reason).toBe("custody_history_mixes_assets");
  });

  it("allows a gap, because an asset really can sit in a yard unassigned", () => {
    /**
     * Refusing a gap would force people to invent a fake custodian, and an
     * invented custodian is worse than a truthful hole.
     */
    const gapped = [
      custody({ custodianId: "tech-a", from: "2026-02-02", until: "2026-03-16" }),
      custody({ custodianId: "tech-b", from: "2026-03-20" }),
    ];
    const at = assets.custodyAt(gapped, "2026-03-18");
    if (!at.ok) throw new Error("a gap is not a refusal");
    expect(at.held).toBe(false);
    if (at.held) throw new Error("expected nobody to hold it");
    expect(at.lastKnown?.custodianId).toBe("tech-a");
    expect(at.explanation).toContain("tech-a");
  });

  it("says nobody held it before the first assignment", () => {
    const at = assets.custodyAt(cleanHistory, "2026-01-01");
    if (!at.ok || at.held) throw new Error("expected nobody to hold it");
    expect(at.lastKnown).toBeNull();
  });

  it("lists what one technician is holding across every asset", () => {
    // The question asked on the day somebody resigns.
    const liftHistory = [
      custody({ assetId: "lift-2", custodianKind: "location", custodianId: "yard", from: "2026-01-02" }),
    ];
    const drillHistory = [
      custody({ assetId: "drill-7", custodianId: "tech-b", from: "2026-04-01" }),
    ];
    const held = assets.heldBy([cleanHistory, liftHistory, drillHistory], "technician", "tech-b", TODAY);
    expect(held.assetIds.sort()).toEqual(["drill-7", "imager-1"]);
    expect(held.refusals).toHaveLength(0);
  });

  it("does not count a job or a place as the technician of the same name", () => {
    /**
     * The id alone is not the answer. A job code and a technician id come from
     * different tables and can collide, and a match in the wrong column puts a
     * saw in somebody's hands on the day they resign when it is really sitting
     * on a job.
     */
    const jobHistory = [
      custody({ assetId: "saw-1", custodianKind: "job", custodianId: "tech-b", from: "2026-04-01" }),
    ];
    expect(assets.heldBy([jobHistory], "technician", "tech-b", TODAY).assetIds).toEqual([]);
    expect(assets.heldBy([jobHistory], "job", "tech-b", TODAY).assetIds).toEqual(["saw-1"]);
  });

  it("reports an incoherent history rather than quietly dropping the asset", () => {
    const broken = [...cleanHistory, custody({ custodianId: "tech-c", from: "2026-03-10", until: "2026-04-01" })];
    const held = assets.heldBy([broken], "technician", "tech-b", TODAY);
    expect(held.assetIds).toHaveLength(0);
    expect(held.refusals).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Meter readings
// ---------------------------------------------------------------------------

describe("meter readings are accepted or refused, never quietly fixed", () => {
  it("refuses a reading that goes backwards without a declared reset", () => {
    /**
     * A replaced hour meter is a real and ordinary event, and inferring it
     * from a decrease throws away every hour the machine already ran. So the
     * decrease is refused and the way through is to declare the replacement.
     */
    const outcome = assets.acceptReading(
      drillReadings.slice(0, 3),
      reading({ value: 14, takenOn: "2026-06-08" }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toBe("reading_goes_backwards");
    if (outcome.reason !== "reading_goes_backwards") throw new Error("wrong refusal");
    expect(outcome.previous).toBe(941);
    expect(outcome.found).toBe(14);
    // The refusal has to tell somebody which of the two buttons to press.
    expect(assets.explainRefusal(outcome)).toContain("declared reset");
  });

  it("accepts the same reading once the replacement is declared", () => {
    const outcome = assets.acceptReading(drillReadings.slice(0, 3), drillReadings[3]!);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected acceptance");
    // 941 to 977 on the old meter is 36, and the new gauge already shows 14
    // it ran from zero, so 50 hours passed between the two readings. Not 14
    // minus 941, and not 36 either.
    expect(outcome.unitsSincePrevious).toBe(50);
  });

  it("refuses a reset that claims the old meter ran backwards too", () => {
    const outcome = assets.acceptReading(
      drillReadings.slice(0, 3),
      reading({ value: 0, takenOn: "2026-06-08", reset: { previousFinalValue: 900, reason: "swapped" } }),
    );
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toBe("reset_rewinds_the_old_meter");
  });

  it("refuses an implausible jump, because a mistyped digit is invisible afterwards", () => {
    /**
     * 941 to 1600 in three days is 219 hours a day against 24 hours in a day.
     * Catching it at the keyboard is the only cheap moment: once it is in,
     * every later reading looks like it goes backwards and gets refused for
     * the wrong reason.
     */
    const outcome = assets.acceptReading(
      drillReadings.slice(0, 3),
      reading({ value: 1600, takenOn: "2026-05-14" }),
    );
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toBe("implausible_jump");
    if (outcome.reason !== "implausible_jump") throw new Error("wrong refusal");
    expect(outcome.gained).toBe(659);
    expect(outcome.maxPerDay).toBe(24);
  });

  it("accepts a hard but possible fortnight", () => {
    // 61 hours over 28 days is 2.2 a day. The ceiling must not be so tight
    // that a busy machine trips it, or people stop recording readings at all.
    const outcome = assets.acceptReading(
      drillReadings.slice(0, 3),
      reading({ value: 1002, takenOn: "2026-06-08" }),
    );
    expect(outcome.ok).toBe(true);
  });

  it("allows two readings on the same day one day of movement, not an infinite rate", () => {
    // A van read at the yard in the morning and at a supply house in the
    // afternoon is ordinary. Dividing by zero days is not.
    const sameDay = assets.acceptReading(
      [reading({ assetId: "van-4", unit: "miles", value: 41207, takenOn: "2026-01-05" })],
      reading({ assetId: "van-4", unit: "miles", value: 41290, takenOn: "2026-01-05" }),
    );
    expect(sameDay.ok).toBe(true);
    const absurd = assets.acceptReading(
      [reading({ assetId: "van-4", unit: "miles", value: 41207, takenOn: "2026-01-05" })],
      reading({ assetId: "van-4", unit: "miles", value: 44000, takenOn: "2026-01-05" }),
    );
    expect(absurd.ok).toBe(false);
  });

  it("lets a caller raise the ceiling for something that genuinely runs harder", () => {
    /**
     * 1,600 miles in a day is a mistyped digit on a service van and an
     * ordinary Tuesday on a truck driving a storm response two states over. A
     * ceiling with no way round it is a ceiling people learn to route around
     * by not recording the reading at all.
     */
    const before = reading({ assetId: "van-4", unit: "miles", value: 41207, takenOn: "2026-01-05" });
    const after = reading({ assetId: "van-4", unit: "miles", value: 42807, takenOn: "2026-01-06" });
    const atDefault = assets.acceptReading([before], after);
    if (atDefault.ok) throw new Error("expected a refusal at the default ceiling");
    expect(atDefault.reason).toBe("implausible_jump");
    if (atDefault.reason !== "implausible_jump") throw new Error("x");
    expect(atDefault.maxPerDay).toBe(1200);

    const raised = assets.acceptReading([before], after, { maxPerDay: 1800 });
    expect(raised.ok).toBe(true);
    if (!raised.ok) throw new Error("expected acceptance");
    expect(raised.unitsSincePrevious).toBe(1600);
  });

  it("refuses a reading that arrives out of order", () => {
    const outcome = assets.acceptReading(drillReadings.slice(0, 3), reading({ value: 950, takenOn: "2026-04-20" }));
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toBe("reading_out_of_order");
  });

  it("refuses a fraction, a negative, a future date and the wrong unit", () => {
    const fraction = assets.acceptReading([], reading({ value: 812.5, takenOn: "2026-03-02" }));
    const negative = assets.acceptReading([], reading({ value: -3, takenOn: "2026-03-02" }));
    const future = assets.acceptReading([], reading({ value: 812, takenOn: "2026-12-01" }), { now: TODAY });
    const unit = assets.acceptReading(
      drillReadings.slice(0, 3),
      reading({ value: 1000, takenOn: "2026-06-08", unit: "miles" }),
    );
    expect(fraction.ok).toBe(false);
    expect(negative.ok).toBe(false);
    expect(future.ok).toBe(false);
    expect(unit.ok).toBe(false);
    if (fraction.ok) throw new Error("x");
    expect(fraction.reason).toBe("reading_not_a_whole_number");
    if (unit.ok) throw new Error("x");
    expect(unit.reason).toBe("reading_unit_mismatch");
  });

  it("accepts the whole drill history including the replacement", () => {
    const validated = assets.validateReadings(drillReadings, { now: TODAY });
    expect(validated.ok).toBe(true);
  });
});

describe("usage across a declared meter reset", () => {
  it("counts the hours run on both meters as one number", () => {
    /**
     * 812 to 977 on the old meter is 165, and the new one went on at zero and
     * is up to 63. The machine did 228 hours of work. Naive subtraction across
     * the swap produces a large negative, which is not a smaller number, it is
     * a different sign, and it silently restarts every interval on the asset.
     * Crediting only the old gauge is quieter and almost as wrong: it loses
     * every hour the new one ran before anybody wrote it down.
     */
    const usage = assets.usageBetween(drillReadings, "2026-03-02", "2026-07-13");
    expect(usage.ok).toBe(true);
    if (!usage.ok) throw new Error("expected usage");
    expect(usage.units).toBe(228);
    expect(usage.crossedAReset).toBe(true);
    expect(usage.readingsUsed).toBe(5);
    expect(usage.observedDays).toBe(133);
  });

  it("stops at the reading the window ends on, old gauge and new one together", () => {
    const usage = assets.usageBetween(drillReadings, "2026-03-02", "2026-06-08");
    if (!usage.ok) throw new Error("expected usage");
    // 812 to 977 on the old gauge is 165, and the new face already reads 14,
    // so 179. Nothing after 8 June is counted, because no reading covers it.
    expect(usage.units).toBe(179);
  });

  it("keeps the hours the new meter put on its own face before anybody read it", () => {
    /**
     * THE HALF OF THE SWAP THAT GOES MISSING QUIETLY. The gauge is pulled in
     * May and nobody reads the replacement until August, by which time it
     * shows 400. Crediting only the 36 the old meter gained before it went
     * loses those 400 hours for good: the 250 hour service restarts, the cost
     * per hour halves, and no number in the system contradicts any other.
     * Continuity across a swap has to hold on both sides of it.
     */
    const swapped: assets.MeterReading[] = [
      reading({ value: 941, takenOn: "2026-05-11" }),
      reading({
        value: 400,
        takenOn: "2026-08-08",
        reset: { previousFinalValue: 977, reason: "Gauge pulled in May, replacement first read in August" },
      }),
    ];
    const usage = assets.usageBetween(swapped, "2026-01-01", "2026-12-31");
    if (!usage.ok) throw new Error("expected usage");
    // 36 on the old meter, 400 on the new one from zero.
    expect(usage.units).toBe(436);
    const accepted = assets.acceptReading([swapped[0]!], swapped[1]!);
    if (!accepted.ok) throw new Error("expected acceptance");
    expect(accepted.unitsSincePrevious).toBe(436);
  });

  it("does not call a window that begins on the new meter a crossing", () => {
    // The swap is not INSIDE this window: the earliest reading in it is
    // already off the new face. Flagging a crossing here puts a caveat on a
    // number the replacement had nothing to do with, and a caveat that fires
    // when it need not is a caveat people stop reading.
    const after = assets.usageBetween(drillReadings, "2026-06-08", "2026-07-13");
    if (!after.ok) throw new Error("expected usage");
    expect(after.crossedAReset).toBe(false);
    expect(after.units).toBe(49);
  });

  it("reports the span the readings actually cover, not the span asked for", () => {
    /**
     * Pretending a window with one reading near the end covers the whole
     * period is how a cost per hour comes out four times too high.
     */
    const usage = assets.usageBetween(drillReadings, "2026-01-01", "2026-12-31");
    if (!usage.ok) throw new Error("expected usage");
    expect(usage.observedDays).toBe(133);
    expect(usage.from.takenOn).toBe("2026-03-02");
    expect(usage.to.takenOn).toBe("2026-07-13");
  });

  it("refuses to call one reading usage, and refuses to call no readings zero", () => {
    const one = assets.usageBetween(drillReadings, "2026-03-02", "2026-03-20");
    const none = assets.usageBetween(drillReadings, "2026-01-01", "2026-02-01");
    if (one.ok || none.ok) throw new Error("expected refusals");
    expect(one.reason).toBe("not_enough_readings");
    expect(none.reason).toBe("not_enough_readings");
    if (one.reason !== "not_enough_readings") throw new Error("x");
    expect(one.found).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Maintenance that is due
// ---------------------------------------------------------------------------

describe("a time interval goes through the recurrence module", () => {
  /**
   * Not reimplemented here, and the test is built so that a reimplementation
   * cannot pass it. A seasonal anchor and a moved occurrence are both things
   * only the recurrence module knows about; counting days forward from the
   * last service produces neither.
   */
  const seasonal: RecurrenceSpec = {
    model: "rule",
    startsOn: "2025-01-01",
    anchorMonths: [4, 10],
    anchorDay: 12,
    exceptions: [{ date: "2026-10-12", action: "moved", movedTo: "2026-10-26" }],
  };

  const plan = (over: Partial<assets.MaintenancePlan> = {}): assets.MaintenancePlan => ({
    assetId: "gen-9",
    taskId: "annual",
    label: "Seasonal service",
    interval: { basis: "time", spec: seasonal },
    lastServicedOn: "2026-04-14",
    ...over,
  });

  it("pins the service to its anchor month rather than counting days forward", () => {
    // A generator serviced before storm season is serviced in October whoever
    // bought it in March. Counting 182 days from a service done on 14 April
    // gives 13 October, which is a different answer from a different rule.
    const status = assets.maintenanceDue(plan(), [], TODAY);
    expect(status.basis).toBe("time");
    if (status.basis !== "time" || status.state !== "scheduled") throw new Error("expected a date");
    expect(status.dueOn).toBe("2026-10-26");
    expect(status.dueOn).toBe(nextOccurrence(seasonal, "2026-04-14"));
    expect(status.daysUntilDue).toBe(33);
    expect(status.overdue).toBe(false);
  });

  it("honours an exception, because a moved visit was a decision somebody made", () => {
    const skipped: RecurrenceSpec = {
      ...seasonal,
      exceptions: [{ date: "2026-10-12", action: "skipped", reason: "Site shut" }],
    };
    const status = assets.maintenanceDue(plan({ interval: { basis: "time", spec: skipped } }), [], TODAY);
    if (status.basis !== "time" || status.state !== "scheduled") throw new Error("expected a date");
    expect(status.dueOn).toBe("2027-04-12");
  });

  it("counts from when the service actually happened, not from when it was booked", () => {
    const anchored: RecurrenceSpec = { model: "anchored_to_completion", startsOn: "2026-01-01", intervalDays: 182 };
    const onTime = assets.maintenanceDue(
      plan({ interval: { basis: "time", spec: anchored }, lastServicedOn: "2026-01-20" }),
      [],
      TODAY,
    );
    const late = assets.maintenanceDue(
      plan({ interval: { basis: "time", spec: anchored }, lastServicedOn: "2026-02-10" }),
      [],
      TODAY,
    );
    if (onTime.state !== "scheduled" || late.state !== "scheduled") throw new Error("expected dates");
    expect(onTime.dueOn).toBe("2026-07-21");
    // Serviced three weeks late, so the next one is three weeks later. The van
    // does not spend the rest of its life out of step.
    expect(late.dueOn).toBe("2026-08-11");
  });

  it("shows an overdue service rather than skipping silently to the next one", () => {
    /**
     * The single most expensive way to be wrong here. Asking the recurrence
     * from TODAY returns the next occurrence and hides the missed one
     * completely: the screen is calm and the compressor is not.
     */
    const anchored: RecurrenceSpec = { model: "anchored_to_completion", startsOn: "2026-01-01", intervalDays: 182 };
    const status = assets.maintenanceDue(
      plan({ interval: { basis: "time", spec: anchored }, lastServicedOn: "2026-01-20" }),
      [],
      TODAY,
    );
    if (status.state !== "scheduled") throw new Error("expected a date");
    expect(status.overdue).toBe(true);
    expect(status.daysUntilDue).toBe(-64);
  });

  it("says so when the schedule has ended instead of inventing a date", () => {
    const ended: RecurrenceSpec = {
      model: "rule",
      startsOn: "2024-01-15",
      intervalDays: 90,
      endsOn: "2025-06-30",
    };
    const status = assets.maintenanceDue(
      plan({ interval: { basis: "time", spec: ended }, lastServicedOn: "2025-06-20" }),
      [],
      TODAY,
    );
    expect(status.state).toBe("no_further_service_due");
  });
});

describe("a meter interval is projected, and says it is a projection", () => {
  const liftPlan = (everyUnits: number, over: Partial<assets.MaintenancePlan> = {}): assets.MaintenancePlan => ({
    assetId: "lift-2",
    taskId: "hydraulic",
    label: "Hydraulic service",
    interval: { basis: "meter", unit: "hours", everyUnits },
    lastServicedOn: "2026-06-15",
    ...over,
  });

  it("projects a due date from the recent rate of use and attaches its provenance", () => {
    const status = assets.maintenanceDue(liftPlan(400), liftReadings, TODAY);
    expect(status.basis).toBe("meter");
    if (status.basis !== "meter" || status.state !== "projected") throw new Error("expected a projection");
    // 3112 at the service, 3371 now, so 259 of the 400 hours are gone.
    expect(status.unitsRemaining).toBe(141);
    expect(status.readingsUsed).toBe(7);
    expect(status.observedDays).toBe(84);
    expect(status.dueOn).toBe("2026-11-16");
    // 84 days and 7 readings is a fair basis, not a good one, and the screen
    // has to be able to say which.
    expect(status.confidence).toBe("fair");
    expect(status.caveat).toContain("projection, not a schedule");
  });

  it("uses the recent window rather than the whole life of the machine", () => {
    /**
     * A rate averaged over everything tells you about last year. The lift did
     * 222 hours in the last 84 days, and only the readings inside the window
     * are allowed to set the rate.
     */
    const status = assets.maintenanceDue(liftPlan(400), liftReadings, TODAY, { rateWindowDays: 30 });
    if (status.basis !== "meter" || status.state !== "projected") throw new Error("expected a projection");
    expect(status.readingsUsed).toBe(3);
    expect(status.observedDays).toBe(28);
    expect(status.confidence).toBe("weak");
  });

  it("says a service is due now from the meter rather than projecting a date", () => {
    // Not a projection: 259 hours against an interval of 250, and the meter
    // already says so.
    const status = assets.maintenanceDue(liftPlan(250), liftReadings, TODAY);
    if (status.basis !== "meter" || status.state !== "due_now") throw new Error("expected due now");
    expect(status.usedSinceService).toBe(259);
    expect(status.unitsOverdue).toBe(9);
  });

  it("measures usage since the service across a meter replacement", () => {
    /**
     * The reason the plan stores a DATE rather than a last service reading. A
     * stored reading of 4,812 is meaningless the moment the meter is replaced
     * and the new face reads 14.
     */
    const status = assets.maintenanceDue(
      {
        assetId: "drill-7",
        taskId: "brushes",
        label: "Brush change",
        interval: { basis: "meter", unit: "hours", everyUnits: 300 },
        lastServicedOn: "2026-04-06",
      },
      drillReadings,
      "2026-07-20",
    );
    if (status.basis !== "meter") throw new Error("expected a meter answer");
    // 878 to 977 on the old gauge is 99, and the new one has run 63 from zero,
    // so 162 hours since the service and 138 of the 300 left.
    if (status.state !== "projected") throw new Error("expected a projection");
    expect(status.unitsRemaining).toBe(138);
  });
});

describe("a projection refuses to guess when the readings will not carry it", () => {
  const stalePlan: assets.MaintenancePlan = {
    assetId: "lift-2",
    taskId: "hydraulic",
    label: "Hydraulic service",
    interval: { basis: "meter", unit: "hours", everyUnits: 400 },
    lastServicedOn: "2026-03-09",
  };

  it("refuses to project from readings that stopped months ago", () => {
    /**
     * THE CASE THIS SECTION EXISTS FOR. An asset with no readings since June
     * is not an asset with a known rate of use, it is an asset nobody has
     * looked at. "Service due 14 March" reads identically whether it came from
     * telematics yesterday or from a technician in the spring, and only one of
     * those is worth acting on.
     */
    const status = assets.maintenanceDue(stalePlan, staleLiftReadings, TODAY);
    if (status.basis !== "meter" || status.state !== "cannot_project") throw new Error("expected a refusal to project");
    expect(status.reason).toBe("stale_readings");
    expect(status.explanation).toContain("113 days ago");
    expect(status.explanation).toContain("2026-06-02");
  });

  it("projects from the same readings when they are current", () => {
    // The guard has to be about the AGE of the readings and nothing else, or
    // it is a guard that also blocks the working case.
    const status = assets.maintenanceDue(stalePlan, staleLiftReadings, "2026-06-20");
    if (status.basis !== "meter") throw new Error("expected a meter answer");
    expect(status.state).toBe("projected");
  });

  it("says nothing at all about an asset with no readings", () => {
    const status = assets.maintenanceDue(stalePlan, [], TODAY);
    if (status.basis !== "meter" || status.state !== "cannot_project") throw new Error("expected a refusal");
    expect(status.reason).toBe("no_readings");
    expect(status.unitsRemaining).toBeNull();
  });

  it("refuses a rate built from one reading, or from nine days of them", () => {
    const justServiced = { ...stalePlan, lastServicedOn: "2026-06-02" };
    const single = assets.maintenanceDue(justServiced, [staleLiftReadings[3]!], "2026-06-20");
    if (single.basis !== "meter" || single.state !== "cannot_project") throw new Error("expected a refusal");
    expect(single.reason).toBe("not_enough_history");
    // It still knows how much of the interval is left, and says so, because
    // that is useful even when the date is not knowable.
    expect(single.unitsRemaining).toBe(400);

    const nineDays = assets.maintenanceDue(
      justServiced,
      [staleLiftReadings[3]!, reading({ assetId: "lift-2", value: 3105, takenOn: "2026-06-11" })],
      "2026-06-20",
    );
    if (nineDays.basis !== "meter" || nineDays.state !== "cannot_project") throw new Error("expected a refusal");
    // Two readings nine days apart is noise, not a rate, and 17 hours in a
    // fortnight extrapolates to anything you like.
    expect(nineDays.reason).toBe("not_enough_history");
    expect(nineDays.unitsRemaining).toBe(383);
  });

  it("says how thin the evidence was when it refuses one reading", () => {
    /**
     * Not a second way of asking the question above. A lone reading is refused
     * whatever the caller sets the minimum span to, because one reading in the
     * window is always the latest one and therefore spans zero days. What this
     * pins is the SENTENCE: a refusal that says only "not enough" sends
     * somebody to stare at a screen, and "1 reading over 0 days" tells them to
     * go and take another one.
     */
    const single = assets.maintenanceDue(
      { ...stalePlan, lastServicedOn: "2026-06-02" },
      [staleLiftReadings[3]!],
      "2026-06-20",
      { minimumObservationDays: 0 },
    );
    if (single.basis !== "meter" || single.state !== "cannot_project") throw new Error("expected a refusal");
    expect(single.reason).toBe("not_enough_history");
    expect(single.explanation).toContain("1 reading(s) over 0 day(s)");
    expect(single.unitsRemaining).toBe(400);
  });

  it("refuses a span of zero days rather than dividing by it", () => {
    /**
     * Two readings taken the same morning span no days, and
     * minimumObservationDays belongs to the caller, who may set it to zero.
     * Twelve hours over zero days is Infinity, which the rate-of-zero guard
     * below does not catch, and would be published as a projection due today
     * at a rate of Infinity a day. Zero hours over zero days is NaN, which
     * reaches addDays and throws RangeError straight out of a function whose
     * whole contract is that it answers or refuses.
     */
    const moved: assets.MeterReading[] = [
      reading({ assetId: "lift-2", value: 3088, takenOn: "2026-06-02" }),
      reading({ assetId: "lift-2", value: 3100, takenOn: "2026-06-02" }),
    ];
    const status = assets.maintenanceDue(
      { ...stalePlan, lastServicedOn: "2026-06-02" },
      moved,
      "2026-06-20",
      { minimumObservationDays: 0 },
    );
    if (status.basis !== "meter" || status.state !== "cannot_project") throw new Error("expected a refusal");
    expect(status.reason).toBe("not_enough_history");

    const motionless: assets.MeterReading[] = [
      reading({ assetId: "lift-2", value: 3088, takenOn: "2026-06-02" }),
      reading({ assetId: "lift-2", value: 3088, takenOn: "2026-06-02" }),
    ];
    expect(() =>
      assets.maintenanceDue(
        { ...stalePlan, lastServicedOn: "2026-06-02" },
        motionless,
        "2026-06-20",
        { minimumObservationDays: 0 },
      ),
    ).not.toThrow();
  });

  it("refuses to divide by a rate of zero when the machine has not moved", () => {
    const idle: assets.MeterReading[] = [
      reading({ assetId: "lift-2", value: 3371, takenOn: "2026-08-10" }),
      reading({ assetId: "lift-2", value: 3371, takenOn: "2026-09-07" }),
      reading({ assetId: "lift-2", value: 3371, takenOn: "2026-09-21" }),
    ];
    const status = assets.maintenanceDue(
      { ...stalePlan, lastServicedOn: "2026-08-10" },
      idle,
      TODAY,
    );
    if (status.basis !== "meter" || status.state !== "cannot_project") throw new Error("expected a refusal");
    expect(status.reason).toBe("no_use_observed");
    expect(status.unitsRemaining).toBe(400);
  });

  it("refuses when nobody read the meter anywhere near the service", () => {
    /**
     * Without a reading from around the service there is no way to know how
     * much of the interval has been used up, and guessing from the earliest
     * reading available under counts it in the dangerous direction.
     */
    const status = assets.maintenanceDue({ ...stalePlan, lastServicedOn: "2026-01-04" }, liftReadings, TODAY);
    if (status.basis !== "meter" || status.state !== "cannot_project") throw new Error("expected a refusal");
    expect(status.reason).toBe("no_reading_at_service");
  });

  it("accepts a reading taken a few days after the service as the baseline", () => {
    // An asset serviced on Friday and read on Monday is the ordinary case, and
    // refusing it would make the feature unusable.
    const status = assets.maintenanceDue({ ...stalePlan, lastServicedOn: "2026-06-10" }, liftReadings, TODAY);
    if (status.basis !== "meter") throw new Error("expected a meter answer");
    expect(status.state).toBe("projected");
  });

  it("will not put a date on a machine that is barely moving", () => {
    const crawling: assets.MeterReading[] = [
      reading({ assetId: "lift-2", value: 3371, takenOn: "2026-06-29" }),
      reading({ assetId: "lift-2", value: 3372, takenOn: "2026-08-10" }),
      reading({ assetId: "lift-2", value: 3373, takenOn: "2026-09-21" }),
    ];
    const status = assets.maintenanceDue(
      { ...stalePlan, lastServicedOn: "2026-06-29" },
      crawling,
      TODAY,
    );
    if (status.basis !== "meter" || status.state !== "cannot_project") throw new Error("expected a refusal");
    // At two hours in eighty four days, the 400 hour service is decades out.
    // That is arithmetic, not information.
    expect(status.reason).toBe("projection_beyond_horizon");
  });
});

// ---------------------------------------------------------------------------
// 4. What an asset costs to keep
// ---------------------------------------------------------------------------

describe("what an asset costs to keep", () => {
  it("keeps the purchase out of the running cost", () => {
    /**
     * Folding the two together makes the month a van was bought look like the
     * most expensive month of its life and every month after it look free, and
     * no comparison between two vans survives that.
     */
    const summary = assets.costsOverPeriod(vanCosts, "2026-01-01", "2026-09-21");
    expect(m(summary.total)).toBe("44980.5300");
    expect(m(summary.acquisition)).toBe("38500.0000");
    expect(m(summary.runningTotal)).toBe("6480.5300");
    expect(m(summary.byKind.fuel)).toBe("3778.0000");
    expect(m(summary.byKind.repair)).toBe("2214.6300");
    expect(m(summary.byKind.storage)).toBe("0.0000");
  });

  it("only counts what was incurred inside the window", () => {
    const summary = assets.costsOverPeriod(vanCosts, "2026-06-01", "2026-08-31");
    expect(m(summary.runningTotal)).toBe("2702.5300");
  });

  it("divides money by an integer count of units and never by a float rate", () => {
    const outcome = assets.costPerUnitOfUse({
      assetId: "van-4",
      costs: vanCosts,
      readings: vanReadings,
      from: "2026-01-01",
      to: "2026-09-21",
    });
    if (!outcome.ok) throw new Error("expected a number");
    expect(outcome.units).toBe(9895);
    expect(m(outcome.cost)).toBe("6480.5300");
    // 6480.53 over 9895 miles does not divide evenly, which is the point.
    expect(m(outcome.perUnit)).toBe("0.6549");
    expect(outcome.observedDays).toBe(259);
    expect(outcome.reliable).toBe(true);
    expect(outcome.caveat).toBeNull();
  });

  it("flags a cost per mile built on three weeks as a number nobody should act on", () => {
    /**
     * The same van, same odometer, same fuel card. Over nine months it costs
     * 65 cents a mile. Over the three weeks around one fuel bill it costs
     * 1.79, and the difference is not the van, it is the window. Tyres,
     * brakes and the one big repair arrive months apart.
     */
    const short = assets.costPerUnitOfUse({
      assetId: "van-4",
      costs: vanCosts,
      readings: vanReadings,
      from: "2026-09-01",
      to: "2026-09-21",
    });
    if (!short.ok) throw new Error("expected a number");
    expect(short.units).toBe(616);
    expect(short.observedDays).toBe(20);
    expect(m(short.perUnit)).toBe("1.7899");
    expect(short.reliable).toBe(false);
    expect(short.caveat).toContain("20 days");
  });

  it("refuses a cost per hour when nothing has been used, rather than reporting zero", () => {
    /**
     * THE DIVISION BY ZERO. Zero reads as "this asset is free", so the
     * cheapest thing in the fleet becomes the one nobody is reading the meter
     * on, which is the exact opposite of the truth and the kind of wrong that
     * gets acted on.
     */
    const idle: assets.MeterReading[] = [
      reading({ assetId: "chipper-3", value: 400, takenOn: "2026-01-05" }),
      reading({ assetId: "chipper-3", value: 400, takenOn: "2026-06-06" }),
    ];
    const costs: assets.AssetCost[] = [
      { assetId: "chipper-3", kind: "insurance", amount: usd("418.60"), incurredOn: "2026-02-01" },
      { assetId: "chipper-3", kind: "storage", amount: usd("291.75"), incurredOn: "2026-03-01" },
    ];
    const outcome = assets.costPerUnitOfUse({
      assetId: "chipper-3",
      costs,
      readings: idle,
      from: "2026-01-01",
      to: "2026-06-30",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toBe("no_recorded_use");
    if (outcome.reason !== "no_recorded_use") throw new Error("x");
    expect(outcome.unit).toBe("hours");
    const words = assets.explainRefusal(outcome);
    expect(words).toContain("division by zero");
    // An idle asset still costs money to keep, so the sentence has to point
    // somewhere rather than just saying no.
    expect(outcome.detail).toContain("standing cost");
  });

  it("refuses when there are not two readings to make a difference out of", () => {
    const outcome = assets.costPerUnitOfUse({
      assetId: "van-4",
      costs: vanCosts,
      readings: vanReadings,
      from: "2026-09-10",
      to: "2026-09-30",
    });
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toBe("no_recorded_use");
    if (outcome.reason !== "no_recorded_use") throw new Error("x");
    expect(outcome.unit).toBe("miles");
    expect(outcome.detail).toContain("difference between two readings");
  });

  it("can include the purchase when the question is total cost of ownership", () => {
    const outcome = assets.costPerUnitOfUse({
      assetId: "van-4",
      costs: vanCosts,
      readings: vanReadings,
      from: "2026-01-01",
      to: "2026-09-21",
      includeAcquisition: true,
    });
    if (!outcome.ok) throw new Error("expected a number");
    expect(m(outcome.cost)).toBe("44980.5300");
    expect(m(outcome.perUnit)).toBe("4.5458");
  });
});

// ---------------------------------------------------------------------------
// 5. Compliance dates
// ---------------------------------------------------------------------------

describe("compliance dates, in the order somebody has to deal with them", () => {
  const obligations: assets.ComplianceObligation[] = [
    { assetId: "van-4", kind: "registration", expiresOn: "2026-11-10", reference: "TX plate" },
    { assetId: "van-4", kind: "inspection", expiresOn: "2026-11-14" },
    { assetId: "imager-1", kind: "calibration", expiresOn: "2026-11-20", lastCertifiedOn: "2025-11-20" },
  ];

  it("orders by when action is needed, not by when things expire", () => {
    /**
     * A calibration that needs six weeks of notice and expires on the 20th is
     * more urgent than a registration that needs thirty days and expires on
     * the 10th. A list sorted by expiry puts them the other way round and the
     * instrument goes out of certificate while the screen looked calm.
     */
    const outlook = assets.complianceOutlook(obligations, TODAY);
    expect(outlook.map((a) => a.obligation.kind)).toEqual(["calibration", "registration", "inspection"]);
    expect(outlook.map((a) => a.obligation.expiresOn)).toEqual(["2026-11-20", "2026-11-10", "2026-11-14"]);
  });

  it("pulls a deadline landing on a weekend back to the Friday, never forward", () => {
    /**
     * Thirty days before 10 November is Sunday 11 October, and the county
     * office is shut. Rolling forward to Monday is renewing it after the
     * warning window closed, and the van is off the road either way.
     */
    const outlook = assets.complianceOutlook(obligations, TODAY);
    const registration = outlook.find((a) => a.obligation.kind === "registration")!;
    expect(registration.actBy).toBe("2026-10-09");
    expect(registration.actBy < "2026-10-11").toBe(true);
    expect(registration.movedOffAWeekend).toBe(true);
  });

  it("makes the last usable day the Friday when the certificate expires on a Saturday", () => {
    // An inspection expiring on Saturday 14 November cannot be renewed on the
    // 14th. Friday the 13th is the last day the van can leave the yard legally
    // and the last day anybody can do anything about it.
    const outlook = assets.complianceOutlook(obligations, TODAY);
    const inspection = outlook.find((a) => a.obligation.kind === "inspection")!;
    expect(inspection.obligation.expiresOn).toBe("2026-11-14");
    expect(inspection.lastUsableDay).toBe("2026-11-13");
    expect(inspection.movedOffAWeekend).toBe(true);
    // Its warning date is a Thursday, so nothing moved on that side.
    expect(inspection.actBy).toBe("2026-10-15");
  });

  it("leaves a deadline alone when it already lands on a working day", () => {
    // The shift must be conditional. A rule that always steps back is a rule
    // that loses a day every time it runs.
    const outlook = assets.complianceOutlook(obligations, TODAY);
    const calibration = outlook.find((a) => a.obligation.kind === "calibration")!;
    expect(calibration.actBy).toBe("2026-10-06");
    expect(calibration.lastUsableDay).toBe("2026-11-20");
    expect(calibration.movedOffAWeekend).toBe(false);
  });

  it("keeps the whole weekend out of both dates for every obligation", () => {
    const everyDay = Array.from({ length: 40 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`)
      .filter((d) => d <= "2026-11-30")
      .map((expiresOn): assets.ComplianceObligation => ({ assetId: "van-4", kind: "inspection", expiresOn }));
    for (const alert of assets.complianceOutlook(everyDay, TODAY)) {
      expect([1, 2, 3, 4, 5], alert.obligation.expiresOn).toContain(
        new Date(`${alert.actBy}T00:00:00Z`).getUTCDay(),
      );
      expect([1, 2, 3, 4, 5], alert.obligation.expiresOn).toContain(
        new Date(`${alert.lastUsableDay}T00:00:00Z`).getUTCDay(),
      );
      expect(alert.lastUsableDay <= alert.obligation.expiresOn).toBe(true);
    }
  });

  it("says a van with an expired inspection cannot leave the yard", () => {
    const expired = assets.complianceOutlook(
      [{ assetId: "van-4", kind: "inspection", expiresOn: "2026-08-31" }],
      TODAY,
    )[0]!;
    expect(expired.status).toBe("expired");
    expect(expired.daysUntilExpiry).toBe(-23);
    expect(expired.groundsTheAsset).toBe(true);
    expect(assets.explainAlert(expired)).toContain("cannot be used");
  });

  it("names the work put in doubt by a lapsed calibration", () => {
    /**
     * THE EXPENSIVE CASE NOBODY THINKS ABOUT. The other three expiries stop
     * something happening tomorrow. This one reaches backwards: the instrument
     * did not start drifting on the day the certificate lapsed, so every
     * report it produced since the last good calibration is open to challenge,
     * and those are the ones that went to insurers and into warranty claims.
     */
    const lapsed = assets.complianceOutlook(
      [{ assetId: "imager-1", kind: "calibration", expiresOn: "2026-02-28", lastCertifiedOn: "2025-02-20" }],
      TODAY,
    )[0]!;
    expect(lapsed.status).toBe("expired");
    expect(lapsed.workAtRiskSince).toBe("2025-02-20");
    // Not grounded: the imager still switches on, which is exactly why this
    // one gets missed.
    expect(lapsed.groundsTheAsset).toBe(false);
    expect(assets.explainAlert(lapsed)).toContain("2025-02-20");
    expect(assets.explainAlert(lapsed)).toContain("open to challenge");
  });

  it("does not put work at risk for an expiry that only looks forward", () => {
    const expired = assets.complianceOutlook(
      [{ assetId: "van-4", kind: "registration", expiresOn: "2026-08-31", lastCertifiedOn: "2025-08-31" }],
      TODAY,
    )[0]!;
    expect(expired.workAtRiskSince).toBeUndefined();
    expect(assets.COMPLIANCE.calibration.invalidatesPastWork).toBe(true);
    expect(assets.COMPLIANCE.registration.invalidatesPastWork).toBe(false);
  });

  it("moves from clear to act now as the warning window opens", () => {
    const far = assets.complianceOutlook(obligations, "2026-01-05");
    const near = assets.complianceOutlook(obligations, "2026-10-12");
    expect(far.every((a) => a.status === "clear")).toBe(true);
    expect(near.find((a) => a.obligation.kind === "registration")!.status).toBe("act_now");
    expect(near.find((a) => a.obligation.kind === "inspection")!.status).toBe("upcoming");
  });

  it("lets the caller say how far ahead counts as upcoming", () => {
    // Forty eight days out. A board that looks two months ahead should show
    // it; one that looks a month ahead should not, and neither of them is the
    // wrong answer, so the window is the caller's to set.
    const one: assets.ComplianceObligation[] = [{ assetId: "van-4", kind: "registration", expiresOn: "2026-11-10" }];
    expect(assets.complianceOutlook(one, TODAY, { lookaheadDays: 30 })[0]!.status).toBe("clear");
    expect(assets.complianceOutlook(one, TODAY, { lookaheadDays: 60 })[0]!.status).toBe("upcoming");
    expect(assets.complianceOutlook(one, TODAY)[0]!.daysUntilExpiry).toBe(48);
  });

  it("names the obligations an asset should have on file and does not", () => {
    /**
     * A van with an EXPIRED inspection is loud. A van with NO inspection
     * record is silent, and it is the same van in the same yard with the same
     * problem.
     */
    expect(assets.missingObligations("vehicle", obligations.filter((o) => o.assetId === "van-4")))
      .toEqual(["insurance"]);
    expect(assets.missingObligations("vehicle", [])).toEqual(["registration", "inspection", "insurance"]);
    expect(assets.missingObligations("instrument", [])).toEqual(["calibration"]);
    expect(assets.missingObligations("hand_tool", [])).toEqual([]);
  });

  it("describes every obligation, because the screen has to name them", () => {
    for (const kind of Object.keys(assets.COMPLIANCE) as assets.ComplianceKind[]) {
      expect(assets.COMPLIANCE[kind].label.length, kind).toBeGreaterThan(0);
      expect(assets.COMPLIANCE[kind].description.length, kind).toBeGreaterThan(20);
      expect(assets.COMPLIANCE[kind].warningDays, kind).toBeGreaterThan(0);
    }
  });
});
