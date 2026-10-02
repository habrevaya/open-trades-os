import { describe, it, expect } from "vitest";
import {
  readBranch, decideBranch, checkBranches, explainBranch, flattenPlan, nestSteps,
  type BranchShape, type PlanNode,
} from "../src/automation";

/**
 * BRANCHING, DECIDED WITHOUT A DATABASE
 *
 * `branch` was in `STEP_PERMISSIONS` from the start with no executor and no shape
 * anybody could author, so an automation could only be a straight line. The
 * decision is here rather than in the runner for the reason every other decision
 * in this package is: a rule about what happens to a customer, written inside a
 * database transaction, is a rule nobody can test exhaustively.
 */
const shape = (over: Partial<BranchShape> = {}): BranchShape => ({
  conditions: { all: [{ path: "invoice.total", op: "gt", value: 1000 }] },
  thenCount: 1,
  elseCount: 1,
  ...over,
});

const over = (total: number) => ({ payload: { invoice: { total } } });

describe("reading a branch config", () => {
  it("takes an arm left out as empty, because that is what an author meant", () => {
    const read = readBranch({ thenCount: 2 });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.shape).toMatchObject({ thenCount: 2, elseCount: 0 });
  });

  it("refuses a branch with nothing in either arm", () => {
    /**
     * Both answers run whatever happens to come next, so the condition decides
     * nothing. Invisible at run time, which is why it is refused at the save.
     */
    const read = readBranch({ conditions: { all: [] } });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.problem.reason).toBe("no_arms");
  });

  it("refuses a negative arm and a non integer one", () => {
    expect(readBranch({ thenCount: -1 })).toMatchObject({ ok: false, problem: { reason: "negative_arm" } });
    expect(readBranch({ thenCount: 1.5 })).toMatchObject({ ok: false, problem: { reason: "not_a_branch" } });
  });

  it("refuses an arm that runs off the end of the list", () => {
    const read = readBranch({ thenCount: 3, elseCount: 2 }, 4);
    expect(read).toMatchObject({ ok: false, problem: { reason: "runs_past_the_end", needs: 5, has: 4 } });
  });

  it("accepts arms that exactly fill what follows", () => {
    expect(readBranch({ thenCount: 3, elseCount: 2 }, 5).ok).toBe(true);
  });
});

describe("deciding a branch", () => {
  it("runs the then arm and writes the otherwise arm off", () => {
    const decision = decideBranch(shape(), over(2000));
    expect(decision.taken).toBe("then");
    /** Offset 1 is the then arm and runs; offset 2 is the otherwise arm. */
    expect(decision.skipOffsets).toEqual([2]);
  });

  it("runs the otherwise arm and writes the then arm off", () => {
    const decision = decideBranch(shape(), over(50));
    expect(decision.taken).toBe("otherwise");
    expect(decision.skipOffsets).toEqual([1]);
  });

  it("skips the whole then arm, not just its first step", () => {
    const decision = decideBranch(shape({ thenCount: 3, elseCount: 0 }), over(50));
    expect(decision.skipOffsets).toEqual([1, 2, 3]);
  });

  it("says otherwise even when that arm is empty, so the log records the answer", () => {
    /**
     * A run whose branch was false and whose otherwise arm is empty did decide
     * something, and "nothing happened" is not the same record as "the condition
     * did not hold".
     */
    const decision = decideBranch(shape({ thenCount: 2, elseCount: 0 }), over(10));
    expect(decision.taken).toBe("otherwise");
    expect(decision.skipOffsets).toEqual([1, 2]);
  });

  it("treats a missing value as not holding rather than as holding", () => {
    const decision = decideBranch(shape(), { payload: {} });
    expect(decision.taken).toBe("otherwise");
  });
});

describe("bracket matching a step list", () => {
  const branch = (thenCount: number, elseCount = 0) =>
    ({ kind: "branch", config: { thenCount, elseCount } });
  const act = { kind: "create_task" };

  it("passes a list with no branches in it", () => {
    expect(checkBranches([act, act, act])).toEqual([]);
  });

  it("passes a branch whose arms fit", () => {
    expect(checkBranches([branch(1, 1), act, act])).toEqual([]);
  });

  it("passes a branch nested inside an arm", () => {
    /** Outer covers 1 to 4. Inner at 1 covers 2 to 3, which closes inside it. */
    expect(checkBranches([branch(4), branch(2), act, act, act])).toEqual([]);
  });

  it("refuses an inner branch whose arm ends outside the arm holding it", () => {
    /**
     * The whole reason the flat form needs a check. Outer covers 1 to 2; the inner
     * branch at 1 wants 2 to 4, so the two describe overlapping regions and no
     * reading of it is the one both authors meant.
     */
    const problems = checkBranches([branch(2), branch(3), act, act, act]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ at: 1, problem: { reason: "crosses_an_arm" } });
  });

  it("reports a branch running off the end of the list", () => {
    const problems = checkBranches([act, branch(3)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ at: 1, problem: { reason: "runs_past_the_end" } });
  });

  it("closes an arm once it is passed, so a later branch is not inside it", () => {
    /**
     * Two branches in sequence, neither containing the other. The first covers 1,
     * and the branch at 2 is outside it rather than crossing it.
     */
    expect(checkBranches([branch(1), act, branch(1), act])).toEqual([]);
  });

  it("explains each problem as a sentence naming the step a person can see", () => {
    const problems = checkBranches([branch(2), branch(3), act, act, act]);
    const said = explainBranch(problems[0]!);
    /** One based, because the screen numbers steps from one. */
    expect(said).toContain("Step 2");
    expect(said).toContain("outside the branch it sits in");
  });

  it("explains an armless branch in terms of what it fails to decide", () => {
    const problems = checkBranches([{ kind: "branch", config: {} }, act]);
    expect(explainBranch(problems[0]!)).toContain("both answers do the same thing");
  });
});

