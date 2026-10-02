import type { Tone } from "@/lib/labels";

export const CREDIT_STATUS: Record<string, string> = {
  draft: "Draft",
  open: "Not yet used",
  partially_applied: "Part used",
  applied: "Used",
  void: "Void",
};

export const CREDIT_TONE: Record<string, Tone> = {
  draft: "neutral",
  open: "info",
  partially_applied: "warning",
  applied: "success",
  void: "neutral",
};

/** Why, in the words an office uses. The order is the order of the list on the form. */
export const CREDIT_REASON: Record<string, string> = {
  billing_error: "We billed it wrong",
  price_adjustment: "Price adjusted",
  work_not_done: "Work not done",
  duplicate_invoice: "Billed twice",
  contract_adjustment: "Contract adjustment",
  goodwill: "Goodwill",
};

export const REASON_OPTIONS = Object.entries(CREDIT_REASON).map(([value, label]) => ({ value, label }));
