import { describe, it, expect } from "vitest";
import * as project from "../src/project/index.js";

/**
 * M12. THE DAYS A CHANGE ORDER ADDS, AND WHO IS BOOKED TWICE.
 *
 * Both are read by somebody deciding what to do with the schedule, so each
 * figure is worked out by hand in the comment beside it.
 */

const phase = (
  id: string, startsOn: string | null, endsOn: string | null,
  dependsOnPhaseId: string | null = null,
  status: project.PhaseStatus = "not_started",
): project.PlannedPhase => ({
  id, name: id, sequence: id.charCodeAt(0), dependsOnPhaseId, startsOn, endsOn, status,
});

describe("the days a change order adds", () => {
  /**
   *   rough    Nov 2 to 6    (5 days)
   *   close    Nov 9 to 12   waits for rough
   *   paint    Nov 13 to 14  waits for close
   *   permit   Nov 2 to 3    waits for nothing
   */
  const plan = [
    phase("rough", "2026-11-02", "2026-11-06"),
    phase("close", "2026-11-09", "2026-11-12", "rough"),
    phase("paint", "2026-11-13", "2026-11-14", "close"),
    phase("permit", "2026-11-02", "2026-11-03"),
  ];

  it("lengthens the phase and moves everything that waits for it, however far down", () => {
    const proposal = project.proposeChangeOrderDays(plan, "rough", 3);
    if (!proposal.ok) throw new Error(proposal.reason);
    /** Rough in ends three days later; close and paint move three days and keep their lengths. */
    expect(proposal.changes).toEqual([
      { id: "rough", name: "rough", wasStartsOn: "2026-11-02", wasEndsOn: "2026-11-06", startsOn: "2026-11-02", endsOn: "2026-11-09" },
      { id: "close", name: "close", wasStartsOn: "2026-11-09", wasEndsOn: "2026-11-12", startsOn: "2026-11-12", endsOn: "2026-11-15" },
      { id: "paint", name: "paint", wasStartsOn: "2026-11-13", wasEndsOn: "2026-11-14", startsOn: "2026-11-16", endsOn: "2026-11-17" },
    ]);
    expect(proposal.finishBefore).toBe("2026-11-14");
    expect(proposal.finishAfter).toBe("2026-11-17");
    expect(proposal.statement).toBe(
      "Adds 3 days to rough and moves 2 later phases out by the same. The finish moves from 2026-11-14 to 2026-11-17.",
    );
  });

  it("leaves a phase that does not wait for it where it is", () => {
    const proposal = project.proposeChangeOrderDays(plan, "rough", 3);
    if (!proposal.ok) throw new Error(proposal.reason);
    expect(proposal.changes.map((c) => c.id)).not.toContain("permit");
  });

  it("says the finish stays when the phase has room to absorb the days", () => {
    /** The permit ends on the 3rd and nothing waits for it, and the finish is the 14th. */
    const proposal = project.proposeChangeOrderDays(plan, "permit", 2);
    if (!proposal.ok) throw new Error(proposal.reason);
    expect(proposal.changes).toHaveLength(1);
    expect(proposal.statement).toBe("Adds 2 days to permit. The finish stays 2026-11-14.");
  });

  it("takes days off the other way, and refuses to leave a phase with none", () => {
    const shorter = project.proposeChangeOrderDays(plan, "rough", -2);
    if (!shorter.ok) throw new Error(shorter.reason);
    /** Five days less two is three: ends Nov 4, and the followers come in two days. */
    expect(shorter.changes[0]).toMatchObject({ endsOn: "2026-11-04" });
    expect(shorter.changes[1]).toMatchObject({ startsOn: "2026-11-07", endsOn: "2026-11-10" });
    expect(shorter.statement).toMatch(/^Takes off 2 days from rough and moves 2 later phases in by the same\./);

    const tooMany = project.proposeChangeOrderDays(plan, "rough", -5);
    expect(tooMany).toEqual({
      ok: false,
      reason: "rough runs 5 days, so it cannot give up 5. Shorten it by hand if the plan really changed.",
    });
  });

  it("refuses a complete phase, a complete follower, a phase with no dates and no days", () => {
    expect(project.proposeChangeOrderDays(
      [phase("a", "2026-11-02", "2026-11-04", null, "complete")], "a", 2,
    )).toEqual({ ok: false, reason: "a is complete, so its dates are what happened." });
    expect(project.proposeChangeOrderDays([
      phase("a", "2026-11-02", "2026-11-04"),
      phase("b", "2026-11-05", "2026-11-06", "a", "complete"),
    ], "a", 2)).toMatchObject({ ok: false, reason: expect.stringMatching(/b waits for a and is already complete/) });
    expect(project.proposeChangeOrderDays([phase("a", null, null)], "a", 2))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/no dates/) });
    expect(project.proposeChangeOrderDays(plan, "rough", 0))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/no days/) });
    expect(project.proposeChangeOrderDays(plan, "ghost", 2))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/not part of this project/) });
  });

  it("skips a follower with no dates and still moves the ones behind it", () => {
    const proposal = project.proposeChangeOrderDays([
      phase("a", "2026-11-02", "2026-11-04"),
      phase("b", null, null, "a"),
      phase("c", "2026-11-10", "2026-11-11", "b"),
    ], "a", 1);
    if (!proposal.ok) throw new Error(proposal.reason);
    expect(proposal.changes.map((c) => c.id)).toEqual(["a", "c"]);
    expect(proposal.changes[1]).toMatchObject({ startsOn: "2026-11-11", endsOn: "2026-11-12" });
  });
});