/**
 * THE TREE AND THE LIST, ROUND TRIPPED
 *
 * The canvas holds a tree because that is what somebody draws, and the engine runs
 * a flat list because that is what resumes. Two translations of the same thing is
 * one translation too many, so both directions live here and the round trip is
 * asserted: a definition saved today has to open tomorrow as the same picture.
 */
describe("the tree a canvas holds and the list the engine runs", () => {
  const task = (title: string): PlanNode => ({ kind: "create_task", config: { title } });
  const cond = { all: [{ path: "invoice.total", op: "gt" as const, value: 1000 }] };

  it("fills in the arm counts, which is the arithmetic nobody should do by hand", () => {
    const plan: PlanNode[] = [{
      kind: "branch",
      config: { conditions: cond },
      then: [task("A"), task("B")],
      otherwise: [task("C")],
    }];
    expect(flattenPlan(plan)).toEqual([
      { kind: "branch", config: { conditions: cond, thenCount: 2, elseCount: 1 } },
      { kind: "create_task", config: { title: "A" } },
      { kind: "create_task", config: { title: "B" } },
      { kind: "create_task", config: { title: "C" } },
    ]);
  });

  it("counts a nested branch's whole subtree in the arm that holds it", () => {
    /**
     * The count is a span, not a child count. An inner branch with two arms takes
     * three places in the list, and an outer arm that counted one would skip into
     * the middle of it.
     */
    const plan: PlanNode[] = [{
      kind: "branch",
      config: { conditions: cond },
      then: [{ kind: "branch", config: { conditions: cond }, then: [task("inner")], otherwise: [] }],
      otherwise: [task("outer else")],
    }];
    const flat = flattenPlan(plan);
    expect(flat[0]?.config).toMatchObject({ thenCount: 2, elseCount: 1 });
    expect(flat[1]?.config).toMatchObject({ thenCount: 1, elseCount: 0 });
    expect(flat.map((s) => s.kind)).toEqual(["branch", "branch", "create_task", "create_task"]);
  });

  it("produces a list the bracket match accepts", () => {
    /** The point of computing the counts rather than typing them. */
    const plan: PlanNode[] = [
      task("first"),
      {
        kind: "branch",
        config: { conditions: cond },
        then: [{ kind: "branch", config: { conditions: cond }, then: [task("deep")], otherwise: [task("other")] }],
        otherwise: [task("outer")],
      },
      task("last"),
    ];
    expect(checkBranches(flattenPlan(plan))).toEqual([]);
  });

  it("round trips a plan with no branches", () => {
    const plan: PlanNode[] = [task("A"), { kind: "wait", config: { days: 3 } }, task("B")];
    expect(nestSteps(flattenPlan(plan))).toEqual(plan);
  });

  it("round trips a branch with both arms", () => {
    const plan: PlanNode[] = [{
      kind: "branch",
      config: { conditions: cond },
      then: [task("A"), task("B")],
      otherwise: [task("C")],
    }];
    expect(nestSteps(flattenPlan(plan))).toEqual(plan);
  });

  it("round trips a branch nested two deep with a sibling after it", () => {
    const plan: PlanNode[] = [
      {
        kind: "branch",
        config: { conditions: cond },
        then: [
          task("A"),
          {
            kind: "branch",
            config: { conditions: cond },
            then: [task("deep")],
            otherwise: [task("shallow")],
          },
        ],
        otherwise: [task("B")],
      },
      task("after"),
    ];
    expect(nestSteps(flattenPlan(plan))).toEqual(plan);
  });

  it("round trips an empty otherwise arm as an empty arm rather than dropping it", () => {
    /**
     * A branch with nothing in its otherwise arm is a real and common shape: "only
     * if this, do that". Losing the empty arm on a round trip would turn it into a
     * branch with no arms at all, which `readBranch` refuses, so the automation
     * would open and then fail to save.
     */
    const plan: PlanNode[] = [{
      kind: "branch", config: { conditions: cond }, then: [task("A")], otherwise: [],
    }];
    expect(nestSteps(flattenPlan(plan))).toEqual(plan);
  });

  it("does not leave the counts in the config it hands back", () => {
    /**
     * The counts are derived. Leaving them on the node would mean the canvas held
     * two sources of truth for the arm sizes, and the next flatten would use the
     * stale one.
     */
    const flat = flattenPlan([{
      kind: "branch", config: { conditions: cond }, then: [task("A")], otherwise: [],
    }]);
    const back = nestSteps(flat);
    expect(back[0]?.config).toEqual({ conditions: cond });
    expect(back[0]?.config).not.toHaveProperty("thenCount");
  });

  it("reads a list whose counts do not add up without throwing", () => {
    /**
     * `checkBranches` refuses this at the save, so it can only arrive from an older
     * build or straight from the table. Opening it has to show something: empty arms
     * and the steps that followed as siblings is the honest reading, and it lets
     * somebody fix it on the screen rather than in SQL.
     */
    const broken = [
      { kind: "branch", config: { thenCount: 9, elseCount: 0 } },
      { kind: "create_task", config: { title: "orphan" } },
    ];
    const back = nestSteps(broken);
    expect(back).toHaveLength(2);
    expect(back[0]).toMatchObject({ kind: "branch", then: [], otherwise: [] });
    expect(back[1]).toMatchObject({ kind: "create_task" });
  });
});
