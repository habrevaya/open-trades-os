import { marketing as mk } from "@opentradesos/core";

/**
 * THE FUNNEL'S QUERY STRING, read in one place.
 *
 * The report and the rows behind each of its cells are both pages of their
 * URL, so the dates, the cut and the model travel in the link, and a drill
 * opened from a cell is computed over exactly what the cell was. Two readers
 * of these four values, each with its own defaults, is how a click lands on a
 * list that does not add up to the number clicked.
 */
export type By = "channel" | "campaign" | "number" | "platform";

export interface FunnelParams {
  from: string;
  to: string;
  by: By;
  model?: mk.AttributionModelKey;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function funnelQuery(
  raw: Record<string, string | string[] | undefined>,
  today: string,
): FunnelParams {
  const one = (key: string) => {
    const value = raw[key];
    return Array.isArray(value) ? value[0] : value;
  };
  /** Thirty days to today, in the company's own calendar, unless asked otherwise. */
  const back = new Date(`${today}T12:00:00Z`);
  back.setUTCDate(back.getUTCDate() - 29);
  const from = one("from") && ISO.test(one("from")!) ? one("from")! : back.toISOString().slice(0, 10);
  const to = one("to") && ISO.test(one("to")!) ? one("to")! : today;
  const by = (["channel", "campaign", "number", "platform"] as const).find((b) => b === one("by")) ?? "channel";
  const model = mk.ATTRIBUTION_MODEL_KEYS.find((m) => m === one("model"));
  return { from, to, by, ...(model ? { model } : {}) };
}

export function rowsHref(params: FunnelParams, key: string, measure: string): string {
  const query = new URLSearchParams({
    from: params.from, to: params.to, by: params.by, key, measure,
    ...(params.model ? { model: params.model } : {}),
  });
  return `/marketing/rows?${query.toString()}`;
}

export const MEASURE_LABEL: Record<string, string> = {
  spend: "Spend",
  calls: "Calls",
  answered: "Answered calls",
  missed: "Missed calls",
  firstTime: "First time callers",
  leads: "Leads",
  booked: "Booked jobs",
  completed: "Completed jobs",
  revenue: "Revenue",
};
