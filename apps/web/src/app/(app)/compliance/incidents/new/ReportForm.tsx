"use client";

import { ActionForm, Select, TextArea, TextField } from "@/components/ActionForm";
import { report } from "../actions";

type Option = { value: string; label: string };

/** Four rows for people, which covers almost every report; more can be named in the description. */
const ROWS = [0, 1, 2, 3];

export function ReportForm({ kinds, roles, people }: { kinds: Option[]; roles: Option[]; people: Option[] }) {
  return (
    <ActionForm action={report} submit="Send the report">
      <Select label="What happened" name="kind" options={kinds} required />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="When" name="occurredAt" type="datetime-local" required />
        <TextField label="Where" name="location" maxLength={300} placeholder="The address, and where on it" />
      </div>
      <TextArea label="What happened, in your own words" name="description" rows={5} required />
      <TextArea label="What was done straight away" name="immediateAction" rows={2} />
      <fieldset>
        <legend className="text-sm font-medium text-ink-700">Who was there</legend>
        <p className="mt-0.5 text-sm text-ink-500">If somebody was hurt, say who: the report needs it.</p>
        <div className="mt-2 space-y-3">
          {ROWS.map((row) => (
            <div key={row} className="grid gap-2 sm:grid-cols-4">
              <select name={`person.${row}.technicianId`} aria-label={`Person ${row + 1}, one of your people`} defaultValue=""
                      className="h-10 rounded border border-steel-300 bg-canvas px-2 text-sm">
                <option value="">One of your people</option>
                {people.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
              <input name={`person.${row}.name`} placeholder="Or a name" aria-label={`Person ${row + 1}, name`}
                     className="h-10 rounded border border-steel-300 px-2 text-sm" />
              <select name={`person.${row}.role`} aria-label={`Person ${row + 1}, how they were involved`} defaultValue="involved"
                      className="h-10 rounded border border-steel-300 bg-canvas px-2 text-sm">
                {roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
              <input name={`person.${row}.injury`} placeholder="The injury, if hurt" aria-label={`Person ${row + 1}, injury`}
                     className="h-10 rounded border border-steel-300 px-2 text-sm" />
            </div>
          ))}
        </div>
      </fieldset>
      <label className="block text-sm">
        <span className="font-medium text-ink-700">A photograph</span>
        <input type="file" name="photo" accept="image/*" capture="environment" className="mt-1 block text-sm" />
      </label>
    </ActionForm>
  );
}
