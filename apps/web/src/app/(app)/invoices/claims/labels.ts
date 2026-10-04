import type { claims } from "@opentradesos/core";

/** How each claim status sits beside the others: settled, waiting, or money we will not see. */
export const CLAIM_TONE: Record<claims.ClaimStatus, "success" | "neutral" | "info" | "warning" | "danger"> = {
  submitted: "neutral",
  approved: "info",
  paid: "success",
  short_paid: "warning",
  denied: "danger",
};
