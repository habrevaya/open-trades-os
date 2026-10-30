/**
 * The rows of the answer-within table on the review policy form: five, one for
 * each star rating, which is as many as a policy the API takes can have (each
 * band reaches a higher whole rating than the one before). A policy stored
 * with more is drawn with every one of its rows, up to `MAX_BAND_ROWS`, so a
 * save from this form never drops one without saying so.
 */
export const BAND_ROWS = 5;
export const MAX_BAND_ROWS = 20;

/** Sunday first, as the policy numbers them: 0 is Sunday and 6 is Saturday. */
export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** "9 AM", "12 noon", "7 PM". */
export function hourLabel(hour: number): string {
  if (hour === 0) return "12 midnight";
  if (hour === 12) return "12 noon";
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}
