/** Where a service report stands, in the office's words. */
export const REPORT_STATUS: Record<"draft" | "submitted" | "published" | "skipped", string> = {
  draft: "Started on the phone",
  submitted: "Not shown to the customer",
  published: "Shown to the customer",
  skipped: "Skipped",
};

export const REPORT_TONE: Record<"draft" | "submitted" | "published" | "skipped", "neutral" | "info" | "success" | "warning"> = {
  draft: "neutral",
  submitted: "info",
  published: "success",
  skipped: "neutral",
};
