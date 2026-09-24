"use client";

import { useActionState, useState } from "react";
import { declarePolicy } from "./actions";

const BUTTON =
  "inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100 disabled:opacity-60";
const FIELD = "h-9 w-full rounded border border-steel-300 px-2 text-sm";

/**
 * DECLARING THE OVERTIME POLICY
 *
 * Every field here is a legal position on somebody's wages, which is why
 * there is a form rather than a default. The product refused to run a
 * timesheet without this and had nowhere to set it, so the refusal named an
 * action nobody could take.
 *
 * THE PRESETS ARE A STARTING POINT AND SAY SO. Filling the form is not the
 * same as agreeing with it: the note is required, it is free text, and it is
 * what the person approving payroll reads to decide whether the declaration
 * is right. A preset that wrote its own note would put words in their mouth.
 *
 * ON CALL HAS NO DEFAULT SELECTED. Whether waiting is working has the widest
 * spread of correct answers here, and core refuses a policy that does not
 * declare it. A preselected radio is a declaration somebody made by not
 * looking.
 */
const PRESETS: Record<string, { label: string; weekly: number | ""; daily: number | "" }> = {
  federal: { label: "Federal floor", weekly: 40 * 60, daily: "" },
  california: { label: "California", weekly: 40 * 60, daily: 8 * 60 },
  none: { label: "Start blank", weekly: "", daily: "" },
};

export function Policy({ current }: { current: string | null }) {
  const [state, declare, saving] = useActionState(declarePolicy, null);
  const [preset, setPreset] = useState<keyof typeof PRESETS>("federal");
  const [open, setOpen] = useState(current === null);

  const error = state && "error" in state ? state.error : null;
  const warning = state && "reclassifies" in state && state.reclassifies;
  const chosen = PRESETS[preset]!;

  if (!open) {
    return (
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setOpen(true)} className={BUTTON}>
          Change the overtime policy
        </button>
        {warning && (
          <span className="text-sm text-ink-700">
            Hours already approved have been reclassified under the new policy.
          </span>
        )}
      </div>
    );
  }

  return (
    <form action={declare} className="mt-6 max-w-2xl rounded-md border border-steel-200 p-4">
      <h2 className="text-base font-semibold">Declare the overtime policy</h2>
      <p className="mt-1 text-sm text-ink-700">
        There is no default here, because every default is a position on what
        somebody is owed. Forty hours a week at time and a half is the federal
        floor and is wrong in California, where a ninth hour in a day is
        already overtime.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="block text-xs text-ink-500">Start from</span>
          <select
            value={preset}
            onChange={(event) => setPreset(event.target.value as keyof typeof PRESETS)}
            className={`mt-1 ${FIELD}`}
          >
            {Object.entries(PRESETS).map(([key, value]) => (
              <option key={key} value={key}>{value.label}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="block text-xs text-ink-500">Name it</span>
          <input name="label" required defaultValue={chosen.label} key={`l-${preset}`}
                 className={`mt-1 ${FIELD}`} />
        </label>

        <label className="block">
          <span className="block text-xs text-ink-500">Overtime after, per week (minutes)</span>
          <input name="weeklyThresholdMinutes" type="number" min="0"
                 defaultValue={chosen.weekly} key={`w-${preset}`} className={`mt-1 ${FIELD}`} />
        </label>

        <label className="block">
          <span className="block text-xs text-ink-500">Overtime after, per day (minutes)</span>
          <input name="dailyThresholdMinutes" type="number" min="0"
                 defaultValue={chosen.daily} key={`d-${preset}`} className={`mt-1 ${FIELD}`} />
        </label>

        <label className="block">
          <span className="block text-xs text-ink-500">Overtime multiplier</span>
          <input name="overtimeMultiplier" defaultValue="1.5" className={`mt-1 ${FIELD}`} />
        </label>

        <label className="block">
          <span className="block text-xs text-ink-500">Double time multiplier</span>
          <input name="doubleTimeMultiplier" defaultValue="2" className={`mt-1 ${FIELD}`} />
        </label>

        <label className="block">
          <span className="block text-xs text-ink-500">The week starts on</span>
          <select name="weekStartsOn" defaultValue="1" className={`mt-1 ${FIELD}`}>
            <option value="0">Sunday</option>
            <option value="1">Monday</option>
            <option value="6">Saturday</option>
          </select>
        </label>

        <label className="block">
          <span className="block text-xs text-ink-500">A shift crossing midnight</span>
          <select name="dayAttribution" defaultValue="shift_start" className={`mt-1 ${FIELD}`}>
            <option value="shift_start">Counts on the day it started</option>
            <option value="split_at_midnight">Splits at midnight</option>
          </select>
        </label>
      </div>

      <fieldset className="mt-4">
        <legend className="text-xs text-ink-500">
          {/*
            No option preselected. Core refuses a policy that does not
            declare this, and a preselected radio is a declaration somebody
            made by not looking.
          */}
          On call time is
        </legend>
        <label className="mt-1 flex items-center gap-2 text-sm">
          <input type="radio" name="onCallTreatment" value="hours_worked_at_base" required />
          Hours worked, at base rate, and counts toward the thresholds
        </label>
        <label className="mt-1 flex items-center gap-2 text-sm">
          <input type="radio" name="onCallTreatment" value="separate_rate_not_hours_worked" />
          Paid at its own rate, and not hours worked
        </label>
      </fieldset>

      <label className="mt-4 block">
        <span className="block text-xs text-ink-500">
          {/*
            Required by core, and the reason is on the label. Somebody
            approving payroll reads this to decide whether the declaration is
            right, and a blank one tells them nothing.
          */}
          Why this is right for your company. Whoever approves payroll reads it.
        </span>
        <textarea name="note" required rows={2}
                  placeholder="Forty hours a week at time and a half. Nothing daily, because Texas has no daily rule."
                  className="mt-1 w-full rounded border border-steel-300 px-2 py-1 text-sm" />
      </label>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="submit" disabled={saving} className={BUTTON}>
          {saving ? "Declaring" : "Declare it"}
        </button>
        {current && (
          <button type="button" onClick={() => setOpen(false)} className={BUTTON}>
            Cancel
          </button>
        )}
        {current && (
          <span className="text-xs text-ink-500">
            This replaces {current}. The old one is kept, because it is the
            answer to what you were operating under before.
          </span>
        )}
      </div>

      {error ? <p role="alert" className="mt-3 text-sm text-red-600">{error}</p> : null}
    </form>
  );
}
