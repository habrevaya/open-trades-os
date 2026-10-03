import { reporting } from "@opentradesos/core";
import { ActionForm, Select, TextArea, TextField } from "@/components/ActionForm";
import type { FormState } from "@/lib/actions";

const WEEKDAYS = [
  { value: 1, label: "Mon" }, { value: 2, label: "Tue" }, { value: 3, label: "Wed" },
  { value: 4, label: "Thu" }, { value: 5, label: "Fri" }, { value: 6, label: "Sat" }, { value: 7, label: "Sun" },
];

export interface ScheduleDefaults {
  report?: string;
  name?: string;
  frequency?: string;
  weekdays?: number[];
  dayOfMonth?: number | null;
  time?: string;
  period?: string;
  userIds?: string[];
  addresses?: string[];
}

/**
 * WHEN A REPORT ARRIVES, AND WHO GETS IT
 *
 * One form for a new schedule and a changed one. Every field is on the page
 * at once rather than revealed by the frequency, so it works with JavaScript
 * off and a person can see what each choice means before making it: the
 * weekdays are read for a weekly schedule and the day of the month for a
 * monthly one, and the form says so beside each.
 *
 * The people are everybody in the company. The service refuses anybody who
 * could not open the report themselves, by name, rather than this form
 * quietly leaving them off the list, because a person missing from a list is
 * a question nobody can answer and a sentence saying why is not.
 */
export function ScheduleForm({
  action, submit, hidden, reports, people, timezone, defaults = {},
}: {
  action: (previous: FormState, form: FormData) => Promise<FormState>;
  submit: string;
  hidden?: Record<string, string>;
  reports: { value: string; label: string }[];
  people: { userId: string; name: string }[];
  timezone: string;
  defaults?: ScheduleDefaults;
}) {
  const frequency = defaults.frequency ?? "weekly";
  return (
    <ActionForm action={action} submit={submit} {...(hidden ? { hidden } : {})} className="mt-6 space-y-5">
      <Select label="Report" name="report" options={reports} defaultValue={defaults.report ?? reports[0]?.value} />
      <TextField label="Name it (optional)" name="name" defaultValue={defaults.name ?? ""}
                 placeholder="The report's own name" />

      <fieldset className="space-y-3 rounded-md border border-steel-200 p-4">
        <legend className="px-1 text-sm font-medium text-ink-700">When</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="How often" name="frequency" defaultValue={frequency} options={[
            { value: "daily", label: "Every day" },
            { value: "weekly", label: "Every week, on the days ticked" },
            { value: "monthly", label: "Every month, on the day below" },
          ]} />
          <TextField label={`Time (${timezone})`} name="time" type="time" defaultValue={defaults.time ?? "07:00"} />
        </div>
        <div>
          <span className="text-sm font-medium text-ink-700">Days of the week (weekly)</span>
          <div className="mt-1 flex flex-wrap gap-3">
            {WEEKDAYS.map((day) => (
              <label key={day.value} className="inline-flex items-center gap-1.5 text-sm">
                <input type="checkbox" name="weekdays" value={day.value}
                       defaultChecked={(defaults.weekdays ?? [1]).includes(day.value)} />
                {day.label}
              </label>
            ))}
          </div>
        </div>
        <TextField label="Day of the month, 1 to 28 (monthly)" name="dayOfMonth" type="number" min={1} max={28}
                   defaultValue={String(defaults.dayOfMonth ?? 1)} className="block max-w-xs" />
        <Select label="Which days it covers" name="period"
                defaultValue={defaults.period ?? reporting.defaultPeriod(frequency as reporting.Frequency)}
                options={reporting.PERIODS.map((p) => ({ value: p.key, label: p.label }))} />
        <p className="text-xs text-ink-500">
          A report sent on Monday covering the seven days before stops at the end of Sunday. Nothing it
          covers is the day it is sent.
        </p>
      </fieldset>

      <fieldset className="space-y-3 rounded-md border border-steel-200 p-4">
        <legend className="px-1 text-sm font-medium text-ink-700">Who gets it</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {people.map((person) => (
            <label key={person.userId} className="inline-flex items-center gap-1.5 text-sm">
              <input type="checkbox" name="userIds" value={person.userId}
                     defaultChecked={(defaults.userIds ?? []).includes(person.userId)} />
              {person.name}
            </label>
          ))}
        </div>
        <TextArea label="Anybody outside the company (your accountant)" name="addresses" rows={2}
                  defaultValue={(defaults.addresses ?? []).join(", ")}
                  placeholder="books@youraccountant.com" />
        <p className="text-xs text-ink-500">
          It runs as you, with what you can see. People here only get it if they could open it themselves.
          An outside address gets the summary and the spreadsheet, and no link into the app.
        </p>
      </fieldset>
    </ActionForm>
  );
}

/** Built-in reports and saved ones, as one list, grouped by words in the label. */
export function reportOptions(
  builtIn: { slug: string; name: string }[],
  saved: { id: string; name: string }[],
): { value: string; label: string }[] {
  return [
    ...builtIn.map((r) => ({ value: `builtIn:${r.slug}`, label: r.name })),
    ...saved.map((r) => ({ value: `saved:${r.id}`, label: `${r.name} (saved)` })),
  ];
}
