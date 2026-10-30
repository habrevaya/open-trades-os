import { describe, it, expect } from "vitest";
import { reportingLoopsInData, describeExistingLoop } from "../src/tasks/index.js";

/**
 * LOOPS ALREADY IN WHO ANSWERS TO WHOM
 *
 * A new line that would close a loop is refused when saved. Lines from before
 * that check can already be loops, and these find them: each loop once, in
 * reporting order, from the first person in the order given, and nobody who
 * only leads into one.
 */
const lines = (pairs: [string, string | null][]) => new Map(pairs);

describe("finding loops in the data", () => {
  it("finds nothing in a chain, a tree or an empty company", () => {
    expect(reportingLoopsInData(lines([]))).toEqual([]);
    expect(reportingLoopsInData(lines([["ana", "ben"], ["ben", "cy"], ["cy", null]]))).toEqual([]);
    expect(reportingLoopsInData(lines([["ana", "cy"], ["ben", "cy"], ["cy", null], ["dee", "ana"]]))).toEqual([]);
  });

  it("finds two people reporting to each other once, not once for each", () => {
    expect(reportingLoopsInData(lines([["ana", "ben"], ["ben", "ana"]]))).toEqual([["ana", "ben"]]);
    expect(reportingLoopsInData(lines([["ben", "ana"], ["ana", "ben"]]))).toEqual([["ben", "ana"]]);
  });

  it("finds a longer loop in reporting order, starting from the first person given", () => {
    const loop = reportingLoopsInData(lines([["ana", "ben"], ["ben", "cy"], ["cy", "ana"]]));
    expect(loop).toEqual([["ana", "ben", "cy"]]);
    // The same loop, whoever it is entered from.
    expect(reportingLoopsInData(lines([["cy", "ana"], ["ana", "ben"], ["ben", "cy"]]))).toEqual([["cy", "ana", "ben"]]);
  });

  it("does not count people who only report into a loop", () => {
    const found = reportingLoopsInData(lines([["dee", "ana"], ["ed", "dee"], ["ana", "ben"], ["ben", "ana"]]));
    expect(found).toEqual([["ana", "ben"]]);
  });

  it("finds a person recorded as their own manager, and several separate loops in order", () => {
    expect(reportingLoopsInData(lines([["ana", "ana"]]))).toEqual([["ana"]]);
    expect(reportingLoopsInData(lines([["ana", "ben"], ["ben", "ana"], ["cy", "dee"], ["dee", "cy"], ["ed", "ed"], ["fay", null]])))
      .toEqual([["ana", "ben"], ["cy", "dee"], ["ed"]]);
  });

  it("ignores a manager who is not on the list at all", () => {
    expect(reportingLoopsInData(lines([["ana", "ghost"]]))).toEqual([]);
  });
});

describe("naming a loop in words", () => {
  it("says who reports to whom, all the way round", () => {
    expect(describeExistingLoop(["Ana", "Ben"])).toBe("Ana reports to Ben and Ben reports to Ana.");
    expect(describeExistingLoop(["Ana", "Ben", "Cy"])).toBe("Ana reports to Ben, Ben reports to Cy, and Cy reports to Ana.");
    expect(describeExistingLoop(["Ana"])).toBe("Ana is recorded as reporting to themselves.");
    expect(describeExistingLoop([])).toBe("");
  });

  it("does not tell anybody how to mend it", () => {
    expect(describeExistingLoop(["Ana", "Ben"])).not.toMatch(/change|remove|fix/i);
  });
});
