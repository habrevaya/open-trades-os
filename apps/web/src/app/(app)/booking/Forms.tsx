"use client";

import { useKeptAction } from "@/lib/use-kept-action";
import { useState, type ReactNode } from "react";
import { offerService, saveWindows, saveHours, saveMemberHold, addSeason, changeSeason } from "./actions";

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
  const [state, actionForm, pending] = useKeptAction(offerService, {});

  if (jobTypes.length === 0) {
    return (
      <p className="mt-3 text-sm text-ink-500">
        Every job type is already offered online. Edit one above to change its
        terms or take it down.
      </p>
    );
  }

  return (
    <form {...actionForm} className="mt-3 grid gap-3 sm:grid-cols-2">
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
  const [state, actionForm, pending] = useKeptAction(saveWindows, {});
  const [rows, setRows] = useState(
    current.length > 0 ? current : [{ name: "", startsAt: "", endsAt: "" }],
  );

  return (
    <form {...actionForm} className="mt-3">
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
 * Which days the company is open, or one branch is.
 *
 * All seven, always. A partial week is ambiguous: a missing Saturday could
 * mean closed or could mean nobody has said yet, and availability treats an
 * absent row as closed, so silence becomes a decision nobody made.
 *
 * With `businessUnitId` it is that branch's own week, and the labels carry
 * the branch's name so a screen with several is read by a screen reader
 * without guessing which Monday is whose.
 */
export function Hours({ current, businessUnitId, name, submit = "Save hours", action = saveHours, hidden = {}, children, keepable, kept = [] }: {
  current: { dayOfWeek: number; opensAt: string | null; closesAt: string | null; closed: boolean }[];
  /** A season's days: each can be ticked to keep the normal week's hours that day. */
  keepable?: boolean;
  /** The days ticked to keep the normal hours when the form opens. */
  kept?: number[];
  businessUnitId?: string;
  name?: string;
  submit?: string;
  /** Where the week goes: the company's or a branch's by default, a phone number's own from its page. */
  action?: typeof saveHours;
  hidden?: Record<string, string>;
  /** Fields above the seven days: a season's name and dates. */
  children?: ReactNode;
}) {
  const [state, actionForm, pending] = useKeptAction(action, {});
  const byDay = new Map(current.map((d) => [d.dayOfWeek, d]));
  const whose = name ? ` in ${name}` : "";

  return (
    <form {...actionForm} className="mt-3">
      {businessUnitId ? <input type="hidden" name="businessUnitId" value={businessUnitId} /> : null}
      {Object.entries(hidden).map(([key, value]) => <input key={key} type="hidden" name={key} value={value} />)}
      {children}
      <div className="space-y-1">
        {DAYS.map((label, day) => {
          const row = byDay.get(day);
          return (
            <div key={day} className="flex flex-wrap items-center gap-3">
              <span className="w-24 text-sm text-ink-700">{label}</span>
              <input name={`opens-${day}`} type="time" defaultValue={row?.opensAt?.slice(0, 5) ?? "07:00"}
                     aria-label={`${label} opens${whose}`}
                     className="h-9 rounded border border-steel-300 px-2 text-sm" />
              <input name={`closes-${day}`} type="time" defaultValue={row?.closesAt?.slice(0, 5) ?? "18:00"}
                     aria-label={`${label} closes${whose}`}
                     className="h-9 rounded border border-steel-300 px-2 text-sm" />
              <label className="flex items-center gap-1 text-sm text-ink-500">
                <input name={`closed-${day}`} type="checkbox" defaultChecked={row?.closed ?? day === 0}
                       aria-label={`${label} closed${whose}`} />
                Closed
              </label>
              {keepable ? (
                <label className="flex items-center gap-1 text-sm text-ink-500">
                  <input name={`keep-${day}`} type="checkbox" defaultChecked={kept.includes(day)}
                         aria-label={`${label} keeps the normal hours${whose}`} />
                  Keep the normal hours
                </label>
              ) : null}
            </div>
          );
        })}
      </div>

      <button type="submit" disabled={pending}
              className="mt-3 h-10 rounded border border-steel-300 px-4 text-sm font-medium">
        {pending ? "Saving" : submit}
      </button>
      <Note state={state} />
    </form>
  );
}

/**
 * A SEASON: HOURS KEPT BETWEEN TWO DATES
 *
 * Its name, its first and last day, whether it comes back every year, and
 * its seven days, which replace the normal week on every date between. A new
 * one starts from the week it sits over, so only the days that differ need
 * changing. A day ticked "Keep the normal hours" is not changed by the season
 * at all. Either end of a yearly season can be a day of the week in a month
 * (the last Monday of May) instead of a date.
 */
export function Season({ season, businessUnitId, owner, start }: {
  /** The season being changed, or absent for a new one. */
  season?: {
    id: string; name: string; startsOn: string; endsOn: string; repeatsYearly: boolean;
    startsRule?: SeasonRule | null; endsRule?: SeasonRule | null; onlySomeDays?: boolean;
    days: { dayOfWeek: number; opensAt: string | null; closesAt: string | null; closed: boolean }[];
  };
  /** The branch a new season is for. Absent is the company's. */
  businessUnitId?: string;
  /** Whose season, for the labels: "the company" or the branch's name. */
  owner: string;
  /** The week a new season starts from. */
  start: { dayOfWeek: number; opensAt: string | null; closesAt: string | null; closed: boolean }[];
}) {
  const label = season ? season.name : `a new season for ${owner}`;
  /** A season changing some days opens with the others ticked, showing the normal week's hours beside them. */
  const changed = new Set(season?.days.map((d) => d.dayOfWeek) ?? []);
  const kept = season?.onlySomeDays ? [0, 1, 2, 3, 4, 5, 6].filter((d) => !changed.has(d)) : [];
  const current = season?.onlySomeDays
    ? start.map((d) => season.days.find((s) => s.dayOfWeek === d.dayOfWeek) ?? d)
    : season?.days ?? start;
  return (
    <Hours
      current={current}
      keepable
      kept={kept}
      name={label}
      action={season ? changeSeason : addSeason}
      submit={season ? `Save ${season.name}` : `Add the season for ${owner}`}
      {...(businessUnitId && !season ? { businessUnitId } : {})}
      hidden={season ? { seasonId: season.id } : {}}
    >
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm text-ink-500">Name</span>
          <input name="seasonName" required maxLength={80} defaultValue={season?.name ?? ""} placeholder="Summer hours"
                 aria-label={`Name of ${label}`} className="h-9 w-48 rounded border border-steel-300 px-2 text-sm" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm text-ink-500">First day</span>
          <input name="startsOn" type="date" defaultValue={season?.startsRule ? "" : season?.startsOn ?? ""}
                 aria-label={`First day of ${label}`} className="h-9 rounded border border-steel-300 px-2 text-sm" />
        </label>
        <SeasonEnd end="starts" label={label} rule={season?.startsRule ?? null} />
        <label className="flex flex-col gap-1">
          <span className="text-sm text-ink-500">Last day</span>
          <input name="endsOn" type="date" defaultValue={season?.endsRule ? "" : season?.endsOn ?? ""}
                 aria-label={`Last day of ${label}`} className="h-9 rounded border border-steel-300 px-2 text-sm" />
        </label>
        <SeasonEnd end="ends" label={label} rule={season?.endsRule ?? null} />
        <label className="flex h-9 items-center gap-1 text-sm text-ink-700">
          <input name="repeatsYearly" type="checkbox" defaultChecked={season?.repeatsYearly ?? true}
                 aria-label={`${label} comes back every year`} />
          Every year
        </label>
        <p className="w-full text-xs text-ink-500">
          For a season that moves with the calendar, like Memorial Day to Labor Day, choose a day of the week
          instead of a date. It is worked out again every year. Tick Keep the normal hours on any day the season
          does not change.
        </p>
      </div>
    </Hours>
  );
}

type SeasonRule = { month: number; weekday: number; week: 1 | 2 | 3 | 4 | "last" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** One end of a season as a day of the week in a month: "Or the [last] [Monday] of [May]". Left on "a date" it is not used. */
function SeasonEnd({ end, label, rule }: { end: "starts" | "ends"; label: string; rule: SeasonRule | null }) {
  const which = end === "starts" ? "Starts" : "Ends";
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-sm text-ink-500">Or {end === "starts" ? "starts" : "ends"} on</legend>
      <div className="flex gap-1">
        <select name={`${end}Week`} defaultValue={rule ? String(rule.week) : ""} aria-label={`${which} on which week, ${label}`}
                className="h-9 rounded border border-steel-300 px-1 text-sm">
          <option value="">the date</option>
          <option value="1">the first</option>
          <option value="2">the second</option>
          <option value="3">the third</option>
          <option value="4">the fourth</option>
          <option value="last">the last</option>
        </select>
        <select name={`${end}Weekday`} defaultValue={String(rule?.weekday ?? 1)} aria-label={`${which} on which day, ${label}`}
                className="h-9 rounded border border-steel-300 px-1 text-sm">
          {DAYS.map((d, i) => <option key={d} value={String(i)}>{d}</option>)}
        </select>
        <select name={`${end}Month`} defaultValue={String(rule?.month ?? 6)} aria-label={`${which} in which month, ${label}`}
                className="h-9 rounded border border-steel-300 px-1 text-sm">
          {MONTHS.map((m, i) => <option key={m} value={String(i + 1)}>of {m}</option>)}
        </select>
      </div>
    </fieldset>
  );
}

/**
 * WHAT A PLAN'S PRIORITY DISPATCH RESERVES
 *
 * A share of each window kept back from anybody who is not a member, let go
 * a number of hours before the window opens. The arithmetic is said beside
 * the numbers, because "25" means nothing until it is "two of eight".
 */
export function MemberHold({ current, plansWithPriority, plans = [] }: {
  current: { reservePercent: number; releaseHours: number };
  plansWithPriority: number;
  /** The plans that promise priority, each with its own share or null for this one. */
  plans?: { id: string; name: string; holdPercent: number | null }[];
}) {
  const [state, actionForm, pending] = useKeptAction(saveMemberHold, {});
  return (
    <form {...actionForm} className="mt-3 max-w-prose">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm text-ink-500">Share of each window held for members (per cent)</span>
          <input name="reservePercent" type="number" min={0} max={90} step={1} defaultValue={current.reservePercent}
                 className="h-10 w-32 rounded border border-steel-300 px-3 text-sm" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm text-ink-500">Let it go this many hours before the window</span>
          <input name="releaseHours" type="number" min={0} max={336} step={1} defaultValue={current.releaseHours}
                 className="h-10 w-32 rounded border border-steel-300 px-3 text-sm" />
        </label>
        <button type="submit" disabled={pending} className="h-10 rounded bg-ink-900 px-4 text-sm font-medium text-white disabled:opacity-60">
          {pending ? "Saving" : "Save"}
        </button>
      </div>
      <p className="mt-2 text-sm text-ink-500">
        A window two technicians could fill with eight jobs, at 25 per cent, offers six to everybody and the last two only to
        members, until the hours above before it opens. Members&apos; own bookings use the held share first. A small window
        is never half held: the share is rounded to whole jobs, a half rounded down.
        {plansWithPriority === 0
          ? " None of your plans promises priority dispatch, so nothing is held until one does."
          : ` Members of the ${plansWithPriority === 1 ? "plan" : `${plansWithPriority} plans`} that promise priority dispatch are offered the held share, from their own account and when they ask to move a visit; the public page never is.`}
      </p>
      {plans.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-sm text-ink-700" aria-label="Each plan's share">
          {plans.map((plan) => (
            <li key={plan.id}>
              <a href={`/agreements/plans/${plan.id}`} className="underline underline-offset-4">{plan.name}</a>
              {": "}
              {plan.holdPercent === null ? "the figure above" : `${plan.holdPercent} per cent, set on the plan`}
            </li>
          ))}
        </ul>
      ) : null}
      {plans.length > 0 ? (
        <p className="mt-1 text-sm text-ink-500">
          A plan can hold its own share instead of the figure above. A window keeps back the largest share any plan holds,
          and a member gets into as much of it as their own plan holds.
        </p>
      ) : null}
      <Note state={state} />
    </form>
  );
}
