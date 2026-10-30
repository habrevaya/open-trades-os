import { describe, it, expect } from "vitest";
import { taskRules } from "../src/index";

describe("the task the daily loop scan raises", () => {
  it("is titled for one loop or several", () => {
    expect(taskRules.reportingLoopTaskTitle(1)).toBe("There is a loop in who answers to whom");
    expect(taskRules.reportingLoopTaskTitle(3)).toBe("There are 3 loops in who answers to whom");
  });

  it("names every loop, says nothing was changed and where to change it", () => {
    const body = taskRules.reportingLoopTaskBody(["Ana reports to Ben and Ben reports to Ana.", "Cy is recorded as reporting to themselves."]);
    expect(body).toContain("Ana reports to Ben and Ben reports to Ana. Cy is recorded as reporting to themselves.");
    expect(body).toContain("Nothing was changed. Open Tasks, then Escalation, and change one line in each loop.");
    expect(body).not.toMatch(/[–—]/);
  });

  it("marks the same loops the same way whichever person the scan started from", () => {
    expect(taskRules.reportingLoopsMark([["b", "a"], ["z"]])).toBe(taskRules.reportingLoopsMark([["z"], ["a", "b"]]));
    expect(taskRules.reportingLoopsMark([["a", "b"]])).not.toBe(taskRules.reportingLoopsMark([["a", "c"]]));
    expect(taskRules.reportingLoopsMark([])).toBe("");
  });
});