describe("one person on two phases at once", () => {
  /**
   *   rough    Nov 2 to 10
   *   fixtures Nov 8 to 14     overlaps rough on Nov 8 to 10
   *   paint    Nov 15 to 16    overlaps neither
   */
  const plan = [
    phase("rough", "2026-11-02", "2026-11-10"),
    phase("fixtures", "2026-11-08", "2026-11-14"),
    phase("paint", "2026-11-15", "2026-11-16"),
  ];
  const ray = (phaseId: string, date: string): project.PhaseBooking =>
    ({ kind: "technician", id: "ray", name: "Ray Nunez", phaseId, date });

  it("names who, which phases and the days both run", () => {
    const clashes = project.findPhaseClashes(plan, [ray("rough", "2026-11-09"), ray("fixtures", "2026-11-10")]);
    expect(clashes).toEqual([{
      kind: "technician", id: "ray", name: "Ray Nunez",
      phaseIds: ["rough", "fixtures"], from: "2026-11-08", to: "2026-11-10", visits: [1, 1],
      statement: "Ray Nunez is booked on rough and fixtures, which both run from 2026-11-08 to 2026-11-10.",
    }]);
  });

  it("is quiet when the visits fall outside the days both phases run", () => {
    expect(project.findPhaseClashes(plan, [ray("rough", "2026-11-03"), ray("fixtures", "2026-11-10")])).toEqual([]);
    expect(project.findPhaseClashes(plan, [ray("rough", "2026-11-09")])).toEqual([]);
  });

  it("is quiet for phases that do not overlap, complete phases and phases with no dates", () => {
    expect(project.findPhaseClashes(plan, [ray("fixtures", "2026-11-14"), ray("paint", "2026-11-15")])).toEqual([]);
    const done = [phase("rough", "2026-11-02", "2026-11-10", null, "complete"), plan[1]!];
    expect(project.findPhaseClashes(done, [ray("rough", "2026-11-09"), ray("fixtures", "2026-11-09")])).toEqual([]);
    expect(project.findPhaseClashes([plan[0]!, phase("fixtures", null, null)], [ray("rough", "2026-11-09"), ray("fixtures", "2026-11-09")])).toEqual([]);
  });

  it("flags two different people separately, and a crew by its own name", () => {
    const crew = (phaseId: string, date: string): project.PhaseBooking =>
      ({ kind: "crew", id: "framers", name: "Framing crew", phaseId, date });
    const clashes = project.findPhaseClashes(plan, [
      ray("rough", "2026-11-09"), ray("fixtures", "2026-11-09"),
      crew("rough", "2026-11-08"), crew("fixtures", "2026-11-10"),
      { kind: "technician", id: "sam", name: "Sam", phaseId: "rough", date: "2026-11-09" },
    ]);
    expect(clashes.map((c) => c.name).sort()).toEqual(["Framing crew", "Ray Nunez"]);
  });

  it("says a single day plainly", () => {
    const tight = [phase("a", "2026-11-02", "2026-11-04"), phase("b", "2026-11-04", "2026-11-06")];
    const [clash] = project.findPhaseClashes(tight, [
      { kind: "technician", id: "t", name: "Tess", phaseId: "a", date: "2026-11-04" },
      { kind: "technician", id: "t", name: "Tess", phaseId: "b", date: "2026-11-04" },
    ]);
    expect(clash!.statement).toBe("Tess is booked on a and b, which both run on 2026-11-04.");
  });
});
