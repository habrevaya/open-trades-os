import { reporting } from "@opentradesos/core";
import type { dashboards } from "@opentradesos/api/services";

/**
 * THE DAYS A DASHBOARD IS LOOKED AT OVER
 *
 * A plain GET form, so the days end up in the address and "Download as PDF"
 * and a link sent to somebody open on the same days. The choices are the four
 * a schedule offers, or two days of the reader's own, both kept. Only the
 * tiles that follow dates take them, so the page says which keep their own.
 * A dashboard none of whose tiles follow dates gets no box, and says how to
 * give it one.
 */

/** The days chosen in the address, as the service takes them. */
export function choiceOf(params: Record<string, string | string[] | undefined>): dashboards.DatesChoice {
  const one = (key: string) => (typeof params[key] === "string" ? params[key] as string : undefined);
  const period = one("dates");
  return period === "between" ? { from: one("from"), to: one("to") } : { period };
}

/** The query string that carries the chosen days, for the PDF link and the tiles' way back. */
export function choiceQuery(params: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const key of ["dates", "from", "to"]) {
    const value = params[key];
    if (typeof value === "string" && value !== "") query.set(key, value);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

const box = "h-9 rounded border border-steel-300 px-2 text-sm";

export function DashboardDates({ action, params, label, refusal, followers, keepsOwn, editable }: {
  /** This page, where the form goes. */
  action: string;
  params: Record<string, string | string[] | undefined>;
  /** The days drawn over, in words, or null for as it stands now. */
  label: string | null;
  /** Why the days chosen were refused, in words. */
  refusal: string | null;
  /** How many tiles follow dates. */
  followers: number;
  /** The tiles that keep their own dates, by title, when days were chosen. */
  keepsOwn: string[];
  /** Whether the reader can turn on "Follows the dashboard's dates" on a tile. */
  editable: boolean;
}) {
  if (followers === 0) {
    return (
      <p className="mt-3 text-sm text-ink-500">
        This dashboard shows things as they stand now. None of its tiles follow dates
        {editable ? ", so there is nothing to choose. Turn on \"Follows the dashboard's dates\" on a tile to look at it over other days." : "."}
      </p>
    );
  }
  const chosen = typeof params.dates === "string" ? params.dates : "";
  const periods = reporting.PERIODS.filter((p) => p.key !== "all");
  return (
    <div className="mt-3 rounded-md border border-steel-200 bg-canvas p-3">
      <form action={action} method="get" className="flex flex-wrap items-end gap-3" aria-label="Dates for this dashboard">
        <label className="text-sm">
          <span className="block text-ink-700">Days</span>
          <select name="dates" defaultValue={chosen} className={`mt-1 ${box}`}>
            <option value="">As it stands now</option>
            {periods.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            <option value="between">Between two dates</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-ink-700">First day</span>
          <input type="date" name="from" defaultValue={typeof params.from === "string" ? params.from : ""} className={`mt-1 ${box}`} />
        </label>
        <label className="text-sm">
          <span className="block text-ink-700">Last day</span>
          <input type="date" name="to" defaultValue={typeof params.to === "string" ? params.to : ""} className={`mt-1 ${box}`} />
        </label>
        <button type="submit" className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
          Show
        </button>
        <span className="text-xs text-ink-500">The two dates are used with Between two dates. Both days are kept.</span>
      </form>
      {refusal ? <p role="alert" className="mt-2 text-sm text-red-600">{refusal}</p> : null}
      {label ? (
        <p className="mt-2 text-sm text-ink-700" role="status">
          Showing {label} on the tiles that follow the dashboard&apos;s dates.
          {keepsOwn.length > 0 ? ` These keep their own dates: ${keepsOwn.join(", ")}.` : ""}
        </p>
      ) : null}
    </div>
  );
}
