"use client";

import { useActionState } from "react";
import { setTimezone } from "./actions";

/**
 * THE COMPANY'S TIME ZONE
 *
 * On this screen because half the product reads it and nothing could write
 * it. `organization.timezone` defaults to America/Chicago and had no setter,
 * so every company was permanently in Chicago: a contractor in Phoenix
 * configuring an 8am arrival window had it published to their customers as
 * 6am, silently, with no setting anywhere that would explain why.
 *
 * The browser's own zone is offered as the answer, because the browser knows
 * it and a dropdown of six hundred names is how somebody picks the wrong one.
 * It stays typeable, because the person setting this up is not always sitting
 * in the same place as the company.
 */
export function Timezone({ current }: { current: string }) {
  const [state, action, pending] = useActionState<
    { done?: boolean; note?: string; error?: string },
    FormData
  >(setTimezone, {});

  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <section className="mt-8 rounded-md border border-steel-200 p-4">
      <h2 className="font-medium text-ink-900">Time zone</h2>
      <p className="mt-1 max-w-prose text-sm text-ink-500">
        Every calendar day in this product becomes a pair of instants in this
        zone: the dispatch board, the arrival windows on your booking page,
        agreement dates, and when a scheduled automation runs.
      </p>

      <form action={action} className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-ink-700">IANA name</span>
          <input
            name="timezone"
            defaultValue={current}
            list="known-zones"
            className="h-10 w-72 rounded border border-steel-300 px-3 text-sm"
          />
        </label>
        <datalist id="known-zones">
          <option value={browserZone} />
          {/*
            A short list rather than the full database. These are the zones a
            United States trades company is actually in, and the field takes
            anything the server can resolve, so the list is a shortcut rather
            than a limit.
          */}
          {[
            "America/New_York", "America/Chicago", "America/Denver",
            "America/Phoenix", "America/Los_Angeles", "America/Anchorage",
            "Pacific/Honolulu",
          ].map((zone) => <option key={zone} value={zone} />)}
        </datalist>

        <button
          type="submit"
          disabled={pending}
          className="h-10 rounded border border-steel-300 px-4 text-sm font-medium"
        >
          {pending ? "Saving" : "Save"}
        </button>

        {browserZone !== current && (
          /*
            Named rather than applied. This browser's zone is a good guess and
            is not authority: somebody setting up a Phoenix company from a
            laptop in Denver would otherwise have their guess silently become
            the company's answer.
          */
          <p className="text-sm text-ink-500">
            This browser is in {browserZone}.
          </p>
        )}
      </form>

      {state.error && (
        <p className="mt-2 text-sm text-red-600" role="alert">{state.error}</p>
      )}
      {state.done && (
        <p className="mt-2 text-sm text-ink-500" role="status">
          {state.note ?? "Saved."}
        </p>
      )}
    </section>
  );
}
