/** Where a file stands, in the words and colours both screens use. */
export const STATUS_WORDS = {
  mapping: "Matching columns",
  checking: "Being checked",
  checked: "Checked, not loaded",
  loading: "Loading",
  finished: "Loaded",
} as const;

export const STATUS_TONE = {
  mapping: "neutral",
  checking: "info",
  checked: "warning",
  loading: "info",
  finished: "success",
} as const;
