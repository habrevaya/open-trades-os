"use client";

import { useState } from "react";

/**
 * WRITING AN AUTOMATION
 *
 * Not a canvas of boxes and arrows. That is the thing everybody pictures and
 * almost nobody finishes, and the shapes a contractor actually wants are
 * three or four: when this happens, wait, then do that.
 *
 * Only the steps this build can perform are offered. A JSON field would be
 * more expressive and would also be a way to save a definition naming a step
 * that does nothing at run time, which is the failure the whole screen exists
 * to prevent.
 */
export interface StepOption {
  kind: string;
  label: string;
  description: string;
  permissions: string[];
  allowed: boolean;
}

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
  const [chosen, setChosen] = useState<string[]>(
    initial?.steps.map((s) => s.kind) ?? ["create_task"],
  );

  const configOf = (kind: string) =>
    (initial?.steps.find((s) => s.kind === kind)?.config ?? {}) as Record<string, unknown>;
  const value = (kind: string, field: string) => {
    const v = configOf(kind)[field];
    return v === undefined || v === null ? "" : String(v);
  };

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

      <fieldset>
        <legend className="text-sm font-medium text-ink-700">What does it do?</legend>
        <p className="mt-1 text-xs text-ink-500">
          In order, top to bottom. A step that fails stops the ones after it,
          because a later step that assumes an earlier one happened will do
          something wrong rather than nothing.
        </p>

        <div className="mt-3 space-y-3">
          {steps.map((step) => {
            const on = chosen.includes(step.kind);
            return (
              <div key={step.kind} className="rounded-md border border-steel-200 p-3">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox" name="step" value={step.kind}
                    checked={on} disabled={!step.allowed}
                    onChange={(e) => setChosen((c) =>
                      e.target.checked ? [...c, step.kind] : c.filter((k) => k !== step.kind))}
                    className="mt-0.5 h-4 w-4"
                  />
                  <span>
                    <span className="font-medium">{step.label}</span>
                    <span className="block text-ink-700">{step.description}</span>
                    {/*
                      Shown with the reason rather than hidden. A step missing
                      from the list reads as a product that cannot do the
                      thing, rather than as an account that may not.
                    */}
                    {!step.allowed && (
                      <span className="block text-ink-500">
                        You do not hold {step.permissions.join(", ")}, so you
                        cannot publish an automation that does this.
                      </span>
                    )}
                  </span>
                </label>

                {on && step.kind === "send_message" && (
                  <label className="mt-3 block text-sm">
                    <span className="block text-ink-700">What it says</span>
                    <textarea
                      name="send_message.body" rows={2}
                      defaultValue={value("send_message", "body")}
                      placeholder="Hi {{ customer.name }}, just checking on the quote we sent."
                      className="mt-1 w-full rounded border border-steel-300 p-2"
                    />
                    <span className="mt-1 block text-xs text-ink-500">
                      Placeholders are filled from the event. Nothing is
                      evaluated: it is substitution and no more. Consent is
                      checked when the message is sent, not now.
                    </span>
                  </label>
                )}

                {on && step.kind === "create_task" && (
                  <div className="mt-3 flex flex-wrap gap-3 text-sm">
                    <label>
                      <span className="block text-ink-700">Title</span>
                      <input
                        name="create_task.title" defaultValue={value("create_task", "title")}
                        placeholder="Chase this estimate"
                        className="mt-1 h-9 w-64 rounded border border-steel-300 px-2"
                      />
                    </label>
                    <label>
                      <span className="block text-ink-700">Queue</span>
                      <input
                        name="create_task.queue" defaultValue={value("create_task", "queue")}
                        placeholder="office"
                        className="mt-1 h-9 w-32 rounded border border-steel-300 px-2"
                      />
                    </label>
                    <label>
                      <span className="block text-ink-700">Due in hours</span>
                      <input
                        name="create_task.dueInHours" type="number" min="0"
                        defaultValue={value("create_task", "dueInHours")}
                        className="mt-1 h-9 w-28 rounded border border-steel-300 px-2"
                      />
                    </label>
                  </div>
                )}

                {on && step.kind === "wait" && (
                  <div className="mt-3 flex flex-wrap gap-3 text-sm">
                    <label>
                      <span className="block text-ink-700">Days</span>
                      <input
                        name="wait.days" type="number" min="0"
                        defaultValue={value("wait", "days") || "3"}
                        className="mt-1 h-9 w-24 rounded border border-steel-300 px-2"
                      />
                    </label>
                    <label>
                      <span className="block text-ink-700">Hours</span>
                      <input
                        name="wait.hours" type="number" min="0"
                        defaultValue={value("wait", "hours") || "0"}
                        className="mt-1 h-9 w-24 rounded border border-steel-300 px-2"
                      />
                    </label>
                    <p className="self-end pb-2 text-xs text-ink-500">
                      Stored on the run, so it survives a restart.
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}
