"use client";

import { useState } from "react";
import { automation } from "@opentradesos/core";
import { Canvas, type StepOption } from "./Canvas";

/**
 * WRITING AN AUTOMATION
 *
 * The trigger half. The steps are a canvas now, in `Canvas.tsx`, and this file used
 * to carry a comment arguing against one: "not a canvas of boxes and arrows, that is
 * the thing everybody pictures and almost nobody finishes".
 *
 * Half of that was right and the half that was right is kept. What this is not is a
 * free-form graph editor, because a free graph expresses a cycle and a dangling
 * node and this engine runs a list that only goes forwards. What it is now is a
 * vertical flow with lanes, which is the shape an automation actually has, and which
 * made `branch` authorable: the step was in the engine's permission table from the
 * start with no shape anybody could write, so every automation was a straight line
 * while the thing contractors ask for first is "only if".
 *
 * Only the steps this build can perform are offered, which is the part that did not
 * change. A JSON field would be more expressive and would also be a way to save a
 * definition naming a step that does nothing at run time.
 */
export type { StepOption } from "./Canvas";

export interface DwellShape {
  key: string;
  label: string;
  question: string;
}

export function Builder({
  events, steps, shapes, initial,
}: {
  events: { name: string; summary: string | null }[];
  steps: StepOption[];
  shapes: DwellShape[];
  initial?: {
    name: string;
    description: string | null;
    triggerKind: string;
    triggerEvents: string[];
    schedule: string | null;
    dwell: { shape: string; afterDays: number } | null;
    steps: { kind: string; config?: Record<string, unknown> }[];
  };
}) {
  const [triggerKind, setTriggerKind] = useState(initial?.triggerKind ?? "event");

  /**
   * The flat list the engine stores, read back as the lanes somebody drew.
   *
   * `nestSteps` is the inverse of what the canvas posts, so opening an automation
   * shows the picture it was saved as rather than a list of its steps in order with
   * the branching flattened out of it.
   */
  const drawn = initial ? automation.nestSteps(initial.steps) : undefined;

  /** What fires it, in words, drawn at the top of the flow. */
  const triggerSummary = triggerKind === "schedule"
    ? "On a clock"
    : triggerKind === "dwell"
      ? "When something has not happened"
      : "When something happens";

  return (
    <div className="space-y-6">
      <label className="block text-sm">
        <span className="block font-medium text-ink-700">Name</span>
        <input
          name="name" required defaultValue={initial?.name ?? ""}
          placeholder="Chase an estimate nobody answered"
          className="mt-1 h-9 w-full max-w-md rounded border border-steel-300 px-2"
        />
      </label>

      <label className="block text-sm">
        <span className="block font-medium text-ink-700">What it is for</span>
        <input
          name="description" defaultValue={initial?.description ?? ""}
          placeholder="So a quote nobody replied to does not just sit there"
          className="mt-1 h-9 w-full max-w-md rounded border border-steel-300 px-2"
        />
      </label>

      <fieldset>
        <legend className="text-sm font-medium text-ink-700">When does it run?</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {[
            { value: "event", label: "When something happens" },
            { value: "schedule", label: "On a clock" },
            { value: "dwell", label: "When something has not happened" },
          ].map((option) => (
            <label
              key={option.value}
              className={`inline-flex items-center gap-2 rounded border px-3 py-1.5 text-sm ${
                triggerKind === option.value
                  ? "border-ink-900 bg-ink-900 text-white"
                  : "border-steel-300 hover:bg-steel-100"
              }`}
            >
              <input
                type="radio" name="triggerKind" value={option.value}
                checked={triggerKind === option.value}
                onChange={() => setTriggerKind(option.value)}
                className="sr-only"
              />
              {option.label}
            </label>
          ))}
        </div>

        {triggerKind === "event" ? (
          <div className="mt-3">
            <p className="max-w-prose text-xs text-ink-500">
              {/*
                The list used to be fourteen names of which one was ever
                emitted, so the commonest automation anybody would write was
                one that saved, enabled, and never ran. Everything offered
                here fires.
              */}
              Picked from a list rather than typed, and every one of these is
              something the product actually emits. An automation on an event
              nothing raises never runs, and nothing can tell you: a
              subscription matching nothing looks exactly like a quiet month.
            </p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {events.map((event) => (
                <label
                  key={event.name}
                  className="flex items-start gap-2 rounded border border-steel-300 px-3 py-2 text-sm hover:bg-steel-100"
                >
                  <input
                    type="checkbox" name="triggerEvent" value={event.name}
                    defaultChecked={initial?.triggerEvents.includes(event.name)}
                    className="mt-0.5 h-4 w-4 shrink-0"
                  />
                  <span>
                    {/*
                      The sentence first and the name second. A column of
                      `agreement.visit_unskipped` next to a checkbox asks
                      somebody to guess; the summary is the sentence they
                      are completing.
                    */}
                    <span className="block text-ink-900">
                      {event.summary ?? event.name}
                    </span>
                    <span className="block font-mono text-xs text-ink-500">{event.name}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : triggerKind === "dwell" ? (
          <div className="mt-3">
            {/*
              The one the other two cannot express. An event fires when
              something happens and a schedule fires on a clock; neither
              fires when something has NOT happened, and the estimate nobody
              answered is money that quietly did not arrive.
            */}
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="block text-ink-700">Wait on</span>
                <select
                  name="dwellShape"
                  defaultValue={initial?.dwell?.shape ?? shapes[0]?.key ?? ""}
                  className="mt-1 h-9 rounded border border-steel-300 px-2"
                >
                  {shapes.map((shape) => (
                    <option key={shape.key} value={shape.key}>{shape.label}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="block text-ink-700">After how many days</span>
                <input
                  name="dwellDays" type="number" min="0" max="365"
                  defaultValue={initial?.dwell?.afterDays ?? 5}
                  className="mt-1 h-9 w-28 rounded border border-steel-300 px-2"
                />
              </label>
            </div>
            <p className="mt-2 text-xs text-ink-500">
              Measured from when the record entered that state, not from when
              anybody last touched it. A customer opening a quote without
              deciding is exactly the one worth chasing.
            </p>
            <ul className="mt-2 space-y-1 text-xs text-ink-500">
              {shapes.map((shape) => (
                <li key={shape.key}>{shape.label}: {shape.question}</li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="mt-3">
            <label className="block text-sm">
              <span className="block text-ink-700">Schedule</span>
              <input
                name="schedule" defaultValue={initial?.schedule ?? "0 9 * * 1-5"}
                placeholder="0 9 * * 1-5"
                className="mt-1 h-9 w-56 rounded border border-steel-300 px-2 font-mono"
              />
            </label>
            <p className="mt-1 text-xs text-ink-500">
              Five fields: minute, hour, day of the month, month, day of the
              week. <span className="font-mono">0 9 * * 1-5</span> is nine in
              the morning on weekdays, in your company&apos;s timezone rather
              than the server&apos;s.
            </p>
          </div>
        )}
      </fieldset>

      <Canvas steps={steps} initial={drawn} triggerSummary={triggerSummary} />
    </div>
  );
}
