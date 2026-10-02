import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Canvas, type StepOption } from "../src/app/(app)/automations/Canvas";
import { automation } from "@opentradesos/core";

const steps: StepOption[] = [
  { kind: "send_message", label: "Send a message", description: "Texts the customer.", permissions: ["message:send"], allowed: true },
  { kind: "create_task", label: "Raise a task", description: "Puts it in the queue.", permissions: ["task:write"], allowed: true },
  { kind: "wait", label: "Wait", description: "Pauses the run.", permissions: [], allowed: true },
  { kind: "branch", label: "Only if", description: "Two lanes.", permissions: [], allowed: true },
];

const cond = { all: [{ path: "invoice.total", op: "gt", value: 1000 }] };

/**
 * M29's CANVAS
 *
 * The step half of the builder was a set of checkboxes: one of each kind, in a fixed
 * order. So two messages was impossible, ordering was impossible, and `branch`, which
 * has been in the engine's permission table from the start, had no shape anybody could
 * author. A render test cannot click, so what it checks is what the canvas draws and
 * what it posts, and the browser test walks the editing.
 */
describe("the automation canvas", () => {
  it("draws the trigger at the top, so the flow starts somewhere", () => {
    const html = renderToStaticMarkup(
      <Canvas steps={steps} triggerSummary="When something happens" />,
    );
    expect(html).toContain("When something happens");
  });

  it("posts the plan as a tree, which is what the server flattens", () => {
    const html = renderToStaticMarkup(
      <Canvas steps={steps} triggerSummary="On a clock"
              initial={[{ kind: "branch", config: { conditions: cond }, then: [{ kind: "create_task", config: { title: "Ring them" } }], otherwise: [] }]} />,
    );
    expect(html).toContain('name="plan"');
    /** The posted value round trips through the same functions the engine uses. */
    const match = /name="plan" value="([^"]*)"/.exec(html);
    expect(match).not.toBeNull();
    const posted = JSON.parse(match![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    const flat = automation.flattenPlan(posted);
    expect(flat[0]?.config).toMatchObject({ thenCount: 1, elseCount: 0 });
    expect(automation.checkBranches(flat)).toEqual([]);
  });

  it("opens a saved automation as the lanes it was drawn as", () => {
    /**
     * The inverse translation. Without it, editing a branching automation would show
     * its steps in order with the branching flattened out, and saving would lose the
     * shape.
     */
    const html = renderToStaticMarkup(
      <Canvas steps={steps} triggerSummary="When something happens"
              initial={[{
                kind: "branch", config: { conditions: cond },
                then: [{ kind: "send_message", config: { body: "Big one" } }],
                otherwise: [{ kind: "create_task", config: { title: "Small one" } }],
              }]} />,
    );
    expect(html).toContain("Then");
    expect(html).toContain("Otherwise");
    expect(html).toContain("Big one");
    expect(html).toContain("Small one");
  });

  it("counts the steps the engine will see, not the cards on the screen", () => {
    /**
     * A branch with two arms is three cards and four steps, and somebody reading a
     * run's rows against this screen needs the engine's number.
     */
    const html = renderToStaticMarkup(
      <Canvas steps={steps} triggerSummary="On a clock"
              initial={[{
                kind: "branch", config: { conditions: cond },
                then: [{ kind: "create_task", config: {} }, { kind: "wait", config: {} }],
                otherwise: [{ kind: "create_task", config: {} }],
              }]} />,
    );
    expect(html).toContain("4 steps when this runs");
  });

  it("says one step in words rather than as a numeral", () => {
    const html = renderToStaticMarkup(
      <Canvas steps={steps} triggerSummary="On a clock" initial={[{ kind: "create_task", config: {} }]} />,
    );
    expect(html).toContain("One step when this runs");
  });

  it("tells somebody a branch with no conditions always takes the first lane", () => {
    /**
     * Said rather than refused. Somebody mid-edit has not finished, and a refusal at
     * that moment is a screen arguing with them.
     */
    const html = renderToStaticMarkup(
      <Canvas steps={steps} triggerSummary="On a clock"
              initial={[{ kind: "branch", config: { conditions: { all: [] } }, then: [{ kind: "create_task", config: {} }], otherwise: [] }]} />,
    );
    expect(html).toContain("would always take the first lane");
  });

  it("says an empty otherwise arm is a real shape rather than a mistake", () => {
    const html = renderToStaticMarkup(
      <Canvas steps={steps} triggerSummary="On a clock"
              initial={[{ kind: "branch", config: { conditions: cond }, then: [{ kind: "create_task", config: {} }], otherwise: [] }]} />,
    );
    expect(html).toContain("only acts when the condition holds");
  });

  it("shows a step the author cannot publish, with the permission it needs", () => {
    /**
     * Not hidden. A step missing from the canvas reads as a product that cannot do
     * the thing rather than an account that may not.
     */
    const narrowed = steps.map((s) => (s.kind === "send_message" ? { ...s, allowed: false } : s));
    const html = renderToStaticMarkup(
      <Canvas steps={narrowed} triggerSummary="On a clock"
              initial={[{ kind: "send_message", config: { body: "x" } }]} />,
    );
    expect(html).toContain("You do not hold message:send");
  });

  it("names every card and control by where it sits, so two cards cannot be confused", () => {
    /**
     * Two task cards have two boxes whose only label is "Title". A screen reader
     * announces them identically and a browser test cannot tell them apart either.
     * Naming the card is the fix a reader benefits from, and the position is the
     * part that makes it unique.
     */
    const html = renderToStaticMarkup(
      <Canvas steps={steps} triggerSummary="On a clock"
              initial={[{ kind: "create_task", config: {} }, { kind: "wait", config: {} }]} />,
    );
    expect(html).toContain('aria-label="step 1, Raise a task"');
    expect(html).toContain('aria-label="step 2, Wait"');
    expect(html).toContain('aria-label="Move step 1, Raise a task down"');
    expect(html).toContain('aria-label="Remove step 2, Wait"');
  });

  it("names a card inside an arm by the arm it is in", () => {
    const html = renderToStaticMarkup(
      <Canvas steps={steps} triggerSummary="On a clock"
              initial={[{
                kind: "branch", config: { conditions: cond },
                then: [{ kind: "create_task", config: {} }],
                otherwise: [{ kind: "wait", config: {} }],
              }]} />,
    );
    expect(html).toContain('aria-label="step 1, then, step 1, Raise a task"');
    expect(html).toContain('aria-label="step 1, otherwise, step 1, Wait"');
  });

  it("says which lane each add button adds to", () => {
    /**
     * Three lanes on one canvas have three buttons reading "Add a step". The visible
     * words stay short because that is what somebody scanning wants; the accessible
     * name carries the lane.
     */
    const html = renderToStaticMarkup(
      <Canvas steps={steps} triggerSummary="On a clock"
              initial={[{ kind: "branch", config: { conditions: cond }, then: [], otherwise: [] }]} />,
    );
    expect(html).toContain('aria-label="Add a step to the end"');
    expect(html).toContain('aria-label="Add a step to step 1, then"');
    expect(html).toContain('aria-label="Add a step to step 1, otherwise"');
  });

  it("offers the comparators in words rather than as operators", () => {
    const html = renderToStaticMarkup(
      <Canvas steps={steps} triggerSummary="On a clock"
              initial={[{ kind: "branch", config: { conditions: cond }, then: [], otherwise: [{ kind: "wait", config: {} }] }]} />,
    );
    expect(html).toContain("is more than");
    expect(html).not.toContain(">gt<");
  });

  it("shows the arm problem while somebody is still editing", () => {
    /**
     * The same sentence the server refuses with, from the same function in core, so
     * this is an earlier copy of the truth rather than a second opinion. Reached by
     * handing it a plan whose stored counts cannot be satisfied.
     */
    const broken = automation.nestSteps([
      { kind: "branch", config: { thenCount: 9, elseCount: 0 } },
      { kind: "create_task", config: {} },
    ]);
    const html = renderToStaticMarkup(
      <Canvas steps={steps} triggerSummary="On a clock" initial={broken} />,
    );
    /** An armless branch, because the counts were dropped as unreadable. */
    expect(html).toContain("both answers do the same thing");
  });
});
