/** What a change order's status means to somebody running the job. */
export const CHANGE_ORDER_STATUS: Record<string, string> = {
  requested: "Asked for, not priced",
  priced: "Priced, not sent",
  sent: "With the customer",
  approved: "Agreed",
  declined: "Declined",
  void: "Withdrawn",
};

export const CHANGE_ORDER_TONE: Record<string, "neutral" | "info" | "warning" | "success" | "danger"> = {
  requested: "neutral", priced: "info", sent: "warning", approved: "success", declined: "danger", void: "neutral",
};
