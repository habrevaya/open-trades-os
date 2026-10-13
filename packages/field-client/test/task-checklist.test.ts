import { describe, it, expect } from "vitest";
import { projectDay, closePayload, closeProblem, tickPayload, describeOperation, type QueuedOperation } from "../src/index";

/**
 * A TASK WITH A CHECKLIST, TICKED AND FINISHED ON THE PHONE
 *
 * Items are ticked one at a time through the queue, shown as ticked and waiting
 * until the office has them, and finishing with some unticked asks for a reason
 * kept apart from the outcome, in the office's own words.
 */
const snapshot = {
  revision: 1, unchanged: false, visits: [], priceBook: [], openTimeEntry: null,
  tasks: [{
    id: "t1", title: "Van check", body: null, priority: "high", status: "open", mine: true, dueAt: null, overdue: false,
    checklistTotal: 3, checklistDone: 1,
    checklist: [
      { id: "i1", label: "Tyres", done: true },
      { id: "i2", label: "Fluids", done: false },
      { id: "i3", label: "Lights", done: false },
    ],
  }, {
    id: "t2", title: "Old server task", body: null, priority: "normal", status: "open", mine: true, dueAt: null, overdue: false,
    checklistTotal: 2, checklistDone: 0,
  }],
};
let n = 0;
const op = (over: Partial<QueuedOperation>): QueuedOperation => ({
  clientId: `op-${++n}`, sequence: n, kind: "task.tick", occurredAt: "2026-10-06T15:00:00Z",
  payload: {}, status: "pending", attempts: 0, ...over,
});

describe("ticking on the phone", () => {
  it("shows an item ticked at once, waiting, with the count following", () => {
    const day = projectDay({ snapshot, operations: [op({ subjectId: "t1", payload: tickPayload("i2", true) })] });
    const task = day.tasks.find((t) => t.id === "t1")!;
    expect(task.checklist.map((i) => [i.id, i.done, i.waiting])).toEqual([["i1", true, false], ["i2", true, true], ["i3", false, false]]);
    expect(task.checklistDone).toBe(2);
    expect(task.waiting).toBe(true);
  });

  it("unticks, and the last one for an item is the one shown", () => {
    const day = projectDay({
      snapshot,
      operations: [
        op({ subjectId: "t1", payload: tickPayload("i1", false) }),
        op({ subjectId: "t1", payload: tickPayload("i3", true) }),
        op({ subjectId: "t1", payload: tickPayload("i3", false) }),
      ],
    });
    const task = day.tasks.find((t) => t.id === "t1")!;
    expect(task.checklist.map((i) => i.done)).toEqual([false, false, false]);
    expect(task.checklistDone).toBe(0);
  });

  it("is not thrown by a server too old to send the items", () => {
    const day = projectDay({ snapshot, operations: [op({ subjectId: "t2", payload: tickPayload("x", true) })] });
    expect(day.tasks.find((t) => t.id === "t2")).toMatchObject({ checklist: [], checklistTotal: 2 });
  });

  it("is said in words when the server refused it", () => {
    const problem = describeOperation(op({
      subjectId: "t1", payload: tickPayload("i2", true), status: "rejected", lastError: "That task is closed, so its checklist is as it was left.",
    }), () => undefined);
    expect(problem!.detail).toBe("Ticking an item on a task was not accepted. That task is closed, so its checklist is as it was left.");
  });
});

describe("finishing it", () => {
  const task = { checklist: [{ id: "i1", label: "Tyres", done: true }, { id: "i2", label: "Fluids", done: false }, { id: "i3", label: "Lights", done: false }].map((i) => ({ ...i, waiting: false })) };
  const ticked = { checklist: task.checklist.map((i) => ({ ...i, done: true })) };

  it("asks for a reason while items are unticked, in the office's words", () => {
    expect(closeProblem(task, "")).toBe("2 items are not ticked. Tick them, or say why it is done anyway.");
    expect(closeProblem({ checklist: [task.checklist[0]!, { ...task.checklist[1]!, done: false }] }, "  ")).toBe("One item is not ticked. Tick it, or say why it is done anyway.");
  });

  it("lets it go when everything is ticked, or when there is a reason", () => {
    expect(closeProblem(ticked, "")).toBeNull();
    expect(closeProblem(task, "Gauge missing, tyres not checked")).toBeNull();
    expect(closeProblem({ checklist: [] }, "")).toBeNull();
  });

  it("keeps the reason apart from the outcome, and sends one only when it is needed", () => {
    expect(closePayload(task, " Van fine ", " Gauge missing ")).toEqual({ outcome: "Van fine", overrideReason: "Gauge missing" });
    expect(closePayload(ticked, "Van fine", "left over text")).toEqual({ outcome: "Van fine" });
    expect(closePayload({ checklist: [] }, "", "")).toEqual({});
  });
});
