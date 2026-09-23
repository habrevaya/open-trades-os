"use client";

import { useActionState, useState } from "react";
import { offerService, saveWindows, saveHours } from "./actions";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function Note({ state }: { state: { done?: boolean; error?: string } }) {
  if (state.error) return <p className="mt-2 text-sm text-red-600" role="alert">{state.error}</p>;
  if (state.done) return <p className="mt-2 text-sm text-ink-500" role="status">Saved.</p>;
  return null;
}

/**
 * OFFERING A JOB TYPE TO THE PUBLIC
 *
 * Per job type rather than per company, which is the whole model: a shop will
 * let the internet book a tune up two days out and will never let it book an
 * emergency line replacement.
 */
export function OfferService({ jobTypes }: {
  jobTypes: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(offerService, {});

  if (jobTypes.length === 0) {
    return (
      <p className="mt-3 text-sm text-ink-500">
        Every job type is already offered online. Edit one below to change its
        terms or take it down.
      </p>
    );
  }

  return (
    <form action={action} className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-ink-700">Job type</span>
        <select name="jobTypeId" required className="h-10 rounded border border-steel-300 px-2 text-sm">
          {jobTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-ink-700">What customers see it called</span>
        <input name="publicName" required maxLength={200}
               className="h-10 rounded border border-steel-300 px-3 text-sm" />
      </label>

      <label className="flex flex-col gap-1 sm:col-span-2">
        <span className="text-sm font-medium text-ink-700">Description</span>
        <textarea name="publicDescription" rows={2} maxLength={2000}
                  className="rounded border border-steel-300 p-2 text-sm" />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-ink-700">Price shown</span>
        <input name="displayPrice" inputMode="decimal" placeholder="Leave blank to quote on site"
               className="h-10 rounded border border-steel-300 px-3 text-sm" />
        {/*
          Blank is not zero. Absent means "we will quote on site", which is
          honest and converts better than a number the company will not
          honour, and the form must not turn it into a free service.
        */}
        <span className="text-xs text-ink-500">Blank means you will quote on site.</span>
      </label>

      <div className="grid grid-cols-3 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-ink-700">Notice (h)</span>
          <input name="minNoticeHours" type="number" defaultValue={24} min={0} max={720}
                 className="h-10 rounded border border-steel-300 px-2 text-sm" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-ink-700">Book out (d)</span>
          <input name="maxAdvanceDays" type="number" defaultValue={60} min={1} max={365}
                 className="h-10 rounded border border-steel-300 px-2 text-sm" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-ink-700">Per window</span>
          <input name="maxPerWindow" type="number" defaultValue={2} min={1} max={100}
                 className="h-10 rounded border border-steel-300 px-2 text-sm" />
        </label>
      </div>

      <div className="sm:col-span-2">
        <button type="submit" disabled={pending}
                className="h-10 rounded border border-steel-300 px-4 text-sm font-medium">
          {pending ? "Saving" : "Offer this online"}
        </button>
        <Note state={state} />
      </div>
    </form>
  );
}

/**
 * The windows a customer picks between.
 *
 * Replaced as a whole set rather than edited one at a time, because
 * add-then-remove is visible to customers in between: a company would be
 * publishing half a set of windows for as long as the two calls take.
 */
export function Windows({ current }: {
  current: { name: string; startsAt: string; endsAt: string }[];
}) {
  const [state, action, pending] = useActionState(saveWindows, {});
  const [rows, setRows] = useState(
    current.length > 0 ? current : [{ name: "", startsAt: "", endsAt: "" }],
  );

  return (
    <form action={action} className="mt-3">
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-sm text-ink-500">Name</span>
              <input name="windowName" defaultValue={row.name} placeholder="8am to 12pm"
                     className="h-10 w-48 rounded border border-steel-300 px-3 text-sm" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm text-ink-500">From</span>
              <input name="windowStart" type="time" defaultValue={row.startsAt.slice(0, 5)}
                     className="h-10 rounded border border-steel-300 px-2 text-sm" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm text-ink-500">To</span>
              <input name="windowEnd" type="time" defaultValue={row.endsAt.slice(0, 5)}
                     className="h-10 rounded border border-steel-300 px-2 text-sm" />
            </label>
          </div>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <button type="button"
                onClick={() => setRows([...rows, { name: "", startsAt: "", endsAt: "" }])}
                className="h-10 rounded border border-steel-300 px-4 text-sm">
          Add a window
        </button>
        <button type="submit" disabled={pending}
                className="h-10 rounded border border-steel-300 px-4 text-sm font-medium">
          {pending ? "Saving" : "Save windows"}
        </button>
      </div>
      <Note state={state} />
    </form>
  );
}

/**
 * Which days the company is open.
 *
 * All seven, always. A partial week is ambiguous: a missing Saturday could
 * mean closed or could mean nobody has said yet, and availability treats an
 * absent row as closed, so silence becomes a decision nobody made.
 */
export function Hours({ current }: {
  current: { dayOfWeek: number; opensAt: string | null; closesAt: string | null; closed: boolean }[];
}) {
  const [state, action, pending] = useActionState(saveHours, {});
  const byDay = new Map(current.map((d) => [d.dayOfWeek, d]));

  return (
    <form action={action} className="mt-3">
      <div className="space-y-1">
        {DAYS.map((label, day) => {
          const row = byDay.get(day);
          return (
            <div key={day} className="flex items-center gap-3">
              <span className="w-24 text-sm text-ink-700">{label}</span>
              <input name={`opens-${day}`} type="time" defaultValue={row?.opensAt?.slice(0, 5) ?? "07:00"}
                     className="h-9 rounded border border-steel-300 px-2 text-sm" />
              <input name={`closes-${day}`} type="time" defaultValue={row?.closesAt?.slice(0, 5) ?? "18:00"}
                     className="h-9 rounded border border-steel-300 px-2 text-sm" />
              <label className="flex items-center gap-1 text-sm text-ink-500">
                <input name={`closed-${day}`} type="checkbox" defaultChecked={row?.closed ?? day === 0} />
                Closed
              </label>
            </div>
          );
        })}
      </div>

      <button type="submit" disabled={pending}
              className="mt-3 h-10 rounded border border-steel-300 px-4 text-sm font-medium">
        {pending ? "Saving" : "Save hours"}
      </button>
      <Note state={state} />
    </form>
  );
}
