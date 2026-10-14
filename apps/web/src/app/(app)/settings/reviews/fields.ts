/** The rows of the answer-within table on the review policy form. The policy has had four; one spare. */
export const BAND_ROWS = 5;

/** Sunday first, as the policy numbers them: 0 is Sunday and 6 is Saturday. */
export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** "9 AM", "12 noon", "7 PM". */
export function hourLabel(hour: number): string {
  if (hour === 0) return "12 midnight";
  if (hour === 12) return "12 noon";
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}
